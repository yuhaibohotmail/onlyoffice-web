/**
 * 第 5 问：**宿主能不能把一个自己的插件下发给编辑器，并给它递一格配置。**
 *
 * ── 为什么这一问与第 1 问是两件事 ──────────────────────────────────────
 *
 * 插件有两条互不相干的通道：
 *
 *   通道一：**静态登记表**（静态根下那份 plugins.json）——装的是镜像自带那 11 个官方插件。
 *           它**给不了配置**，没有 options 那一格。第 1 问验的是它。
 *   通道二：**编辑器配置**里的 `editorConfig.plugins`（pluginsData / autostart / **options**）
 *           ——`options` 是**宿主给插件下发配置的唯一通道**，
 *           真实部署里放的正是插件访问它自己后端要用的凭证。**这一问验的是它。**
 *
 * 通道二才是接真后端时要紧的那条：**能带凭证的只有它**。
 * 而且它不经那个静态宿主，所以「纯静态」那件事对它没有影响。
 *
 * ── 判据：插件自己说它收到了什么 ────────────────────────────────────────
 *
 * 不看插件面板上有没有东西——那只说明它被列出来了。
 * 判据是插件**跑起来之后把 `Asc.plugin.info.options` 报回给最外层页面**，
 * 而报回来的内容里要有宿主刚放进去的那个记号。
 *
 * ⚠ **对照组不能省**：同样一趟，加 `?noPlugin=1` 不下发插件，
 * 那时**不该有任何插件报到**。没有这一组的话，「插件报到了」可能是镜像自带那 11 个
 * 里的某一个碰巧也在报——那条断言就成了恒真。
 *
 * 跑法（两个服务器都要起着）：
 *   node embed-poc/probe/plugin-channel.mjs
 */

import { chromium } from "playwright";

const 宿主 = (process.argv[2] || "http://127.0.0.1:3043").replace(/\/+$/, "");
const 静态 = (process.argv[3] || "http://127.0.0.1:3042").replace(/\/+$/, "");

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

const 浏览器 = await chromium.launch();

/** 开一趟，等到插件报到（或超时），把宿主的状态取回来。 */
async function 跑一趟(下发插件) {
  const 页 = await 浏览器.newPage({ viewport: { width: 1440, height: 900 } });
  const 取不到的 = [];
  页.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/plugin")) {
      取不到的.push(r.status() + " " + r.url().replace(静态, ""));
    }
  });

  const 地址 =
    宿主 + "/?embedOrigin=" + encodeURIComponent(静态) + (下发插件 ? "" : "&noPlugin=1");
  await 页.goto(地址, { waitUntil: "domcontentloaded", timeout: 60000 });

  await 页
    .waitForFunction(() => window.__host?.ready?.() === true, null, { timeout: 60000 })
    .catch(() => {});
  await 页
    .frameLocator("#接入页")
    .locator(".onlyoffice-container > iframe:not([data-onlyoffice-preload])")
    .waitFor({ state: "attached", timeout: 120000 })
    .catch(() => {});

  // 插件是编辑器起来之后才加载并自动展开的。**等多久要说出来**——
  // 只等两秒就说「没有插件」，和真的没有插件长得一样。
  const 等了 = 45000;
  await 页
    .waitForFunction(() => window.__host.state().插件报告 !== null, null, { timeout: 等了 })
    .catch(() => {});

  const 状态 = await 页.evaluate(() => window.__host.state());
  await 页.close();
  return { 状态, 取不到的, 等了 };
}

console.log("① 下发插件 —— 它该跑起来，并且收到宿主放进去的那格 options");
const 甲 = await 跑一趟(true);
const 报告 = 甲.状态.插件报告;
断言("插件跑起来了并报到了", !!报告 && 报告.__pocPlugin === "ready",
  报告 ? JSON.stringify(报告).slice(0, 160) : "等了 " + 甲.等了 + "ms 没等到");
断言("**插件收到了宿主下发的 options**", !!报告 && 报告.有没有收到options === true,
  报告 ? JSON.stringify(报告.options || {}).slice(0, 200) : "");
断言(
  "options 里那个记号确实是宿主放进去的那一个",
  !!报告 && typeof 取来自(报告) === "string" && 取来自(报告) === "宿主页",
  报告 ? "来自=" + String(取来自(报告)) : "",
);
if (甲.取不到的.length) {
  console.log("   ⚠ 插件相关的 4xx/5xx：" + JSON.stringify(甲.取不到的.slice(0, 5)));
}

/**
 * 从插件报回来的东西里取那个记号。
 *
 * ⚠ **编辑器交给插件的 `Asc.plugin.info.options` 已经把 guid 那一层剥掉了。**
 * 宿主那边放的是 `options: { "<guid>": { 来自, 记号, … } }`，
 * 而插件读到的直接就是 `{ 来自, 记号, … }`。
 * 第一版这里按嵌套去取，结果拿到 `undefined` ——
 * 而那时前两条断言是绿的，**看起来像「收到了但内容不对」，其实是判据写错了**。
 */
function 取来自(报告) {
  const o = 报告 && 报告.options;
  return o && o.来自;
}

console.log("\n② 对照组：不下发插件 —— 不该有任何插件报到");
const 乙 = await 跑一趟(false);
断言(
  "不下发就没有插件报到（证明上面那几条不是恒真）",
  乙.状态.插件报告 === null,
  乙.状态.插件报告
    ? "竟然有插件报到了：" + JSON.stringify(乙.状态.插件报告).slice(0, 160) +
      " —— 那说明上面那几条与我们下发的配置无关"
    : "干净",
);

await 浏览器.close();

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
