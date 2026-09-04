/**
 * 第 2 问：**接入页那条链走不走得通，而且凭据是不是每次现要的。**
 *
 * 整条链：宿主起 iframe → 接入页说就绪 → 宿主发 open → 接入页要头 → 取件 →
 * 组件打开 → **真键盘敲字** → 导出 → 要头 → 存回 mock。
 *
 * ── 判据取服务端那份字节，不取界面上写了什么 ────────────────────────────
 *
 * 页面上会显示「已保存」，但那只是一句话。这里的判据是：
 * mock 手里那份 docx 的**版本号变了**、**字节变了**、
 * 而且**把它解开之后，里面真有这次敲进去的那几个字**。
 *
 * ── 反向断言是免费探针 ──────────────────────────────────────────────────
 *
 * 「新版里有这几个字」必须配上「**旧版里没有**」。不配的话，
 * 万一那几个字是种子文档里本来就有的，这条断言恒真——
 * 而恒真的断言和正确的断言长得一模一样。所以每趟先复位、先取一份旧的存着。
 *
 * ── 对照组：故意写错的那一档 ────────────────────────────────────────────
 *
 * 宿主页上有个开关，可以切成「开场拿一份凭据用到底」。mock 那边**用过的凭据一律拒**，
 * 所以那一档第二次请求就该当场被拒。
 * **没有这一组，「一路通」可能只是因为 mock 从来不拦**——切过去看见它真的红，
 * 前一档的绿才有内容。
 *
 * 跑法（两个服务器都要起着）：
 *   node embed-poc/server/static-server.mjs 3042 &
 *   node embed-poc/server/mock-host.mjs 3043 &
 *   node embed-poc/probe/embed-flow.mjs
 *
 * 退出码：0 全过；1 有条目没过；2 = 一条断言都没跑。
 */

import { chromium } from "playwright";
import { docx正文 } from "./zip.mjs";

const 宿主 = (process.argv[2] || "http://127.0.0.1:3043").replace(/\/+$/, "");
const 静态 = (process.argv[3] || "http://127.0.0.1:3042").replace(/\/+$/, "");
/** 这次敲进去的记号。带时间戳，**保证种子文档里不可能本来就有**。 */
const 记号 = "PoC记号" + Date.now();

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

async function 问mock(路径, 选项) {
  const r = await fetch(宿主 + 路径, 选项);
  const t = await r.text();
  try {
    return { 状态: r.status, 体: JSON.parse(t) };
  } catch {
    return { 状态: r.status, 体: t };
  }
}

async function 取当前文档() {
  const r = await fetch(宿主 + "/file", {
    headers: { Authorization: "Bearer probe-" + Math.random().toString(36).slice(2) },
  });
  if (!r.ok) throw new Error("探针自己取件失败 " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ── 每趟先复位到同一个起点 ──────────────────────────────────────────────
// 不复位的话文档会一轮轮堆积上一轮敲进去的记号，「旧版里没有这几个字」那条
// 免费探针会随机失效——**而它失效的样子是全绿**。
await 问mock("/_probe/reset", { method: "POST" });
const 旧字节 = await 取当前文档();
const 旧正文 = docx正文(旧字节);
console.log("复位了。旧版 " + 旧字节.length + " 字节，正文 " + (旧正文 || "").length + " 字");

const 浏览器 = await chromium.launch();
const 页 = await 浏览器.newPage({ viewport: { width: 1440, height: 900 } });
const 控制台错误 = [];
页.on("console", (m) => {
  if (m.type() === "error") 控制台错误.push(m.text().slice(0, 200));
});

/**
 * 这一趟**开着插件跑**（不加 `noPlugin=1`）——那才是真实配置。
 *
 * ⚠ 但它一度不得不关掉插件，原因值得记着：插件那份 `config.json` 里
 * `isInsideMode` 原来写的是 `false`，于是它**开成一个居中的弹窗、盖住正文**。
 * 而这里是**按坐标点鼠标**再敲键盘的，那一点就落到了弹窗上，字没进正文。
 *
 * **那次的样子很有欺骗性**：存件成功、版本号往前走、字节也真的变了
 * （编辑器把文档重新导出了一遍），**只有「新版里有这次敲的记号」那一条红**。
 * 判据要是取「保存成功」而不取服务端字节，这一趟会全绿而什么都没验到。
 *
 * 改成 `isInsideMode: true`（停靠在左边那条面板里，与 `demo/plugin` 一致）之后
 * 正文不再被盖住，这一趟就能开着插件跑了。
 */
const 地址 = 宿主 + "/?embedOrigin=" + encodeURIComponent(静态);
console.log("打开宿主页 " + 地址);
await 页.goto(地址, { waitUntil: "domcontentloaded", timeout: 60000 });

// ── 接入页起来、文档打开 ────────────────────────────────────────────────

const 接入页 = 页.frameLocator("#接入页");
// ⚠ **要排掉预载那个 iframe**：组件会另开一个预热资源用的 iframe，
// 不排的话会拿到它，而它里面什么都没有——于是「编辑器在，但是空的」。
const 编辑器选择器 = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";

let 就绪 = false;
try {
  await 页.waitForFunction(() => window.__host?.ready?.() === true, null, { timeout: 60000 });
  就绪 = true;
} catch {
  /* 下面那条断言会报出来 */
}
断言("接入页说了「我好了」，宿主也收到了", 就绪);

let 编辑器起来了 = false;
try {
  await 接入页.locator(编辑器选择器).waitFor({ state: "attached", timeout: 120000 });
  // 画出首屏要时间；**首屏画出来 ≠ 可以导出**（canvas 一出现就调导出会挂满 30 秒
  // 再抛超时，等一会儿再调则很快返回），所以这里多等一段。
  await 页.waitForTimeout(6000);
  编辑器起来了 = true;
} catch {
  /* 同上 */
}
断言("编辑器真的起来了", 编辑器起来了);

// ── 真键盘敲字 ──────────────────────────────────────────────────────────

if (编辑器起来了) {
  /**
   * ⚠ **先等插件面板落定，再点。**
   *
   * 插件是编辑器起来之后**异步**加载并自动展开的，展开时左边那条面板会挤走正文。
   * 固定等几秒就点的话，机器一忙，面板可能正好在「点」与「敲」之间冒出来
   * ——布局一移，字就掉到别处。这一条是套件里偶发红一次、而单独连跑两趟全绿之后
   * 定位到的：**症状是随机的，原因是固定等待**。
   *
   * 等不到也照常往下走（这一问不是在验插件），只是把布局稳定的那个时刻等到。
   */
  await 页
    .waitForFunction(() => window.__host.state().插件报告 !== null, null, { timeout: 60000 })
    .catch(() => console.log("（没等到插件报到，照常往下点）"));
  await 页.waitForTimeout(1500);

  // 点进正文再 Control+End —— 光标不在正文里的话，敲的字会掉进别处而没有任何报错。
  const 框 = await 页.locator("#接入页").boundingBox();
  await 页.mouse.click(框.x + 框.width * 0.42, 框.y + 框.height * 0.72);
  await 页.waitForTimeout(500);
  await 页.keyboard.press("Control+End");
  await 页.waitForTimeout(600);
  await 页.keyboard.type(记号, { delay: 25 });
  await 页.waitForTimeout(2000);
}

// ── 存件 ────────────────────────────────────────────────────────────────

await 页.evaluate(() => window.__host.save());
let 存好了 = false;
try {
  await 页.waitForFunction(
    () => {
      const s = window.__host.state();
      return !!s.上次存件 || !!s.上次失败;
    },
    null,
    { timeout: 120000 },
  );
  存好了 = true;
} catch {
  /* 下面报 */
}
const 宿主状态 = await 页.evaluate(() => window.__host.state());
断言(
  "存件这一步有了结果（不是一直卡着）",
  存好了,
  JSON.stringify(宿主状态.上次失败 || 宿主状态.上次存件 || null).slice(0, 300),
);
断言("存件成功", !!宿主状态.上次存件 && !宿主状态.上次失败, JSON.stringify(宿主状态.上次存件));

// ── 判据取服务端那份字节 ────────────────────────────────────────────────

const mock状态 = (await 问mock("/_probe/state")).体;
const 新字节 = await 取当前文档();
const 新正文 = docx正文(新字节);

断言("服务端版本号往前走了", mock状态.版本 === 2, "现在是第 " + mock状态.版本 + " 版");
断言("服务端那份字节真的变了", 新字节.length !== 旧字节.length || !新字节.equals(旧字节),
  旧字节.length + " → " + 新字节.length + " 字节");
const 记号进去了 = !!新正文 && 新正文.includes(记号);
if (!记号进去了) {
  // 这一条红的时候，八成是那一点没落进正文（布局被面板挤走了）。
  // **留一张图**，否则下次红了还得从头猜一遍。
  await 页.screenshot({ path: "embed-poc/out/敲字没进去.png" }).catch(() => {});
  console.log("   （已把当时的样子存到 embed-poc/out/敲字没进去.png）");
}
断言("新版里有这次敲进去的记号", 记号进去了, 记号);
// 反向断言：没有它，上面那条可能恒真。
断言("旧版里没有这个记号（反向断言，证明上一条不是恒真）", !!旧正文 && !旧正文.includes(记号));
断言(
  "种子那句话还在（编辑器没把原文吃掉）",
  !!新正文 && 新正文.includes("这是 PoC 的种子文档"),
);

// ── 凭据是不是每次现要的 ────────────────────────────────────────────────

断言(
  "**每次请求的凭据都不一样**",
  mock状态.收到过的凭据数 > 1 && mock状态.收到过的凭据数 === mock状态.互不相同的凭据数,
  "收到 " + mock状态.收到过的凭据数 + " 次，互不相同 " + mock状态.互不相同的凭据数 + " 份",
);

// ── 对照组：切成「开场一份用到底」，它必须被拒 ──────────────────────────

await 问mock("/_probe/reset", { method: "POST" });
await 页.reload({ waitUntil: "domcontentloaded" });
// ⚠ **要在接入页开口要头之前切**：切晚了，取件那一次已经用「每次现给」拿走了，
// 于是存件那次是这一档的第一次使用、不会重放，对照组就白跑了。
await 页.evaluate(() => window.__host.setMode("开场一份"));

let 对照就绪 = false;
try {
  await 页.waitForFunction(() => window.__host?.ready?.() === true, null, { timeout: 60000 });
  await 接入页.locator(编辑器选择器).waitFor({ state: "attached", timeout: 120000 });
  await 页.waitForTimeout(6000);
  对照就绪 = true;
} catch {
  /* 下面那条会把它报出来 */
}

let 对照结果 = null;
if (对照就绪) {
  await 页.evaluate(() => window.__host.save());
  try {
    await 页.waitForFunction(
      () => {
        const s = window.__host.state();
        return s.上次失败 !== null || s.上次存件 !== null;
      },
      null,
      { timeout: 90000 },
    );
  } catch {
    /* 下面按「什么都没发生」报 */
  }
  对照结果 = await 页.evaluate(() => window.__host.state());
}

// ⚠ 三种结果要分得开：**被拒**（对）、**通过了**（mock 那道拒绝没生效）、
// **什么都没发生**（这一趟根本没跑到）。混成一句话的话，上一版就把第三种
// 报成了第二种，指着一个好好的东西说它坏了。
const 对照被拒 = !!对照结果?.上次失败;
const 对照通过 = !!对照结果?.上次存件;
断言(
  "对照组：开场拿一份用到底 → 真的被拒了（证明「每次都不一样」那条不是恒真）",
  对照被拒 && !对照通过,
  对照被拒
    ? "被拒在 " + String(对照结果.上次失败.stage) + " " + String(对照结果.上次失败.status ?? "") +
      "：" + String(对照结果.上次失败.body || 对照结果.上次失败.message).slice(0, 120)
    : 对照通过
      ? "它竟然存成功了 —— mock 那道重放拒绝没生效，上面那条「每次都不一样」作废"
      : "这一趟什么都没发生（就绪=" + 对照就绪 + "）—— 对照组没跑起来，不是它通过了",
);

if (控制台错误.length) {
  console.log("\n控制台错误 " + 控制台错误.length + " 条（前 5 条）：");
  控制台错误.slice(0, 5).forEach((s) => console.log("   " + s));
}

await 浏览器.close();

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
// ⚠ 用 exitCode 而不是 process.exit()：硬退会让 libuv 在 playwright 收尾时抛断言失败，
// 那句话会盖在真正的结论后面，看着像这个脚本自己崩了。
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
