#!/usr/bin/env node
/**
 * 自动实测。要先起两个进程：`node demo/server/index.mjs` 与 `npm run dev`。
 *
 * **每一条的判据都取「东西本身」，不取哪个界面上写了什么。**
 * 上一轮吃过一次亏：接口报「ready in 23ms」而页面是白的。所以：
 *   - 「服务端那份变了」取**服务端磁盘上那个文件的字节**，不取前端说的「保存成功」
 *   - 「插件干了活」取**导出的 docx 里找不找得到那段字**，不取面板上的状态行
 *   - 「门在挡」先跑坏的那几条，**再**跑好的那条
 *
 * 用法：
 *   node demo/e2e/run.mjs            全跑
 *   node demo/e2e/run.mjs --headed   看着跑
 *
 * 退出码：0 全过；1 有条目没过；**2 = 一条断言都没跑**——「没过」与「根本没跑」
 * 不是一回事，混成一个码的话，人看到红会去查被测的东西，而该查的是自己那条命令。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PROJECT_ROOT, WEB_ORIGIN, API_PORT, SDK_VERSION } from "../../config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** demo/ 那棵树：落盘的文档与插件配置都在这底下。 */
const ROOT = path.resolve(HERE, "..");
/** ⚠ 截图与 report.json 落**仓库根**的 out/，不是 demo/out/——`.gitignore` 里写的是 `/out/`。 */
const OUT = path.join(PROJECT_ROOT, "out");
const API = "http://127.0.0.1:" + API_PORT;
const HEADED = process.argv.includes("--headed");

/** 纯 ASCII、不用输入法就能敲出来的记号——真键盘输入那一步要用。 */
const TYPED_MARK = "POCMARK2026";
const CLICK_MARK = "CCBUTTONCLICKED-3F9K";
const OPTIONS_PROBE = "OPTIONSPROBE-7Q4X";

/**
 * 编辑器 iframe。**按 id 找永远找不到**：组件把那个 div 换掉了，
 * 编辑器 iframe 是 .onlyoffice-container 的直接子节点；
 * body 上另有一个 preload iframe 也带 canvas，要排掉。
 */
const EDITOR_IFRAME = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) || {};
    results.push({ name, status: "PASS", ms: Date.now() - t0, ...detail });
    console.log("  ✅ " + name + "  (" + (Date.now() - t0) + "ms)");
    return detail;
  } catch (e) {
    results.push({ name, status: "FAIL", ms: Date.now() - t0, error: String(e && e.message ? e.message : e) });
    console.log("  ❌ " + name + "  " + String(e && e.message ? e.message : e));
    return null;
  }
}
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── 服务端那一侧的判据：直接读磁盘，不经前端 ────────────────────────────

function storageMeta(docId = 1) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "storage", String(docId), "meta.json"), "utf8"));
}
/**
 * 某一版在盘上的路径。
 *
 * ⚠ **扩展名跟着文档自己的类型走，别写死 docx。** 服务端那边就是这么存的
 * （见 demo/server/storage.mjs）；这里写死的话，换一份 PDF 来验就会指到一个不存在的文件，
 * 而报错是「文件不存在」——那句话不指向这一行。
 */
function versionPath(docId, v) {
  const ext = storageMeta(docId).fileType || "docx";
  return path.join(ROOT, "storage", String(docId), "v" + v + "." + ext);
}

/**
 * 解出 docx 里的 document.xml。
 *
 * ⚠ 走 `bash -c` 而不是直接 execFileSync("unzip")：这台机器上 Node 解析裸命令时
 * 会挑到 Windows 自带的那个 tar/unzip，报「gzip: stdin: unexpected end of file」，
 * 看着像归档包坏了。路径也要转成 /e/... 那种形式。
 */
function documentXml(file) {
  const p = file.replace(/^([A-Za-z]):/, (_m, d) => "/" + d.toLowerCase()).split(path.sep).join("/");
  return execFileSync("bash", ["-c", "unzip -p '" + p + "' word/document.xml"], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
}

async function api(pathname, init = {}) {
  const r = await fetch(API + pathname, init);
  return { status: r.status, text: await r.text() };
}

// ── 浏览器 ────────────────────────────────────────────────────────────────

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 240)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 240)));
  await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pocReady === true, null, { timeout: 30000 });
  return { ctx, page, consoleErrors };
}

/**
 * 等编辑器真的画出来。
 *
 * ⚠ **首屏画出来 ≠ 可以导出。** canvas 一出现就调 export()，它会**整整挂 30 秒**
 * 再抛「Timed out waiting for OnlyOffice export data」；等一会儿再调则 200ms 返回。
 * 报出来的那句话指着导出，而真正的原因是调早了——一个不报错的空等。
 */
async function waitEditorPainted(page, timeout = 180000) {
  await page.waitForSelector(EDITOR_IFRAME, { timeout });
  await page.waitForFunction((sel) => {
    const f = document.querySelector(sel);
    const d = f && f.contentDocument;
    if (!d) return false;
    return Array.from(d.querySelectorAll("canvas")).some((c) => c.width > 400 && c.height > 400);
  }, EDITOR_IFRAME, { timeout });
  await page.waitForTimeout(1500);
}

/**
 * 把光标挪到文档末尾。
 *
 * ⚠ **每次往文档里插东西之前都要做这一下。** 内容控件是「进去就整块选中」的，
 * 光标停在里面时下一次 PasteHtml 会**替换掉**上一次插进去的内容——
 * 于是「插进去了」和「还在」变成两件事，而中间没有任何报错。
 * 我们就是这么丢过一次按钮留下的那段字：它在点完按钮那一刻的导出里是有的，
 * 到存回服务端时没了。
 */
async function moveCursorToEnd(page) {
  const box = await (await page.$(EDITOR_IFRAME)).boundingBox();
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.75);
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(600);
}

/** 往正文里敲字，走真键盘——比调内部 API 更接近「人在编辑」。 */
async function typeIntoDocument(page, text) {
  await moveCursorToEnd(page);
  await page.keyboard.type(text, { delay: 25 });
  await page.waitForTimeout(2000);
}

/** 插件图标那个颜色，见 demo/plugin/resources/README.md：纯洋红，正文里不会有第二处。 */
const ICON_RGB = [255, 0, 255];

/**
 * 在编辑器画布上找那个「判分」按钮的中心点。
 *
 * ⚠ **它不是 DOM 元素。** 编辑器把内容控件的边框、标签和挂在上面的按钮
 * **全画在画布上**，DOM 里按文字或按背景图去搜，搜到的永远是零个
 * ——我们就是这么一度把「按钮好好的」误判成「按钮不工作」的。
 *
 * 所以判据换成画布像素：把编辑器那几张画布的像素读出来，找我们那个图标的颜色。
 * 这也是插件图标被做成一整块纯洋红的原因——为了让这一步是确定的，而不是靠估坐标。
 */
async function findButtonOnCanvas(page) {
  return page.evaluate(({ sel, rgb }) => {
    const f = document.querySelector(sel);
    const frameRect = f.getBoundingClientRect();
    const found = [];
    f.contentDocument.querySelectorAll("canvas").forEach((c) => {
      if (c.width < 50 || c.height < 50) return;
      let img;
      try { img = c.getContext("2d").getImageData(0, 0, c.width, c.height); } catch { return; }
      const r = c.getBoundingClientRect();
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const dr = img.data[i] - rgb[0], dg = img.data[i + 1] - rgb[1], db = img.data[i + 2] - rgb[2];
          if (dr * dr + dg * dg + db * db < 900) {
            n++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (n > 20) {
        found.push({
          pixels: n,
          x: Math.round(frameRect.x + r.x + ((minX + maxX) / 2) * (r.width / c.width)),
          y: Math.round(frameRect.y + r.y + ((minY + maxY) / 2) * (r.height / c.height)),
        });
      }
    });
    return found;
  }, { sel: EDITOR_IFRAME, rgb: ICON_RGB });
}

/**
 * 把光标挪进内容控件，等按钮画出来，然后点它。
 *
 * 逐行往下点，每点一次就问画布「我们那个图标出现了吗」——出现了就说明
 * 光标进到控件里、按钮也画好了，这一步的停止条件因此是确定的，不靠估行高。
 */
async function clickContentControlButton(page) {
  const box = await (await page.$(EDITOR_IFRAME)).boundingBox();
  const x = box.x + box.width * 0.42;
  for (let y = box.y + 250; y < box.y + box.height * 0.6; y += 14) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(700);
    const hits = await findButtonOnCanvas(page);
    if (!hits.length) continue;
    const b = hits[0];
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(2500);
    return { enteredAt: { x: Math.round(x), y: Math.round(y) }, buttonAt: { x: b.x, y: b.y }, pixels: b.pixels };
  }
  throw new Error("在正文里点了一圈，画布上始终没出现按钮图标——按钮没被画出来");
}

/** 在编辑器 iframe 里按名字点一个插件面板上的按钮。 */
/**
 * 我们那个插件的 guid，从它自己的 config.json 读——**不写死**。
 * 写死的话改了插件 guid 之后这里还绿着，而它验的是另一个东西。
 */
const OUR_PLUGIN_GUID = JSON.parse(
  fs.readFileSync(path.join(ROOT, "plugin/config.json"), "utf8"),
).guid;

/**
 * 点插件面板里的按钮。
 *
 * ⚠ **必须按 guid 精确找我们那个插件的框架。** 镜像自带的 11 个官方插件登记上之后，
 * 页面里同时会有别的插件的 iframe（例如 AI 那个会自己开一个），
 * 用 `iframe[id*='iframe_asc.']` 这种宽写法会同时命中好几个。
 * 这不是产品坏了，是判据不够准——而不准的判据要么当场报错，要么点到别人身上。
 */
async function clickPluginButton(page, buttonId, timeout = 30000) {
  const editor = page.frameLocator(EDITOR_IFRAME);
  const pluginFrame = editor.frameLocator('iframe[id="iframe_' + OUR_PLUGIN_GUID + '"]');
  await pluginFrame.locator("#" + buttonId).click({ timeout });
}

async function main() {
  console.log("端到端实测 —— 页面 " + WEB_ORIGIN + "，后端 " + API + "\n");

  // 每趟从同一个起点开始。不复位的话，文档会一轮轮堆积上一轮插进去的东西，
  // 「旧版里没有这些字」那条免费探针就会随机地失效——而它失效的样子是「全绿」。
  const reset = await api("/api/_probe/reset", { method: "POST" });
  if (reset.status !== 200) {
    console.error("复位失败 " + reset.status + "，后端是不是没重启？");
    process.exit(2);
  }
  console.log("已把 1 号文档复位到 v" + JSON.parse(reset.text).version + "\n");

  // ── B1 取件那道门（先跑坏的） ──────────────────────────────────────
  let goodUrl = null;
  await step("B1 取件那道门：无票 401 / 换文档 403 / 换 cacheKey 403 / 过期 401 / 正确 200", async () => {
    const s = await api("/api/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentIds: [1] }),
    });
    must(s.status === 200, "拿会话票失败 " + s.status);
    const token = JSON.parse(s.text).token;

    const c = await api("/api/editor/config/1", { headers: { authorization: "Bearer " + token } });
    must(c.status === 200, "取配置失败 " + c.status);
    goodUrl = JSON.parse(c.text).document.url;
    const bare = goodUrl.replace(/\?token=.*$/, "");
    const dlToken = goodUrl.replace(/^.*\?token=/, "");

    const noToken = await api(bare);
    must(noToken.status === 401, "不带票应当 401，实得 " + noToken.status);

    const otherDoc = await api(bare.replace("/download/1/", "/download/2/") + "?token=" + dlToken);
    must(otherDoc.status === 403, "拿 1 号的票去取 2 号应当 403，实得 " + otherDoc.status);

    const badKey = await api(bare.replace(/\/download\/1\/[^/]+\//, "/download/1/deadbeefcafe/") + "?token=" + dlToken);
    must(badKey.status === 403, "cacheKey 对不上应当 403，实得 " + badKey.status);

    const forged = await api(bare + "?token=" + dlToken.slice(0, -4) + "AAAA");
    must(forged.status === 401, "签名被改过应当 401，实得 " + forged.status);

    const ok = await api(goodUrl);
    must(ok.status === 200, "正确的票应当 200，实得 " + ok.status);
    const onDisk = fs.statSync(versionPath(1, storageMeta(1).version)).size;
    must(Buffer.byteLength(ok.text, "utf8") > 0, "取回来是空的");
    return { onDiskBytes: onDisk };
  });

  const browser = await chromium.launch({ headless: !HEADED });
  const { ctx, page, consoleErrors } = await newPage(browser);

  const before = storageMeta(1);
  console.log("  （开跑前服务端是第 " + before.version + " 版，摘要 " + before.sha256.slice(0, 12) + "）\n");

  // ── B2 从服务端打开 ────────────────────────────────────────────────
  await step("B2 从服务端取件并画出首屏", async () => {
    const r = await page.evaluate(() => window.__poc.openFromServer(1));
    await waitEditorPainted(page);
    await page.screenshot({ path: path.join(OUT, "b2-opened.png") });
    return { openMs: r.ms, serverVersion: r.version, key: r.key };
  });

  // ── B7 插件页签 / 面板 ─────────────────────────────────────────────
  const pluginInfo = await step("B7 插件真的跑起来了（面板初始化完，且收到了配置）", async () => {
    const ready = await page.waitForFunction(() => window.__poc.pluginReady(), null, { timeout: 60000 })
      .then((h) => h.jsonValue());
    must(ready && ready.guid, "插件没报告初始化完成");
    must(ready.options && ready.options.probe === OPTIONS_PROBE,
      "插件没收到后端下发的配置，实得 " + JSON.stringify(ready.options));
    await page.screenshot({ path: path.join(OUT, "b7-plugin-panel.png") });
    return { guid: ready.guid, options: ready.options };
  });

  // ── B8 插公式 ──────────────────────────────────────────────────────
  await step("B8 插公式：导出的 document.xml 里出现 <m:oMath>", async () => {
    await clickPluginButton(page, "btn-formula");
    await page.waitForTimeout(3000);
    const out = await page.evaluate(() => window.__poc.exportBase64());
    const xml = Buffer.from(out.base64, "base64");
    fs.writeFileSync(path.join(OUT, "b8-formula.docx"), xml);
    const doc = documentXml(path.join(OUT, "b8-formula.docx"));
    must(doc.includes("<m:oMath"), "导出的文档里没有 <m:oMath>——公式没进去，或只进去了纯文本");
    return { exportedBytes: out.size, hasOMath: true };
  });

  // ── B9 文档内按钮 ──────────────────────────────────────────────────
  await step("B9 文档里那个按钮：插入带按钮的一块，点它，痕迹进了文档", async () => {
    await clickPluginButton(page, "btn-question");
    await page.waitForTimeout(3500);
    const where = await clickContentControlButton(page);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, "b9-cc-button.png") });

    const out = await page.evaluate(() => window.__poc.exportBase64());
    fs.writeFileSync(path.join(OUT, "b9-clicked.docx"), Buffer.from(out.base64, "base64"));
    const doc = documentXml(path.join(OUT, "b9-clicked.docx"));
    must(doc.includes(CLICK_MARK), "点了按钮但文档里没有它该留下的那段字");
    return { clickMarkFound: true, buttonAt: where };
  });

  // ── B10 配置下发通道 ───────────────────────────────────────────────
  await step("B10 后端下发的配置到得了插件，且能被写进文档", async () => {
    // 先把光标挪出内容控件，否则这一次粘贴会顶掉上一条留下的字（见 moveCursorToEnd）
    await moveCursorToEnd(page);
    await clickPluginButton(page, "btn-options");
    await page.waitForTimeout(3000);
    const out = await page.evaluate(() => window.__poc.exportBase64());
    fs.writeFileSync(path.join(OUT, "b10-options.docx"), Buffer.from(out.base64, "base64"));
    const doc = documentXml(path.join(OUT, "b10-options.docx"));
    must(doc.includes(OPTIONS_PROBE), "文档里没有那个配置记号");
    return { probe: OPTIONS_PROBE };
  });

  // ── B3 编辑 ────────────────────────────────────────────────────────
  await step("B3 真键盘往正文里敲字", async () => {
    await typeIntoDocument(page, TYPED_MARK);
    return { typed: TYPED_MARK };
  });

  // ── B4 存件 ────────────────────────────────────────────────────────
  const saveResult = await step("B4 点「保存到服务器」，服务端收下并回了新版本号", async () => {
    const r = await page.evaluate(() => window.__poc.saveToServer(1));
    must(r.version === before.version + 1, "版本号应当从 " + before.version + " 变成 " + (before.version + 1) + "，实得 " + r.version);
    return r;
  });

  // ── B5 服务端那份真的变了（判据取磁盘） ────────────────────────────
  await step("B5 服务端磁盘上那份真的变了（且改动之前那份里确实没有这些字）", async () => {
    const after = storageMeta(1);
    must(after.version === before.version + 1, "meta 里的版本没跟上");
    must(after.sha256 !== before.sha256, "新旧两版摘要一样——文件根本没变");
    must(saveResult && after.sha256 === saveResult.sha256, "磁盘上的摘要与接口回的对不上");

    const newXml = documentXml(versionPath(1, after.version));
    const oldXml = documentXml(versionPath(1, before.version));

    // 正向：新版里该有的东西
    must(newXml.includes(TYPED_MARK), "服务端新版里没有敲进去的字");
    must(newXml.includes(CLICK_MARK), "服务端新版里没有按钮留下的字");
    must(newXml.includes(OPTIONS_PROBE), "服务端新版里没有那个配置记号");
    must(newXml.includes("<m:oMath"), "服务端新版里没有公式");
    must(newXml.includes("一次函数"), "服务端新版里原文没了");

    // 反向（免费探针）：**旧版里必须没有这些**。
    // 少了这一条的话，只要 documentXml 恒返回一个含记号的串，上面五条就全是恒真的。
    must(!oldXml.includes(TYPED_MARK), "旧版里居然有敲进去的字——断言是恒真的，判据无效");
    must(!oldXml.includes(CLICK_MARK), "旧版里居然有按钮的痕迹——断言是恒真的");
    must(!oldXml.includes("<m:oMath"), "旧版里居然有公式——断言是恒真的");

    return {
      fromVersion: before.version, toVersion: after.version,
      fromSha: before.sha256.slice(0, 12), toSha: after.sha256.slice(0, 12),
      fromBytes: before.size, toBytes: after.size,
    };
  });

  // ── B6 没票不许写 ──────────────────────────────────────────────────
  await step("B6 没票不许写：401，且磁盘上不多出一版", async () => {
    const v0 = storageMeta(1).version;
    const r = await api("/api/documents/1/content", {
      method: "POST", headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("PKfake"),
    });
    must(r.status === 401, "不带票的写应当 401，实得 " + r.status);
    must(storageMeta(1).version === v0, "被拒了却还是多出了一版");
    must(!fs.existsSync(versionPath(1, v0 + 1)), "磁盘上多出了 v" + (v0 + 1));

    // 顺带：票是真的，但里面没有这份文档 → 403，不是 401
    const s = await api("/api/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentIds: [999] }),
    });
    const otherToken = JSON.parse(s.text).token;
    const r2 = await api("/api/documents/1/content", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", authorization: "Bearer " + otherToken },
      body: Buffer.from("PKfake"),
    });
    must(r2.status === 403, "票里没有这份文档时应当 403，实得 " + r2.status);
    return { version: v0 };
  });

  // ── B7b 对照：把登记与下发都关掉，插件就不该出现 ────────────────────
  await step("B7b 对照：不登记也不下发配置时，插件不出现（证明上面那次是被我们招出来的）", async () => {
    await api("/api/_probe/plugin-registry", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    try {
      const p2 = await ctx.newPage();
      await p2.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
      await p2.waitForFunction(() => window.__pocReady === true, null, { timeout: 30000 });
      await p2.evaluate(() => window.__poc.openFromServer(1, { plugins: "off" }));
      await waitEditorPainted(p2);
      await p2.waitForTimeout(6000);
      const ready = await p2.evaluate(() => window.__poc.pluginReady());
      must(ready === null, "关掉之后插件居然还在：" + JSON.stringify(ready));
      await p2.screenshot({ path: path.join(OUT, "b7b-no-plugin.png") });
      await p2.close();
      return { pluginAbsent: true };
    } finally {
      await api("/api/_probe/plugin-registry", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
    }
  });

  // ── B11 那句「设了 cdnOrigin 就进跨源模式」到底对不对 ────────────────
  await step("B11 核实旧说法：同源的绝对地址不该被当成跨源", async () => {
    const same = await page.evaluate((o) => window.__poc.probeCdnMode(o), WEB_ORIGIN + "/packages");
    const cross = await page.evaluate(() => window.__poc.probeCdnMode("https://cdn.example.com/packages"));
    must(same.isCdnMode === false, "同源绝对地址被判成了跨源");
    must(cross.isCdnMode === true, "真跨源地址没被判成跨源");
    return { sameOrigin: same, crossOrigin: cross };
  });

  await step("B12 导出回落成原文件时，前端拒绝上传而不是报「保存成功」", async () => {
    // 直接看代码路径能不能被触发太贵（要造一个超大 office xml），
    // 这里退一步：确认那一格**被读了**，且读到 true 时走的是抛错分支。
    const hasGuard = await page.evaluate(async () => {
      const src = String(window.__poc.saveToServer);
      return src.includes("isOriginalFileFallback") && src.includes("拒绝上传");
    });
    must(hasGuard, "保存路径里没有查 isOriginalFileFallback");
    return { note: "静态确认：保存路径读了那一格并在为真时抛错。真触发它要造超限文档，见 FINDINGS。" };
  });

  // ── B13 镜像自带的官方插件真的登记上了 ──────────────────────────────
  // 上游那个包的登记表是 `{"pluginsData":[]}` 一个空壳——**那是「插件用不了」的
  // 第一个原因**：编辑器拿这份表里的字符串直接去取插件配置，表空就一个都不出现，
  // 包括镜像自带的那 11 个官方插件。这条断言判的是「表里真有东西且取得到」。
  await step("B13 镜像自带的官方插件登记上了，且每一条都取得到", async () => {
    const r = await api("/packages/onlyoffice/" + SDK_VERSION + "/plugins.json");
    must(r.status === 200, "取登记表回了 HTTP " + r.status);
    const data = JSON.parse(r.text);
    const 自带 = (data.pluginsData || []).filter((u) => u.includes("/sdkjs-plugins/"));
    const 我们的 = (data.pluginsData || []).filter((u) => u.includes("/plugins/config.json"));
    must(自带.length >= 10, "自带插件只登记了 " + 自带.length + " 条，上游那份空壳就是 0 条");
    must(我们的.length === 1, "我们自己那个插件没在表里");
    // ⚠ 登记上了不等于取得到——地址拼错的话表是满的而每条都 404，且不报错。
    const 取不到 = [];
    for (const u of 自带) {
      const rr = await fetch(u);
      if (!rr.ok) { 取不到.push(rr.status + " " + u); continue; }
      const cfg = await rr.json();
      if (!cfg.guid) 取不到.push("没有 guid: " + u);
    }
    must(取不到.length === 0, "这些登记项取不到：" + 取不到.slice(0, 3).join(" / "));
    return { 自带插件数: 自带.length, 我们的插件数: 我们的.length };
  });

  // ── B14 PDF 打得开（上游缺 pdfeditor，症状是白页且不出声）────────────
  await step("B14 打开一份 PDF：加载的是 pdfeditor，且画布上真的画出了东西", async () => {
    const p3 = await ctx.newPage();
    await p3.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
    await p3.waitForFunction(() => window.__pocReady === true, null, { timeout: 30000 });
    await p3.evaluate(() => window.__poc.openFromServer(2));
    await waitEditorPainted(p3);

    // 判据一：最后落在 pdfeditor 那个应用上。**这正是上游缺的那一块**——
    // sdkjs 里的 pdf 解析那一半它有，缺的只是 web-apps 下这个加载入口。
    //
    // ⚠ **要取 iframe 当前的地址，不能取它的 src 属性。** 编辑器先加载
    // `apps/common/index.html`，那是一个分派页，它读完参数再 location.replace 到
    // `pdfeditor/main/index.html`；src 属性停在跳转前那个值不会变。
    // 顺带说明了上游那个缺陷的形状：**没有 pdfeditor 目录时，这一跳落到 404，
    // 页面白着而一句错都不报。**
    const 落点 = await p3.$eval(EDITOR_IFRAME, (f) => {
      try { return f.contentWindow.location.href; } catch { return "（读不到）"; }
    });
    must(/pdfeditor/.test(落点), "编辑器没落在 pdfeditor 上，而是：" + 落点);

    // 判据二：画布上有深色像素。**白页正是上游那个缺陷的症状**，
    // 所以「画出来了」这件事必须取像素，不能取「接口回报就绪」。
    const 深色 = await p3.evaluate((sel) => {
      const d = document.querySelector(sel).contentDocument;
      const cs = Array.from(d.querySelectorAll("canvas")).filter((c) => c.width > 400 && c.height > 400);
      let n = 0;
      for (const c of cs) {
        const g = c.getContext("2d");
        if (!g) continue;
        const px = g.getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] < 128 && px[i + 1] < 128 && px[i + 2] < 128 && px[i + 3] > 200) n++;
        }
      }
      return n;
    }, EDITOR_IFRAME);
    must(深色 > 50, "画布上几乎没有深色像素（" + 深色 + " 个）——这就是白页");

    await p3.screenshot({ path: path.join(OUT, "b14-pdf.png") });
    await p3.close();
    return { 编辑器: 落点.split("?")[0].split("/").slice(-3).join("/"), 深色像素: 深色 };
  });

  // ── B15 两种 PDF 各去各的地方，而且都真的载进去了 ──────────────────
  //
  // 打开 PDF 时编辑器先加载一个分派页，它判断这是不是一份**带可编辑内容的 PDF**
  // （OnlyOffice 自己导出的那种），再决定往哪跳：
  //
  //   是 → documenteditor（能填能改）      不是 → pdfeditor（看和批注）
  //
  // ⚠ **必须两份一起验。** 这个判断曾经永远回「不是」（它要的那个端点我们没有，请求 404），
  // 而在只有普通 PDF 的测试里，一个永远回「不是」的判断与正确的判断表现得一模一样。
  // 3 号那份可编辑 PDF 就是把这两者分开的那个输入。
  await step("B15 两种 PDF 各去各的应用，且都真的画出了纸张", async () => {
    const 结果 = [];
    for (const 条 of [
      { 文档: 2, 叫什么: "普通 PDF", 该落在: "pdfeditor" },
      { 文档: 3, 叫什么: "可编辑 PDF", 该落在: "documenteditor" },
    ]) {
      const p = await ctx.newPage();
      try {
        await p.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
        await p.waitForFunction(() => window.__pocReady === true, null, { timeout: 30000 });
        await p.evaluate((id) => window.__poc.openFromServer(id), 条.文档);
        await waitEditorPainted(p);
        await p.waitForTimeout(4000);

        // ⚠ 取 iframe **当前**地址，不是 src 属性——分派页跳转后属性不变。
        const 落点 = await p.$eval(EDITOR_IFRAME, (fr) => {
          try { return fr.contentWindow.location.href; } catch { return ""; }
        });
        const 应用 = (落点.match(/[/]apps[/]([a-z]+)[/]main[/]/) || [])[1] ?? "认不出";
        must(应用 === 条.该落在, 条.叫什么 + " 落在 " + 应用 + "，该落在 " + 条.该落在);

        // 判据取像素：**纸张**画出来了才算文档载进去了。
        // ⚠ 别拿「内容像素」当通用判据——3 号那份模板本来就是空白的，
        // 它载进去之后也没有深色内容。
        const 像素 = await p.evaluate((sel) => {
          const d = document.querySelector(sel).contentDocument;
          const cs = Array.from(d.querySelectorAll("canvas")).filter((c) => c.width > 300 && c.height > 300);
          let 白 = 0;
          for (const c of cs) {
            const g = c.getContext("2d");
            if (!g) continue;
            const px = g.getImageData(0, 0, c.width, Math.min(c.height, 500)).data;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240 && px[i + 3] > 200) 白++;
            }
          }
          return 白;
        }, EDITOR_IFRAME);
        must(像素 > 10000, 条.叫什么 + " 没画出纸张（近白像素 " + 像素 + "）——文档没载进去");

        // 报错框：可编辑 PDF 曾经在这里弹「文件的扩展名不一致」，而工具栏是齐的。
        const 报错 = await p.evaluate((sel) => {
          const d = document.querySelector(sel).contentDocument;
          return Array.from(d.querySelectorAll(".asc-window, [class*=error]"))
            .map((x) => (x.innerText || "").replace(/\s+/g, " ").trim())
            .filter((t) => t.includes("错误") || t.includes("出错"))
            .join(" | ").slice(0, 200);
        }, EDITOR_IFRAME);
        must(!报错, 条.叫什么 + " 弹了报错框：" + 报错);

        await p.screenshot({ path: path.join(OUT, "b15-doc" + 条.文档 + ".png") });
        结果.push({ [条.叫什么]: { 应用, 纸张像素: 像素 } });
      } finally {
        await p.close();
      }
    }
    return { 逐份: 结果 };
  });

  // ── B16 编辑器与查看器是两档，不是一件事 ────────────────────────────────
  //
  // 组件把挑应用入口的那一格写死成 `desktop`，所以在这之前**永远只加载完整编辑器**。
  // 现在有了 `variant`，同一份 docx 两档各开一遍，验三样：
  //
  //   ① **落点不同**——`documenteditor/main` 对 `documenteditor/embed`。
  //     这是「切没切过去」唯一说得清的判据：两档的接口回报、事件、就绪状态全都一样。
  //   ② 查看器那档**真的画出了纸张与内容**（判据取像素，不取「就绪」）。
  //   ③ ⚠ **反向断言**：查看器那档**没有**插件面板、**没有**功能区标签页。
  //     少了这一条，「切过去了」与「没切过去但恰好也画出来了」分不开——
  //     而它同时是一条**免费探针**：编辑器那档必须两样都有。要是我这几个选择器写错了、
  //     恒回 0，编辑器那一半会当场红，不会两边一起静静地绿着。
  //
  // 顺带把法律声明入口也验一遍：换应用**不换容器**（它挂在 `.onlyoffice-container` 上），
  // 所以按理说它还在——**但许可要求的东西不能按理说，要实测**。
  await step("B16 查看器是另一个应用：落点 embed、画得出内容、没有插件面板与工具栏标签（编辑器那档两样都有）", async () => {
    const 画像 = {};
    for (const variant of ["editor", "viewer"]) {
      const p = await ctx.newPage();
      try {
        await p.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
        await p.waitForFunction(() => window.__pocReady === true, null, { timeout: 30000 });
        // ⚠ **走页面上那个下拉框，不走 window.__poc。**
        // 脚本直接调接口的话，控件本身坏了（状态没接上、选了没生效）没有任何东西会红
        // ——「手点着好使」与「脚本跑绿」变成两件事，而这个项目刻意不许它们分开。
        if (variant === "viewer") {
          await p.selectOption("#variant-pick", "viewer");
        } else {
          await p.evaluate(() => window.__poc.openFromServer(1));
        }
        await waitEditorPainted(p);

        // 编辑器那档等插件真的起来再数，否则数到的是「还没来得及出现」而不是「没有」。
        // 查看器那档没有这个信号，固定等一会儿——它要证明的是「等了也没有」。
        if (variant === "editor") {
          await p.waitForFunction(() => window.__poc.pluginReady(), null, { timeout: 60000 });
        }
        await p.waitForTimeout(6000);

        // ⚠ 取 iframe **当前**地址，不是 src 属性。
        const 落点 = await p.$eval(EDITOR_IFRAME, (f) => {
          try { return f.contentWindow.location.href; } catch { return ""; }
        });

        const 界面 = await p.evaluate((sel) => {
          const d = document.querySelector(sel).contentDocument;
          const 数 = (q) => d.querySelectorAll(q).length;
          const cs = Array.from(d.querySelectorAll("canvas")).filter((c) => c.width > 300 && c.height > 300);
          let 白 = 0;
          let 黑 = 0;
          for (const c of cs) {
            const g = c.getContext("2d");
            if (!g) continue;
            const px = g.getImageData(0, 0, c.width, Math.min(c.height, 500)).data;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i + 3] < 200) continue;
              if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240) 白++;
              else if (px[i] < 128 && px[i + 1] < 128 && px[i + 2] < 128) 黑++;
            }
          }
          return {
            纸张: 白,
            内容: 黑,
            // 插件面板：每个跑起来的插件都会开一个 iframe_<guid>。
            插件iframe: 数('iframe[id^="iframe_"]'),
            // 功能区那排标签（文件/开始/插入…）。embed 那个应用一个都没有。
            标签页: 数(".ribtab"),
            body类: d.body.className,
          };
        }, EDITOR_IFRAME);

        // 法律声明入口挂在主页面的 .onlyoffice-container 上，不在 iframe 里。
        //
        // ⚠ **光量宽高不够**：一个被别的东西整个盖住的元素，
        // `getBoundingClientRect()` 照样回一个正的宽高——于是「显著可见」这条
        // 许可要求会在一次纯样式改动里静静地失效。所以还要问一句
        // `elementFromPoint`：它中心那个点上，最上面的是不是它自己。
        const 法律 = await p.evaluate(() => {
          const b = document.querySelector("[data-onlyoffice-legal-notice]");
          if (!b) return { 有: false, 可见: false, 没被盖住: false, 在视口里: false };
          const r = b.getBoundingClientRect();
          const 最上面的 = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + r.height / 2),
          );
          return {
            有: true,
            可见: r.width > 0 && r.height > 0,
            在视口里: r.top >= 0 && r.left >= 0
              && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
            没被盖住: !!最上面的 && (最上面的 === b || b.contains(最上面的)),
            那个点上是: 最上面的 ? (最上面的.tagName + "." + (最上面的.className || "")).slice(0, 60) : "(空)",
            文字: (b.textContent || "").trim(),
          };
        });

        // 顺手把「只读」那个按钮点一下，验它**不是**切到查看器那一档：
        // 只读是同一个应用关掉编辑，落点必须还在 main。两档要是被谁做成了一件事，
        // 这一条会红——而在这之前，页面上那个按钮一条实测都没碰过。
        let 只读之后 = null;
        if (variant === "editor") {
          const 之前 = 落点;
          await p.getByRole("button", { name: /切成只读/ }).click();
          await p.waitForTimeout(4000);
          const 之后 = await p.$eval(EDITOR_IFRAME, (f) => {
            try { return f.contentWindow.location.href; } catch { return ""; }
          });
          只读之后 = { 落点没变: 之前.split("?")[0] === 之后.split("?")[0], 落点: 之后 };
        }

        await p.screenshot({ path: path.join(OUT, "b16-" + variant + ".png") });
        画像[variant] = { 落点, ...界面, 法律, 只读之后 };
      } finally {
        await p.close();
      }
    }

    const e = 画像.editor;
    const v = 画像.viewer;

    // ① 落点
    must(/\/documenteditor\/main\//.test(e.落点), "编辑器那档没落在 documenteditor/main：" + e.落点);
    must(/\/documenteditor\/embed\//.test(v.落点), "查看器那档没落在 documenteditor/embed：" + v.落点);

    // ② 查看器真的画出来了。**纸张与内容都要**——这份教案不是空文档，
    //    只画出白纸没有字，说明壳起来了而文档没进去。
    must(v.纸张 > 10000, "查看器那档没画出纸张（近白像素 " + v.纸张 + "）——文档没载进去");
    must(v.内容 > 500, "查看器那档画了纸没有字（深色像素 " + v.内容 + "）");

    // ③ 反向断言 + 它的对照组。**两边都要断言，否则选择器写错了没人知道。**
    must(e.插件iframe > 0, "对照组塌了：编辑器那档也没有插件面板（选择器可能写错了，那样这条断言恒真）");
    must(e.标签页 > 0, "对照组塌了：编辑器那档也没有功能区标签（选择器可能写错了）");
    must(v.插件iframe === 0, "查看器那档竟然有 " + v.插件iframe + " 个插件面板——那说明它还在 main 里");
    must(v.标签页 === 0, "查看器那档竟然有 " + v.标签页 + " 个功能区标签——那说明它还在 main 里");

    // 许可要求的那个入口，两档都得在，而且得真的看得见。
    for (const [名, x] of [["编辑器", e], ["查看器", v]]) {
      must(x.法律.有, 名 + "那档没有法律声明入口——许可的附加条款第三条要求它在界面上");
      must(x.法律.可见, 名 + "那档的法律声明入口在 DOM 里但看不见（宽高为 0）");
      must(x.法律.在视口里, 名 + "那档的法律声明入口跑到视口外面去了——那就不「显著可见」了");
      must(x.法律.没被盖住,
        名 + "那档的法律声明入口被别的东西盖住了（它中心那个点上最上面的是 " +
        x.法律.那个点上是 + "）——宽高还在，但人点不到，许可那条不算满足");
    }

    // 只读 ≠ 查看器：切只读之后还得留在 main。
    must(e.只读之后 && e.只读之后.落点没变,
      "点了「切成只读」之后编辑器换了应用（落到 " + (e.只读之后 && e.只读之后.落点) +
      "）——只读与查看器被做成一件事了，它们是两档");

    return {
      编辑器: { 入口: e.落点.split("?")[0].split("/").slice(-3).join("/"), 纸张: e.纸张, 内容: e.内容, 插件面板: e.插件iframe, 标签页: e.标签页 },
      查看器: { 入口: v.落点.split("?")[0].split("/").slice(-3).join("/"), 纸张: v.纸张, 内容: v.内容, 插件面板: v.插件iframe, 标签页: v.标签页, body类: v.body类 },
    };
  });

  await browser.close();

  const failed = results.filter((r) => r.status === "FAIL");
  const report = {
    when: new Date().toISOString(),
    app: WEB_ORIGIN,
    api: API,
    consoleErrors: consoleErrors.slice(0, 20),
    results,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  console.log("\n" + "=".repeat(64));
  console.log("过 " + (results.length - failed.length) + " / " + results.length + "，报告写在 out/report.json");
  if (consoleErrors.length) {
    console.log("浏览器控制台里有 " + consoleErrors.length + " 条错误，前三条：");
    consoleErrors.slice(0, 3).forEach((e) => console.log("   " + e));
  }
  // 一条都没跑 → 2。「没过」与「根本没跑」不是一回事。
  if (results.length === 0) process.exit(2);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("实测本身崩了：", e);
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ crashed: String(e), results }, null, 2));
  process.exit(results.length === 0 ? 2 : 1);
});
