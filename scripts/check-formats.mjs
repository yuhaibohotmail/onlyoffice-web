#!/usr/bin/env node
/**
 * 把各种格式的文档逐个打开一遍，出一张表：**哪些打得开、打开之后画没画出东西、导不导得出**。
 *
 *   npm run server & npm run dev &
 *   node scripts/check-formats.mjs
 *   node scripts/check-formats.mjs --only docx,xlsx   # 只跑几个
 *
 * 文档由 `scripts/make-format-fixtures.mjs` 现生成，清单问服务端要
 * （`/api/_probe/fixtures`）——**不在这里抄一份**，抄的那份会与盘上实际有什么漂开，
 * 而漂开的样子是「少测了一个格式，然后全绿」。
 *
 * ── 三列判据，各防一种假通过 ────────────────────────────────────────────────
 *
 * **打开**  接口回报「就绪」不算数。上游那个包缺 PDF 编辑器时，接口照样回报就绪，
 *           页面是白的。所以要看编辑器 iframe 有没有真的落到某个应用上。
 * **画面**  取像素，分两格：**纸张**（近白，说明版面画出来了）与**内容**（近黑，说明有字）。
 *           只看「内容」会把空白文档误判成失败；只看「纸张」会把「画了张白纸但没内容」放过去。
 * **导出**  再走一遍 x2t 的另一半。**只验读不验写，等于只验了一半**——
 *           有的格式读得进来却导不出去。
 *
 * ⚠ 要真设施（两个服务起着 + 真浏览器），**刻意不挂进任何自动检查**。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  全部打得开
 *   1  有打不开的
 *   2  **一个都没测**（清单是空的，或者服务没起）——与「全过」不是一回事
 */

import { chromium } from "playwright";

import { WEB_ORIGIN, API_PORT } from "../config.mjs";

const API = "http://127.0.0.1:" + API_PORT;
const EDITOR_IFRAME = ".onlyoffice-container > iframe:not([data-onlyoffice-preload])";

/** 画布出现之后再等多久才量。实测十几秒才稳定，别调小。加 --quick 可以调到 4 秒先看个大概。 */
const SETTLE_MS = process.argv.includes("--quick") ? 4000 : 12000;

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i > 0 ? new Set(process.argv[i + 1].split(",")) : null;
})();

const 清单 = await fetch(API + "/api/_probe/fixtures")
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => []);

if (!清单.length) {
  console.error(
    "✗ 一个测试文档都没有。\n" +
      "  先跑 node scripts/make-format-fixtures.mjs，再确认后端起着（npm run server）。",
  );
  process.exit(2);
}

// 服务端那份清单里既有手写的三份、也有各种格式那一摊，按 `组` 筛。
// **分组由服务端给，不在这里自己判**——两处各判一次，它们迟早不一致。
const 格式夹具 = 清单.filter((x) => x.组 === "各种格式");
const 要跑的 = only ? 格式夹具.filter((x) => only.has(x.fileType)) : 格式夹具;
if (!要跑的.length) {
  console.error("✗ --only 把所有文档都过滤掉了");
  process.exit(2);
}

console.log(`一共 ${要跑的.length} 份文档，逐个打开。每份要十几秒，请等一会儿。\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const 结果 = [];

for (const 条 of 要跑的) {
  const page = await ctx.newPage();
  const 控制台错 = [];
  page.on("console", (m) => {
    if (m.type() === "error") 控制台错.push(m.text().slice(0, 120));
  });

  const 行 = { 格式: 条.fileType, 文件: 条.文件名, 打开: "—", 应用: "—", 纸张: 0, 内容: 0, 导出: "—", 说明: "" };
  const t0 = Date.now();
  try {
    await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__pocReady === true, { timeout: 30000 });
    await page.evaluate((id) => window.__poc.openFromServer(id), 条.docId);

    // 等编辑器 iframe 出现并画出画布；等不到就是没打开。
    await page.waitForSelector(EDITOR_IFRAME, { timeout: 60000 });
    await page.waitForFunction(
      (sel) => {
        const d = document.querySelector(sel)?.contentDocument;
        return !!d && Array.from(d.querySelectorAll("canvas")).some((c) => c.width > 300 && c.height > 300);
      },
      EDITOR_IFRAME,
      { timeout: 60000 },
    );
    // ⚠ **画布出现 ≠ 已经画完，更 ≠ 可以导出。**
    // 等太短的话，像素数会是 0、导出会挂满 30 秒再超时——两条都看着像
    // 「这个格式打不开」，而其实只是问早了。工作中的探针实测要十几秒才稳定。
    await page.waitForTimeout(SETTLE_MS);

    行.打开 = "开了";
    行.用时 = Date.now() - t0;

    const 落点 = await page.$eval(EDITOR_IFRAME, (f) => {
      try {
        return f.contentWindow.location.href;
      } catch {
        return "";
      }
    });
    行.应用 = (落点.match(/[/]apps[/]([a-z]+)[/]/g) || []).pop()?.replace(/[/]apps[/]|[/]/g, "") ?? "?";

    const 像素 = await page.evaluate((sel) => {
      const d = document.querySelector(sel).contentDocument;
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
      return { 白, 黑 };
    }, EDITOR_IFRAME);
    行.纸张 = 像素.白;
    行.内容 = 像素.黑;

    // 报错框：曾经出现过「工具栏齐全但文档没载进去」，那时页面上就挂着这么一个框。
    const 报错 = await page.evaluate((sel) => {
      const d = document.querySelector(sel).contentDocument;
      return Array.from(d.querySelectorAll(".asc-window, [class*=error]"))
        .map((x) => (x.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t.includes("错误") || t.includes("出错") || /error/i.test(t))
        .join(" | ")
        .slice(0, 120);
    }, EDITOR_IFRAME);
    if (报错) 行.说明 = "弹了报错框：" + 报错;

    // 导出：只验读不验写等于只验了一半。
    try {
      const out = await page.evaluate(() => window.__poc.exportBase64());
      行.导出 = out.fallback ? "回落成原文件" : out.size + " 字节";
    } catch (e) {
      行.导出 = "导不出：" + String(e.message ?? e).slice(0, 60);
    }
  } catch (e) {
    行.打开 = "打不开";
    行.用时 = Date.now() - t0;
    行.说明 = String(e.message ?? e).split("\n")[0].slice(0, 100);
    const err = await page.evaluate(() => window.__poc?.lastError?.() ?? null).catch(() => null);
    if (err) 行.说明 = String(err).slice(0, 140);
  }
  if (!行.说明 && 控制台错.length) 行.说明 = "控制台 " + 控制台错.length + " 条错误";

  结果.push(行);
  const 标 = 行.打开 === "开了" ? (行.内容 > 0 ? "✓" : 行.纸张 > 10000 ? "○" : "✗") : "✗";
  console.log(
    `  ${标} ${行.格式.padEnd(6)} ${行.打开.padEnd(7)} ${String(行.应用).padEnd(18)}` +
      ` 纸张 ${String(行.纸张).padStart(7)}  内容 ${String(行.内容).padStart(6)}  导出 ${行.导出}` +
      (行.说明 ? "  ← " + 行.说明 : ""),
  );

  await page.close();
}

await browser.close();

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(96));
console.log("格式    打开     落在哪个应用        纸张像素   内容像素  导出           用时");
console.log("─".repeat(96));
for (const r of 结果) {
  console.log(
    r.格式.padEnd(8) +
      r.打开.padEnd(9) +
      String(r.应用).padEnd(20) +
      String(r.纸张).padStart(9) +
      String(r.内容).padStart(10) +
      "  " +
      String(r.导出).padEnd(15) +
      String(r.用时 ?? "") +
      "ms",
  );
}
console.log("─".repeat(96));
console.log("✓ 有内容画出来　○ 画了纸张但没内容（文档本身可能就是空的）　✗ 没打开或没画出纸张");

const 没开 = 结果.filter((r) => r.打开 !== "开了");
const 空白 = 结果.filter((r) => r.打开 === "开了" && r.纸张 <= 10000);
console.log(`\n${结果.length} 份里：开了 ${结果.length - 没开.length} 份，没开 ${没开.length} 份，开了但没画出纸张 ${空白.length} 份`);
if (没开.length) console.log("  没开的：" + 没开.map((r) => r.格式).join("、"));
if (空白.length) console.log("  开了却没画出纸张的：" + 空白.map((r) => r.格式).join("、"));

process.exit(没开.length || 空白.length ? 1 : 0);
