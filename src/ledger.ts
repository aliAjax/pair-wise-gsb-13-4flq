export type ShiftKind = "早班" | "中班" | "晚班";
export type PaymentAmounts = {
  cashAmount: number;
  digitalAmount: number;
  liters: number;
};
export type FinancialEventType = "sale" | "refund";
export type LedgerEventType =
  | "shift-open"
  | FinancialEventType
  | "review"
  | "resolution"
  | "shift-close";
export type ReviewResult = "账实一致" | "有差异";

export type LedgerEvent = {
  id: string;
  machineId: string;
  machineName: string;
  seq: number;
  type: LedgerEventType;
  createdAt: string;
  businessAt: string;
  confirmedAt: string | null;
  shiftId: string;
  shiftDate?: string;
  shiftKind?: ShiftKind;
  voucher?: string;
  refVoucher?: string;
  cashAmount?: number;
  digitalAmount?: number;
  liters?: number;
  note?: string;
  reviewResult?: ReviewResult;
  conflictId?: string;
  chosenEventId?: string;
  migrated?: boolean;
};

export type NewLedgerEvent = Omit<LedgerEvent, "id" | "seq" | "createdAt">;

export type RegisterInfo = {
  machineId: string;
  machineName: string;
};

export type MigrationState = {
  status: "running" | "completed" | "failed";
  source: "旧版数组" | "内置示例";
  total: number;
  done: number;
  lastIndex: number;
  lastStage: number;
  updatedAt: string;
  error?: string;
};

type LegacyRecord = {
  id?: unknown;
  shift?: unknown;
  fuelSales?: unknown;
  cash?: unknown;
  digital?: unknown;
  status?: unknown;
  notes?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
};

export const REGISTERS: RegisterInfo[] = [
  { machineId: "register-a", machineName: "收银机 A" },
  { machineId: "register-b", machineName: "收银机 B" }
];

const OLD_STORAGE_KEY = "dfwlfront-7-shift";
const BASE_STORAGE_KEY = "dfwlfront-7-shift-ledger-v2";
const SETTINGS_KEY = `${BASE_STORAGE_KEY}:settings`;
const MIGRATION_KEY = `${BASE_STORAGE_KEY}:migration`;
const EVENT_KEY_PREFIX = `${BASE_STORAGE_KEY}:event:`;

const SEED_LEGACY_RECORDS: LegacyRecord[] = [
  {
    shift: "早班",
    fuelSales: 4280,
    cash: 8300,
    digital: 21000,
    status: "已复核",
    notes: "账实一致"
  },
  {
    shift: "中班",
    fuelSales: 3910,
    cash: 6400,
    digital: 19800,
    status: "待复核",
    notes: "等待站长确认"
  }
];

function nowIso() {
  return new Date().toISOString();
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T): T {
  return safeParse<T>(localStorage.getItem(key)) ?? fallback;
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function eventStorageKey(event: Pick<LedgerEvent, "machineId" | "seq">) {
  return `${EVENT_KEY_PREFIX}${event.machineId}:${event.seq}`;
}

function asFiniteNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeAmounts(event: LedgerEvent): PaymentAmounts {
  return {
    cashAmount: asFiniteNumber(event.cashAmount),
    digitalAmount: asFiniteNumber(event.digitalAmount),
    liters: asFiniteNumber(event.liters)
  };
}

function signedAmounts(event: LedgerEvent): PaymentAmounts {
  const amounts = normalizeAmounts(event);
  const sign = event.type === "refund" ? -1 : 1;
  return {
    cashAmount: amounts.cashAmount * sign,
    digitalAmount: amounts.digitalAmount * sign,
    liters: amounts.liters * sign
  };
}

function isValidEvent(event: Partial<LedgerEvent> | null | undefined): event is LedgerEvent {
  if (!event) return false;
  return Boolean(
    event.id &&
      event.machineId &&
      event.machineName &&
      typeof event.seq === "number" &&
      event.type &&
      event.createdAt &&
      event.businessAt &&
      "confirmedAt" in event &&
      event.shiftId
  );
}

export function loadRegisterSetting(): RegisterInfo {
  const saved = readJson<Partial<RegisterInfo>>(SETTINGS_KEY, {});
  const found = REGISTERS.find((item) => item.machineId === saved.machineId);
  return found ?? REGISTERS[0];
}

export function saveRegisterSetting(register: RegisterInfo) {
  writeJson(SETTINGS_KEY, register);
}

export function scanEvents(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(EVENT_KEY_PREFIX)) continue;
    const event = safeParse<Partial<LedgerEvent>>(localStorage.getItem(key));
    if (isValidEvent(event) && eventStorageKey(event) === key) {
      events.push(event);
    }
  }
  return events.sort((a, b) => a.businessAt.localeCompare(b.businessAt) || a.id.localeCompare(b.id));
}

function putEvent(event: LedgerEvent) {
  localStorage.setItem(eventStorageKey(event), JSON.stringify(event));
}

export function appendEvent(input: NewLedgerEvent): LedgerEvent {
  let nextSeq = 1;
  for (const event of scanEvents()) {
    if (event.machineId === input.machineId) {
      nextSeq = Math.max(nextSeq, event.seq + 1);
    }
  }

  let event: LedgerEvent;
  let attempts = 0;
  do {
    event = {
      ...input,
      id: `${input.machineId}:${nextSeq}`,
      seq: nextSeq,
      createdAt: nowIso()
    };
    attempts += 1;
    nextSeq += 1;
  } while (localStorage.getItem(eventStorageKey(event)) && attempts < 100);

  if (localStorage.getItem(eventStorageKey(event))) {
    throw new Error("本机流水号连续冲突，请刷新后重试");
  }
  putEvent(event);
  return event;
}

export function confirmPendingEvents(confirmedAt = nowIso()): number {
  const pending = scanEvents().filter((event) => event.confirmedAt === null);
  pending.forEach((event) => {
    putEvent({ ...event, confirmedAt });
  });
  return pending.length;
}

function legacyNumber(record: LegacyRecord, key: "fuelSales" | "cash" | "digital") {
  return Math.max(0, asFiniteNumber(record[key]));
}

function readLegacyRecords(): { records: LegacyRecord[]; source: MigrationState["source"] } | { error: string } {
  const raw = localStorage.getItem(OLD_STORAGE_KEY);
  if (raw === null) {
    return { records: SEED_LEGACY_RECORDS, source: "内置示例" };
  }
  const parsed = safeParse<LegacyRecord[]>(raw);
  if (!Array.isArray(parsed)) {
    return { error: "旧版数组无法解析，已保留原始数据，请修复后继续升级。" };
  }
  return { records: parsed, source: "旧版数组" };
}

function migrationEvent(
  seq: number,
  part: Omit<LedgerEvent, "id" | "machineId" | "machineName" | "seq" | "createdAt" | "migrated">
): LedgerEvent {
  return {
    ...part,
    id: `legacy-migration:${seq}`,
    machineId: "legacy-migration",
    machineName: "旧账升级",
    seq,
    createdAt: part.businessAt,
    migrated: true
  };
}

function writeMigrationEvent(event: LedgerEvent) {
  const key = eventStorageKey(event);
  if (localStorage.getItem(key)) return;
  putEvent(event);
}

type MigrationStep = {
  stage: number;
  event: LedgerEvent;
};

function migrationSteps(record: LegacyRecord, index: number): MigrationStep[] {
  const safeId = String(record.id ?? index + 1).replace(/[^a-zA-Z0-9_-]/g, "-") || String(index + 1);
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : nowIso();
  const shiftDate = createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const shiftKind = (record.shift === "中班" || record.shift === "晚班" ? record.shift : "早班") as ShiftKind;
  const shiftId = `legacy-${safeId}`;
  const baseSeq = index * 4;
  const cash = legacyNumber(record, "cash");
  const digital = legacyNumber(record, "digital");
  const liters = legacyNumber(record, "fuelSales");
  const note = typeof record.notes === "string" ? record.notes : "";
  const steps: MigrationStep[] = [
    {
      stage: 0,
      event: migrationEvent(baseSeq + 1, {
        type: "shift-open",
        businessAt: createdAt,
        confirmedAt: createdAt,
        shiftId,
        shiftDate,
        shiftKind,
        note: "由旧版台账升级"
      })
    },
    {
      stage: 1,
      event: migrationEvent(baseSeq + 2, {
        type: "sale",
        businessAt: createdAt,
        confirmedAt: createdAt,
        shiftId,
        shiftDate,
        shiftKind,
        voucher: `LEGACY-${safeId}`,
        cashAmount: cash,
        digitalAmount: digital,
        liters,
        note
      })
    }
  ];

  if (record.status === "已复核" || record.status === "有差异") {
    steps.push({
      stage: 2,
      event: migrationEvent(baseSeq + 3, {
        type: "review",
        businessAt: createdAt,
        confirmedAt: createdAt,
        shiftId,
        reviewResult: record.status === "有差异" ? "有差异" : "账实一致",
        note: note || "旧版复核记录"
      })
    });
  }

  return steps;
}

function saveMigrationState(state: MigrationState) {
  state.updatedAt = nowIso();
  writeJson(MIGRATION_KEY, state);
}

export function runLegacyMigration(): MigrationState {
  const existing = readJson<MigrationState | null>(MIGRATION_KEY, null);
  if (existing?.status === "completed") return existing;

  const loaded = readLegacyRecords();
  if ("error" in loaded) {
    const failed: MigrationState = {
      status: "failed",
      source: existing?.source ?? "旧版数组",
      total: existing?.total ?? 0,
      done: existing?.done ?? 0,
      lastIndex: existing?.lastIndex ?? -1,
      lastStage: existing?.lastStage ?? -1,
      updatedAt: nowIso(),
      error: loaded.error
    };
    writeJson(MIGRATION_KEY, failed);
    return failed;
  }

  const state: MigrationState = existing ?? {
    status: "running",
    source: loaded.source,
    total: loaded.records.length,
    done: 0,
    lastIndex: -1,
    lastStage: -1,
    updatedAt: nowIso()
  };
  state.status = "running";
  state.total = loaded.records.length;
  state.error = undefined;
  saveMigrationState(state);

  for (let index = Math.max(0, state.lastIndex); index < loaded.records.length; index += 1) {
    const steps = migrationSteps(loaded.records[index], index);
    for (const step of steps) {
      if (index === state.lastIndex && step.stage <= state.lastStage) continue;
      state.lastIndex = index;
      state.lastStage = step.stage;
      state.done = index;
      saveMigrationState(state);
      writeMigrationEvent(step.event);
    }
    state.lastIndex = index;
    state.lastStage = steps[steps.length - 1].stage;
    state.done = index + 1;
    saveMigrationState(state);
  }

  state.status = "completed";
  state.lastIndex = loaded.records.length - 1;
  state.done = loaded.records.length;
  saveMigrationState(state);
  return state;
}

export type ConflictGroup = {
  id: string;
  kind: "financial" | "review";
  shiftId: string;
  type: LedgerEventType;
  voucher: string;
  refVoucher?: string;
  events: LedgerEvent[];
  cashDiff: number;
  digitalDiff: number;
  litersDiff: number;
  chosenEventId: string | null;
  resolutionConflict: boolean;
  resolutions: LedgerEvent[];
};

export type TransactionLine = {
  event: LedgerEvent;
  duplicates: number;
  resolvedConflict: boolean;
};

export type ShiftView = {
  id: string;
  date: string;
  kind: ShiftKind | "未知班次";
  openedAt: string | null;
  openingMachines: string[];
  transactions: TransactionLine[];
  reviews: LedgerEvent[];
  currentReview: LedgerEvent | null;
  closeEvent: LedgerEvent | null;
  cashTotal: number;
  digitalTotal: number;
  litersTotal: number;
  pendingEvents: LedgerEvent[];
  pendingCash: number;
  pendingDigital: number;
  pendingLiters: number;
  conflicts: ConflictGroup[];
  unresolvedCashDiff: number;
  unresolvedDigitalDiff: number;
  unresolvedLitersDiff: number;
  reviewed: boolean;
  closed: boolean;
  canClose: boolean;
  blockedReason: string;
};

export type LedgerView = {
  events: LedgerEvent[];
  shifts: ShiftView[];
  pendingEvents: LedgerEvent[];
  conflicts: ConflictGroup[];
  openShiftCount: number;
  unreviewedCount: number;
  totalUnresolvedMoneyDiff: number;
  pendingMoney: number;
};

function eventTime(event: LedgerEvent) {
  return event.confirmedAt ?? event.businessAt;
}

function sortByTime(events: LedgerEvent[]) {
  return [...events].sort((a, b) => eventTime(a).localeCompare(eventTime(b)) || a.id.localeCompare(b.id));
}

function financialGroupKey(event: LedgerEvent) {
  return `${event.type}:${event.shiftId}:${event.voucher ?? ""}`;
}

function financialSignature(event: LedgerEvent) {
  const amounts = normalizeAmounts(event);
  return [
    event.type,
    event.shiftId,
    event.voucher ?? "",
    event.refVoucher ?? "",
    amounts.liters.toFixed(3),
    amounts.cashAmount.toFixed(2),
    amounts.digitalAmount.toFixed(2)
  ].join("|");
}

function difference(values: number[]) {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

function parseShiftId(id: string): { date: string; kind: ShiftView["kind"] } {
  const match = id.match(/^(\d{4}-\d{2}-\d{2})-(早班|中班|晚班)$/);
  if (match) return { date: match[1], kind: match[2] as ShiftKind };
  return { date: id, kind: "未知班次" };
}

export function buildLedgerView(eventsInput: LedgerEvent[]): LedgerView {
  const events = [...eventsInput].sort(
    (a, b) => a.businessAt.localeCompare(b.businessAt) || a.id.localeCompare(b.id)
  );
  const confirmedEvents = events.filter((event) => event.confirmedAt !== null);
  const pendingEvents = events.filter((event) => event.confirmedAt === null);

  const financialGroups = new Map<string, LedgerEvent[]>();
  const reviewGroups = new Map<string, LedgerEvent[]>();
  for (const event of confirmedEvents) {
    if (event.type === "sale" || event.type === "refund") {
      const key = financialGroupKey(event);
      const group = financialGroups.get(key) ?? [];
      group.push(event);
      financialGroups.set(key, group);
    } else if (event.type === "review") {
      const group = reviewGroups.get(event.shiftId) ?? [];
      group.push(event);
      reviewGroups.set(event.shiftId, group);
    }
  }

  const resolutionGroups = new Map<string, LedgerEvent[]>();
  for (const event of confirmedEvents) {
    if (event.type !== "resolution" || !event.conflictId) continue;
    const group = resolutionGroups.get(event.conflictId) ?? [];
    group.push(event);
    resolutionGroups.set(event.conflictId, group);
  }

  const acceptedByGroup = new Map<string, { event: LedgerEvent; resolvedConflict: boolean }>();
  const acceptedReviews = new Map<string, LedgerEvent>();
  const conflicts: ConflictGroup[] = [];

  for (const [key, groupEvents] of financialGroups) {
    const group = sortByTime(groupEvents);
    const signatures = new Set(group.map(financialSignature));
    const resolutions = sortByTime(resolutionGroups.get(`conflict:${key}`) ?? []);
    const chosenIds = [...new Set(resolutions.map((event) => event.chosenEventId).filter(Boolean))] as string[];
    const resolutionConflict = chosenIds.length > 1;
    const chosenEventId = !resolutionConflict && chosenIds.length === 1 ? chosenIds[0] : null;
    const chosenEvent = chosenEventId ? group.find((event) => event.id === chosenEventId) : undefined;
    const hasConflict = group.length > 1 && signatures.size > 1;

    if (hasConflict) {
      const cashValues = group.map((event) => normalizeAmounts(event).cashAmount);
      const digitalValues = group.map((event) => normalizeAmounts(event).digitalAmount);
      const litersValues = group.map((event) => normalizeAmounts(event).liters);
      conflicts.push({
        id: `conflict:${key}`,
        kind: "financial",
        shiftId: group[0].shiftId,
        type: group[0].type,
        voucher: group[0].voucher ?? "",
        refVoucher: group[0].refVoucher,
        events: group,
        cashDiff: difference(cashValues),
        digitalDiff: difference(digitalValues),
        litersDiff: difference(litersValues),
        chosenEventId: chosenEvent ? chosenEvent.id : null,
        resolutionConflict,
        resolutions
      });
    }

    if (!hasConflict) {
      acceptedByGroup.set(key, { event: group[0], resolvedConflict: false });
    } else if (chosenEvent) {
      acceptedByGroup.set(key, { event: chosenEvent, resolvedConflict: true });
    }
  }

  for (const [shiftId, groupEvents] of reviewGroups) {
    const group = sortByTime(groupEvents);
    const results = new Set(group.map((event) => event.reviewResult));
    const conflictId = `conflict:review:${shiftId}`;
    const resolutions = sortByTime(resolutionGroups.get(conflictId) ?? []);
    const chosenIds = [...new Set(resolutions.map((event) => event.chosenEventId).filter(Boolean))] as string[];
    const resolutionConflict = chosenIds.length > 1;
    const chosenEventId = !resolutionConflict && chosenIds.length === 1 ? chosenIds[0] : null;
    const chosenEvent = chosenEventId ? group.find((event) => event.id === chosenEventId) : undefined;
    const hasConflict = group.length > 1 && results.size > 1;

    if (hasConflict) {
      conflicts.push({
        id: conflictId,
        kind: "review",
        shiftId,
        type: "review",
        voucher: "班次复核",
        events: group,
        cashDiff: 0,
        digitalDiff: 0,
        litersDiff: 0,
        chosenEventId: chosenEvent ? chosenEvent.id : null,
        resolutionConflict,
        resolutions
      });
    }

    if (!hasConflict) {
      acceptedReviews.set(shiftId, group[group.length - 1]);
    } else if (chosenEvent) {
      acceptedReviews.set(shiftId, chosenEvent);
    }
  }

  const shiftMap = new Map<string, ShiftView & { openingMachineSet: Set<string> }>();

  function ensureShift(id: string): ShiftView & { openingMachineSet: Set<string> } {
    let shift = shiftMap.get(id);
    if (!shift) {
      const parsed = parseShiftId(id);
      shift = {
        id,
        date: parsed.date,
        kind: parsed.kind,
        openedAt: null,
        openingMachineSet: new Set<string>(),
        openingMachines: [],
        transactions: [],
        reviews: [],
        currentReview: null,
        closeEvent: null,
        cashTotal: 0,
        digitalTotal: 0,
        litersTotal: 0,
        pendingEvents: [],
        pendingCash: 0,
        pendingDigital: 0,
        pendingLiters: 0,
        conflicts: [],
        unresolvedCashDiff: 0,
        unresolvedDigitalDiff: 0,
        unresolvedLitersDiff: 0,
        reviewed: false,
        closed: false,
        canClose: false,
        blockedReason: ""
      };
      shiftMap.set(id, shift);
    }
    return shift;
  }

  for (const event of confirmedEvents) {
    if (event.type === "shift-open") {
      const shift = ensureShift(event.shiftId);
      shift.date = event.shiftDate ?? shift.date;
      shift.kind = event.shiftKind ?? shift.kind;
      shift.openingMachineSet.add(event.machineName);
      if (!shift.openedAt || eventTime(event) < shift.openedAt) {
        shift.openedAt = eventTime(event);
      }
    } else if (event.type === "sale" || event.type === "refund") {
      ensureShift(event.shiftId);
    } else if (event.type === "review") {
      ensureShift(event.shiftId);
    } else if (event.type === "shift-close") {
      ensureShift(event.shiftId);
    }
  }

  for (const event of pendingEvents) {
    ensureShift(event.shiftId);
  }

  for (const [key, accepted] of acceptedByGroup) {
    const { event, resolvedConflict } = accepted;
    const shift = ensureShift(event.shiftId);
    const group = financialGroups.get(key) ?? [];
    const amounts = signedAmounts(event);
    shift.cashTotal += amounts.cashAmount;
    shift.digitalTotal += amounts.digitalAmount;
    shift.litersTotal += amounts.liters;
    shift.transactions.push({ event, duplicates: group.length, resolvedConflict });
  }

  for (const event of confirmedEvents) {
    if (event.type !== "review") continue;
    const shift = ensureShift(event.shiftId);
    shift.reviews.push(event);
  }

  const closeEvents = confirmedEvents
    .filter((event) => event.type === "shift-close")
    .sort((a, b) => eventTime(a).localeCompare(eventTime(b)));
  for (const event of closeEvents) {
    const shift = ensureShift(event.shiftId);
    if (!shift.closeEvent) shift.closeEvent = event;
  }

  for (const event of pendingEvents) {
    const shift = ensureShift(event.shiftId);
    shift.pendingEvents.push(event);
    if (event.type === "sale" || event.type === "refund") {
      const amounts = signedAmounts(event);
      shift.pendingCash += amounts.cashAmount;
      shift.pendingDigital += amounts.digitalAmount;
      shift.pendingLiters += amounts.liters;
    }
  }

  for (const conflict of conflicts) {
    if (conflict.chosenEventId) continue;
    const shift = ensureShift(conflict.shiftId);
    shift.conflicts.push(conflict);
    shift.unresolvedCashDiff += conflict.cashDiff;
    shift.unresolvedDigitalDiff += conflict.digitalDiff;
    shift.unresolvedLitersDiff += conflict.litersDiff;
  }

  const shifts = [...shiftMap.values()].map((shift) => {
    shift.openingMachines = [...shift.openingMachineSet];
    shift.transactions.sort(
      (a, b) => eventTime(b.event).localeCompare(eventTime(a.event)) || b.event.id.localeCompare(a.event.id)
    );
    shift.reviews.sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
    shift.pendingEvents.sort((a, b) => b.businessAt.localeCompare(a.businessAt));
    shift.currentReview = acceptedReviews.get(shift.id) ?? null;
    shift.reviewed = Boolean(shift.currentReview);
    shift.closed = Boolean(shift.closeEvent);
    if (!shift.reviewed) shift.blockedReason = "班次尚未复核";
    else if (shift.conflicts.length > 0) shift.blockedReason = "仍有冲突未核";
    else if (shift.pendingEvents.length > 0) shift.blockedReason = "仍有流水未确认";
    else shift.blockedReason = "";
    shift.canClose = !shift.closed && shift.reviewed && shift.conflicts.length === 0 && shift.pendingEvents.length === 0;
    return shift;
  });

  shifts.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  const unresolvedConflicts = conflicts.filter((conflict) => !conflict.chosenEventId);
  return {
    events,
    shifts,
    pendingEvents: sortByTime(pendingEvents).reverse(),
    conflicts: unresolvedConflicts,
    openShiftCount: shifts.filter((shift) => !shift.closed).length,
    unreviewedCount: shifts.filter((shift) => !shift.reviewed).length,
    totalUnresolvedMoneyDiff: unresolvedConflicts.reduce(
      (sum, conflict) => sum + conflict.cashDiff + conflict.digitalDiff,
      0
    ),
    pendingMoney: shifts.reduce((sum, shift) => sum + Math.abs(shift.pendingCash + shift.pendingDigital), 0)
  };
}

export function replayLedger(): LedgerView {
  return buildLedgerView(scanEvents());
}

export function makeShiftId(date: string, kind: ShiftKind) {
  return `${date}-${kind}`;
}
