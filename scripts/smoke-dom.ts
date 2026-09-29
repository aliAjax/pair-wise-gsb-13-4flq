// 端到端冒烟：jsdom 加载真实应用，走一遍双机交接 / 断网补录 / 裁决 / 复核 / 关账。
import { JSDOM } from "jsdom";
import { build } from "vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "ledger-smoke-"));

// 测试入口：去掉与逻辑无关的 Element Plus 全量样式，保留应用自身样式
const entry = join(out, "entry.ts");
const { writeFileSync } = await import("node:fs");
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
    outDir: out,
    emptyOutDir: false,
    write: true,
    minify: false,
    lib: { entry, formats: ["iife"], name: "smoke", fileName: () => "app.js" },
  },
});

const { readFileSync } = await import("node:fs");
const jsCode = readFileSync(join(out, "app.js"), "utf8");

const indexHtml = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="root"></div></body></html>`;

const dom = new JSDOM(indexHtml, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;

// 补齐 Vue 运行需要的浏览器 API
window.queueMicrotask = (cb: () => void) => Promise.resolve().then(cb);
window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
window.cancelAnimationFrame = (id: number) => clearTimeout(id);

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
};

// 执行应用产物
window.eval(jsCode);

await new Promise((r) => setTimeout(r, 200));
const doc = window.document;

const text = () => doc.querySelector(".shell")!.textContent!;
const $ = <T extends Element>(sel: string) => doc.querySelector(sel) as T | null;
const $$ = (sel: string) => [...doc.querySelectorAll(sel)];

console.log("初始渲染（内置三种交接局面的种子）");
assert(text().includes("加油站班次交接台账"), "页面标题渲染");
assert(text().includes("待核差异"), "待核区指标存在");
const banner = $(".conflict-banner");
assert(Boolean(banner), "种子已生成待核区（260/250 销售 + 80/60 退款）");
assert(banner!.textContent!.includes("O-1002") && banner!.textContent!.includes("O-1001"), "待核区显示双方冲突单号");
assert(banner!.textContent!.includes("260") && banner!.textContent!.includes("250"), "双方金额都显示");
assert($$(".conflict").length === 2, `共 2 笔待核（实际 ${$$(".conflict").length}）`);

console.log("班次卡片显示现金/电子/升数/待核差异");
const record = $(".record")!;
assert(record.textContent!.includes("现金净额"), "显示现金净额");
assert(record.textContent!.includes("电子支付净额"), "显示电子支付净额");
assert(record.textContent!.includes("油品升数"), "显示油品升数");
assert(record.textContent!.includes("待核差异"), "显示待核差异");
assert(record.textContent!.includes("74.7 L") && !record.textContent!.includes("115.2 L"), "同额销售 O-1001 幂等合并（40.5+34.2=74.7L，不是 40.5×2+34.2=115.2L）");

console.log("未复核限制：中班有冲突，关账按钮禁用");
const closeBtn = $$(".record .actions button").find((b) => b.textContent!.trim() === "关账") as HTMLButtonElement;
assert(closeBtn && closeBtn.disabled, "关账按钮禁用");
assert((closeBtn.title || "").includes("待核差异"), "禁用原因含待核差异");

console.log("裁决两笔冲突");
const resolveButtons = $$(".conflict-actions button");
// O-1001 退款冲突"采用甲机"，O-1002 销售冲突"采用甲机"
$$(".conflict").forEach(() => {});
(resolveButtons[0] as HTMLButtonElement).click(); // 第一个冲突区块第一键=采用甲机
await new Promise((r) => setTimeout(r, 50));
(resolveButtons[3] as HTMLButtonElement).click(); // 第二个冲突区块第一键
await new Promise((r) => setTimeout(r, 50));
assert(!$(".conflict-banner"), "裁决后待核区清空");

console.log("复核后才能关账");
const reviewBtn = $$(".record .actions button").find((b) => b.textContent!.trim() === "复核本班次") as HTMLButtonElement;
reviewBtn.click();
await new Promise((r) => setTimeout(r, 50));
const closeBtn2 = $$(".record .actions button").find((b) => b.textContent!.trim() === "关账") as HTMLButtonElement;
assert(!closeBtn2.disabled, "复核+无冲突后关账按钮可用");
closeBtn2.click();
await new Promise((r) => setTimeout(r, 50));
assert($(".record .status")!.textContent!.trim() === "已关账", "班次状态变为已关账");

console.log("切换乙机、断网、补录一笔退款 → 重连后合并");
($$("button.dev")[1] as HTMLButtonElement).click();
await new Promise((r) => setTimeout(r, 30));
const netCheckbox = $(".net input") as HTMLInputElement;
netCheckbox.checked = true;
netCheckbox.dispatchEvent(new window.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
assert(text().includes("断网暂存中"), "进入断网状态");

// 用页面表单记一笔新销售（新单号，不产生冲突）
const inputs = $$(".panel input, .panel select, .panel textarea") as HTMLInputElement[];
const setVal = (el: Element, v: string) => {
  const i = el as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new window.Event("input", { bubbles: true }));
  i.dispatchEvent(new window.Event("change", { bubbles: true }));
};
// 找到业务单号 / 金额 / 升数输入框
const orderInput = $$(".panel input").find((i) => (i as HTMLInputElement).placeholder?.includes("O-1003")) as HTMLInputElement;
setVal(orderInput, "O-2001");
const numInputs = $$(".panel input[type=number]") as HTMLInputElement[];
setVal(numInputs[0], "188");
setVal(numInputs[1], "25");
($(".panel button[type=submit]") as HTMLButtonElement).click();
await new Promise((r) => setTimeout(r, 50));
assert(text().includes("1 笔"), "断网暂存产生 1 笔待确认流水");

// 重连
($(".reconnect") as HTMLButtonElement).click();
await new Promise((r) => setTimeout(r, 50));
assert(text().includes("在线"), "重连回到在线状态（断网开关自动复位）");
assert(text().includes("待核差异") && !$(".conflict-banner"), "新单无冲突，待核区仍为空");
assert($$(".record .status")[0].textContent!.trim() === "待复核", "已关账班次收到补录后回到待复核（旧复核/关账失效，需重新复核关账）");
assert($$(".record .block-reasons")[0].textContent!.includes("重新复核"), "页面明示需重新复核");

console.log("持久化：localStorage 中是流水而非整份覆盖");
const journal = JSON.parse(window.localStorage.getItem("dfwlfront-ledger.journal.v1")!);
assert(Array.isArray(journal.entries) && journal.entries.length >= 10, `流水已持久化（${journal.entries.length} 条）`);
assert(journal.entries.every((e: unknown, i: number, arr: unknown[]) =>
  i === 0 || (arr[i] as { seq: number }).seq !== (arr[i - 1] as { seq: number }).seq ||
  (arr[i] as { deviceId: string }).deviceId !== (arr[i - 1] as { deviceId: string }).deviceId),
  "相邻流水 (设备,seq) 不重复");
assert(journal.entries.some((e: { confirmedAt: string | null }) => e.confirmedAt), "含已确认流水");

console.log(failures === 0 ? "\n端到端冒烟全部通过" : `\n${failures} 个失败`);
process.exit(failures === 0 ? 0 : 1);
