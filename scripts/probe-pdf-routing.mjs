#!/usr/bin/env node
/**
 * 探一探：打开一份 PDF 之后，编辑器最后落在哪个应用上、文档到底载进去没有。
 *
 *   npm run server & npm run dev &
 *   node scripts/probe-pdf-routing.mjs
 *
 * ── 为什么要有这么一条 ──────────────────────────────────────────────────────
 *
 * 打开 PDF 时编辑器先加载一个分派页，它读文件开头 300 字节判断这是不是一份
 * **带可编辑内容的 PDF**，再决定往哪跳：
 *
 *   是 → documenteditor（能填能改）      不是 → pdfeditor（看和批注）
 *
 * 这条探针把两份 PDF 各开一遍，把落点与页面情况并排打出来。
 * **两份一起看才有意义**：一个永远回「不是」的判断，在只有普通 PDF 的测试里
 * 表现得和正确的判断一模一样。
 *
 * ⚠ **别拿「深色像素个数」当通用判据。** 3 号那份是一张**空白**的表单模板，
 * 它载进去之后本来就没有深色内容。区分「空白因为文档是空的」与「空白因为没载进去」
 * 要看别的：画布上有没有画出**纸张**（一大片纯白压在灰底上），以及状态栏报没报页数。
 */

import { chromium } from "playwright";

import { WEB_ORIGIN } from "../config.mjs";

const 要开的 = [
  { 文档: 2, 叫什么: "普通 PDF（手写的最小 PDF，有一行字）", 该落在: "pdfeditor" },
  { 文档: 3, 叫什么: "可编辑 PDF（OnlyOffice 表单模板，空白）", 该落在: "documenteditor" },
];

const EDITOR_IFRAME = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";

/** 在编辑器 iframe 里数像素：纸张（近白）、内容（近黑）、其余。 */
const 数像素 = (sel) => {
  const el = document.querySelector(sel);
  const d = el && el.contentDocument;
  if (!d) return null;
  const cs = Array.from(d.querySelectorAll("canvas")).filter((c) => c.width > 300 && c.height > 300);
  let 白 = 0;
  let 黑 = 0;
  let 其余 = 0;
  for (const c of cs) {
    const g = c.getContext("2d");
    if (!g) continue;
    const px = g.getImageData(0, 0, c.width, Math.min(c.height, 500)).data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const gg = px[i + 1];
      const b = px[i + 2];
      const a = px[i + 3];
      if (a < 200) continue;
      if (r > 240 && gg > 240 && b > 240) 白++;
      else if (r < 128 && gg < 128 && b < 128) 黑++;
      else 其余++;
    }
  }
  return { 画布数: cs.length, 纸张像素: 白, 内容像素: 黑, 其余像素: 其余 };
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();

for (const 条 of 要开的) {
  const page = await ctx.newPage();
  const 没取到 = [];
  page.on("response", (r) => {
    if (r.status() >= 400) 没取到.push(r.status() + " " + r.url().split("/").slice(-2).join("/"));
  });

  console.log("\n──────── " + 条.叫什么 + "（" + 条.文档 + " 号文档） ────────");
  try {
    await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__pocReady === true, { timeout: 30000 });
    await page.evaluate((id) => window.__poc.openFromServer(id), 条.文档);
  } catch (e) {
    console.log("  打开就失败了：" + String(e).split("\n")[0]);
    await page.close();
    continue;
  }

  await page.waitForTimeout(14000);

  const 落点 = await page
    .$eval(EDITOR_IFRAME, (f) => {
      try {
        return f.contentWindow.location.href;
      } catch {
        return "（跨源，读不到）";
      }
    })
    .catch(() => "（连 iframe 都没有）");

  const 画面 = (await page.evaluate(数像素, EDITOR_IFRAME).catch(() => null)) ?? {
    画布数: 0,
    纸张像素: 0,
    内容像素: 0,
    其余像素: 0,
  };

  const 页面 = await page
    .evaluate((sel) => {
      const d = document.querySelector(sel)?.contentDocument;
      if (!d) return { 全文: "", 状态栏: "", 报错框: "" };
      const 全文 = (d.body?.innerText || "").replace(/\s+/g, " ");
      const 状态栏 =
        (d.querySelector("#status-bar, .statusbar, #statusbar")?.innerText || "").replace(/\s+/g, " ") ||
        (全文.match(/第\s*\d+\s*页[^ ]*/) || [""])[0];
      const 报错框 = Array.from(d.querySelectorAll(".asc-window, .modal, [class*=error]"))
        .map((x) => (x.innerText || "").replace(/\s+/g, " "))
        .filter((t) => t.length > 2)
        .join(" | ")
        .slice(0, 200);
      return { 全文: 全文.slice(0, 200), 状态栏, 报错框 };
    }, EDITOR_IFRAME)
    .catch(() => ({ 全文: "（读不到）", 状态栏: "", 报错框: "" }));

  // ⚠ 从完整地址里取应用名。别用 /apps\/(\w+)\//——它会先命中 "web-apps/" 里的 apps。
  const 应用 = (落点.match(/\/apps\/([a-z]+)\/main\//) || [])[1] ?? "（认不出）";
  const 表单标记 = (落点.match(/isForm=(true|false)/) || [])[1] ?? "（没有）";

  console.log("  落在应用   " + 应用 + (应用 === 条.该落在 ? "  ✓ 与预期一致" : "  ✗ 预期 " + 条.该落在));
  console.log("  isForm     " + 表单标记);
  console.log(
    "  画布       " +
      画面.画布数 +
      " 个：纸张 " +
      画面.纸张像素 +
      " / 内容 " +
      画面.内容像素 +
      " / 其余 " +
      画面.其余像素,
  );
  console.log("  状态栏     " + JSON.stringify(页面.状态栏));
  if (页面.报错框) console.log("  ⚠ 报错框   " + JSON.stringify(页面.报错框));
  if (没取到.length) console.log("  没取到     " + [...new Set(没取到)].join(" / "));
  console.log("  页面文字   " + JSON.stringify(页面.全文.slice(0, 150)));

  await page.close();
}

await browser.close();
