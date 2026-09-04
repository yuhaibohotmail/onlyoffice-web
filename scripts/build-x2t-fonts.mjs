#!/usr/bin/env node
/**
 * 配 PDF 导出用的那套字体（浏览器里那个转换引擎要它们）。
 *
 *   node scripts/build-x2t-fonts.mjs
 *   node scripts/build-x2t-fonts.mjs --force
 *
 * ── 为什么不直接用上游那套 ──────────────────────────────────────────────────
 *
 * 上游那个组件包的 `x2t-fonts/` 里有两个问题，**都不报错**：
 *
 * **一、里面是真的 Monotype Arial**（name 表写着 Version 2.82、
 * 「本字体是 Monotype 的财产」）。那不是能随分发包发出去的东西。
 * 我们换成 Liberation Sans——它是专门照 Arial 的字宽做的替代品，SIL OFL 许可，
 * 而且就在我们自己那个社区版镜像里。换掉之后排版宽度不变。
 *
 * **二、粗体和斜体的文件装反了。** 名字叫 `Arial-Bold.ttf` 的文件里装的是斜体，
 * 叫 `Arial-Italic.ttf` 的装的是粗体；Carlito 那四个也一样反。
 * 四个信号一致：name 表的子族名、OS/2 的 fsSelection、head 的 macStyle、字重值。
 * 组件是按文件名映射的，所以**导出 PDF 时粗体印成斜体、斜体印成粗体**，
 * 一句报错都没有。
 *
 * 所以这个脚本除了拷文件，还干一件事：**逐个打开字体，核对它里面自报的样式
 * 与我们给它的名字一致**。对不上就停。这条判据就是上面那个缺陷的探针——
 * 它要是当初存在过，那套字体根本进不来。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DOCUMENT_SERVER as DS } from "../config.mjs";
import { readStyle } from "./lib/ttf-style.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "vendor/x2t-fonts");
const FORCE = process.argv.includes("--force");

const log = (...a) => console.log("→", ...a);
const die = (m) => {
  console.error("✗ " + m);
  process.exit(1);
};

/**
 * 要哪些字体、从容器里哪个文件拿、期望是什么样式。
 * `样式` 那一格就是判据：粗、斜、粗斜、常规，四选一。
 */
const FONTS = [
  // 西文正文：Carlito 与 Calibri 字宽一致
  { 名: "Carlito-Regular.ttf", 源: "core-fonts/crosextra/Carlito-Regular.ttf", 样式: "常规", 许可: "SIL OFL 1.1" },
  { 名: "Carlito-Bold.ttf", 源: "core-fonts/crosextra/Carlito-Bold.ttf", 样式: "粗", 许可: "SIL OFL 1.1" },
  { 名: "Carlito-Italic.ttf", 源: "core-fonts/crosextra/Carlito-Italic.ttf", 样式: "斜", 许可: "SIL OFL 1.1" },
  { 名: "Carlito-BoldItalic.ttf", 源: "core-fonts/crosextra/Carlito-BoldItalic.ttf", 样式: "粗斜", 许可: "SIL OFL 1.1" },

  // Arial 的替代：Liberation Sans 字宽与 Arial 一致
  { 名: "LiberationSans-Regular.ttf", 源: "core-fonts/liberation/LiberationSans-Regular.ttf", 样式: "常规", 许可: "SIL OFL 1.1" },
  { 名: "LiberationSans-Bold.ttf", 源: "core-fonts/liberation/LiberationSans-Bold.ttf", 样式: "粗", 许可: "SIL OFL 1.1" },
  { 名: "LiberationSans-Italic.ttf", 源: "core-fonts/liberation/LiberationSans-Italic.ttf", 样式: "斜", 许可: "SIL OFL 1.1" },
  { 名: "LiberationSans-BoldItalic.ttf", 源: "core-fonts/liberation/LiberationSans-BoldItalic.ttf", 样式: "粗斜", 许可: "SIL OFL 1.1" },

  // 中日韩兜底。⚠ 只有这一款，所以中文的粗体是靠引擎自己加粗描边模拟的。
  { 名: "DroidSansFallback.ttf", 源: "core-fonts/droid/DroidSansFallbackFull.ttf", 样式: "常规", 许可: "Apache 2.0" },
];

function bashOut(script, { binary = false } = {}) {
  const r = spawnSync("bash", ["-c", script], { encoding: binary ? "buffer" : "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) die(`命令失败（退出码 ${r.status}）：\n${script}\n${r.stderr ?? ""}`);
  return binary ? r.stdout : r.stdout.trim();
}

function onDockerHost(cmd) {
  if (!DS.host) return cmd;
  return `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${DS.sshUser}@${DS.host} ${JSON.stringify(cmd)}`;
}

function main() {
  if (fs.existsSync(DEST) && !FORCE) die(`${DEST} 已经有了。要重配加 --force。`);
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });

  const 记录 = [];
  for (const f of FONTS) {
    const remote = `docker exec ${DS.container} cat ${DS.root}/${f.源}`;
    const buf = bashOut(onDockerHost(remote), { binary: true });
    if (!buf || buf.length < 1024) die(`取 ${f.源} 只拿到 ${buf?.length ?? 0} 字节`);

    const s = readStyle(buf);
    if (!s) die(`${f.名}：读不出 OS/2 或 head 表，这不像一个 TrueType`);
    if (s.样式 !== f.样式) {
      die(
        `${f.名} 装的不是「${f.样式}」，字体自己说它是「${s.样式}」（子族名 ${JSON.stringify(s.子族)}）。\n` +
          `  源文件：${f.源}\n` +
          `  ⚠ 这正是上游那套字体犯过的错——粗体文件里装着斜体，导出的 PDF 粗斜互换而不报错。`,
      );
    }

    fs.writeFileSync(path.join(DEST, f.名), buf);
    记录.push({
      文件: f.名,
      源: f.源,
      样式: s.样式,
      子族名: s.子族,
      字节: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      许可: f.许可,
    });
    log(`${f.名.padEnd(30)} ${s.样式.padEnd(4)} ${(buf.length / 1024).toFixed(0).padStart(5)} KB  ${f.许可}`);
  }

  fs.writeFileSync(
    path.join(DEST, "SOURCE.json"),
    JSON.stringify(
      {
        说明: "PDF 导出用的字体是从哪来的。别手改——由 scripts/build-x2t-fonts.mjs 生成。",
        全部取自: DS.image + " 的 core-fonts/",
        镜像ID: DS.imageId,
        取的时间: new Date().toISOString(),
        刻意不带的东西: [
          "Monotype Arial——上游那套里有，但它不是能随分发包发出去的字体，" +
            "已换成字宽一致的 Liberation Sans",
        ],
        每个文件都核过: "打开字体读 OS/2 的 fsSelection 与 head 的 macStyle，与文件名要求的样式一致才收",
        字体: 记录,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`\n✓ 配好了：${DEST}（${记录.length} 个文件，共 ${(记录.reduce((s, r) => s + r.字节, 0) / 1048576).toFixed(1)} MB）`);
  console.log("  每个都核过里面自报的样式与文件名一致——这条判据就是上游那个粗斜互换缺陷的探针。");
}

main();
