#!/usr/bin/env node
/**
 * 打开一份文档到底下了多少东西：**编辑器一遍、查看器一遍，同一份文档并排出一张表**。
 *
 *   npm run server & npm run dev &
 *   node scripts/measure-payload.mjs
 *   node scripts/measure-payload.mjs --doc 101      # 换一份文档
 *   node scripts/measure-payload.mjs --top 25       # 列出最大的 25 条请求
 *   node scripts/measure-payload.mjs --only viewer  # 只量一档
 *
 * ── 判据怎么定的（五条，各防一种把结论带偏的量法）────────────────────────────
 *
 * **一、字节取网线上的字节，不取响应体的大小。**
 * ⚠ 这两个数在**命中缓存时差得最远**：Playwright 的 `request.sizes().responseBodySize`
 * 那一格，缓存命中时照样回文件本身的大小。拿它量暖载，会得到「暖载与冷载一模一样」
 * ——**而那正好长得像「缓存没生效」这个真实缺陷**，两者分不开。
 * 所以这里走 CDP 的 `Network.loadingFinished.encodedDataLength`：命中缓存时它是 0，
 * 并且另有一格 `fromDiskCache` 把「没下」与「下了 0 字节」分开。
 *
 * **二、冷载与暖载分开量，而且要用一个真的浏览器档案。**
 * 冷载 = 一个**空的用户档案目录**（缓存是空的）；暖载 = 同一个档案里再开一份。
 * 静态资源那一大堆是带版本号的长缓存（`immutable`），第二次开不该再下。
 * **日常体验看的是暖载**——人一天开十份文档，只有第一份是冷的。
 *
 * ⚠ **这里必须走 `launchPersistentContext`，不能用 `browser.newContext()`。**
 * 后者是个无痕上下文，**只有内存缓存、没有磁盘缓存**，而那几个 20–30 MB 的
 * `sdk-all.js` 大过内存缓存肯放的尺寸，于是一条都存不住。
 * 拿它量出来的暖载与冷载**一模一样**（实测 437 请求 221.7 MB，两次分毫不差），
 * 看着就像「长缓存没生效」这个真实缺陷——**而那是量法的毛病，不是产品的**。
 * 这个坑值钱的地方在于：它不报错，出来的数还很整齐。
 *
 * **三、按两条轴分组，因为总数掩盖结构。**
 * 一条轴是**东西的类型**（字体 / sdkjs / 界面 / 插件 / x2t）；
 * 另一条轴是**谁在下**（组件那个预载 iframe / 编辑器 iframe / 主页面）。
 * ⚠ **第二条轴是这张表最要紧的一格**：组件在挂载编辑器之前先塞了一个预载 iframe，
 * 它一次把四个编辑器的 sdk 与一大堆字体全拉下来，**两档完全一样**。
 * 只按类型分组的话，这一大块会摊进「sdkjs」与「字体」两格里，
 * 于是「查看器省了多少」这个问题会被答成一个几乎为零的百分比，
 * 而真正该说的是「这一档省下的是应用外壳，那一大块跟它无关，要另外治」。
 *
 * **四、记请求数，不只记字节。** 几百个小文件与一个大文件字节数可能一样，代价不一样。
 *
 * **五、同一份文档、同一趟跑、同一台机器。**
 * ⚠ 报告里那组旧数（117.6 MB / 88 请求）是第一轮在**另一个 PoC** 上量的：
 * 静态资源来源不同、x2t 版本不同、预压缩副本删没删也不同。
 * **那组数不能与这里的数放在一起比**——这也正是这个脚本坚持在一次运行里出两列的原因。
 *
 * ⚠ 本项目的后端**不开压缩**（`demo/server/index.mjs` 直接 `content-length` + 裸流），
 * 所以这里量到的字节 ≈ 盘上的字节。真部署上了 gzip/br 之后绝对值会小一大截，
 * **两档之间的比例与结构才是这张表能带走的东西**。
 *
 * ⚠ 要真设施（两个服务起着 + 真浏览器），**刻意不挂进任何自动检查**。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  要量的都量到了
 *   1  有一档没量成
 *   2  **一档都没量**（服务没起、或 --only 把两档都滤掉了）——与「量到了」不是一回事
 */

import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import { WEB_ORIGIN, API_PORT, PROJECT_ROOT } from "../config.mjs";

const API = "http://127.0.0.1:" + API_PORT;
const EDITOR_IFRAME = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";
const OUT = path.join(PROJECT_ROOT, "out");

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const DOC = Number(argOf("--doc", 1));
const TOP = Number(argOf("--top", 12));
/** 画布出现之后至少再等这么久。**别调小**——懒加载的那几块是后到的。 */
const SETTLE_MS = Number(argOf("--settle", 8000));
/** 连着这么久没有新请求就算下完了。SETTLE_MS 只当下限，这个才是停止条件。 */
const QUIET_MS = 4000;
/** 再久也不等了。**收数的上限要有**，否则一个卡住的请求能把整趟拖到天亮。 */
const HARD_CAP_MS = 90000;
const 只量 = argOf("--only", null);

/**
 * 一条请求归到哪一类。**从上往下第一条命中的算数**，顺序本身是判据的一部分：
 *
 * - `sdkjs/common/AllFonts.js`（字体目录）、`fonts/NNN`（字体本体，245 个无扩展名的文件）、
 *   `libfont`（字体光栅化引擎）路径上都不长得像字体，但它们装的**就是字体那一摊**。
 *   按路径归给 sdkjs 会让「字体一共多大」这个问题答错一个数量级——
 *   这一趟里光 `fonts/NNN` 就有 84 MB。
 * - `x2t-fonts/` 下那堆 ttf 跟着转换引擎走只是因为导出 PDF 要用它们，按体量该算字体。
 *   所以先认字体，再认 x2t。
 */
const 分组规则 = [
  ["字体", (u) => /\/fonts\//.test(u) || /x2t-fonts\//.test(u) || /libfont/.test(u)
    || /AllFonts|fonts_thumbnail/i.test(u) || /\.(ttf|otf|woff2?|eot)(\?|$)/i.test(u)],
  ["x2t", (u) => /\/x2t\//.test(u)],
  ["插件", (u) => /sdkjs-plugins\//.test(u) || /\/plugins\//.test(u)],
  ["sdkjs", (u) => /\/sdkjs\//.test(u)],
  ["界面", (u) => /\/web-apps\//.test(u)],
  ["其他", () => true],
];
const 组名 = 分组规则.map(([n]) => n);
function 归组(url) {
  for (const [名, 判] of 分组规则) if (判(url)) return 名;
  return "其他";
}

/** 谁在下这条。三档，见文件头「第三条」。 */
const 来源名 = ["预载 iframe", "编辑器 iframe", "主页面"];

const 人读 = (n) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB"
    : n >= 1024 ? (n / 1024).toFixed(0) + " KB"
      : n + " B";

// ── 先确认服务起着，且那份文档真的在 ────────────────────────────────────────

const 清单 = await fetch(API + "/api/_probe/fixtures")
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (!清单) {
  console.error("✗ 后端没应答（" + API + "）。先 npm run server。");
  process.exit(2);
}
const 这份 = 清单.find((d) => d.docId === DOC);
if (!这份) {
  console.error("✗ 服务端没有 " + DOC + " 号文档。有的是：" + 清单.map((d) => d.docId).join("、"));
  process.exit(2);
}

const 要量的 = ["editor", "viewer"].filter((v) => !只量 || 只量 === v);
if (!要量的.length) {
  console.error("✗ --only 把两档都滤掉了。只认 editor 或 viewer。");
  process.exit(2);
}

console.log(
  "量的是 " + DOC + " 号《" + 这份.文件名 + "》（" + 这份.fileType + "），" +
  要量的.join(" 与 ") + " 各一遍，冷载与暖载各一次。\n" +
  "每一遍要等十几秒，请等一会儿。\n",
);

// ── 一次测量 = 一个页面 ──────────────────────────────────────────────────────

async function 量一趟(ctx, variant, 标签) {
  const page = await ctx.newPage();
  const 控制台错 = [];
  page.on("console", (m) => { if (m.type() === "error") 控制台错.push(m.text().slice(0, 160)); });

  // ── CDP：真·网线字节 + 缓存标记 + 是哪个 frame 发的 ──
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");

  /** requestId → 这条请求的样子。**在 requestWillBeSent 时建，后面几个事件往里补。** */
  const 请求 = new Map();
  let 最后动静 = Date.now();

  cdp.on("Network.requestWillBeSent", (e) => {
    最后动静 = Date.now();
    请求.set(e.requestId, {
      url: e.request.url,
      frameId: e.frameId,
      字节: 0,
      命中缓存: false,
      完成: false,
    });
  });
  cdp.on("Network.responseReceived", (e) => {
    最后动静 = Date.now();
    const r = 请求.get(e.requestId);
    if (!r) return;
    r.命中缓存 = Boolean(e.response.fromDiskCache) || Boolean(e.response.fromPrefetchCache);
    r.状态 = e.response.status;
    if (!r.frameId) r.frameId = e.frameId;
  });
  cdp.on("Network.loadingFinished", (e) => {
    最后动静 = Date.now();
    const r = 请求.get(e.requestId);
    if (!r) return;
    // ⚠ 这一格才是网线上的字节。命中缓存时它是 0。
    r.字节 = e.encodedDataLength || 0;
    r.完成 = true;
  });
  cdp.on("Network.loadingFailed", (e) => {
    最后动静 = Date.now();
    const r = 请求.get(e.requestId);
    if (r) { r.完成 = true; r.失败 = e.errorText; }
  });

  const t0 = Date.now();
  await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pocReady === true, null, { timeout: 30000 });
  await page.evaluate(([id, v]) => window.__poc.openFromServer(id, { variant: v }), [DOC, variant]);

  // 画布出现＝文档载进去了。等不到就是这一趟没成。
  await page.waitForSelector(EDITOR_IFRAME, { timeout: 120000 });
  await page.waitForFunction(
    (sel) => {
      const d = document.querySelector(sel)?.contentDocument;
      return !!d && Array.from(d.querySelectorAll("canvas")).some((c) => c.width > 300 && c.height > 300);
    },
    EDITOR_IFRAME,
    { timeout: 120000 },
  );
  const 画出来用时 = Date.now() - t0;

  // ⚠ **画出来 ≠ 下完了**：懒加载的那几块（brotli 解码、导出那半、插件面板、字体）是后到的。
  // 停止条件取「连着 QUIET_MS 没有新动静」，SETTLE_MS 当下限、HARD_CAP_MS 当上限。
  await page.waitForTimeout(SETTLE_MS);
  const 死线 = t0 + HARD_CAP_MS;
  while (Date.now() < 死线 && Date.now() - 最后动静 < QUIET_MS) {
    await page.waitForTimeout(500);
  }
  const 总用时 = Date.now() - t0;
  const 到点了 = Date.now() >= 死线;

  // 落点：**取 iframe 当前的地址，不是 src 属性**——PDF 那条路上有个分派页会跳转，属性不变。
  const 落点 = await page.$eval(EDITOR_IFRAME, (f) => {
    try { return f.contentWindow.location.href; } catch { return ""; }
  });
  const 入口 = (落点.match(/\/apps\/([a-z]+)\/([a-z]+)\//) || []).slice(1, 3).join("/") || "认不出";

  // ── frameId → 哪一档来源。走一次 frame 树，逐层往上找到顶层下面那一层。 ──
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const 父 = new Map();
  const 地址 = new Map();
  (function 走(节点) {
    地址.set(节点.frame.id, 节点.frame.url || "");
    if (节点.frame.parentId) 父.set(节点.frame.id, 节点.frame.parentId);
    for (const c of 节点.childFrames || []) 走(c);
  })(frameTree);
  const 顶层 = frameTree.frame.id;

  function 来源(frameId) {
    if (!frameId || frameId === 顶层) return "主页面";
    // 一直往上走到「父亲就是顶层」的那一层——插件 iframe 是编辑器 iframe 的孩子，
    // 这样它会归到编辑器名下，而不是自成一档。
    let f = frameId;
    const 走过 = new Set();
    while (父.has(f) && 父.get(f) !== 顶层 && !走过.has(f)) { 走过.add(f); f = 父.get(f); }
    const u = 地址.get(f) || "";
    if (/preload\.html/.test(u)) return "预载 iframe";
    if (!父.has(f) && f !== 顶层) return "主页面";   // 已经拆掉的 frame，认不出就算主页面
    return "编辑器 iframe";
  }

  await page.screenshot({ path: path.join(OUT, "payload-" + variant + "-" + 标签 + ".png") });
  await cdp.detach().catch(() => {});
  await page.close();

  // ── 汇总 ──
  const 条目 = [...请求.values()]
    .filter((r) => /^https?:/.test(r.url))     // data:/blob: 不走网线
    .map((r) => ({ ...r, 组: 归组(r.url), 来源: 来源(r.frameId) }));

  const 按组 = Object.fromEntries(组名.map((n) => [n, { 请求数: 0, 字节: 0, 缓存命中: 0 }]));
  const 按来源 = Object.fromEntries(来源名.map((n) => [n, { 请求数: 0, 字节: 0 }]));
  for (const e of 条目) {
    const g = 按组[e.组];
    g.请求数 += 1; g.字节 += e.字节; if (e.命中缓存) g.缓存命中 += 1;
    const s = 按来源[e.来源] ?? (按来源[e.来源] = { 请求数: 0, 字节: 0 });
    s.请求数 += 1; s.字节 += e.字节;
  }

  return {
    variant, 标签, 入口, 落点, 画出来用时, 总用时, 到点了,
    请求数: 条目.length,
    字节: 条目.reduce((a, b) => a + b.字节, 0),
    缓存命中: 条目.filter((e) => e.命中缓存).length,
    按组, 按来源, 条目,
    控制台错: 控制台错.length,
  };
}

// ── 跑 ──────────────────────────────────────────────────────────────────────

const 结果 = [];
const 失败 = [];

for (const variant of 要量的) {
  // **一个空的用户档案目录 = 一次真正的冷载。**
  // ⚠ 用的是持久化档案而不是无痕上下文，理由见文件头「第二条」——
  // 无痕上下文没有磁盘缓存，量出来的暖载会与冷载分毫不差。
  const 档案目录 = path.join(OUT, "payload-profile-" + variant);
  fs.rmSync(档案目录, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(档案目录, {
    headless: true,
    viewport: { width: 1500, height: 950 },
  });
  try {
    for (const 标签 of ["cold", "warm"]) {
      const r = await 量一趟(ctx, variant, 标签);
      console.log(
        "  " + variant.padEnd(6) + (标签 === "cold" ? " 冷载  " : " 暖载  ") +
        String(r.请求数).padStart(4) + " 请求（缓存命中 " + String(r.缓存命中).padStart(3) + "）  " +
        人读(r.字节).padStart(9) + "   首屏 " + String(r.画出来用时).padStart(5) + "ms  →  " + r.入口 +
        (r.到点了 ? "   ⚠ 收数到了上限，可能还没下完" : ""),
      );
      结果.push(r);
    }
  } catch (e) {
    失败.push({ variant, 原因: String(e && e.message ? e.message : e).split("\n")[0].slice(0, 160) });
    console.log("  ✗ " + variant + " 没量成：" + 失败[失败.length - 1].原因);
  } finally {
    await ctx.close();
    // 档案目录留着没用，而且一个就一百多 MB。
    fs.rmSync(档案目录, { recursive: true, force: true });
  }
}

if (!结果.length) {
  console.error("\n✗ 一档都没量到。");
  process.exit(2);
}

// ── 出表 ────────────────────────────────────────────────────────────────────

const 取 = (v, 标签) => 结果.find((r) => r.variant === v && r.标签 === 标签);

function 并排(标签, 轴, 行名) {
  const e = 取("editor", 标签);
  const w = 取("viewer", 标签);
  if (!e && !w) return;
  const 头 = 标签 === "cold"
    ? "冷载（全新上下文，缓存是空的）"
    : "暖载（同一个上下文里再开一份 —— 日常体验看的是这一列）";
  console.log("\n" + "─".repeat(86));
  console.log(头 + "　按" + (轴 === "按组" ? "东西的类型" : "谁在下") + "分");
  console.log("─".repeat(86));
  console.log(
    "".padEnd(14) + "编辑器 请求".padStart(12) + "编辑器 字节".padStart(14) +
    "查看器 请求".padStart(12) + "查看器 字节".padStart(14) + "查看器省下".padStart(14),
  );
  console.log("─".repeat(86));
  for (const g of 行名) {
    const eg = e?.[轴][g] ?? { 请求数: 0, 字节: 0 };
    const wg = w?.[轴][g] ?? { 请求数: 0, 字节: 0 };
    if (!eg.请求数 && !wg.请求数) continue;
    console.log(
      g.padEnd(14) +
      String(eg.请求数).padStart(12) + 人读(eg.字节).padStart(14) +
      String(wg.请求数).padStart(12) + 人读(wg.字节).padStart(14) +
      (e && w ? (eg.字节 - wg.字节 >= 0 ? 人读(eg.字节 - wg.字节) : "多下 " + 人读(wg.字节 - eg.字节)).padStart(14) : "".padStart(14)),
    );
  }
  console.log("─".repeat(86));
  console.log(
    "合计".padEnd(14) +
    String(e?.请求数 ?? 0).padStart(12) + 人读(e?.字节 ?? 0).padStart(14) +
    String(w?.请求数 ?? 0).padStart(12) + 人读(w?.字节 ?? 0).padStart(14) +
    (e && w ? 人读(Math.max(0, e.字节 - w.字节)).padStart(14) : "".padStart(14)),
  );
  if (e && w && 轴 === "按组") {
    const 比 = e.字节 > 0 ? ((1 - w.字节 / e.字节) * 100).toFixed(1) : "0";
    console.log("查看器比编辑器少下 " + 比 + "%（" + 人读(e.字节 - w.字节) + "），少 " + (e.请求数 - w.请求数) + " 个请求。");
  }
}

for (const 标签 of ["cold", "warm"]) {
  并排(标签, "按组", 组名);
  并排(标签, "按来源", 来源名);
}

console.log("\n" + "─".repeat(86));
console.log("首屏画出来用时（同一台机器同一趟，只作参考——受机器忙不忙影响很大）");
console.log("─".repeat(86));
for (const r of 结果) {
  console.log(
    "  " + r.variant.padEnd(7) + r.标签.padEnd(6) + "落在 " + r.入口.padEnd(24) +
    "首屏 " + String(r.画出来用时).padStart(6) + "ms   停止收数于 " + String(r.总用时).padStart(6) + "ms",
  );
}

if (TOP > 0) {
  for (const r of 结果.filter((x) => x.标签 === "cold")) {
    console.log("\n" + r.variant + " 冷载里最大的 " + TOP + " 条：");
    for (const e of [...r.条目].sort((a, b) => b.字节 - a.字节).slice(0, TOP)) {
      console.log(
        "  " + 人读(e.字节).padStart(9) + "  " + e.组.padEnd(6) + "  " + e.来源.padEnd(14) + "  " +
        e.url.replace(WEB_ORIGIN, "").split("?")[0].slice(-70),
      );
    }
  }
}

const 报告 = {
  when: new Date().toISOString(),
  文档: { docId: DOC, 文件名: 这份.文件名, fileType: 这份.fileType },
  说明: "字节 = CDP 的 encodedDataLength（网线上的字节，含响应头），命中缓存时为 0。后端不开压缩，所以冷载那一列≈盘上的字节。",
  结果: 结果.map(({ 条目, ...r }) => ({
    ...r,
    最大的十条: [...条目].sort((a, b) => b.字节 - a.字节).slice(0, 10)
      .map((e) => ({ 字节: e.字节, 组: e.组, 来源: e.来源, url: e.url.replace(WEB_ORIGIN, "") })),
  })),
  失败,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "payload.json"), JSON.stringify(报告, null, 2));
console.log("\n明细写在 out/payload.json，截图 out/payload-*.png");

process.exit(失败.length ? 1 : 0);
