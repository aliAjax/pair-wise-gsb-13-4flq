// 可重放班次账本的领域模型：
// 账本里只有"流水"，班次、金额、冲突全部由流水重放派生，从不整体覆盖。

export type DeviceId = "REG-A" | "REG-B" | "LEGACY";
export type ShiftType = "早班" | "中班" | "晚班";
export type PayMethod = "cash" | "digital";

// sale=销售  refund=退款  review=复核  resolve=待核裁决  close=关账  open=开班
export type EntryKind = "sale" | "refund" | "review" | "resolve" | "close" | "open";

export type ConflictType =
  // 同一业务单号两边录了不同金额
  | "saleMismatch"
  // 同一笔退款两边金额不一致
  | "refundDup"
  // 退款累计超过对应销售
  | "refundExceed"
  // 退款找不到对应销售
  | "refundOrphan";

export type Resolution = "keepFirst" | "keepSecond" | "dropAll";

/**
 * 一条本机流水。
 * (deviceId, seq) 是全局唯一、永不复用的身份，也是重放去重的依据。
 * ts 为业务发生时刻，confirmedAt 为进入共享账本的确认时刻；
 * 断网暂存时 confirmedAt 为 null，重连后补确认。
 */
export interface JournalEntry {
  deviceId: DeviceId;
  seq: number;
  ts: string;
  confirmedAt: string | null;
  kind: EntryKind;
  shiftId: string;
  amount?: number;
  liters?: number;
  payMethod?: PayMethod;
  orderNo?: string;
  note?: string;
  shiftType?: ShiftType;
  shiftDate?: string;
  // resolve 流水
  conflictKey?: string;
  resolution?: Resolution;
  operator?: string;
}

export interface ConflictSide {
  entryId: string;
  deviceId: DeviceId;
  seq: number;
  amount: number;
  liters?: number;
  payMethod?: PayMethod;
  ts: string;
}

export interface Conflict {
  key: string;
  shiftId: string;
  type: ConflictType;
  orderNo: string;
  title: string;
  sideA: ConflictSide | null;
  sideB: ConflictSide | null;
  // 待核差异金额（元）
  diff: number;
  resolved: boolean;
  resolution?: Resolution;
  resolvedBy?: DeviceId;
  resolvedEntryId?: string;
  // 被识别为同一笔业务的重复补录（金额一致），自动按一笔合并
  idempotent: boolean;
  extraCount: number;
}

export interface ShiftView {
  id: string;
  date: string;
  type: ShiftType;
  openedAt: string | null;
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedBy: DeviceId | null;
  closed: boolean;
  closedAt: string | null;
  closedBy: DeviceId | null;
  entries: JournalEntry[];
  pendingEntries: JournalEntry[];
  acceptedEntryIds: Set<string>;
  idempotentDupIds: Set<string>;
  conflicts: Conflict[];
  unresolvedCount: number;
  diffTotal: number;
  cashNet: number;
  digitalNet: number;
  litersNet: number;
  status: "open" | "reviewed" | "closed";
  statusLabel: string;
  canClose: boolean;
  blockReasons: string[];
}

export interface LedgerStats {
  entryCount: number;
  pendingCount: number;
  pendingAmount: number;
  conflictCount: number;
  unresolvedCount: number;
  diffTotal: number;
  openCount: number;
  reviewedCount: number;
  closedCount: number;
}

export interface LedgerView {
  shifts: ShiftView[];
  stats: LedgerStats;
}

export interface MigrationState {
  total: number;
  checkpoint: number;
  interrupted: boolean;
  done: boolean;
  startedAt: string;
  finishedAt: string | null;
}

export function shiftIdOf(date: string, type: ShiftType): string {
  return `${date}#${type}`;
}

export function parseShiftId(id: string): { date: string; type: ShiftType } {
  const idx = id.lastIndexOf("#");
  return { date: id.slice(0, idx), type: id.slice(idx + 1) as ShiftType };
}

export function entryIdOf(deviceId: DeviceId, seq: number): string {
  return `${deviceId}#${seq}`;
}
