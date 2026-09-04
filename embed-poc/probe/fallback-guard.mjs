/**
 * 第 3 问：**导出回落成「打开时那份原文件」的时候，接入页真的会拒绝上传吗。**
 *
 * ── 为什么这一条值得单独测 ──────────────────────────────────────────────
 *
 * 组件在文档解压后体积超限时，`exportAsBlob()` 回的**不是这次编辑的结果，
 * 而是打开时那份原文件**，只在返回值里多一格 `isOriginalFileFallback`。
 *
 * 不查那一格就传上去的后果是**最坏的那一类**：服务端存下了原样的字节、
 * 版本号照样往前走、页面上显示「保存成功」，而**用户这次的全部改动没了**，
 * 一句报错都没有。
 *
 * ── 怎么触发 ────────────────────────────────────────────────────────────
 *
 * 契约里有一格 `officeXmlLimitBytes`。把它压到 1 字节，任何文档都必然超限。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 * 两条，缺一条都不够：
 *   ① 接入页报出 `failed / export`（它说它拒绝了）；
 *   ② **服务端那份一个字节都没动**（它是真的没传上去）。
 *
 * 只有①的话，「我拒绝了」可能只是一句话而字节照样传了；
 * 只有②的话，没传上去可能是别的原因（比如它压根没走到那一步）。
 *
 * 跑法（两个服务器都要起着）：
 *   node embed-poc/probe/fallback-guard.mjs
 */

import { chromium } from "playwright";

const 宿主 = (process.argv[2] || "http://127.0.0.1:3043").replace(/\/+$/, "");
const 静态 = (process.argv[3] || "http://127.0.0.1:3042").replace(/\/+$/, "");

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

async function 状态() {
  return (await (await fetch(宿主 + "/_probe/state")).json());
}

await fetch(宿主 + "/_probe/reset", { method: "POST" });
const 存件前 = await 状态();
console.log("复位了。第 " + 存件前.版本 + " 版，" + 存件前.字节数 + " 字节");

const 浏览器 = await chromium.launch();
const 页 = await 浏览器.newPage({ viewport: { width: 1440, height: 900 } });

const 地址 =
  宿主 + "/?embedOrigin=" + encodeURIComponent(静态) + "&officeXmlLimitBytes=1";
console.log("打开宿主页（体积上限压到 1 字节）" + 地址);
await 页.goto(地址, { waitUntil: "domcontentloaded", timeout: 60000 });

const 接入页 = 页.frameLocator("#接入页");
/**
 * ⚠ **不要求编辑器 iframe 出现。**
 *
 * 第一版这么写过，结果整条断言红在「文档没打开」上，而那是**误解**：
 * 那道体积闸是在**打开**的时候置上标记的（x2t 转换输入时超限），
 * 超限的文档本来就打不开或打不全。`exportAsBlob()` 之后看的是那个标记。
 *
 * 也就是说这一问要验的场景是：**打不开的那份文档，导出会把原文原样还给你**
 * ——而接入页必须认出这一点、拒绝上传。所以这里只等接入页有反应，不等编辑器。
 */
let 起来了 = false;
try {
  await 页.waitForFunction(() => window.__host?.ready?.() === true, null, { timeout: 60000 });
  // 给它一段时间去取件、去撞那道闸。
  await 页.waitForTimeout(20000);
  起来了 = true;
} catch {
  /* 下面报 */
}
const 接入页状态 = await 接入页.locator("#状态").textContent().catch(() => "(读不到)");
console.log("接入页此刻说：" + 接入页状态);
断言("接入页起来了并收到了 open", 起来了);

if (起来了) {
  await 页.evaluate(() => window.__host.save());
  try {
    await 页.waitForFunction(
      () => {
        const s = window.__host.state();
        return s.上次失败 !== null || s.上次存件 !== null;
      },
      null,
      { timeout: 120000 },
    );
  } catch {
    /* 下面按「什么都没发生」报 */
  }
}

const 宿主状态 = await 页.evaluate(() => window.__host.state());
await 浏览器.close();

const 失败 = 宿主状态.上次失败;
断言(
  "① 接入页报了「导出回落，拒绝上传」",
  !!失败 && 失败.stage === "export",
  失败
    ? String(失败.stage) + "：" + String(失败.message).slice(0, 140)
    : 宿主状态.上次存件
      ? "它竟然存成功了 —— 那一格没查，改动被原文顶掉了"
      : "什么都没发生，这一趟没跑到",
);

const 存件后 = await 状态();
断言(
  "② 服务端那份一个字节都没动（真的没传上去）",
  存件后.版本 === 存件前.版本 && 存件后.字节数 === 存件前.字节数,
  "第 " + 存件前.版本 + " 版 " + 存件前.字节数 + " 字节 → 第 " + 存件后.版本 + " 版 " +
    存件后.字节数 + " 字节",
);

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
