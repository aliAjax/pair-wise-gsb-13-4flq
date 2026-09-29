// 验证旧数组升级：分条 checkpoint、中断后续迁、旧 key 完成后才改名备份。
import { replay } from "../src/ledger/replay";
import {
  LEGACY_BACKUP_KEY,
  LEGACY_KEY,
  MIGRATION_KEY,
  runMigration,
} from "../src/ledger/migration";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

function install(storage: MemStorage) {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;
}

const legacyRecords = Array.from({ length: 5 }, (_, i) => ({
  id: `old-${i + 1}`,
  shift: ["早班", "中班", "晚班"][i % 3],
  fuelSales: 1000 + i * 100,
  cash: 2000 + i * 50,
  digital: 5000 + i * 100,
  status: i < 3 ? "已复核" : "待复核",
  notes: "旧数据",
  createdAt: new Date(Date.now() - i * 86400000).toISOString(),
}));

console.log("迁移1：旧数组 5 条，第一次打开完整升级");
{
  const storage = new MemStorage();
  storage.setItem(LEGACY_KEY, JSON.stringify(legacyRecords));
  install(storage);
  const p = runMigration()!;
  assert(p.state.done, "迁移完成");
  assert(p.state.checkpoint === 5, "checkpoint=5");
  assert(storage.getItem(LEGACY_KEY) === null, "原 key 已清空");
  assert(storage.getItem(LEGACY_BACKUP_KEY) != null, "旧数组已备份");
  const v = replay(p.migrated);
  const cash = v.shifts.reduce((n, s) => n + s.cashNet, 0);
  const expectCash = legacyRecords.reduce((n, r) => n + r.cash, 0);
  assert(cash === expectCash, `现金合计一致 ${cash} = ${expectCash}`);
  assert(v.stats.reviewedCount === 3, "旧版已复核的 3 个班次保持已复核");
}

console.log("迁移2：升级到第 3 条时崩溃（杀掉进程），下次打开继续");
{
  const storage = new MemStorage();
  storage.setItem(LEGACY_KEY, JSON.stringify(legacyRecords));
  install(storage);

  // 手动模拟：跑到 checkpoint=3 后，页面关闭（内存全丢，只剩 localStorage）
  const first = runMigration()!;
  assert(first.state.done, "对照：正常情况会完成");

  // 重新构造"中断现场"：checkpoint=3、只含前 3 条产物，旧 key 保持原样
  const env = JSON.parse(storage.getItem(MIGRATION_KEY)!);
  const cutoff = env.entries.filter((e: { seq: number }) => e.seq <= 3 * 10).length;
  env.state.done = false;
  env.state.finishedAt = null;
  env.entries = env.entries.slice(0, cutoff);
  env.state.checkpoint = 3;
  env.processed = env.processed.slice(0, 3);
  storage.setItem(MIGRATION_KEY, JSON.stringify(env));
  storage.setItem(LEGACY_KEY, JSON.stringify(legacyRecords)); // 旧 key 尚未改名
  assert(storage.getItem(LEGACY_KEY) != null, "中断时旧 key 仍在原地");

  const resume = runMigration()!;
  assert(resume.state.done, "再次打开后续迁完成");
  assert(resume.state.checkpoint === 5, "从 checkpoint 3 续到 5");
  assert(storage.getItem(LEGACY_KEY) === null, "续迁完成后旧 key 才改名备份");

  // 幂等：用完整迁移结果重放，前 3 条不能重复
  const v = replay(resume.migrated);
  const cash = v.shifts.reduce((n, s) => n + s.cashNet, 0);
  const expectCash = legacyRecords.reduce((n, r) => n + r.cash, 0);
  assert(cash === expectCash, `续迁后金额不重不漏 ${cash} = ${expectCash}`);
  const digital = v.shifts.reduce((n, s) => n + s.digitalNet, 0);
  const expectDigital = legacyRecords.reduce((n, r) => n + r.digital, 0);
  assert(digital === expectDigital, `电子支付不重不漏 ${digital} = ${expectDigital}`);
}

console.log("迁移3：没有旧数据时不产生迁移");
{
  install(new MemStorage());
  assert(runMigration() === null, "无旧 key 返回 null");
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 个失败`);
process.exit(failures === 0 ? 0 : 1);
