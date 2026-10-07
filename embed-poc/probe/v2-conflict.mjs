/**
 * 第 8 问：**两个人先后存，后存的那个被拒、不丢数。**（2026-10-07 新增，第二版协议）
 *
 * 这个编辑器不支持多人同时编辑。两个人各开同一份、各自改、先后保存时，后存的那个基于旧版本，
 * **直接覆盖会把先存的那一份整个丢掉，而两边都显示成功**。第二版里防这件事的是 `baseVersion`：
 * 宿主把它签进配置令牌，接入后端在回调里原样带回，宿主比一下，不符就拒（mock 回 409）。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 *   ① 甲先存：成功，mock 到第 2 版，正文里有甲的记号；
 *   ② 乙后存：宿主收到 `failed{stage:"save", status:409, from:"host", unsavedKept:true}`，
 *      页面上出现「把我这一份存到本地」按钮；
 *   ③ **mock 那份没被覆盖**：还是第 2 版，正文里有甲的记号、没有乙的；
 *   ④ 乙点「存到本地」：浏览器真的下载了一个文件，**解开之后里面有乙的记号**
 *      ——这说明留下的就是乙这次改的那一份，不是打开时的原文；
 *   ⑤ 乙这个会话是**不许下载**的（令牌里 `permissions.download=false`），④照样成立：
 *      那是他自己刚改的内容，不给就等于丢数。
 *
 * 跑法：由 run.mjs 起好静态服务器、mock 与接入后端之后调用。
 *   node embed-poc/probe/v2-conflict.mjs <宿主> <静态> <接入后端>
 */

import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";
import { docx正文 } from "./zip.mjs";

const 宿主 = (process.argv[2] || "http://127.0.0.1:3043").replace(/\/+$/, "");
const 静态 = (process.argv[3] || "http://127.0.0.1:3042").replace(/\/+$/, "");
const 接入后端 = (process.argv[4] || "http://127.0.0.1:3044").replace(/\/+$/, "");
const 甲记号 = "甲记号" + Date.now();
const 乙记号 = "乙记号" + Date.now();

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

const 状态 = async () => (await fetch(宿主 + "/_probe/state")).json();
async function 取当前文档() {
  const r = await fetch(宿主 + "/file", {
    headers: { Authorization: "Bearer probe-" + Math.random().toString(36).slice(2) },
  });
  return Buffer.from(await r.arrayBuffer());
}

await fetch(宿主 + "/_probe/reset", { method: "POST" });

const 浏览器 = await chromium.launch();
const 编辑器选择器 = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";

async function 开一页(名, 额外参数) {
  const 页 = await 浏览器.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const 地址 =
    宿主 + "/?protocol=2&embedOrigin=" + encodeURIComponent(静态) + "&backend=" + encodeURIComponent(接入后端) + 额外参数;
  console.log("打开" + 名 + "：" + 地址);
  await 页.goto(地址, { waitUntil: "domcontentloaded", timeout: 60000 });
  await 页
    .waitForFunction(() => window.__host?.stateV2?.().打开信息 || window.__host?.stateV2?.().上次失败, null, { timeout: 120000 })
    .catch(() => {});
  await 页.frameLocator("#接入页").locator(编辑器选择器).waitFor({ state: "attached", timeout: 120000 }).catch(() => {});
  await 页.waitForTimeout(6000);
  await 页
    .waitForFunction(() => window.__host.state().插件报告 !== null, null, { timeout: 60000 })
    .catch(() => {});
  await 页.waitForTimeout(1500);
  return 页;
}

async function 敲字(页, 字) {
  await 页.bringToFront();
  const 框 = await 页.locator("#接入页").boundingBox();
  await 页.mouse.click(框.x + 框.width * 0.42, 框.y + 框.height * 0.72);
  await 页.waitForTimeout(500);
  await 页.keyboard.press("Control+End");
  await 页.waitForTimeout(600);
  await 页.keyboard.type(字, { delay: 25 });
  await 页.waitForTimeout(2000);
}

async function 存(页) {
  await 页.evaluate(() => window.__host.save());
  await 页
    .waitForFunction(() => {
      const s = window.__host.stateV2();
      return !!s.上次存件 || !!s.上次失败;
    }, null, { timeout: 120000 })
    .catch(() => {});
  return 页.evaluate(() => window.__host.stateV2());
}

// 两个人都在 mock 还是第 1 版时打开。
const 甲 = await 开一页("甲", "");
const 乙 = await 开一页("乙（不许下载）", "&download=0");
const 甲开 = await 甲.evaluate(() => window.__host.stateV2().打开信息);
const 乙开 = await 乙.evaluate(() => window.__host.stateV2().打开信息);
断言("两个人都基于第 1 版打开", 甲开?.baseVersion === 1 && 乙开?.baseVersion === 1, JSON.stringify([甲开, 乙开]));
断言("乙的令牌不许下载 → 乙那边 allowDownload 为 false", 乙开?.allowDownload === false);

// ① 甲先存
await 敲字(甲, 甲记号);
const 甲存 = await 存(甲);
断言("① 甲先存：成功", !!甲存.上次存件 && !甲存.上次失败, JSON.stringify(甲存.上次失败 || 甲存.上次存件));

// ② 乙后存
await 敲字(乙, 乙记号);
const 乙存 = await 存(乙);
const 失败 = 乙存.上次失败;
断言(
  "② 乙后存：被宿主拒，409，接入页说它还留着那一份",
  !!失败 && 失败.stage === "save" && 失败.status === 409 && 失败.from === "host" && 失败.unsavedKept === true,
  JSON.stringify(失败 || 乙存.上次存件).slice(0, 300),
);
断言("② 宿主页上出现了「把我这一份存到本地」", 乙存.存到本地钮可见 === true);
断言("（对照）甲那边没有这个按钮", (await 甲.evaluate(() => window.__host.stateV2())).存到本地钮可见 === false);

// ③ mock 那份没被覆盖
const s = await 状态();
const 正文 = docx正文(await 取当前文档());
断言("③ mock 还是第 2 版", s.版本 === 2, "第 " + s.版本 + " 版");
断言("③ 正文里有甲的记号", !!正文 && 正文.includes(甲记号));
断言("③ 正文里没有乙的记号（没被覆盖）", !!正文 && !正文.includes(乙记号));

// ④⑤ 乙存到本地
let 下载内容 = null;
try {
  await 乙.bringToFront();
  const [下载] = await Promise.all([
    乙.waitForEvent("download", { timeout: 30000 }),
    乙.evaluate(() => window.__host.downloadUnsaved()),
  ]);
  const 存到 = path.join("embed-poc", "out", "v2-乙没存上的那一份.docx");
  fs.mkdirSync(path.dirname(存到), { recursive: true });
  await 下载.saveAs(存到);
  下载内容 = docx正文(fs.readFileSync(存到));
} catch (e) {
  console.log("   （存到本地没等到下载：" + String(e).slice(0, 200) + "）");
}
断言(
  "④⑤ 乙（不许下载的会话）点了「存到本地」，下到的文件里有乙的记号",
  !!下载内容 && 下载内容.includes(乙记号),
  下载内容 === null ? "没有下载" : "下到 " + 下载内容.length + " 字",
);

await 浏览器.close();

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
