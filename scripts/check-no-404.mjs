#!/usr/bin/env node
/**
 * 打开页面、打开一份文档，把**所有没取到的请求**列出来。
 *
 *   npm run server & npm run dev &     # 要这两个先起着
 *   node scripts/check-no-404.mjs
 *   node scripts/check-no-404.mjs --pdf      # 换成打开 PDF（验 pdfeditor 那条路）
 *   node scripts/check-no-404.mjs --viewer   # 换成查看器那一档（验 embed 那条路）
 *
 * ⚠ **三条路要各跑一遍**：它们加载的是不同的应用（`main` / `pdfeditor` / `embed`），
 * 缺的东西也各不相同。只跑默认那条，等于只看了三分之一。
 *
 * ── 为什么要单独有这么一条 ──────────────────────────────────────────────────
 *
 * 这套东西的失败方式大多**不出声**：静态资源少一个文件，编辑器不会报错，
 * 它只是少一个功能、或者页面白着。上游那个包缺 `pdfeditor` 就是这样——
 * 接口回报「就绪」，页面是白的，唯一的痕迹是浏览器控制台里一条没人看的 404。
 *
 * 那 13 条自动实测会顺带数一下控制台错误，但它只报个数、不说是哪一条；
 * 而**「有一条 404」和「有一条 404，是缺了 pdfeditor」是两个信息量完全不同的东西**。
 *
 * ⚠ 它要真设施（两个服务起着 + 真浏览器），所以**刻意不挂进任何自动检查**。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  一条都没有
 *   1  有取不到的请求
 *   2  **一条请求都没观察到**——页面根本没起来，这与「全都取到了」不是一回事
 */

import { chromium } from "playwright";

import { WEB_ORIGIN } from "../config.mjs";

/**
 * 已知会 404、而且**不是我们造成的**那些。
 *
 * ⚠ **每一条都必须写理由**，而且理由要说清「为什么不修」。
 * 不写理由的豁免名单是真 404 被藏起来的唯一方式：下一个人看到绿，
 * 而名单里那条早就从「上游的小毛病」变成了「我们抽漏了一个目录」。
 */
const 已知不算数的 = [
  {
    匹配: /sdkjs-plugins\/.*\/translations\/helpers\/zh-ZH[.]json$/,
    理由:
      "上游社区版镜像自己的问题：编辑器传的语言标记是 zh-ZH，而 AI 插件自带的那个文件叫 zh-CN.json。" +
      "真的 Document Server 上也是这个 404，落回英文。我们抽出来的文件与容器里逐个对得上，不是抽漏了。" +
      "不修的理由：修就得往人家的插件里塞一份我们自己的翻译文件，" +
      "换一次镜像还要重塞一遍，而收益只是 AI 插件的几句中文提示。",
  },
  {
    匹配: /\/packages\/onlyoffice\/downloadfile\//,
    理由:
      "⚠ 这条是**我们自己的一个真缺口，还没修**，不是上游的毛病。见 FINDINGS.md 第十节。" +
      "pdfeditor 打开 PDF 前会先下载文件开头一段，判断这是不是一份「带可编辑内容的 PDF」" +
      "（OnlyOffice 自己导出的那种）。它优先用 document.directUrl，而组件从不传这一格，" +
      "于是退回文档服务器那套 downloadfile 端点——我们没有那个端点。" +
      "后果：普通 PDF 恰好判对（答案本来就是「不是」），但 OnlyOffice 生成的 PDF 会被当成" +
      "普通 PDF 打开、丢掉可编辑性，而且不报错。" +
      "暂不修的理由：修法要动模拟服务持有的文档模型（现在那个 url 指向的是转换后的中间格式，" +
      "不是原始 PDF 字节），而验它需要一份真的可编辑 PDF 当夹具——该单独做、单独验。",
  },
];

const PDF = process.argv.includes("--pdf");
const VIEWER = process.argv.includes("--viewer");

const 全部 = [];
const 没取到 = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();

// ⚠ 监听挂在 context 上，而且必须在 goto **之前**挂。
// 挂在 page 上、或者挂晚了，会漏掉最早那一批——而最早那批恰好是静态资源。
ctx.on("response", (r) => {
  全部.push(r.url());
  if (r.status() >= 400) 没取到.push({ 怎么了: String(r.status()), 地址: r.url() });
});
ctx.on("requestfailed", (r) => {
  全部.push(r.url());
  没取到.push({ 怎么了: r.failure()?.errorText ?? "请求失败", 地址: r.url() });
});

const page = await ctx.newPage();
try {
  await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pocReady === true, { timeout: 30000 });
  await page.evaluate(
    ([pdf, viewer]) => window.__poc.openFromServer(pdf ? 2 : 1, viewer ? { variant: "viewer" } : {}),
    [PDF, VIEWER],
  );
  // 首屏画出来之后还会继续拉字体与插件，多等一会儿再收网。
  await page.waitForTimeout(8000);
} catch (e) {
  console.error("✗ 页面没能走到打开文档这一步：" + String(e).split("\n")[0]);
  await browser.close();
  process.exit(2);
}
await browser.close();

if (全部.length === 0) {
  console.error("✗ 一条请求都没观察到——监听没挂上，或者页面根本没起来");
  process.exit(2);
}

// 先把已知不算数的那些挑出来。**挑出来要打印**——悄悄少掉几条与「全都取到了」
// 长得一模一样，而那正是这条检查要防的东西。
const 豁免掉的 = [];
const 真没取到 = [];
for (const x of 没取到) {
  const 命中 = 已知不算数的.find((e) => e.匹配.test(x.地址.replace(/%7B/gi, "{").replace(/%7D/gi, "}")));
  if (命中) 豁免掉的.push({ ...x, 理由: 命中.理由 });
  else 真没取到.push(x);
}

console.log(
  `观察到 ${全部.length} 条请求（${PDF ? "PDF" : "1 号文档"}，` +
  `${VIEWER ? "查看器" : "编辑器"}那一档）。`,
);
if (豁免掉的.length) {
  console.log(`\n有 ${豁免掉的.length} 条按已知情况放过（不是我们造成的）：`);
  for (const x of 豁免掉的) {
    console.log("  " + x.怎么了 + "  " + x.地址.split("/").slice(-3).join("/"));
    console.log("    理由：" + x.理由);
  }
}
if (真没取到.length === 0) {
  console.log("\n✓ 没有取不到的（除了上面按已知情况放过的）");
  process.exit(0);
}
没取到.length = 0;
没取到.push(...真没取到);

// 归类：同一个目录下缺一堆文件时，逐条列出来没用，要看的是缺了哪一块。
const 按目录 = new Map();
for (const x of 没取到) {
  const key = x.地址.replace(/[?#].*$/, "").split("/").slice(0, -1).join("/");
  if (!按目录.has(key)) 按目录.set(key, []);
  按目录.get(key).push(x);
}
console.error(`\n✗ 有 ${没取到.length} 条没取到：`);
for (const [dir, items] of 按目录) {
  console.error(`\n  ${dir}/`);
  for (const x of items.slice(0, 8)) {
    console.error(`    ${x.怎么了.padEnd(6)} ${x.地址.slice(dir.length + 1)}`);
  }
  if (items.length > 8) console.error(`    …… 还有 ${items.length - 8} 条`);
}
process.exit(1);
