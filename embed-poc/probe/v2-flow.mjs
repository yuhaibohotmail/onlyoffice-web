/**
 * 第 7 问：**第二版协议那条链走不走得通。**（2026-10-07 新增）
 *
 * 整条链：宿主起 iframe → 接入页各发一条 ready → 宿主（第二版）向 mock 要一张配置令牌，
 * 连同接入后端地址发 open → 接入页把令牌交给接入后端验 → 接入后端带签名去 mock 取件 →
 * 组件打开 → **真键盘敲字** → 导出 → 交给接入后端 → 接入后端暂存、带签名回调 mock →
 * mock 来取暂存的那份、存下 → 回调答复一路回到宿主。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 * 与第一版那一趟同一个原则：**取 mock 手里那份字节**，不取界面上写了什么。另外几条：
 *   · open 里故意塞了第一版的明文（只读、假的取件地址、假的基准版 999），
 *     打开之后必须是**可编辑**、基准版 **1**，而且 mock 从没被要过那个假地址
 *     ——这才说明「只认令牌里的值」；
 *   · mock 收到的每一次取件签名都对（`payload.url` 等于它自己看到的地址、带 `use`、带 `exp`）；
 *   · 回调是 status 6、forcesavetype 1、带回基准版 1；
 *   · **锁定**：这一页按第二版打开之后，宿主再发一条**第一版**的 save，必须什么都不发生；
 *   · 同一个会话里再存一次也成功（基准版往前走了，否则第二次必然撞冲突）。
 *
 * 跑法：由 run.mjs 起好静态服务器、mock 与接入后端之后调用。
 *   node embed-poc/probe/v2-flow.mjs <宿主> <静态> <接入后端>
 *
 * 退出码：0 全过；1 有条目没过；2 = 一条断言都没跑。
 */

import { chromium } from "playwright";
import { docx正文 } from "./zip.mjs";

const 宿主 = (process.argv[2] || "http://127.0.0.1:3043").replace(/\/+$/, "");
const 静态 = (process.argv[3] || "http://127.0.0.1:3042").replace(/\/+$/, "");
const 接入后端 = (process.argv[4] || "http://127.0.0.1:3044").replace(/\/+$/, "");
const 记号 = "V2记号" + Date.now();

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

await 问mock("/_probe/reset", { method: "POST" });
const 旧字节 = await 取当前文档();
const 旧正文 = docx正文(旧字节);

const 浏览器 = await chromium.launch();
const 页 = await 浏览器.newPage({ viewport: { width: 1440, height: 900 } });
const 编辑器选择器 = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";
const 接入页 = 页.frameLocator("#接入页");

const 地址 =
  宿主 + "/?protocol=2&embedOrigin=" + encodeURIComponent(静态) + "&backend=" + encodeURIComponent(接入后端);
console.log("打开宿主页（第二版）" + 地址);
await 页.goto(地址, { waitUntil: "domcontentloaded", timeout: 60000 });

// ── 打开 ────────────────────────────────────────────────────────────────

let 打开信息 = null;
try {
  await 页.waitForFunction(() => window.__host?.stateV2?.().打开信息 || window.__host?.stateV2?.().上次失败, null, {
    timeout: 120000,
  });
} catch {
  /* 下面报 */
}
const 开后 = await 页.evaluate(() => window.__host.stateV2());
打开信息 = 开后.打开信息;
断言("接入页按第二版打开了（宿主收到 opened）", !!打开信息, JSON.stringify(打开信息 || 开后.上次失败).slice(0, 300));
断言(
  "**只认令牌**：open 里明文写着只读，打开的却是可编辑（令牌里是 edit）",
  打开信息?.mode === "edit",
  "mode=" + 打开信息?.mode,
);
断言("**只认令牌**：明文基准版 999 被忽略，用的是令牌里的 1", 打开信息?.baseVersion === 1, "baseVersion=" + 打开信息?.baseVersion);
断言("令牌里许下载 → allowDownload 为 true", 打开信息?.allowDownload === true);

let 编辑器起来了 = false;
try {
  await 接入页.locator(编辑器选择器).waitFor({ state: "attached", timeout: 120000 });
  await 页.waitForTimeout(6000);
  编辑器起来了 = true;
} catch {
  /* 下面报 */
}
断言("编辑器真的起来了", 编辑器起来了);

const 开后mock = (await 问mock("/_probe/state")).体;
断言(
  "mock 收到的取件签名全对（payload.url 等于它看到的地址、use=fetch、有 exp）",
  开后mock.取件签名?.对 >= 1 && 开后mock.取件签名?.错 === 0,
  JSON.stringify(开后mock.取件签名),
);
断言(
  "明文里那个假取件地址从没被要过",
  !(开后mock.没有的路径 || []).some((p) => p.includes("明文取件")),
  JSON.stringify(开后mock.没有的路径 || []),
);

// ── 敲字、存件 ──────────────────────────────────────────────────────────

if (编辑器起来了) {
  await 页
    .waitForFunction(() => window.__host.state().插件报告 !== null, null, { timeout: 60000 })
    .catch(() => console.log("（没等到插件报到，照常往下点）"));
  await 页.waitForTimeout(1500);
  const 框 = await 页.locator("#接入页").boundingBox();
  await 页.mouse.click(框.x + 框.width * 0.42, 框.y + 框.height * 0.72);
  await 页.waitForTimeout(500);
  await 页.keyboard.press("Control+End");
  await 页.waitForTimeout(600);
  await 页.keyboard.type(记号, { delay: 25 });
  await 页.waitForTimeout(2000);
}

async function 存一次() {
  await 页.evaluate(() => window.__host.save());
  try {
    await 页.waitForFunction(
      () => {
        const s = window.__host.stateV2();
        return !!s.上次存件 || !!s.上次失败;
      },
      null,
      { timeout: 120000 },
    );
  } catch {
    /* 下面报 */
  }
  return 页.evaluate(() => window.__host.stateV2());
}

const 存后 = await 存一次();
断言("存件成功", !!存后.上次存件 && !存后.上次失败, JSON.stringify(存后.上次失败 || 存后.上次存件).slice(0, 300));

const mock状态 = (await 问mock("/_probe/state")).体;
const 新字节 = await 取当前文档();
const 新正文 = docx正文(新字节);
断言("服务端版本号往前走了", mock状态.版本 === 2, "现在是第 " + mock状态.版本 + " 版");
const 记号进去了 = !!新正文 && 新正文.includes(记号);
if (!记号进去了) await 页.screenshot({ path: "embed-poc/out/v2-敲字没进去.png" }).catch(() => {});
断言("新版里有这次敲进去的记号", 记号进去了, 记号);
断言("旧版里没有这个记号（反向断言）", !!旧正文 && !旧正文.includes(记号));
断言("种子那句话还在", !!新正文 && 新正文.includes("这是 PoC 的种子文档"));
const 回调 = (mock状态.回调 || [])[0];
断言(
  "回调是 status 6、forcesavetype 1，带回基准版 1",
  !!回调 && 回调.status === 6 && 回调.forcesavetype === 1 && 回调.baseVersion === 1,
  JSON.stringify(回调),
);

// ── 锁定：第一版的 save 必须不理 ─────────────────────────────────────────

await 页.evaluate(() => window.__host.sendRaw({ protocol: "onlyoffice-web-embed/1", type: "save" }));
await 页.waitForTimeout(8000);
const 锁后 = (await 问mock("/_probe/state")).体;
断言(
  "**锁定**：按第二版打开之后，第一版的 save 什么都没触发",
  锁后.版本 === 2 && (锁后.回调 || []).length === 1,
  "版本 " + 锁后.版本 + "，回调 " + (锁后.回调 || []).length + " 次",
);

// ── 同一会话再存一次 ────────────────────────────────────────────────────

// 点保存会先清掉上一次的结果（见 host.ts），所以下面等到的一定是这一次的。
await 页.evaluate(() => window.__host.save());
let 第二次 = null;
try {
  await 页.waitForFunction(
    () => {
      const s = window.__host.stateV2();
      return s.上次失败 || (s.上次存件 && s.上次存件.version === 3);
    },
    null,
    { timeout: 120000 },
  );
} catch {
  /* 下面报 */
}
第二次 = await 页.evaluate(() => window.__host.stateV2());
断言(
  "同一个会话里第二次存也成功（基准版往前走了）",
  第二次.上次存件?.version === 3 && !第二次.上次失败,
  JSON.stringify(第二次.上次失败 || 第二次.上次存件),
);

await 浏览器.close();

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
