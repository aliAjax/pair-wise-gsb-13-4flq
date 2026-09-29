<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useLedger } from "./ledger/store";
import { Resolution, ShiftType, ShiftView } from "./ledger/types";
import { clockOf, liters, money, timeOf, today } from "./ledger/format";

const ledger = useLedger();
const { view, currentDevice, offline, migration } = ledger;

const SHIFT_TYPES: readonly ShiftType[] = ["早班", "中班", "晚班"];

const filter = ref<"全部班次" | ShiftType>("全部班次");
const expanded = ref<string | null>(null);
const toast = ref("");

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function flash(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2600);
}

const form = reactive({
  date: today(),
  shiftType: "中班" as ShiftType,
  kind: "sale" as "sale" | "refund",
  orderNo: "",
  amount: 0,
  liters: 0,
  payMethod: "cash" as "cash" | "digital",
  note: "",
});

function submitEntry() {
  if (!form.orderNo.trim()) {
    flash("请填写业务单号（油枪单号 / 退款单号）");
    return;
  }
  const params = {
    date: form.date,
    shiftType: form.shiftType,
    orderNo: form.orderNo.trim(),
    amount: Number(form.amount) || 0,
    liters: Number(form.liters) || 0,
    payMethod: form.payMethod,
    note: form.note || undefined,
  };
  if (form.kind === "sale") ledger.addSale(params);
  else ledger.addRefund(params);
  flash(
    `${form.kind === "sale" ? "销售" : "退款"}已记入 ${currentDevice.value} 流水` +
      (offline.value ? "（断网暂存，待重连确认）" : ""),
  );
  form.orderNo = "";
  form.amount = 0;
  form.liters = 0;
  form.note = "";
}

function reconnect() {
  const n = ledger.confirmPending();
  flash(n > 0 ? `重连完成，${currentDevice.value} 补确认 ${n} 笔流水` : "当前设备没有待确认流水");
}

const filteredShifts = computed(() =>
  filter.value === "全部班次"
    ? view.value.shifts
    : view.value.shifts.filter((s) => s.type === filter.value),
);

const unresolvedConflicts = computed(() =>
  view.value.shifts.flatMap((s) => s.conflicts.filter((c) => !c.resolved).map((c) => ({ shift: s, c }))),
);

function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id;
}

function resolve(shift: ShiftView, key: string, resolution: Resolution) {
  ledger.resolveConflict(key, shift.id, resolution);
  flash("裁决已作为流水入账，重放后账目自动更新");
}

function review(shift: ShiftView) {
  ledger.review(shift.date, shift.type, "站长复核通过");
  flash("复核流水已入账");
}

function close(shift: ShiftView) {
  if (!shift.canClose) return;
  ledger.closeShift(shift.date, shift.type);
  flash("关账流水已入账");
}

const statusClass: Record<string, string> = {
  open: "st-open",
  reviewed: "st-reviewed",
  closed: "st-closed",
};

const resolutionLabel: Record<Resolution, string> = {
  keepFirst: "采用甲机金额",
  keepSecond: "采用乙机金额",
  dropAll: "两笔均剔除",
};

const pendingA = computed(() => ledger.pendingOf("REG-A"));
const pendingB = computed(() => ledger.pendingOf("REG-B"));
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">可重放班次账本 · 双机交接 / 断网补录</p>
          <h1>加油站班次交接台账</h1>
          <p class="subtitle">
            每笔销售、退款、复核均为本机只追加流水，带 (设备, 流水号) 与确认时刻；
            重连或重启后按流水合并重放，金额冲突进入待核区并保留双方金额。
          </p>
        </div>
        <div class="device-box">
          <div class="device-switch">
            <button
              v-for="d in ledger.DEVICES"
              :key="d"
              type="button"
              :class="['dev', currentDevice === d ? 'active' : '']"
              @click="ledger.switchDevice(d)"
            >
              {{ d === "REG-A" ? "甲机 REG-A" : "乙机 REG-B" }}
            </button>
          </div>
          <label class="net">
            <input type="checkbox" :checked="offline" @change="ledger.setOffline(($event.target as HTMLInputElement).checked)" />
            <span :class="offline ? 'off' : 'on'">{{ offline ? "● 断网暂存中" : "● 在线" }}</span>
          </label>
          <button class="secondary reconnect" type="button" :disabled="!offline" @click="reconnect">
            模拟重连并补确认
          </button>
        </div>
      </header>

      <div v-if="migration" class="migration">
        <strong>旧版数组升级：</strong>
        共 {{ migration.state.total }} 条旧记录，已升级 {{ migration.state.checkpoint }} 条，
        生成 {{ migration.migratedCount }} 条流水；
        <span v-if="migration.state.done">升级完成（原数据已备份为 legacy-backup，升级中断可从断点继续）。</span>
        <span v-else>升级中断，下次打开自动续迁。</span>
      </div>

      <section class="metrics">
        <article class="metric">
          <span>在班 / 已复核 / 已关账</span>
          <strong>{{ view.stats.openCount }} / {{ view.stats.reviewedCount }} / {{ view.stats.closedCount }}</strong>
        </article>
        <article class="metric">
          <span>待确认流水（断网暂存）</span>
          <strong>{{ view.stats.pendingCount }} 笔</strong>
          <small>金额 {{ money(view.stats.pendingAmount) }} · 甲 {{ pendingA.length }} / 乙 {{ pendingB.length }}</small>
        </article>
        <article class="metric" :class="{ alarm: view.stats.unresolvedCount > 0 }">
          <span>待核差异</span>
          <strong>{{ view.stats.unresolvedCount }} 笔</strong>
          <small>差异合计 {{ money(view.stats.diffTotal) }}</small>
        </article>
      </section>

      <section v-if="unresolvedConflicts.length" class="conflict-banner">
        <h2>待核区（{{ unresolvedConflicts.length }}）</h2>
        <div v-for="{ shift, c } in unresolvedConflicts" :key="c.key" class="conflict">
          <div class="conflict-main">
            <p class="conflict-title">{{ c.title }}</p>
            <p class="conflict-meta">{{ shift.date }} {{ shift.type }} · {{ c.type }}</p>
            <div class="sides">
              <div class="side">
                <span class="who">甲机 {{ c.sideA?.deviceId }}#{{ c.sideA?.seq }}</span>
                <strong>{{ c.sideA ? money(c.sideA.amount) : "—" }}</strong>
                <small v-if="c.sideA?.liters">升数 {{ c.sideA.liters }}L</small>
                <small>{{ c.sideA ? c.sideA.payMethod === "digital" ? "电子支付" : "现金" : "" }}</small>
              </div>
              <div class="vs">VS<br />差 {{ money(c.diff) }}</div>
              <div class="side">
                <span class="who">乙机 {{ c.sideB?.deviceId }}#{{ c.sideB?.seq }}</span>
                <strong>{{ c.sideB ? money(c.sideB.amount) : "—" }}</strong>
                <small v-if="c.sideB?.liters">升数 {{ c.sideB.liters }}L</small>
                <small>{{ c.sideB ? c.sideB.payMethod === "digital" ? "电子支付" : "现金" : "" }}</small>
              </div>
            </div>
          </div>
          <div class="conflict-actions">
            <button type="button" :disabled="!c.sideA" @click="resolve(shift, c.key, 'keepFirst')">采用甲机</button>
            <button type="button" :disabled="!c.sideB" @click="resolve(shift, c.key, 'keepSecond')">采用乙机</button>
            <button class="danger" type="button" @click="resolve(shift, c.key, 'dropAll')">两笔剔除</button>
          </div>
        </div>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submitEntry">
          <h2>本机记账</h2>
          <p class="panel-hint">流水将以 {{ currentDevice }} #{{ ledger.nextSeqOf(currentDevice) }} 入账</p>
          <div class="form-grid">
            <div class="row2">
              <label>
                类型
                <select v-model="form.kind">
                  <option value="sale">销售（油款）</option>
                  <option value="refund">退款</option>
                </select>
              </label>
              <label>
                班次
                <select v-model="form.shiftType">
                  <option v-for="t in SHIFT_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </label>
            </div>
            <label>
              业务日期
              <input type="date" v-model="form.date" required />
            </label>
            <label>
              业务单号（油枪 / 退款单号）
              <input v-model="form.orderNo" placeholder="如 O-1003，双方同号即同一笔" required />
            </label>
            <div class="row2">
              <label>
                金额（元）
                <input type="number" step="0.01" min="0" v-model.number="form.amount" required />
              </label>
              <label>
                油品升数（销售）
                <input type="number" step="0.01" min="0" v-model.number="form.liters" />
              </label>
            </div>
            <label>
              收款方式
              <select v-model="form.payMethod">
                <option value="cash">现金</option>
                <option value="digital">电子支付</option>
              </select>
            </label>
            <label>
              备注
              <textarea v-model="form.note" placeholder="油号 / 退款原因 / 交接说明" />
            </label>
            <button type="submit">记入本机流水</button>
            <p v-if="offline" class="warn">当前断网：流水先存本机、确认时刻留空，重连后补确认并合并。</p>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>班次账本</h2>
            <select v-model="filter">
              <option>全部班次</option>
              <option v-for="t in SHIFT_TYPES" :key="t">{{ t }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredShifts.length === 0" class="empty">暂无班次，先在左侧记一笔销售开班</div>
            <article v-for="shift in filteredShifts" :key="shift.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ shift.date }} {{ shift.type }}</p>
                <span :class="['status', statusClass[shift.status]]">{{ shift.statusLabel }}</span>
              </div>

              <div class="totals">
                <div><span>现金净额</span><strong>{{ money(shift.cashNet) }}</strong></div>
                <div><span>电子支付净额</span><strong>{{ money(shift.digitalNet) }}</strong></div>
                <div><span>油品升数</span><strong>{{ liters(shift.litersNet) }}</strong></div>
                <div :class="{ alarm: shift.unresolvedCount > 0 }">
                  <span>待核差异</span>
                  <strong>{{ shift.unresolvedCount }} 笔 / {{ money(shift.diffTotal) }}</strong>
                </div>
              </div>

              <div class="meta-line">
                <span>开班 {{ timeOf(shift.openedAt) }}</span>
                <span>复核 {{ shift.reviewedAt ? timeOf(shift.reviewedAt) + " " + shift.reviewedBy : "未复核" }}</span>
                <span>关账 {{ shift.closedAt ? timeOf(shift.closedAt) + " " + shift.closedBy : "未关账" }}</span>
                <span>流水 {{ shift.entries.length }} 条</span>
              </div>

              <div class="actions">
                <button type="button" class="secondary" @click="toggle(shift.id)">
                  {{ expanded === shift.id ? "收起流水" : "查看本机流水" }}
                </button>
                <button type="button" :disabled="shift.reviewed" @click="review(shift)">
                  {{ shift.reviewed ? "已复核" : "复核本班次" }}
                </button>
                <button
                  type="button"
                  :disabled="!shift.canClose"
                  :title="shift.canClose ? '关账' : shift.blockReasons.join('；')"
                  @click="close(shift)"
                >
                  关账
                </button>
              </div>
              <p v-if="!shift.canClose" class="block-reasons">
                关账受限：{{ shift.blockReasons.join("；") }}
              </p>

              <div v-if="expanded === shift.id" class="journal">
                <table>
                  <thead>
                    <tr>
                      <th>本机流水</th><th>类型</th><th>单号</th><th>金额</th><th>方式</th><th>业务时刻</th><th>确认时刻</th><th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="e in [...shift.entries].sort((a, b) =>
                        a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1)"
                      :key="e.deviceId + '#' + e.seq"
                      :class="{ pending: !e.confirmedAt, dup: shift.idempotentDupIds.has(e.deviceId + '#' + e.seq) }"
                    >
                      <td class="mono">{{ e.deviceId }}#{{ e.seq }}</td>
                      <td>{{ { sale: "销售", refund: "退款", review: "复核", resolve: "裁决", close: "关账", open: "开班" }[e.kind] }}</td>
                      <td>{{ e.orderNo || "—" }}</td>
                      <td>{{ e.amount != null ? money((e.kind === "refund" ? -1 : 1) * e.amount) : "—" }}</td>
                      <td>{{ e.payMethod === "digital" ? "电子" : e.payMethod === "cash" ? "现金" : "—" }}</td>
                      <td>{{ timeOf(e.ts) }}</td>
                      <td :class="e.confirmedAt ? '' : 'unconfirmed'">{{ clockOf(e.confirmedAt) }}</td>
                      <td>{{ e.note || (e.resolution ? resolutionLabel[e.resolution] : "") }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="shift.pendingEntries.length" class="warn">
                  {{ shift.pendingEntries.length }} 条流水尚未确认（断网暂存），重连补确认后参与关账校验。
                </p>
              </div>
            </article>
          </div>
        </section>
      </section>

      <div v-if="toast" class="toast">{{ toast }}</div>
    </div>
  </main>
</template>
