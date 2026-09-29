<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  appendEvent,
  buildLedgerView,
  confirmPendingEvents,
  loadRegisterSetting,
  makeShiftId,
  REGISTERS,
  replayLedger,
  runLegacyMigration,
  saveRegisterSetting,
  type ConflictGroup,
  type LedgerEvent,
  type LedgerView,
  type MigrationState,
  type ReviewResult,
  type ShiftKind
} from "./ledger";

const currentRegister = ref(loadRegisterSetting());
const online = ref(navigator.onLine);
const ledger = ref<LedgerView>(replayLedger());
const migration = ref<MigrationState | null>(null);
const feedback = ref("");
const conflictChoice = reactive<Record<string, string>>({});

const today = new Date().toISOString().slice(0, 10);
const shiftForm = reactive({ date: today, kind: "早班" as ShiftKind, note: "" });
const transactionForm = reactive({
  type: "sale" as "sale" | "refund",
  shiftId: "",
  voucher: "",
  refVoucher: "",
  cashAmount: 0,
  digitalAmount: 0,
  liters: 0,
  note: ""
});
const reviewForm = reactive<{ shiftId: string; result: ReviewResult; note: string }>({
  shiftId: "",
  result: "账实一致",
  note: ""
});

const openShifts = computed(() => ledger.value.shifts.filter((shift) => !shift.closed));
const totalCash = computed(() => ledger.value.shifts.reduce((sum, shift) => sum + shift.cashTotal, 0));
const totalDigital = computed(() => ledger.value.shifts.reduce((sum, shift) => sum + shift.digitalTotal, 0));
const totalLiters = computed(() => ledger.value.shifts.reduce((sum, shift) => sum + shift.litersTotal, 0));

const currencyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 2
});

const numberFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2
});

function money(value: number) {
  return currencyFormatter.format(value);
}

function liters(value: number) {
  return `${numberFormatter.format(value)} L`;
}

function formatTime(value: string | null) {
  if (!value) return "未确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function eventLabel(type: LedgerEvent["type"]) {
  if (type === "sale") return "销售";
  if (type === "refund") return "退款";
  if (type === "review") return "复核";
  if (type === "resolution") return "核账";
  if (type === "shift-open") return "开班";
  return "关班";
}

function refreshLedger() {
  ledger.value = replayLedger();
}

function startMigration() {
  migration.value = runLegacyMigration();
}

function appendCommon(partial: Omit<Parameters<typeof appendEvent>[0], "machineId" | "machineName" | "businessAt" | "confirmedAt">) {
  const time = new Date().toISOString();
  return appendEvent({
    ...partial,
    machineId: currentRegister.value.machineId,
    machineName: currentRegister.value.machineName,
    businessAt: time,
    confirmedAt: online.value ? time : null
  });
}

function resetTransactionForm() {
  transactionForm.type = "sale";
  transactionForm.shiftId = openShifts.value[0]?.id ?? "";
  transactionForm.voucher = "";
  transactionForm.refVoucher = "";
  transactionForm.cashAmount = 0;
  transactionForm.digitalAmount = 0;
  transactionForm.liters = 0;
  transactionForm.note = "";
}

function openShift() {
  const shiftId = makeShiftId(shiftForm.date, shiftForm.kind);
  const existing = ledger.value.shifts.find((shift) => shift.id === shiftId);
  if (existing?.closed) {
    feedback.value = "该班次已关班，不能重复开班。";
    return;
  }
  appendCommon({
    type: "shift-open",
    shiftId,
    shiftDate: shiftForm.date,
    shiftKind: shiftForm.kind,
    note: shiftForm.note || `${currentRegister.value.machineName}开班`
  });
  shiftForm.note = "";
  feedback.value = "开班流水已写入。";
  refreshLedger();
}

function submitTransaction() {
  if (!transactionForm.shiftId) {
    feedback.value = "请选择要入账的班次。";
    return;
  }
  const cash = Math.max(0, Number(transactionForm.cashAmount) || 0);
  const digital = Math.max(0, Number(transactionForm.digitalAmount) || 0);
  const fuelLiters = Math.max(0, Number(transactionForm.liters) || 0);
  if (cash + digital <= 0) {
    feedback.value = "现金和电子支付至少填写一项金额。";
    return;
  }
  if (transactionForm.type === "sale" && fuelLiters <= 0) {
    feedback.value = "销售必须填写油品升数。";
    return;
  }
  if (transactionForm.type === "refund" && !transactionForm.refVoucher.trim()) {
    feedback.value = "退款必须填写原销售凭证号。";
    return;
  }

  const datePart = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const voucher =
    transactionForm.voucher.trim() ||
    (transactionForm.type === "refund"
      ? `R-${transactionForm.refVoucher.trim()}`
      : `S-${datePart}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`);

  appendCommon({
    type: transactionForm.type,
    shiftId: transactionForm.shiftId,
    voucher,
    refVoucher: transactionForm.type === "refund" ? transactionForm.refVoucher.trim() : undefined,
    cashAmount: cash,
    digitalAmount: digital,
    liters: transactionForm.type === "sale" ? fuelLiters : fuelLiters,
    note: transactionForm.note
  });

  feedback.value = online.value
    ? `${eventLabel(transactionForm.type)}已确认并入账。`
    : "网络断开，流水保存在本机，重连后按流水合并。";
  resetTransactionForm();
  refreshLedger();
}

function submitReview() {
  if (!reviewForm.shiftId) {
    feedback.value = "请选择要复核的班次。";
    return;
  }
  appendCommon({
    type: "review",
    shiftId: reviewForm.shiftId,
    reviewResult: reviewForm.result,
    note: reviewForm.note || reviewForm.result
  });
  reviewForm.shiftId = "";
  reviewForm.note = "";
  feedback.value = online.value ? "复核流水已确认。" : "复核已暂存本机，重连确认后生效。";
  refreshLedger();
}

function closeShift(shiftId: string) {
  const shift = ledger.value.shifts.find((item) => item.id === shiftId);
  if (!shift || !shift.canClose) return;
  appendCommon({
    type: "shift-close",
    shiftId,
    note: "复核、待核与待确认流水均已清空，执行关班"
  });
  feedback.value = online.value ? "关班流水已确认。" : "关班申请暂存本机，重连确认后关闭。";
  refreshLedger();
}

function resolveConflict(conflict: ConflictGroup) {
  if (!online.value) {
    feedback.value = "离线时不能做最终核账，请先重连确认流水。";
    return;
  }
  const chosenEventId = conflictChoice[conflict.id];
  if (!chosenEventId) {
    feedback.value = "请选择待核区中保留的一方金额。";
    return;
  }
  appendCommon({
    type: "resolution",
    shiftId: conflict.shiftId,
    conflictId: conflict.id,
    chosenEventId,
    note: "站长按双方流水核账"
  });
  delete conflictChoice[conflict.id];
  feedback.value = "核账结论已作为不可变流水保存。";
  refreshLedger();
}

function setOnline(value: boolean) {
  if (online.value === value) return;
  online.value = value;
  if (value) {
    const count = confirmPendingEvents();
    feedback.value = count > 0 ? `已确认 ${count} 笔本机暂存流水，并完成重放合并。` : "网络已恢复，账本已重放。";
    refreshLedger();
  } else {
    feedback.value = "已切换为断网模式，新增流水先保存在本机。";
  }
}

function changeRegister(machineId: string) {
  const register = REGISTERS.find((item) => item.machineId === machineId);
  if (!register) return;
  currentRegister.value = register;
  saveRegisterSetting(register);
  feedback.value = `当前录入终端：${register.machineName}。`;
  refreshLedger();
}

function handleStorage(event: StorageEvent) {
  if (event.key?.startsWith("dfwlfront-7-shift-ledger-v2")) refreshLedger();
}

onMounted(() => {
  startMigration();
  const recoveredCount = online.value ? confirmPendingEvents() : 0;
  refreshLedger();
  transactionForm.shiftId = openShifts.value[0]?.id ?? "";
  reviewForm.shiftId = openShifts.value[0]?.id ?? "";
  if (recoveredCount > 0) {
    feedback.value = `检测到 ${recoveredCount} 笔崩溃或断网后未确认流水，已确认并重放合并。`;
  }
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("storage", handleStorage);
});

onUnmounted(() => {
  window.removeEventListener("storage", handleStorage);
});
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 可重放班次账本</p>
          <h1>加油站班次交接</h1>
          <p class="subtitle">
            销售、退款、复核与关班全部按本机流水追加；崩溃重启或网络恢复后重放合并，同凭证金额冲突进入待核区。
          </p>
        </div>
        <div class="terminal-box">
          <label>
            当前收银机
            <select :value="currentRegister.machineId" @change="changeRegister(($event.target as HTMLSelectElement).value)">
              <option v-for="register in REGISTERS" :key="register.machineId" :value="register.machineId">
                {{ register.machineName }}
              </option>
            </select>
          </label>
          <label class="switch-label">
            <input v-model="online" type="checkbox" @change="setOnline(online)" />
            <span :class="['network-dot', online ? 'online' : 'offline']"></span>
            {{ online ? "网络在线" : "断网暂存" }}
          </label>
        </div>
      </header>

      <section v-if="migration && migration.status !== 'completed'" class="migration-banner" :class="migration.status">
        <template v-if="migration.status === 'running'">
          旧数组升级中：{{ migration.source }} {{ migration.done }}/{{ migration.total }}。
          升级事件已逐条落盘，中断后再次打开会从第 {{ migration.lastIndex + 1 }} 条旧记录继续，已写入的流水不会重复。
        </template>
        <template v-else>
          旧数组升级中断：{{ migration.error }}。原始旧数组未覆盖，修复后刷新页面即可继续。
        </template>
      </section>
      <p v-if="feedback" class="feedback">{{ feedback }}</p>

      <section class="metrics">
        <article class="metric">
          <span>未关班次</span>
          <strong>{{ ledger.openShiftCount }}</strong>
        </article>
        <article class="metric">
          <span>待复核班次</span>
          <strong>{{ ledger.unreviewedCount }}</strong>
        </article>
        <article class="metric">
          <span>现金 / 电子 / 升数</span>
          <strong class="metric-stack">{{ money(totalCash) }} · {{ money(totalDigital) }} · {{ liters(totalLiters) }}</strong>
        </article>
        <article class="metric" :class="{ warning: ledger.conflicts.length > 0 }">
          <span>待核金额差异 / 本机待传</span>
          <strong>{{ money(ledger.totalUnresolvedMoneyDiff) }} / {{ money(ledger.pendingMoney) }}</strong>
        </article>
      </section>

      <section class="workspace">
        <div class="form-column">
          <form class="panel" @submit.prevent="openShift">
            <h2>开班</h2>
            <div class="form-grid">
              <label>
                营业日期
                <input v-model="shiftForm.date" type="date" required />
              </label>
              <label>
                班次
                <select v-model="shiftForm.kind">
                  <option>早班</option>
                  <option>中班</option>
                  <option>晚班</option>
                </select>
              </label>
              <label>
                开班备注
                <input v-model="shiftForm.note" placeholder="例如：泵码 12480" />
              </label>
              <button type="submit">写入开班流水</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitTransaction">
            <h2>油款 / 退款</h2>
            <div class="form-grid">
              <label>
                类型
                <select v-model="transactionForm.type">
                  <option value="sale">销售</option>
                  <option value="refund">退款</option>
                </select>
              </label>
              <label>
                班次
                <select v-model="transactionForm.shiftId" required>
                  <option value="" disabled>请选择未关班次</option>
                  <option v-for="shift in openShifts" :key="shift.id" :value="shift.id">
                    {{ shift.date }} {{ shift.kind }}
                  </option>
                </select>
              </label>
              <label>
                {{ transactionForm.type === "sale" ? "销售凭证号（相同凭证用于重放去重）" : "退款凭证号（留空则按原销售号生成）" }}
                <input v-model="transactionForm.voucher" :placeholder="transactionForm.type === 'sale' ? '同笔油款两端请填同一凭证号' : '退款单号'" />
              </label>
              <label v-if="transactionForm.type === 'refund'">
                原销售凭证号
                <input v-model="transactionForm.refVoucher" placeholder="必填，关联原销售" required />
              </label>
              <div class="two-fields">
                <label>
                  现金
                  <input v-model.number="transactionForm.cashAmount" type="number" min="0" step="0.01" required />
                </label>
                <label>
                  电子支付
                  <input v-model.number="transactionForm.digitalAmount" type="number" min="0" step="0.01" required />
                </label>
              </div>
              <label>
                油品升数
                <input v-model.number="transactionForm.liters" type="number" min="0" step="0.001" />
              </label>
              <label>
                备注
                <textarea v-model="transactionForm.note" placeholder="油品、枪号或退款原因" />
              </label>
              <button type="submit">写入本机流水</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitReview">
            <h2>班次复核</h2>
            <div class="form-grid">
              <label>
                班次
                <select v-model="reviewForm.shiftId" required>
                  <option value="" disabled>请选择班次</option>
                  <option v-for="shift in openShifts" :key="shift.id" :value="shift.id">
                    {{ shift.date }} {{ shift.kind }}
                  </option>
                </select>
              </label>
              <label>
                复核结论
                <select v-model="reviewForm.result">
                  <option>账实一致</option>
                  <option>有差异</option>
                </select>
              </label>
              <label>
                复核说明
                <textarea v-model="reviewForm.note" placeholder="站长或交接人说明" />
              </label>
              <button type="submit">写入复核流水</button>
            </div>
          </form>
        </div>

        <div class="ledger-column">
          <section class="panel pending-panel">
            <div class="section-title">
              <h2>待核区</h2>
              <span>{{ ledger.conflicts.length }} 组冲突 · {{ ledger.pendingEvents.length }} 笔待确认</span>
            </div>

            <div v-if="ledger.pendingEvents.length" class="pending-uploads">
              <h3>本机待确认流水</h3>
              <div v-for="event in ledger.pendingEvents" :key="event.id" class="pending-line">
                <span>{{ event.machineName }} #{{ event.seq }} · {{ eventLabel(event.type) }} · {{ event.voucher || event.shiftId }}</span>
                <strong>{{ event.type === 'refund' ? '-' : '' }}{{ money((event.cashAmount ?? 0) + (event.digitalAmount ?? 0)) }}</strong>
                <em>录入 {{ formatTime(event.businessAt) }}</em>
              </div>
            </div>

            <div v-if="ledger.conflicts.length === 0 && ledger.pendingEvents.length === 0" class="empty">
              当前没有待确认流水或金额冲突
            </div>

            <article v-for="conflict in ledger.conflicts" :key="conflict.id" class="conflict-card">
              <div class="conflict-head">
                <div>
                  <h3>
                    {{ conflict.kind === "review" ? "复核冲突" : `${eventLabel(conflict.type)}冲突` }}
                    · {{ conflict.voucher }}
                  </h3>
                  <p v-if="conflict.refVoucher">原销售凭证：{{ conflict.refVoucher }}</p>
                </div>
                <span v-if="conflict.kind === 'financial'" class="diff-badge">
                  差异 {{ money(conflict.cashDiff + conflict.digitalDiff) }} / {{ liters(conflict.litersDiff) }}
                </span>
                <span v-else class="diff-badge">结论不一致</span>
              </div>
              <div v-if="conflict.resolutionConflict" class="resolution-warning">
                双方核账结论也不一致，已保留全部核账流水，请现场重新确认。
              </div>
              <label v-for="event in conflict.events" :key="event.id" class="conflict-choice">
                <input v-model="conflictChoice[conflict.id]" type="radio" :name="conflict.id" :value="event.id" />
                <span>
                  <strong>{{ event.machineName }} #{{ event.seq }}</strong>
                  <template v-if="conflict.kind === 'financial'">
                    确认 {{ formatTime(event.confirmedAt) }} · 现金 {{ money(event.cashAmount ?? 0) }} ·
                    电子 {{ money(event.digitalAmount ?? 0) }} · {{ liters(event.liters ?? 0) }}
                  </template>
                  <template v-else>
                    确认 {{ formatTime(event.confirmedAt) }} · 复核结论：{{ event.reviewResult }}
                    <em v-if="event.note">（{{ event.note }}）</em>
                  </template>
                </span>
              </label>
              <button type="button" :disabled="!online" @click="resolveConflict(conflict)">
                {{ online ? "按所选一方核账" : "重连后才能核账" }}
              </button>
            </article>
          </section>

          <section v-for="shift in ledger.shifts" :key="shift.id" class="panel shift-card">
            <header class="shift-head">
              <div>
                <h2>{{ shift.date }} {{ shift.kind }}</h2>
                <p>{{ shift.id }} · {{ shift.openingMachines.join("、") || "未识别开班终端" }}</p>
              </div>
              <div class="badges">
                <span :class="['badge', shift.closed ? 'closed' : shift.reviewed ? 'reviewed' : 'pending']">
                  {{ shift.closed ? "已关班" : shift.reviewed ? "已复核" : "待复核" }}
                </span>
                <span v-if="shift.pendingEvents.length" class="badge warn">待确认 {{ shift.pendingEvents.length }}</span>
                <span v-if="shift.conflicts.length" class="badge danger">待核 {{ shift.conflicts.length }}</span>
              </div>
            </header>

            <div class="shift-metrics">
              <div>
                <span>现金净额</span>
                <strong :class="{ negative: shift.cashTotal < 0 }">{{ money(shift.cashTotal) }}</strong>
              </div>
              <div>
                <span>电子支付净额</span>
                <strong :class="{ negative: shift.digitalTotal < 0 }">{{ money(shift.digitalTotal) }}</strong>
              </div>
              <div>
                <span>油品净升数</span>
                <strong :class="{ negative: shift.litersTotal < 0 }">{{ liters(shift.litersTotal) }}</strong>
              </div>
              <div :class="{ unresolved: shift.conflicts.length }">
                <span>待核差异</span>
                <strong>{{ money(shift.unresolvedCashDiff + shift.unresolvedDigitalDiff) }}</strong>
                <small>升数差 {{ liters(shift.unresolvedLitersDiff) }}</small>
              </div>
            </div>

            <div v-if="shift.currentReview" class="review-line">
              最近复核：{{ shift.currentReview.reviewResult }} · {{ shift.currentReview.machineName }} #{{ shift.currentReview.seq }}
              · 确认 {{ formatTime(shift.currentReview.confirmedAt) }}
              <em v-if="shift.currentReview.note">{{ shift.currentReview.note }}</em>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>本机流水</th>
                    <th>类型</th>
                    <th>凭证</th>
                    <th>现金</th>
                    <th>电子</th>
                    <th>升数</th>
                    <th>确认时刻</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="line in shift.transactions" :key="line.event.id">
                    <td>{{ line.event.machineName }} #{{ line.event.seq }}</td>
                    <td>{{ eventLabel(line.event.type) }}</td>
                    <td>
                      {{ line.event.voucher }}
                      <small v-if="line.duplicates > 1 && line.resolvedConflict"> · 收到 {{ line.duplicates }} 份，已核账保留</small>
                      <small v-else-if="line.duplicates > 1"> · 已合并 {{ line.duplicates }} 份相同流水</small>
                      <small v-if="line.event.refVoucher"><br />退：{{ line.event.refVoucher }}</small>
                    </td>
                    <td :class="{ negative: line.event.type === 'refund' }">{{ money(line.event.cashAmount ?? 0) }}</td>
                    <td :class="{ negative: line.event.type === 'refund' }">{{ money(line.event.digitalAmount ?? 0) }}</td>
                    <td :class="{ negative: line.event.type === 'refund' }">{{ liters(line.event.liters ?? 0) }}</td>
                    <td>{{ formatTime(line.event.confirmedAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="shift.pendingEvents.length" class="shift-pending">
              <h3>待确认（暂不计入上方净额）</h3>
              <p v-for="event in shift.pendingEvents" :key="event.id">
                {{ event.machineName }} #{{ event.seq }} {{ eventLabel(event.type) }} ·
                {{ event.type === 'refund' ? '-' : '' }}{{ money((event.cashAmount ?? 0) + (event.digitalAmount ?? 0)) }} ·
                录入 {{ formatTime(event.businessAt) }}
              </p>
            </div>

            <footer class="shift-actions">
              <span v-if="shift.closed" class="closed-note">
                关班：{{ shift.closeEvent?.machineName }} #{{ shift.closeEvent?.seq }}，{{ formatTime(shift.closeEvent?.confirmedAt ?? null) }}
              </span>
              <span v-else-if="!shift.canClose" class="blocked-note">不能关班：{{ shift.blockedReason }}</span>
              <button v-else type="button" @click="closeShift(shift.id)">关班</button>
            </footer>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
