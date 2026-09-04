#!/usr/bin/env node
/**
 * 核一件事：**我们照抄的那条规则，原文还是不是那样。**
 *
 *   node scripts/check-copied-rule.mjs
 *
 * 零设施、亚秒级。
 *
 * ── 在防什么 ────────────────────────────────────────────────────────────────
 *
 * `src/internal/editor/pdf-form.ts` 里那个
 * 「这份 PDF 是不是带可编辑内容的那种」的判断，是**照抄编辑器自己那份**
 * `isExtendedPDFFile`（在 `web-apps/apps/common/index.html` 里）。
 *
 * 照抄是有理由的（见那个文件的头注释：同一个答案我们这边也要用来决定怎么转换），
 * 但代价是**换一次静态资源，原文改了而我们这份不会跟着改**。
 * 两边不一致的样子是：**PDF 进错了应用，或者进对了应用却打不开文档**——
 * 都不报错。
 *
 * 这条检查把原文里那几个决定性的字面量取出来，与我们这份逐个对。
 * 它不比对整段代码（那会因为空格和压缩天天误报），只比对**规则本身依赖的那几个值**。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  一致
 *   1  对不上——回去看原文，把我们那份改过来
 *   2  **一条都没核**（找不到原文或我们那份）——与「一致」不是一回事
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SDK_ROOT, SDK_VERSION } from "../config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 原文路径 = path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "web-apps/apps/common/index.html");
const 我们那份路径 = path.join(ROOT, "src/internal/editor/pdf-form.ts");

const die = (码, m) => {
  console.error("✗ " + m);
  process.exit(码);
};

if (!fs.existsSync(原文路径)) die(2, "找不到原文：" + 原文路径 + "\n  先跑 node scripts/extract-assets.mjs");
if (!fs.existsSync(我们那份路径)) die(2, "找不到我们那份：" + 我们那份路径);

/**
 * ⚠ 原文按 **latin1** 读，不能按 utf8。
 *
 * 那条规则里有一段高位字节（PDF 头之后那行二进制注释），它们在文件里是裸字节。
 * 按 utf8 读会被换成替换字符，于是**永远找不到**，判据变成恒红——
 * 而恒红的判据下一步就是被加进豁免名单。我们自己那份 TS 是 utf8，照 utf8 读。
 */
const 原文 = fs.readFileSync(原文路径, "latin1");
const 我们那份 = fs.readFileSync(我们那份路径, "utf8");

const i = 原文.indexOf("function isExtendedPDFFile");
if (i < 0) {
  die(
    2,
    "原文里找不到 isExtendedPDFFile——**这本身就是要看的信号**：\n" +
      "  要么它改名了，要么这份判断整个被换掉了。两种都要回去看一眼。",
  );
}
// 规则由两个函数共同构成：checkExtendedPDF（决定读多少字节）与 isExtendedPDFFile（决定怎么判）。
// 取它们两个所在的整段，别只取后者。
const 起 = 原文.indexOf("function checkExtendedPDF");
const 原文规则 = 原文.slice(起 >= 0 ? 起 : i, 原文.indexOf("function downloadPartialy", i));

/**
 * 规则依赖的那几个值。**只对这些，不对整段代码**——
 * 整段比对会因为空格、压缩、注释天天误报，而一条会误报的判据比没有判据更糟。
 *
 * ⚠ **两边各给一个找法。** 同一个值在两处的写法不一样：
 * 原文里那行二进制注释是**裸字节**，而我们那份是用 `String.fromCharCode` 拼出来的
 * （源码文件是 utf8，直接写裸字节会被编码成别的东西）。
 * 拿同一个字符串去比两边，只会得到一条恒红的判据。
 */
// ⚠ 原文里那两个值是 **JS 源码的十六进制转义写法**（`%\xCD\xCA\xD2\xA9\x0D`、
// `stream\x0D\x0A`），不是裸字节。所以在原文里要按**源码文本**找。
// 我们那份是 utf8 的 TS，同一个值只能用字符码拼或用 \r\n 写，写法必然不同。
const BS = String.fromCharCode(92);
const 原文里的二进制注释 = "%" + BS + "xCD" + BS + "xCA" + BS + "xD2" + BS + "xA9" + BS + "x0D";
const 原文里的流开头 = "stream" + BS + "x0D" + BS + "x0A";
const 我们那份的流开头 = '"stream' + BS + "r" + BS + 'n"';

const 要对的 = [
  {
    是什么: "PDF 头之后那行二进制注释",
    原文里: (s) => s.includes(原文里的二进制注释),
    我们那份里: (s) => s.includes("0xcd, 0xca, 0xd2, 0xa9"),
    说明: "原文写成十六进制转义，我们那份用字符码拼，是同一个值",
  },
  { 是什么: "第一个对象的开头", 原文里: (s) => s.includes("1 0 obj"), 我们那份里: (s) => s.includes("1 0 obj") },
  {
    是什么: "流的开头",
    原文里: (s) => s.includes(原文里的流开头),
    我们那份里: (s) => s.includes(我们那份的流开头),
    说明: "原文写 x0D x0A，我们那份写 r n，是同一个值",
  },
  {
    是什么: "表单标记",
    原文里: (s) => s.includes("ONLYOFFICEFORM"),
    我们那份里: (s) => s.includes("ONLYOFFICEFORM"),
  },
  {
    是什么: "只读开头多少字节",
    原文里: (s) => /limit\s*=\s*300\b/.test(s),
    我们那份里: (s) => /PDF_FORM_SNIFF_BYTES\s*=\s*300\b/.test(s),
    说明: "原文叫 limit，我们那份叫 PDF_FORM_SNIFF_BYTES",
  },
];

let 不对 = 0;
let 核过 = 0;
for (const 条 of 要对的) {
  核过++;
  const 在原文 = 条.原文里(原文规则);
  const 在我们那份 = 条.我们那份里(我们那份);
  if (在原文 && 在我们那份) {
    console.log("✓ " + 条.是什么.padEnd(22) + (条.说明 ? "（" + 条.说明 + "）" : ""));
  } else {
    console.error(
      "✗ " +
        条.是什么 +
        "：原文里" +
        (在原文 ? "有" : "**没有**") +
        "，我们那份里" +
        (在我们那份 ? "有" : "**没有**") +
        (条.说明 ? "　" + 条.说明 : ""),
    );
    不对++;
  }
}

// 反向断言（免费探针）：造一个原文里绝不会有的值，它必须判为不一致。
const 探针值 = "ONLYOFFICEFORM-这段字原文里不可能有";
if (原文规则.includes(探针值)) {
  console.error("✗ 探针没红：原文里居然有一段我们编造的字，判据是坏的");
  process.exit(1);
}
console.log("\n探针：拿一段编造的标记去比，原文里找不到——判据会红，上面那些绿是真的。");

if (核过 === 0) die(2, "一条都没核");
if (不对) {
  console.error(
    `\n✗ ${核过} 条里有 ${不对} 条对不上。` +
      `\n  回去读 ${原文路径} 里的 isExtendedPDFFile，把 ${path.relative(ROOT, 我们那份路径)} 改成一样的。`,
  );
  process.exit(1);
}
console.log(`\n✓ ${核过} 条都对得上（原文：${SDK_VERSION} 那棵树）`);
