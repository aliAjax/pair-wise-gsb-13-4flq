// 纯逻辑验证脚本：node --loader tsx 不需要，直接用 vite 的 esbuild 转译后运行。
// 覆盖：幂等合并 / 双方冲突 / 退款不重扣 / 断网补录重放 / 关账约束 / 迁移续点。
import { replay } from "../src/ledger/replay";
import { JournalEntry, Resolution, shiftIdOf } from "../src/ledger/types";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

let seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
function entry(partial: Partial<JournalEntry> & Pick<JournalEntry, "kind" | "deviceId">): JournalEntry {
  seq[partial.deviceId!] += 1;
  return {
    seq: seq[partial.deviceId!],
    ts: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    shiftId: shiftId,
    ...partial,
  } as JournalEntry;
}

const date = "2026-09-29";
const shiftId = shiftIdOf(date, "晚班");

console.log("场景1：两台机器录同一笔销售，金额一致 → 幂等合并，只算一次");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t = new Date(`${date}T20:00:00`).toISOString();
  const journal = [
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-1", amount: 300, liters: 40, payMethod: "digital", ts: t }),
    entry({ deviceId: "REG-B", kind: "sale", shiftId, orderNo: "O-1", amount: 300, liters: 40, payMethod: "digital", ts: t }),
  ];
  const v = replay(journal);
  assert(v.shifts.length === 1, "只有一个班次");
  assert(v.shifts[0].digitalNet === 300, `电子净额 300（实际 ${v.shifts[0].digitalNet}）`);
  assert(v.shifts[0].litersNet === 40, `升数 40（实际 ${v.shifts[0].litersNet}）`);
  assert(v.shifts[0].conflicts.length === 0, "无冲突");
}

console.log("场景2：同一笔销售双方金额不一致 → 待核，双方金额保留，差异 10");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t = new Date(`${date}T20:05:00`).toISOString();
  const journal = [
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-2", amount: 260, liters: 34, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-B", kind: "sale", shiftId, orderNo: "O-2", amount: 250, liters: 34, payMethod: "cash", ts: t }),
  ];
  const v = replay(journal);
  const s = v.shifts[0];
  assert(s.conflicts.length === 1, "1 笔待核冲突");
  assert(s.conflicts[0].sideA?.amount === 260 && s.conflicts[0].sideB?.amount === 250, "双方金额分别为 260 / 250");
  assert(s.diffTotal === 10, `差异 10（实际 ${s.diffTotal}）`);
  assert(s.cashNet === 260, "未裁决时先按第一方 260 入账，第二方暂挂");
}

console.log("场景3：夜班断网，同一笔退款被两台机器重复补回且金额不同 → 不重扣");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t0 = new Date(`${date}T20:00:00`).toISOString();
  const t1 = new Date(`${date}T23:00:00`).toISOString();
  const journal = [
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t0, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-3", amount: 300, payMethod: "digital", ts: t0 }),
    entry({ deviceId: "REG-A", kind: "refund", shiftId, orderNo: "O-3", amount: 80, payMethod: "digital", ts: t1, confirmedAt: null }),
    entry({ deviceId: "REG-B", kind: "refund", shiftId, orderNo: "O-3", amount: 60, payMethod: "digital", ts: t1, confirmedAt: null }),
  ];
  const v = replay(journal);
  const s = v.shifts[0];
  assert(s.conflicts.some((c) => c.type === "refundDup"), "退款重复进待核区");
  assert(s.pendingEntries.length === 2, "两笔退款确认时刻为空");
  // 未裁决：只扣第一方 80，不会 80+60 重扣
  assert(s.digitalNet === 220, `净额 300-80=220（实际 ${s.digitalNet}）`);
}

console.log("场景4：重连后补确认 + 裁决 keepSecond，重放结果稳定");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t0 = new Date(`${date}T20:00:00`).toISOString();
  const t1 = new Date(`${date}T23:00:00`).toISOString();
  const now = new Date(`${date}T23:30:00`).toISOString();
  const mk = () => [
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t0, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-4", amount: 300, payMethod: "digital", ts: t0 }),
    entry({ deviceId: "REG-A", kind: "refund", shiftId, orderNo: "O-4", amount: 80, payMethod: "digital", ts: t1, confirmedAt: now }),
    entry({ deviceId: "REG-B", kind: "refund", shiftId, orderNo: "O-4", amount: 60, payMethod: "digital", ts: t1, confirmedAt: now }),
    entry({ deviceId: "REG-A", kind: "resolve", shiftId, conflictKey: `refund:${shiftId}:O-4`, resolution: "keepSecond" as Resolution, ts: now }),
  ];
  const base = mk();
  const v1 = replay(base);
  const v2 = replay([...base].reverse().concat(base)); // 重复+乱序输入
  const s = v1.shifts[0];
  assert(s.conflicts[0].resolved, "冲突已裁决");
  assert(s.digitalNet === 240, `采用乙方 60：300-60=240（实际 ${s.digitalNet}）`);
  assert(v2.shifts[0].digitalNet === 240, "重复/乱序流水重放结果一致（幂等可重放）");
  assert(v2.stats.entryCount === v1.stats.entryCount, "重复流水按 (设备,seq) 去重");
}

console.log("场景5：未复核 / 有未决冲突 / 有待确认 → 不能关账");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t = new Date(`${date}T20:00:00`).toISOString();
  // 5a 未复核直接关账
  const v1 = replay([
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-5", amount: 100, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-A", kind: "close", shiftId, ts: t }),
  ]);
  assert(v1.shifts[0].closed === false, "未复核不能关账");
  assert(!v1.shifts[0].canClose, "canClose=false 并给出原因");

  // 5b 复核但有未决冲突 → 不能关账
  const v2 = replay([
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-5", amount: 100, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-B", kind: "sale", shiftId, orderNo: "O-5", amount: 90, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-A", kind: "review", shiftId, ts: t }),
    entry({ deviceId: "REG-A", kind: "close", shiftId, ts: t }),
  ]);
  assert(v2.shifts[0].closed === false, "有待核差异不能关账");

  // 5c 全部解决后重新关账 → 生效；之后断网补录带出冲突 → 旧关账失效
  const resolveTs = new Date(`${date}T20:30:00`).toISOString();
  const closeTs = new Date(`${date}T20:40:00`).toISOString();
  const lateTs = new Date(`${date}T23:50:00`).toISOString();
  const base = [
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-5", amount: 100, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-B", kind: "sale", shiftId, orderNo: "O-5", amount: 90, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-A", kind: "review", shiftId, ts: t }),
    entry({ deviceId: "REG-A", kind: "resolve", shiftId, conflictKey: `sale:${shiftId}:O-5`, resolution: "keepFirst" as Resolution, ts: resolveTs }),
    entry({ deviceId: "REG-A", kind: "close", shiftId, ts: closeTs }),
  ];
  const v3 = replay(base);
  assert(v3.shifts[0].closed === true, "复核+裁决后关账生效");
  const v4 = replay([
    ...base,
    entry({ deviceId: "REG-B", kind: "refund", shiftId, orderNo: "O-5", amount: 50, payMethod: "cash", ts: lateTs }),
    entry({ deviceId: "REG-A", kind: "refund", shiftId, orderNo: "O-5", amount: 30, payMethod: "cash", ts: lateTs }),
  ]);
  assert(v4.shifts[0].closed === false, "关账后断网补录出新差异，旧关账自动失效");

  // 关账后补录一笔无冲突新交易：旧复核与旧关账都应失效，必须重新复核
  const v5 = replay([
    ...base,
    entry({ deviceId: "REG-B", kind: "sale", shiftId, orderNo: "O-7", amount: 70, payMethod: "digital", ts: lateTs }),
  ]);
  assert(v5.shifts[0].closed === false, "关账后到达新交易，旧关账失效");
  assert(v5.shifts[0].reviewed === false, "旧复核失效，状态回到待复核");
  assert(v5.shifts[0].blockReasons.some((r) => r.includes("重新复核")), "给出重新复核原因");
}

console.log("场景5b：同一设备对同一笔重复补录（崩溃后重试）→ 幂等不重复计");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t = new Date(`${date}T19:00:00`).toISOString();
  const sale = entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-8", amount: 200, liters: 26, payMethod: "cash", ts: t });
  // 同一流水副本（同 deviceId+seq）被重复合并（模拟崩溃重启后日志重放）
  const v = replay([
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    sale, { ...sale, confirmedAt: null }, { ...sale },
  ]);
  const s = v.shifts[0];
  assert(s.cashNet === 200, `同流水副本只计一次 200（实际 ${s.cashNet}）`);
  assert(s.litersNet === 26, "升数只计一次 26");
  assert(s.entries.length === 2, "(设备,seq) 去重后只剩开班+销售 2 条");
}

console.log("场景6：孤儿退款 / 超额退款进入待核");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t = new Date(`${date}T20:00:00`).toISOString();
  const v = replay([
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-6", amount: 100, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-A", kind: "refund", shiftId, orderNo: "O-6", amount: 150, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-A", kind: "refund", shiftId, orderNo: "O-9", amount: 20, payMethod: "cash", ts: t }),
  ]);
  const types = v.shifts[0].conflicts.map((c) => c.type);
  assert(types.includes("refundExceed"), "超额退款进待核");
  assert(types.includes("refundOrphan"), "孤儿退款进待核");
}

console.log("场景7：断网时做的复核/关账（无确认时刻）在补确认前不生效");
{
  seq = { "REG-A": 0, "REG-B": 0, LEGACY: 0 };
  const t = new Date(`${date}T20:00:00`).toISOString();
  const t1 = new Date(`${date}T20:30:00`).toISOString();
  const t2 = new Date(`${date}T20:40:00`).toISOString();
  const base = [
    entry({ deviceId: "REG-A", kind: "open", shiftId, ts: t, shiftType: "晚班", shiftDate: date }),
    entry({ deviceId: "REG-A", kind: "sale", shiftId, orderNo: "O-71", amount: 100, payMethod: "cash", ts: t }),
    entry({ deviceId: "REG-A", kind: "review", shiftId, ts: t1, confirmedAt: null }),
    entry({ deviceId: "REG-A", kind: "close", shiftId, ts: t2, confirmedAt: null }),
  ];
  const offline = replay(base);
  assert(offline.shifts[0].reviewed === false, "未确认的复核不生效，仍为待复核");
  assert(offline.shifts[0].closed === false, "未确认的关账不生效");
  assert(offline.shifts[0].blockReasons.some((r) => r.includes("重连确认")), "提示复核待确认");

  // 重连补确认（同流水身份，仅 confirmedAt 补全）-> 重放后生效
  const reconnected = replay(base.map((e) =>
    e.kind === "review" || e.kind === "close" ? { ...e, confirmedAt: t2 } : e,
  ));
  assert(reconnected.shifts[0].reviewed === true, "补确认后复核生效");
  assert(reconnected.shifts[0].closed === true, "补确认后关账生效");
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 个失败`);
process.exit(failures === 0 ? 0 : 1);
