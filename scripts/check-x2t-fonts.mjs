#!/usr/bin/env node
/**
 * 核一遍 PDF 导出用的那套字体：**每个文件里装的，真的是它名字说的那一款吗。**
 *
 *   node scripts/check-x2t-fonts.mjs
 *
 * 零设施、亚秒级，随时能跑。
 *
 * ── 它在防什么 ──────────────────────────────────────────────────────────────
 *
 * 上游那套字体里，名字叫 `Carlito-Bold.ttf` 的文件装的是**斜体**，
 * 叫 `Carlito-Italic.ttf` 的装的是**粗体**；Arial 那四个也一样反。
 * 组件是按文件名把字体喂给转换引擎的，于是导出的 PDF 里粗体印成斜体、斜体印成粗体
 * ——**而这件事从头到尾没有任何一处会报错**。
 *
 * 一个只在导出结果里才看得出来、且没人会去逐字比对的错误，靠人是防不住的。
 * 所以这里立一条判据：打开字体，读它自己声明的样式，与文件名要求的对一遍。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  全对
 *   1  有对不上的
 *   2  **一个都没核**（目录空的、或者根本不在）——「没过」与「根本没跑」是两回事，
 *      混成一个码的话，人看到绿会以为核过了，而实际上一次都没跑。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStyle, styleFromFileName } from "./lib/ttf-style.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "vendor/x2t-fonts");

let 核过 = 0;
let 不对 = 0;

if (!fs.existsSync(DIR)) {
  console.error("✗ " + DIR + " 不在。先跑 node scripts/build-x2t-fonts.mjs");
  process.exit(2);
}

const files = fs.readdirSync(DIR).filter((f) => /[.]ttf$/i.test(f)).sort();

for (const f of files) {
  const buf = fs.readFileSync(path.join(DIR, f));
  const 应该是 = styleFromFileName(f);
  const s = readStyle(buf);
  核过++;
  if (!s) {
    console.error(`✗ ${f}：读不出 OS/2 或 head 表，这不像一个 TrueType`);
    不对++;
    continue;
  }
  if (s.样式 !== 应该是) {
    console.error(
      `✗ ${f}：名字说它是「${应该是}」，字体自己说是「${s.样式}」（子族名 ${JSON.stringify(s.子族)}）`,
    );
    不对++;
    continue;
  }
  console.log(`✓ ${f.padEnd(30)} ${s.样式}`);
}

// ── 反向断言（免费探针）────────────────────────────────────────────────────
//
// 上面全绿有两种可能：判据真的在核，或者判据其实恒真。
// 分开这两种的办法只有一个：造一个**该红的**输入，看它红不红。
// 这里拿斜体那份的字节，问它「你是粗体吗」——必须回答不是。
const 斜体文件 = files.find((f) => styleFromFileName(f) === "斜");
if (!斜体文件) {
  console.error("✗ 探针跑不了：一个斜体文件都没有，上面那些绿说明不了判据在工作");
  process.exit(2);
}
const 探针 = readStyle(fs.readFileSync(path.join(DIR, 斜体文件)));
if (!探针 || 探针.样式 === "粗") {
  console.error(`✗ 探针没红：把 ${斜体文件} 当成粗体来判，它居然通过了——判据是坏的`);
  process.exit(1);
}
console.log(`\n探针：拿 ${斜体文件} 冒充粗体，判为「${探针.样式}」——判据会红，上面那些绿是真的。`);

if (核过 === 0) {
  console.error("✗ 一个字体都没核到");
  process.exit(2);
}
if (不对) {
  console.error(`\n✗ ${核过} 个里有 ${不对} 个对不上`);
  process.exit(1);
}
console.log(`\n✓ ${核过} 个字体全对`);
