// 浏览器路径迁移验证：预置旧版数组，启动真实应用，确认升级提示与账本接管。
import { JSDOM } from "jsdom";
import { build } from "vite";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "ledger-migrate-"));
const entry = join(out, "entry.ts");
writeFileSync(
  entry,
  `import { createApp } from "vue";\nimport "/@fs/${join(root, "src/styles.css").replace(/\\/g, "/")}";\nimport App from "/@fs/${join(root, "src/App.vue").replace(/\\/g, "/")}";\ncreateApp(App).mount("#root");\n`,
);
await build({
  root,
  configFile: join(root, "vite.config.ts"),
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: out, emptyOutDir: false, write: true, minify: false,
    lib: { entry, formats: ["iife"], name: "smoke", fileName: () => "app.js" },
  },
});
const jsCode = readFileSync(join(out, "app.js"), "utf8");

const dom = new JSDOM(
  `<!doctype html><html><body><div id="root"></div></body></html>`,
  { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true },
);
const { window } = dom;
window.queueMicrotask = (cb: () => void) => Promise.resolve().then(cb);
window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;

// 预置旧版数据（正是旧 App.vue 的 storageKey 与形态）
const legacy = [
  { id: "seed-1", shift: "早班", fuelSales: 4280, cash: 8300, digital: 21000, status: "已复核", notes: "账实一致", createdAt: "2026-09-28T01:00:00.000Z" },
  { id: "seed-2", shift: "中班", fuelSales: 3910, cash: 6400, digital: 19800, status: "待复核", notes: "等待站长确认", createdAt: "2026-09-29T07:00:00.000Z" },
];
window.localStorage.setItem("dfwlfront-7-shift", JSON.stringify(legacy));

window.eval(jsCode);
await new Promise((r) => setTimeout(r, 200));

let failures = 0;
const assert = (c: boolean, m: string) => {
  console.log(c ? `  ✓ ${m}` : `  ✗ ${m}`);
  if (!c) failures++;
};
const t = window.document.querySelector(".shell")!.textContent!;

assert(t.includes("旧版数组升级"), "显示升级提示条");
assert(t.includes("已升级 2 条"), "2 条旧记录全部升级");
assert(t.includes("升级完成"), "升级标记为完成");
assert(t.includes("早班") && t.includes("中班"), "两个旧班次都在账本里");
assert(t.includes("8,300") && t.includes("21,000"), "旧金额 ¥8300 / ¥21000 可在班次中看到");
assert(t.includes("已复核"), "早班保持已复核状态");
assert(window.localStorage.getItem("dfwlfront-7-shift") === null, "旧 key 已清空");
assert(window.localStorage.getItem("dfwlfront-7-shift.legacy-backup") != null, "旧数组已备份可回滚");
const journal = JSON.parse(window.localStorage.getItem("dfwlfront-ledger.journal.v1")!);
assert(journal.entries.some((e: { kind: string }) => e.kind === "sale"), "新账本里是流水而不是旧数组");

// 再"重启"一次：迁移不应重复执行、金额不翻倍
window.eval(jsCode);
await new Promise((r) => setTimeout(r, 100));
const journal2 = JSON.parse(window.localStorage.getItem("dfwlfront-ledger.journal.v1")!);
assert(journal2.entries.length === journal.entries.length, "重新打开不重复迁移（流水条数不变）");
const cashText = window.document.querySelector(".shell")!.textContent!;
assert((cashText.match(/8,300\.00/g) || []).length === 1, "旧金额只出现一次，不重复累计");

console.log(failures === 0 ? "\n浏览器迁移验证全部通过" : `\n${failures} 个失败`);
process.exit(failures === 0 ? 0 : 1);
