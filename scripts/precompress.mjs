#!/usr/bin/env node
/**
 * 给 `vendor/` 那棵静态树的每个大文件配一份 `.gz`，让发文件的那一头零 CPU 地发压缩过的字节。
 *
 *   node scripts/precompress.mjs           # 配齐（增量，已有且不旧的跳过）
 *   node scripts/precompress.mjs --check   # 只报覆盖率与能省多少，不写
 *   node scripts/precompress.mjs --clean   # 全删
 *   node scripts/precompress.mjs --min 4096
 *
 * ── 为什么要有这一步 ────────────────────────────────────────────────────────
 *
 * 这棵树发出去的字节今天是**没压过的**，两头都关着：
 *
 * - 镜像里本来每个文件旁边都有一份 `.gz`，而 `scripts/extract-assets.mjs` 把它们全删了。
 *   删的理由原话是「没有静态服务器会去读这些」——**那句话是错的**：
 *   nginx 的 `gzip_static on` 读的就是这些，读不到才回落到现压或不压。
 * - 发布上去那一侧的 nginx 也没开压缩。nginx 默认的 `gzip_types` 只有 `text/html`，
 *   所以就算继承到一条 `gzip on`，js 与字体照样是原样发出去的。
 *
 * ⚠ **两头各关一半，症状是「谁看都正常」**：页面能开、缓存生效、请求数正常，
 * 只有冷载的字节数偏大，而那个数平时没人盯。
 *
 * ── 为什么在这里现配，不去镜像里取那一份 ────────────────────────────────────
 *
 * 取那一份要多传一趟（整棵树差不多翻倍），而且**只覆盖镜像里有的文件**——
 * 我们后处理生成的那几份（`api.js`、`plugins.json`、按类型分开的预载页）它没有。
 * 在本机现配一次，两件事一起解决，而且换静态服务器也带得走。
 *
 * ── 压缩比（实测，社区版 9.4.0.129）────────────────────────────────────────
 *
 *   sdkjs/word/sdk-all.js                  27.53 MB → 4.49 MB   (16%)
 *   sdkjs/word/sdk-all-min.js               3.36 MB → 0.61 MB   (18%)
 *   web-apps/…/documenteditor/main/code.js  2.20 MB → 0.32 MB   (14%)
 *   sdkjs/common/libfont/engine/fonts.wasm  3.45 MB → 1.36 MB   (40%)
 *   fonts/070（微软雅黑 Regular）           18.79 MB → 11.86 MB  (63%)
 *
 * 中文字体只压得掉四成上下——它们是这棵树里**压完之后剩下的大头**。
 *
 * ── 几条判据 ────────────────────────────────────────────────────────────────
 *
 * 一、**压完不比原文件小就不留那一份**。留着的话发出去的字节反而更多，
 *     而两边都回 200，没有任何东西报错。
 * 二、**已经压过的格式不碰**（png / jpg / woff2 / zip …）。
 *     ⚠ 但 `fonts/` 底下那 245 个文件**没有扩展名**，它们正是最该压的那一批——
 *     所以这里按扩展名放行，不按扩展名挑，认不出扩展名的一律压。
 * 三、增量：`.gz` 比原文件新就跳过。改完一个文件重跑一遍即可。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  配好了 / --check 全覆盖
 *   1  --check 发现有该配而没配的
 *   2  **一个文件都没看**（vendor 不在）——与「都配好了」不是一回事
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { PROJECT_ROOT } from "../config.mjs";

const VENDOR = path.join(PROJECT_ROOT, "vendor");

/** 已经是压缩格式的，再压一遍只会变大。 */
const 别压 = new Set([
  ".gz", ".br", ".zip", ".7z", ".xz", ".bz2",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
  ".woff", ".woff2",
  ".mp3", ".mp4", ".m4a", ".webm", ".ogg", ".ogv",
]);

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const CHECK = process.argv.includes("--check");
const CLEAN = process.argv.includes("--clean");
/** 比这个小的不配：省下来的字节抵不上多一个文件的代价。 */
const MIN = argOf("--min", 1024);

const 人读 = (n) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + " GB"
    : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + " MB"
      : (n / 1024).toFixed(0) + " KB";

function* 走(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* 走(p);
    else if (e.isFile()) yield p;
  }
}

function main() {
  if (!fs.existsSync(VENDOR)) {
    console.error("✗ 没有 vendor/：先跑 node scripts/extract-assets.mjs");
    process.exit(2);
  }

  if (CLEAN) {
    let n = 0;
    let 字节 = 0;
    for (const f of 走(VENDOR)) {
      if (path.extname(f).toLowerCase() !== ".gz") continue;
      字节 += fs.statSync(f).size;
      fs.rmSync(f);
      n++;
    }
    console.log(`✓ 删掉 ${n} 份预压缩副本，腾出 ${人读(字节)}`);
    return;
  }

  const t0 = Date.now();
  let 看过 = 0;
  let 配了 = 0;
  let 跳过_已有 = 0;
  let 跳过_太小 = 0;
  let 跳过_格式 = 0;
  let 不划算 = 0;
  let 原字节 = 0;
  let 压后字节 = 0;
  const 缺的 = [];

  for (const f of 走(VENDOR)) {
    const ext = path.extname(f).toLowerCase();
    if (别压.has(ext)) { 跳过_格式++; continue; }
    看过++;
    const st = fs.statSync(f);
    if (st.size < MIN) { 跳过_太小++; continue; }

    const gz = f + ".gz";
    if (fs.existsSync(gz)) {
      const gzst = fs.statSync(gz);
      if (gzst.mtimeMs >= st.mtimeMs) {
        跳过_已有++;
        原字节 += st.size;
        压后字节 += gzst.size;
        continue;
      }
    }

    if (CHECK) {
      缺的.push(f);
      continue;
    }

    const buf = fs.readFileSync(f);
    const out = zlib.gzipSync(buf, { level: 9 });
    if (out.length >= buf.length) {
      // 压不小就别留——留着等于发更多字节，而两边都回 200。
      if (fs.existsSync(gz)) fs.rmSync(gz);
      不划算++;
      原字节 += buf.length;
      压后字节 += buf.length;
      continue;
    }
    fs.writeFileSync(gz, out);
    配了++;
    原字节 += buf.length;
    压后字节 += out.length;
    if (配了 % 500 === 0) process.stdout.write(`\r  配到 ${配了} 份…`);
  }

  if (配了 >= 500) process.stdout.write("\r" + " ".repeat(30) + "\r");

  if (CHECK) {
    if (缺的.length) {
      console.error(`✗ 有 ${缺的.length} 个文件没配 .gz（或者那份比源文件旧），例如：`);
      for (const f of 缺的.slice(0, 5)) console.error("    " + path.relative(PROJECT_ROOT, f));
      console.error("  跑一遍：node scripts/precompress.mjs");
      process.exit(1);
    }
    // ⚠ 报的是**真的配着 .gz 的那个数**，不是「看过多少个」——后者把太小的那一批也算进去了，
    // 于是这行字会比实际覆盖的多出几百个，而它看着完全正常。
    console.log(`✓ ${跳过_已有} 个文件配着 .gz（大于 ${MIN} 字节的那一批；另有 ${跳过_太小} 个太小、${跳过_格式} 个本来就是压缩格式）`);
    console.log(`  发出去的字节：${人读(原字节)} → ${人读(压后字节)}（${((压后字节 / 原字节) * 100).toFixed(0)}%）`);
    return;
  }

  console.log(`✓ 预压缩完毕（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  console.log(`  新配        ${配了} 份`);
  console.log(`  已有跳过    ${跳过_已有} 份`);
  console.log(`  太小跳过    ${跳过_太小} 个（小于 ${MIN} 字节）`);
  console.log(`  压缩格式    ${跳过_格式} 个（png / woff2 这一类，压了会变大）`);
  console.log(`  压不小      ${不划算} 个（已按判据没留那一份）`);
  console.log(`  发出去的字节 ${人读(原字节)} → ${人读(压后字节)}（${((压后字节 / 原字节) * 100).toFixed(0)}%）`);
  console.log(`\n  ⚠ 发文件那一头也要配上才算数：nginx 是 gzip_static on，本项目的 demo 后端已经会读了。`);
}

main();
