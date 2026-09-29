// 旧版数据（一个 JSON 数组直接整体覆盖）到流水账本的升级。
// 升级按"每条旧记录"为最小步骤，进度写入 migration checkpoint：
// 中途崩溃/关闭页面后再次打开，从 checkpoint 继续，不会重复或漏掉任何一条。

import { DeviceId, JournalEntry, MigrationState, ShiftType, shiftIdOf } from "./types";

export const LEGACY_KEY = "dfwlfront-7-shift";
export const LEGACY_BACKUP_KEY = "dfwlfront-7-shift.legacy-backup";
export const MIGRATION_KEY = "dfwlfront-ledger.migration";

export interface LegacyRecord {
  id?: string;
  shift?: string;
  fuelSales?: number | string;
  cash?: number | string;
  digital?: number | string;
  status?: string;
  notes?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface MigrationProgress {
  state: MigrationState;
  migrated: JournalEntry[];
  done: boolean;
}

interface MigrationEnvelope {
  source: typeof LEGACY_KEY;
  state: MigrationState;
  // 已升级出的流水（append 累积，崩溃后续迁不会重做）
  entries: JournalEntry[];
  // 已处理旧记录的 id / 下标，双重去重
  processed: string[];
}

function readLegacy(): LegacyRecord[] | null {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LegacyRecord[]) : null;
  } catch {
    return null;
  }
}

function loadEnvelope(total: number): MigrationEnvelope {
  const raw = localStorage.getItem(MIGRATION_KEY);
  if (raw) {
    try {
      const env = JSON.parse(raw) as MigrationEnvelope;
      if (env.source === LEGACY_KEY && Array.isArray(env.entries) && env.state?.total === total) {
        return env;
      }
    } catch {
    }
  }
  const now = new Date().toISOString();
  return {
    source: LEGACY_KEY,
    state: {
      total,
      checkpoint: 0,
      interrupted: false,
      done: false,
      startedAt: now,
      finishedAt: null,
    },
    entries: [],
    processed: [],
  };
}

function saveEnvelope(env: MigrationEnvelope) {
  localStorage.setItem(MIGRATION_KEY, JSON.stringify(env));
}

function dateOf(record: LegacyRecord, index: number): string {
  const ts = record.createdAt ? Date.parse(record.createdAt) : NaN;
  const d = Number.isFinite(ts) ? new Date(ts) : new Date(Date.now() - index * 86400000);
  return d.toISOString().slice(0, 10);
}

function typeOf(record: LegacyRecord): ShiftType {
  const v = String(record.shift ?? "早班");
  return (["早班", "中班", "晚班"] as const).includes(v as ShiftType)
    ? (v as ShiftType)
    : "早班";
}

/**
 * 把一条旧记录升级成若干流水。旧记录只有班次汇总值，因此映射为：
 * open（开班）+ 一笔现金销售 + 一笔电子销售 + 可选 review（复核）。
 * LEGACY 设备独占流水号段，seq 在该旧记录内固定，保证重复升级也产出同样的流水。
 */
export function convertRecord(record: LegacyRecord, index: number): JournalEntry[] {
  const date = dateOf(record, index);
  const type = typeOf(record);
  const shiftId = shiftIdOf(date, type);
  const ts = record.createdAt ?? new Date(`${date}T08:00:00`).toISOString();
  const deviceId: DeviceId = "LEGACY";
  const base = index * 10 + 1;
  const cash = Number(record.cash ?? 0) || 0;
  const digital = Number(record.digital ?? 0) || 0;
  const liters = Number(record.fuelSales ?? 0) || 0;

  const entries: JournalEntry[] = [
    {
      deviceId,
      seq: base,
      ts,
      confirmedAt: ts,
      kind: "open",
      shiftId,
      shiftType: type,
      shiftDate: date,
      note: "旧版台账升级生成",
    },
  ];

  if (cash > 0) {
    entries.push({
      deviceId,
      seq: base + 1,
      ts,
      confirmedAt: ts,
      kind: "sale",
      shiftId,
      orderNo: `LEGACY-CASH-${index + 1}`,
      amount: cash,
      liters: 0,
      payMethod: "cash",
      note: record.notes || "旧版现金收入汇总",
    });
  }
  if (digital > 0) {
    entries.push({
      deviceId,
      seq: base + 2,
      ts,
      confirmedAt: ts,
      kind: "sale",
      shiftId,
      orderNo: `LEGACY-DIGITAL-${index + 1}`,
      amount: digital,
      liters,
      payMethod: "digital",
      note: record.notes || "旧版电子支付与油品升数汇总",
    });
  }
  if (record.status === "已复核" || record.status === "有差异") {
    entries.push({
      deviceId,
      seq: base + 3,
      ts,
      confirmedAt: ts,
      kind: "review",
      shiftId,
      note: record.notes || (record.status === "有差异" ? "旧版标记为有差异" : "账实一致"),
    });
  }
  return entries;
}

/**
 * 执行（或继续）迁移。每处理一条旧记录立即落盘一次 checkpoint，
 * 因此任何时刻中断，下次都能从断点继续。
 * 返回 null 表示没有旧数据需要迁移。
 */
export function runMigration(): MigrationProgress | null {
  const legacy = readLegacy();
  if (legacy == null) return null;

  // 已完整迁移过：旧 key 已被改名备份，直接报告完成
  if (localStorage.getItem(LEGACY_KEY) == null && localStorage.getItem(LEGACY_BACKUP_KEY)) {
    const raw = localStorage.getItem(MIGRATION_KEY);
    if (raw) {
      const env = JSON.parse(raw) as MigrationEnvelope;
      return { state: env.state, migrated: env.entries, done: true };
    }
  }

  const env = loadEnvelope(legacy.length);
  env.state.interrupted = env.state.checkpoint > 0 && !env.state.done;

  for (let i = env.state.checkpoint; i < legacy.length; i++) {
    const record = legacy[i];
    const token = String(record.id ?? `idx:${i}`);
    if (!env.processed.includes(token)) {
      const produced = convertRecord(record, i);
      env.entries.push(...produced);
      env.processed.push(token);
    }
    env.state.checkpoint = i + 1;
    // 逐条落盘：崩溃后下一条未 checkpoint 的记录会被重做，
    // 但流水身份 (LEGACY, seq) 固定，重放时自然幂等。
    saveEnvelope(env);
  }

  env.state.done = true;
  env.state.finishedAt = new Date().toISOString();
  saveEnvelope(env);

  // 迁移成功后才把旧数组改名备份（保留可回滚），并清空原 key
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw != null) localStorage.setItem(LEGACY_BACKUP_KEY, raw);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 存储受限时迁移成果仍在 envelope 中，下次继续收尾
  }

  return { state: env.state, migrated: env.entries, done: true };
}

export function migrationStatus(): MigrationState | null {
  const raw = localStorage.getItem(MIGRATION_KEY);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as MigrationEnvelope).state;
  } catch {
    return null;
  }
}
