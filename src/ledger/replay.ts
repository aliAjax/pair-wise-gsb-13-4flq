// 重放引擎：把各台收银机的本机流水合并重放，派生班次账目与待核冲突。
// 规则：
//  1. 同一条流水以 (deviceId, seq) 去重，无论重放多少次结果一致（可重放/幂等）。
//  2. 同一业务单号 orderNo 的销售/退款来自两台机器：金额一致 -> 幂等合并为一笔；
//     金额不一致 -> 进入待核区，保留双方金额与差异。
//  3. 退款按业务单号匹配销售；超额退款、孤儿退款进入待核区。
//  4. 复核/裁决/关账本身也是流水，重连补录后按顺序生效。

import {
  Conflict,
  ConflictSide,
  DeviceId,
  JournalEntry,
  LedgerView,
  ShiftView,
  entryIdOf,
  parseShiftId,
} from "./types";

const DEVICE_RANK: Record<DeviceId, number> = {
  "REG-A": 0,
  "REG-B": 1,
  LEGACY: 2,
};

/**
 * 规范化后用于重放的流水序列：
 * 先按 (deviceId, seq) 去重，再给出确定的全局顺序：
 * 业务时刻 ts -> 设备 -> 本机流水号。断网补录的流水 ts 较早，
 * 因此重放后仍然回到业务发生时的位置。
 */
export function normalize(entries: readonly JournalEntry[]): JournalEntry[] {
  const byId = new Map<string, JournalEntry>();
  for (const e of entries) {
    const id = entryIdOf(e.deviceId, e.seq);
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, e);
      continue;
    }
    // 同一流水的两个副本：优先采用已确认、或确认时刻更早的那个
    byId.set(id, pickCanonical(prev, e));
  }
  return [...byId.values()].sort(compareEntries);
}

function pickCanonical(a: JournalEntry, b: JournalEntry): JournalEntry {
  if (a.confirmedAt && !b.confirmedAt) return a;
  if (!a.confirmedAt && b.confirmedAt) return b;
  if (a.confirmedAt && b.confirmedAt && a.confirmedAt !== b.confirmedAt) {
    return a.confirmedAt <= b.confirmedAt ? a : b;
  }
  return a;
}

function compareEntries(a: JournalEntry, b: JournalEntry): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const rank = DEVICE_RANK[a.deviceId] - DEVICE_RANK[b.deviceId];
  if (rank !== 0) return rank;
  return a.seq - b.seq;
}

interface ContentGroup {
  // 该内容组（同金额/升数/方式）最早一条，作为计入与对账代表
  representative: JournalEntry;
  members: JournalEntry[];
}

interface MutableShift {  id: string;
  type: ShiftView["type"];
  date: string;
  openedAt: string | null;
  entries: JournalEntry[];
  pendingEntries: JournalEntry[];
  // orderNo -> 该单的销售流水（已归一化去重后）
  salesByOrder: Map<string, JournalEntry[]>;
  refundsByOrder: Map<string, JournalEntry[]>;
  reviews: JournalEntry[];
  closes: JournalEntry[];
  // orderNo -> 冲突
  conflicts: Map<string, Conflict>;
  // resolve 流水：conflictKey -> 最新一条
  resolutions: Map<string, JournalEntry>;
}

function newShift(id: string, type: ShiftView["type"], date: string): MutableShift {
  return {
    id,
    type,
    date,
    openedAt: null,
    entries: [],
    pendingEntries: [],
    salesByOrder: new Map(),
    refundsByOrder: new Map(),
    reviews: [],
    closes: [],
    conflicts: new Map(),
    resolutions: new Map(),
  };
}

function sideOf(e: JournalEntry): ConflictSide {
  return {
    entryId: entryIdOf(e.deviceId, e.seq),
    deviceId: e.deviceId,
    seq: e.seq,
    amount: Number(e.amount ?? 0),
    liters: e.liters,
    payMethod: e.payMethod,
    ts: e.ts,
  };
}

function amountOf(list: JournalEntry[]): number {
  return list.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
}

export function replay(allEntries: readonly JournalEntry[]): LedgerView {
  const ordered = normalize(allEntries);
  const shifts = new Map<string, MutableShift>();

  const ensureShift = (e: JournalEntry): MutableShift => {
    let s = shifts.get(e.shiftId);
    if (!s) {
      const { date, type } = parseShiftId(e.shiftId);
      s = newShift(e.shiftId, e.shiftType ?? type, e.shiftDate ?? date);
      shifts.set(e.shiftId, s);
    }
    if (e.kind === "open" && (!s.openedAt || e.ts < s.openedAt)) s.openedAt = e.ts;
    return s;
  };

  // 第一遍：归位。open 携带班次类型/日期，优先用于回填。
  for (const e of ordered) {
    const s = ensureShift(e);
    s.entries.push(e);
    if (!e.confirmedAt) s.pendingEntries.push(e);

    switch (e.kind) {
      case "sale": {
        const list = s.salesByOrder.get(e.orderNo ?? "") ?? [];
        list.push(e);
        s.salesByOrder.set(e.orderNo ?? "", list);
        break;
      }
      case "refund": {
        const list = s.refundsByOrder.get(e.orderNo ?? "") ?? [];
        list.push(e);
        s.refundsByOrder.set(e.orderNo ?? "", list);
        break;
      }
      case "review":
        if (e.confirmedAt) s.reviews.push(e);
        break;
      case "close":
        if (e.confirmedAt) s.closes.push(e);
        break;
      case "resolve":
        if (e.confirmedAt && e.conflictKey) {
          const prev = s.resolutions.get(e.conflictKey);
          if (!prev || e.ts >= prev.ts) s.resolutions.set(e.conflictKey, e);
        }
        break;
      case "open":
        if (e.shiftType) s.type = e.shiftType;
        if (e.shiftDate) s.date = e.shiftDate;
        break;
    }
  }

  const views: ShiftView[] = [];

  for (const s of shifts.values()) {
    const conflicts: Conflict[] = [];
    const accepted = new Set<string>();
    const idempotentDups = new Set<string>();
    // 业务单 -> 内容分组（检测与计数共用，保证口径一致）
    const saleGroups = new Map<string, ContentGroup[]>();
    const refundGroups = new Map<string, ContentGroup[]>();

    /**
     * 同一单号按内容（金额/升数/方式）签名分组：
     *  - 组内：同内容的跨设备/跨副本录入 = 同一笔，代表流水取最早一条，其余幂等折叠；
     *  - 组间：同单号出现两种内容 = 双方录入口径不一致，进待核。
     */
    const groupByContent = (list: JournalEntry[]): ContentGroup[] => {
      const bySig = new Map<string, JournalEntry[]>();
      for (const e of list) {
        const sig = `${e.amount ?? 0}|${e.liters ?? 0}|${e.payMethod ?? ""}`;
        const bucket = bySig.get(sig) ?? [];
        bucket.push(e);
        bySig.set(sig, bucket);
      }
      return [...bySig.values()]
        .map((bucket) => {
          const sorted = bucket.sort(compareEntries);
          return { representative: sorted[0], members: sorted };
        })
        .sort((a, b) => compareEntries(a.representative, b.representative));
    };

    const markGroup = (groups: ContentGroup[]) => {
      for (const g of groups) {
        g.members.forEach((e) => accepted.add(entryIdOf(e.deviceId, e.seq)));
        g.members.slice(1).forEach((e) => idempotentDups.add(entryIdOf(e.deviceId, e.seq)));
      }
    };

    // ---- 销售分组与冲突检测 ----
    for (const [orderNo, sales] of s.salesByOrder) {
      const groups = groupByContent(sales);
      saleGroups.set(orderNo, groups);
      markGroup(groups);
      if (groups.length >= 2) {
        const [first, second, ...rest] = groups;
        conflicts.push({
          key: `sale:${s.id}:${orderNo}`,
          shiftId: s.id,
          type: "saleMismatch",
          orderNo,
          title: `销售单 ${orderNo} 双方金额不一致`,
          sideA: sideOf(first.representative),
          sideB: sideOf(second.representative),
          diff: round2(Math.abs(first.representative.amount ?? 0) - (second.representative.amount ?? 0)),
          resolved: false,
          idempotent: false,
          extraCount: rest.length,
        });
      }
    }

    // ---- 退款分组、冲突检测、销售匹配 ----
    for (const [orderNo, refunds] of s.refundsByOrder) {
      const groups = groupByContent(refunds);
      refundGroups.set(orderNo, groups);
      markGroup(groups);

      if (groups.length >= 2) {
        const [first, second, ...rest] = groups;
        conflicts.push({
          key: `refund:${s.id}:${orderNo}`,
          shiftId: s.id,
          type: "refundDup",
          orderNo,
          title: `退款单 ${orderNo} 双方金额不一致`,
          sideA: sideOf(first.representative),
          sideB: sideOf(second.representative),
          diff: round2(
            Math.abs(first.representative.amount ?? 0) - (second.representative.amount ?? 0),
          ),
          resolved: false,
          idempotent: false,
          extraCount: rest.length,
        });
      }

      const saleTotal = amountOf((saleGroups.get(orderNo) ?? []).map((g) => g.representative));
      const refundTotal = amountOf(groups.map((g) => g.representative));
      const firstRep = groups[0]?.representative ?? null;
      if ((saleGroups.get(orderNo) ?? []).length === 0) {
        conflicts.push({
          key: `orphan:${s.id}:${orderNo}`,
          shiftId: s.id,
          type: "refundOrphan",
          orderNo,
          title: `退款单 ${orderNo} 找不到对应销售`,
          sideA: firstRep ? sideOf(firstRep) : null,
          sideB: null,
          diff: round2(refundTotal),
          resolved: false,
          idempotent: false,
          extraCount: 0,
        });
      } else if (refundTotal > saleTotal + 0.001) {
        conflicts.push({
          key: `exceed:${s.id}:${orderNo}`,
          shiftId: s.id,
          type: "refundExceed",
          orderNo,
          title: `退款单 ${orderNo} 退款超过销售金额`,
          sideA: firstRep ? sideOf(firstRep) : null,
          sideB: null,
          diff: round2(refundTotal - saleTotal),
          resolved: false,
          idempotent: false,
          extraCount: 0,
        });
      }
    }

    // ---- 应用裁决流水 ----
    for (const conflict of conflicts) {
      const r = s.resolutions.get(conflict.key);
      if (r) {
        conflict.resolved = true;
        conflict.resolution = r.resolution;
        conflict.resolvedBy = r.deviceId;
        conflict.resolvedEntryId = entryIdOf(r.deviceId, r.seq);
      }
    }

    // ---- 计算净额：对每个业务单确定"计入流水"集合，再统一求和 ----
    // 每个内容组的代表流水计一笔，组内其余跨设备副本幂等折叠；
    // 口径冲突未裁决时只计第一方，第二方暂挂；已裁决按裁决计入。
    const counted = new Set<string>();

    const pickSides = (c: Conflict): string[] => {
      if (!c.resolved) return c.sideA ? [c.sideA.entryId] : [];
      if (c.resolution === "keepFirst") return c.sideA ? [c.sideA.entryId] : [];
      if (c.resolution === "keepSecond") return c.sideB ? [c.sideB.entryId] : [];
      return []; // dropAll
    };

    const mismatchConflicts = new Map<string, Conflict>();
    for (const c of conflicts) {
      if (c.type === "saleMismatch" || c.type === "refundDup") {
        mismatchConflicts.set(c.orderNo, c);
      }
    }

    const countGroups = (
      orderGroups: Map<string, ContentGroup[]>,
      kind: "saleMismatch" | "refundDup",
    ) => {
      for (const [orderNo, groups] of orderGroups) {
        const c = mismatchConflicts.get(orderNo);
        if (c && c.type === kind) {
          pickSides(c).forEach((id) => counted.add(id));
        } else {
          groups.forEach((g) => counted.add(entryIdOf(g.representative.deviceId, g.representative.seq)));
        }
      }
    };
    countGroups(saleGroups, "saleMismatch");
    countGroups(refundGroups, "refundDup");

    let cashNet = 0;
    let digitalNet = 0;
    let litersNet = 0;
    const byId = new Map(s.entries.map((e) => [entryIdOf(e.deviceId, e.seq), e]));
    for (const id of counted) {
      const e = byId.get(id);
      if (!e) continue;
      const sign = e.kind === "refund" ? -1 : 1;
      const amt = Number(e.amount ?? 0) * sign;
      if (e.payMethod === "digital") digitalNet += amt;
      else cashNet += amt;
      if (e.kind === "sale") litersNet += Number(e.liters ?? 0);
    }

    const review = lastByTs(s.reviews);
    const close = lastByTs(s.closes);
    const unresolved = conflicts.filter((c) => !c.resolved);
    const diffTotal = round2(unresolved.reduce((sum, c) => sum + c.diff, 0));
    const unconfirmed = s.pendingEntries.filter(
      (e) => e.kind === "sale" || e.kind === "refund",
    );
    const unconfirmedControl = s.pendingEntries.filter(
      (e) => e.kind === "review" || e.kind === "close" || e.kind === "resolve",
    );

    // 复核必须晚于最后一笔销售/退款，否则补录到达后旧复核自动失效
    const txEntries = s.entries.filter((e) => e.kind === "sale" || e.kind === "refund");
    const lastTx = lastByTs(txEntries);
    const reviewValid = Boolean(review) && (!lastTx || review!.ts >= lastTx.ts);

    // 关账生效必须满足（全部基于流水，确定性可重放）：
    //  - 复核有效（晚于最后一笔业务），关账晚于复核；
    //  - 不存在未裁决冲突，且最后一次裁决不晚于关账；
    //  - 关账时刻之后没有新的销售/退款；
    //  - 当班销售/退款均已确认。
    // 断网补录一旦带出未裁决冲突或新交易，旧关账自动失效，需重新关账。
    let closed = false;
    if (close) {
      const laterTx = s.entries.some(
        (e) =>
          (e.kind === "sale" || e.kind === "refund") &&
          e.ts > close.ts,
      );
      closed =
        reviewValid &&
        review!.ts <= close.ts &&
        unresolved.length === 0 &&
        conflicts.every((c) => {
          const r = s.resolutions.get(c.key);
          return r ? r.ts <= close.ts : false;
        }) &&
        !laterTx &&
        unconfirmed.length === 0;
    }

    const blockReasons: string[] = [];
    if (!review) {
      blockReasons.push(
        unconfirmedControl.some((e) => e.kind === "review")
          ? "复核流水断网暂存，重连确认后生效"
          : "班次尚未复核",
      );
    } else if (!reviewValid) blockReasons.push("补录后需重新复核");
    if (unresolved.length > 0) {
      blockReasons.push(
        unconfirmedControl.some((e) => e.kind === "resolve")
          ? `还有 ${unresolved.length} 笔待核差异（裁决待确认）`
          : `还有 ${unresolved.length} 笔待核差异`,
      );
    }
    if (unconfirmed.length > 0) blockReasons.push(`${unconfirmed.length} 笔流水尚未确认`);
    if (close && !closed && blockReasons.length === 0) {
      blockReasons.push("补录后需重新关账");
    }

    views.push({
      id: s.id,
      date: s.date,
      type: s.type,
      openedAt: s.openedAt,
      reviewed: reviewValid,
      reviewedAt: reviewValid ? review!.ts : null,
      reviewedBy: reviewValid ? review!.deviceId : null,
      closed,
      closedAt: closed && close ? close.ts : null,
      closedBy: closed && close ? close.deviceId : null,
      entries: s.entries,
      pendingEntries: s.pendingEntries,
      acceptedEntryIds: accepted,
      idempotentDupIds: idempotentDups,
      conflicts,
      unresolvedCount: unresolved.length,
      diffTotal,
      cashNet: round2(cashNet),
      digitalNet: round2(digitalNet),
      litersNet: round2(litersNet),
      status: closed ? "closed" : reviewValid ? "reviewed" : "open",
      statusLabel: closed ? "已关账" : reviewValid ? "已复核" : "待复核",
      canClose: blockReasons.length === 0,
      blockReasons,
    });
  }

  views.sort((a, b) => (a.date === b.date ? a.type.localeCompare(b.type) : a.date < b.date ? 1 : -1));

  const stats: LedgerView["stats"] = {
    entryCount: ordered.length,
    pendingCount: ordered.filter((e) => !e.confirmedAt).length,
    pendingAmount: round2(
      ordered
        .filter((e) => !e.confirmedAt && (e.kind === "sale" || e.kind === "refund"))
        .reduce((sum, e) => sum + Number(e.amount ?? 0), 0),
    ),
    conflictCount: views.reduce((n, s) => n + s.conflicts.length, 0),
    unresolvedCount: views.reduce((n, s) => n + s.unresolvedCount, 0),
    diffTotal: round2(views.reduce((n, s) => n + s.diffTotal, 0)),
    openCount: views.filter((s) => s.status === "open").length,
    reviewedCount: views.filter((s) => s.status === "reviewed").length,
    closedCount: views.filter((s) => s.status === "closed").length,
  };

  return { shifts: views, stats };
}

function lastByTs(list: JournalEntry[]): JournalEntry | null {
  return list.reduce<JournalEntry | null>(
    (last, e) => (!last || e.ts >= last.ts ? e : last),
    null,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
