// 账本存储：只追加（append-only）的本机流水 + 重放视图。
// 两台收银机在同一浏览器中用"当前设备"切换模拟；各自的 seq 单调递增、
// 绝不复用。断网时流水照常落账（confirmedAt=null），重连时批量补确认。

import { computed, reactive, ref } from "vue";
import {
  DeviceId,
  JournalEntry,
  MigrationState,
  PayMethod,
  Resolution,
  ShiftType,
  shiftIdOf,
  entryIdOf,
} from "./types";
import { replay } from "./replay";
import { runMigration } from "./migration";

const JOURNAL_KEY = "dfwlfront-ledger.journal.v1";
const DEVICE_KEY = "dfwlfront-ledger.device";

interface JournalEnvelope {
  version: 1;
  entries: JournalEntry[];
  seq: Record<DeviceId, number>;
  seeded: boolean;
}

const DEVICES: DeviceId[] = ["REG-A", "REG-B"];

function emptyEnvelope(): JournalEnvelope {
  return {
    version: 1,
    entries: [],
    seq: { "REG-A": 0, "REG-B": 0, LEGACY: 0 },
    seeded: false,
  };
}

function loadEnvelope(): JournalEnvelope {
  const raw = localStorage.getItem(JOURNAL_KEY);
  if (!raw) return emptyEnvelope();
  try {
    const env = JSON.parse(raw) as JournalEnvelope;
    return {
      version: 1,
      entries: Array.isArray(env.entries) ? env.entries : [],
      seq: Object.assign({ "REG-A": 0, "REG-B": 0, LEGACY: 0 }, env.seq ?? {}),
      seeded: Boolean(env.seeded),
    };
  } catch {
    return emptyEnvelope();
  }
}

// ---- 演示种子：覆盖交接时最常见的三种局面 ----
// 1) 两台机器录同一笔油款，金额一致 -> 幂等合并；
// 2) 同一笔双方金额不一致 -> 待核区，双方金额都在；
// 3) 同一笔退款夜班断网后被两台机器重复补回，金额不一致 -> 待核区。
// 时间统一锚定在"当前时刻之前"，保证打开页面后复核/关账时刻晚于全部业务流水。
function seedEntries(env: JournalEnvelope) {
  const base = Date.now();
  const at = (minusMinutes: number) => new Date(base - minusMinutes * 60000).toISOString();
  const openTs = at(7 * 60);
  const day = openTs.slice(0, 10);
  const shift = shiftIdOf(day, "中班");

  const add = (
    deviceId: DeviceId,
    kind: JournalEntry["kind"],
    ts: string,
    extra: Partial<JournalEntry>,
  ) => {
    env.seq[deviceId] += 1;
    env.entries.push({
      deviceId,
      seq: env.seq[deviceId],
      ts,
      confirmedAt: ts,
      kind,
      shiftId: shift,
      ...extra,
    });
  };

  add("REG-A", "open", openTs, { shiftType: "中班", shiftDate: day });
  add("REG-B", "open", openTs, { shiftType: "中班", shiftDate: day });

  // 同一笔 92# 油款，两边都录了 300 元（电子支付）-> 幂等合并
  add("REG-A", "sale", at(6 * 60 + 39), {
    orderNo: "O-1001", amount: 300, liters: 40.5, payMethod: "digital", note: "92#",
  });
  add("REG-B", "sale", at(6 * 60 + 40), {
    orderNo: "O-1001", amount: 300, liters: 40.5, payMethod: "digital", note: "92# 交接同步",
  });
  // 现金油款双方金额不一致：A 录 260，B 录 250 -> 待核
  add("REG-A", "sale", at(5 * 60 + 54), {
    orderNo: "O-1002", amount: 260, liters: 34.2, payMethod: "cash", note: "95#",
  });
  add("REG-B", "sale", at(5 * 60 + 55), {
    orderNo: "O-1002", amount: 250, liters: 34.2, payMethod: "cash", note: "95#",
  });

  // 夜班断网，退款被两台机器重复补回且金额不一致 -> 待核
  add("REG-A", "refund", at(48), {
    orderNo: "O-1001", amount: 80, payMethod: "digital", note: "客户投诉退差，断网补录",
  });
  add("REG-B", "refund", at(50), {
    orderNo: "O-1001", amount: 60, payMethod: "digital", note: "断网补录同一笔退款",
  });

  env.seeded = true;
}

const envelope = reactive<JournalEnvelope>(loadEnvelope());
const currentDevice = ref<DeviceId>(
  (localStorage.getItem(DEVICE_KEY) as DeviceId) === "REG-B" ? "REG-B" : "REG-A",
);
const offline = ref(false);
const migration = ref<{ state: MigrationState; migratedCount: number } | null>(null);

// 首次启动：先迁移旧数组，再（全新环境）植入演示种子
(function bootstrap() {
  const progress = runMigration();
  if (progress) {
    migration.value = { state: progress.state, migratedCount: progress.migrated.length };
    for (const e of progress.migrated) appendEntry(e, { persist: false, assignSeq: false });
    persist();
  }
  if (envelope.entries.length === 0 && !envelope.seeded) {
    seedEntries(envelope);
    persist();
  }
})();

function persist() {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(envelope));
}

interface AppendOptions {
  persist?: boolean;
  assignSeq?: boolean;
}

/** 追加一条流水。默认分配当前设备的下一个本机流水号。 */
function appendEntry(input: JournalEntry, options: AppendOptions = {}) {
  const { assignSeq = true, persist: shouldPersist = true } = options;
  if (assignSeq) {
    envelope.seq[input.deviceId] += 1;
    input.seq = envelope.seq[input.deviceId];
  } else if (input.seq > envelope.seq[input.deviceId]) {
    envelope.seq[input.deviceId] = input.seq;
  }
  envelope.entries.push(input);
  if (shouldPersist) persist();
}

function nowIso() {
  return new Date().toISOString();
}

function appendBusiness(
  kind: "sale" | "refund",
  params: {
    date: string;
    shiftType: ShiftType;
    orderNo: string;
    amount: number;
    liters: number;
    payMethod: PayMethod;
    note?: string;
    ts?: string;
  },
): JournalEntry {
  const ts = params.ts ?? nowIso();
  const entry: JournalEntry = {
    deviceId: currentDevice.value,
    seq: 0,
    ts,
    // 断网时本地先记账但无确认时刻；重连后由 confirmPeding 补
    confirmedAt: offline.value ? null : ts,
    kind,
    shiftId: shiftIdOf(params.date, params.shiftType),
    shiftType: params.shiftType,
    shiftDate: params.date,
    orderNo: params.orderNo,
    amount: params.amount,
    liters: kind === "sale" ? params.liters : 0,
    payMethod: params.payMethod,
    note: params.note,
  };
  appendEntry(entry);
  return entry;
}

const view = computed(() => replay(envelope.entries));

export function useLedger() {
  return {
    DEVICES,
    envelope,
    view,
    currentDevice,
    offline,
    migration,

    switchDevice(device: DeviceId) {
      currentDevice.value = device;
      localStorage.setItem(DEVICE_KEY, device);
    },

    setOffline(value: boolean) {
      offline.value = value;
    },

    addSale(params: Parameters<typeof appendBusiness>[1]) {
      return appendBusiness("sale", params);
    },

    addRefund(params: Parameters<typeof appendBusiness>[1]) {
      return appendBusiness("refund", params);
    },

    /** 重连：恢复在线，把本机所有未确认流水补上确认时刻（模拟服务端确认回收） */
    confirmPending(): number {
      offline.value = false;
      const now = nowIso();
      let n = 0;
      for (const e of envelope.entries) {
        if (e.deviceId === currentDevice.value && !e.confirmedAt) {
          e.confirmedAt = now;
          n += 1;
        }
      }
      if (n > 0) persist();
      return n;
    },

    pendingOf(device: DeviceId) {
      return envelope.entries.filter((e) => e.deviceId === device && !e.confirmedAt);
    },

    review(date: string, shiftType: ShiftType, note?: string) {
      const ts = nowIso();
      appendEntry({
        deviceId: currentDevice.value,
        seq: 0,
        ts,
        confirmedAt: offline.value ? null : ts,
        kind: "review",
        shiftId: shiftIdOf(date, shiftType),
        note,
      });
    },

    resolveConflict(conflictKey: string, shiftId: string, resolution: Resolution) {
      const ts = nowIso();
      appendEntry({
        deviceId: currentDevice.value,
        seq: 0,
        ts,
        confirmedAt: offline.value ? null : ts,
        kind: "resolve",
        shiftId,
        conflictKey,
        resolution,
        note: `裁决：${resolution}`,
      });
    },

    closeShift(date: string, shiftType: ShiftType) {
      const ts = nowIso();
      appendEntry({
        deviceId: currentDevice.value,
        seq: 0,
        ts,
        confirmedAt: offline.value ? null : ts,
        kind: "close",
        shiftId: shiftIdOf(date, shiftType),
        note: "班次关账",
      });
    },

    nextSeqOf(device: DeviceId) {
      return envelope.seq[device] + 1;
    },

    entryIdOf,
  };
}
