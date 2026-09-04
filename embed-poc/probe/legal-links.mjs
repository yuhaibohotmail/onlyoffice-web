/**
 * 第 6 问：**界面上那个法律声明入口，点开之后那四条链接真的能到东西吗。**
 *
 * ── 为什么这一条必须有 ──────────────────────────────────────────────────
 *
 * 许可的附加条款第三条要的是「清晰可达、显著可见」的入口，让用户拿得到许可信息；
 * 许可证正文第 13 条要的是「凡通过网络与本程序交互的用户都能免费取得**本版本**的
 * 完整对应源码」。**入口点开之后 404 与没有入口是一回事。**
 *
 * ⚠ 既有那套实测**逮不住这件事**：`demo/e2e/run.mjs` 的 B16 只断言那个按钮
 * **在、且没被别的东西盖住**，从不点开链接。这个仓库里真的因此坏过一次
 * ——dev 那份 vite 配置漏了 `/legal` 反代，四条链接全是 404，而所有实测都是绿的。
 *
 * ── 纯静态那一档尤其要验 ────────────────────────────────────────────────
 *
 * 「获取源代码」默认指的是 `<legalRoot>/source`，那条要由后端**现打一个源码包**。
 * 而纯静态部署里没有那个进程 —— 所以它必须被 `registerLegalNotice({sourceUrl})`
 * 指到公开仓库去。这一条就是在验那一步真的做了。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 *   ① 入口在，而且**中心那个点上最上面的就是它自己**（只量宽高不够：
 *      一个被整个盖住的元素，`getBoundingClientRect()` 照样回一个正的宽高）；
 *   ② 点开之后四条链接都在；
 *   ③ 「获取源代码」**指的是外部仓库，不是 `/source` 那条**
 *      （指着 `/source` 就说明纯静态那一档没配，点开会 404）；
 *   ④ 另外三条（都是本机静态文件）**真的取得到**。
 *
 * ⚠ ③刻意**不去网上取那个地址**：那会把这条实测绑到外网，
 * 而它要验的是「配没配」，不是「GitHub 通不通」。
 *
 * 跑法（静态服务器起着就行）：
 *   node embed-poc/probe/legal-links.mjs [静态地址]
 */

import { chromium } from "playwright";

const 静态 = (process.argv[2] || "http://127.0.0.1:3042").replace(/\/+$/, "");
const 宿主源 = process.argv[3] || "http://127.0.0.1:3043";

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

const 浏览器 = await chromium.launch();
const 页 = await 浏览器.newPage({ viewport: { width: 1400, height: 900 } });

/**
 * 走**真的宿主页**（不是自己给接入页发消息）。
 *
 * ⚠ 第一版是直接开接入页、再从那一页自己 postMessage 一条 open。两次都不行，
 * 而且两次的原因不一样、都值得记：
 *   ① `hostOrigin` 声明成了 mock 那个源，于是自发的消息被来源校验**正确地拒了**；
 *   ② 改成信本页之后 open 收下了，但**没人答 `need-headers`**，接入页等 10 秒超时，
 *      文档没打开 —— 而**法律入口是随编辑器挂上的**，编辑器不出来就没有它。
 * 两次的样子都是「四条断言全红而产品一点毛病没有」。
 */
const 地址 = 宿主源 + "/?embedOrigin=" + encodeURIComponent(静态);
await 页.goto(地址, { waitUntil: "domcontentloaded", timeout: 60000 });

/** 法律入口挂在**接入页那一层**的 `.onlyoffice-container` 上，不在最外层。 */
const 接入页 = 页.frameLocator("#接入页");
let 入口出现了 = false;
try {
  await 接入页
    .locator("[data-onlyoffice-legal-notice]")
    .waitFor({ state: "visible", timeout: 150000 });
  入口出现了 = true;
} catch {
  /* 下面报 */
}

// ① 在，而且没被盖住
const 可见 = 入口出现了
  ? await 接入页.locator("body").evaluate(() => {
      const b = document.querySelector("[data-onlyoffice-legal-notice]");
      if (!b) return { 有: false };
      const r = b.getBoundingClientRect();
      // ⚠ **光量宽高不够**：被整个盖住的元素照样回一个正的宽高，
      // 于是「显著可见」这条许可要求会在一次纯样式改动里静静地失效。
      const 上面那个 = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        有: true,
        宽: Math.round(r.width),
        高: Math.round(r.height),
        没被盖住: b.contains(上面那个) || b === 上面那个,
      };
    })
  : { 有: false };
断言(
  "法律声明入口在，而且中心那点上最上面的就是它自己（没被盖住）",
  可见.有 && 可见.宽 > 0 && 可见.高 > 0 && 可见.没被盖住,
  JSON.stringify(可见),
);

// ② 点开，取四条链接
let 链接 = [];
if (可见.有) {
  await 接入页.locator("[data-onlyoffice-legal-notice]").click();
  await 页.waitForTimeout(500);
  链接 = await 接入页.locator("body").evaluate(() =>
    [...document.querySelectorAll("a")]
      .filter((a) => a.textContent && a.href)
      .map((a) => ({ 文字: a.textContent.trim(), 地址: a.href })),
  );
}
断言("点开之后四条链接都在", 链接.length >= 4, 链接.map((x) => x.文字).join(" / "));

// ③ 「获取源代码」指的是外部仓库，不是 /source
const 源码链接 = 链接.find((x) => x.文字.includes("源代码"));
断言(
  "**「获取源代码」指的是外部仓库，不是 `/legal/source`**",
  !!源码链接 && /^https?:\/\//.test(源码链接.地址) && !源码链接.地址.endsWith("/legal/source"),
  源码链接
    ? 源码链接.地址 +
      (源码链接.地址.endsWith("/legal/source")
        ? " —— 纯静态那一档没配 sourceUrl，点开会 404"
        : "")
    : "根本没有这条链接",
);

// ④ 另外三条（本机静态文件）真的取得到
const 本机的 = 链接.filter((x) => x.地址.startsWith(静态));
const 结果 = [];
for (const l of 本机的) {
  let s;
  try {
    s = (await fetch(l.地址)).status;
  } catch (e) {
    s = "连不上：" + String(e);
  }
  结果.push({ ...l, 状态: s });
}
// 反向探针：一个编造的 legal 路径必须取不到，否则「都取得到」是恒真的。
let 反向;
try {
  反向 = (await fetch(静态 + "/legal/根本没有这一份.txt")).status;
} catch {
  反向 = "连不上";
}
断言("反向探针有效（编造的许可文件取不到）", 反向 !== 200, "回了 " + 反向);
断言(
  "本机那几条许可文件真的取得到",
  结果.length > 0 && 结果.every((x) => x.状态 === 200),
  结果.map((x) => x.文字 + "=" + x.状态).join("，") || "一条本机链接都没有",
);

await 浏览器.close();

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
