#!/usr/bin/env node
/**
 * 问的是：**把转换搬到后端之后，浏览器就拿不到原始文档了吗？**
 *
 * 搬完之后浏览器收到的不再是那份 docx，而是 `Editor.bin`——编辑器的内部格式。
 * 这个脚本量的就是「手里有 Editor.bin 的人，实际掌握了什么」，三问：
 *
 *   一、正文能不能直接读出来（不用任何 OnlyOffice 代码）
 *   二、原文件里那些**不显示但在文件里**的东西还在不在（作者元数据、隐藏文字）
 *   三、能不能还原成一份 docx
 *
 * ⚠ 第三问在这里是用 x2t.wasm 做的，而**浏览器自己就带着那份 x2t.wasm**
 * ——所以它不是「攻击者要另外准备工具」，是**导出按钮本来就在做的事**。
 *
 * 跑法：`node poc/backend-x2t/probe-what-browser-gets.mjs`
 * 退出码：0 = 跑完了（**不代表「安全」**，看输出的结论）；2 = 没跑成。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, AVS } from "./x2t-node.mjs";
import { readZipEntries, extractText } from "./zip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUTHOR = "机密作者ZZTOP";
const HIDDEN = "隐藏内容MARKERQQ";

// ── 造一份带元数据与隐藏文字的 docx ────────────────────────────────────────
// 用夹具那份当底，加三样：作者、公司、一段设了 w:vanish 的文字（Word 里不显示）。

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** 只用 store（不压缩）写 zip。够 x2t 读，省掉一个依赖。 */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const src = readZipEntries(fs.readFileSync(path.join(ROOT, "fixtures/lesson-plan-zh.docx")));
if (!src) {
  console.error("✗ 读不到夹具 fixtures/lesson-plan-zh.docx");
  process.exit(2);
}

const docx = writeZip([
  [
    "[Content_Types].xml",
    Buffer.from(
      src["[Content_Types].xml"].toString("utf8").replace(
        "</Types>",
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
      ),
      "utf8",
    ),
  ],
  [
    "_rels/.rels",
    Buffer.from(
      src["_rels/.rels"].toString("utf8").replace(
        "</Relationships>",
        '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
          '<Relationship Id="rIdApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
      ),
      "utf8",
    ),
  ],
  [
    "docProps/core.xml",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
        ' xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        `<dc:creator>${AUTHOR}</dc:creator><cp:lastModifiedBy>${AUTHOR}</cp:lastModifiedBy></cp:coreProperties>`,
      "utf8",
    ),
  ],
  [
    "docProps/app.xml",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        `<Company>${AUTHOR}</Company></Properties>`,
      "utf8",
    ),
  ],
  [
    "word/document.xml",
    Buffer.from(
      src["word/document.xml"]
        .toString("utf8")
        .replace(
          "</w:body>",
          `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${HIDDEN}</w:t></w:r></w:p></w:body>`,
        ),
      "utf8",
    ),
  ],
]);

console.log(`原 docx ${docx.length} 字节（含作者元数据与一段 w:vanish 隐藏文字）`);

const bin = await convert({
  data: docx,
  fileFrom: "probe.docx",
  fileTo: "Editor.bin",
  formatFrom: AVS.DOCX,
  formatTo: AVS.CANVAS_WORD,
});
if (!bin.ok) {
  console.error(`✗ 转 Editor.bin 失败 rc=${bin.rc}`);
  process.exit(2);
}
console.log(`服务端转出的 Editor.bin ${bin.output.length} 字节 —— 这是搬完之后浏览器收到的东西\n`);

// ── 一、正文能不能直接读出来 ───────────────────────────────────────────────
// 不用 x2t、不用 sdkjs，就是把连续的 UTF-16LE 片段拉出来。

function visibleRuns(buf) {
  const out = [];
  let cur = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    if (code >= 0x20 && code < 0xfff0) cur += String.fromCharCode(code);
    else {
      if (cur.length >= 4) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

const chinese = visibleRuns(bin.output).filter((s) => /[一-龥]{4,}/.test(s));
console.log("一、不用任何 OnlyOffice 代码，直接从 bin 里读出来的中文：");
for (const line of chinese.slice(0, 4)) console.log("     " + line);
console.log(`   → 共 ${chinese.length} 段。正文是**明文 UTF-16LE**，没有加密也没有混淆。\n`);

// ── 二、不显示但在文件里的那些东西 ─────────────────────────────────────────

console.log("二、原文件里「不显示但在文件里」的东西，转完还在不在：");
let leaked = 0;
for (const [label, needle] of [
  ["作者元数据", AUTHOR],
  ["隐藏文字（w:vanish）", HIDDEN],
]) {
  const where = ["utf8", "utf16le"].filter((enc) =>
    bin.output.includes(Buffer.from(needle, enc)),
  );
  if (where.length) leaked++;
  console.log(
    `   ${where.length ? "⚠ 还在" : "✅ 没了"}  ${label.padEnd(20)}「${needle}」` +
      (where.length ? `（${where.join("/")}）` : ""),
  );
}
console.log(
  leaked
    ? "   → 服务端转换**不是一次净化**：原文件里看不见的东西照样跟着到浏览器。\n"
    : "   → 这一趟被剥掉了。\n",
);

// ── 三、能不能还原成 docx ──────────────────────────────────────────────────

const back = await convert({
  data: bin.output,
  fileFrom: "Editor.bin",
  fileTo: "out.docx",
  formatFrom: AVS.CANVAS_WORD,
  formatTo: AVS.DOCX,
});
const text = back.ok ? extractText(back.output, "docx") : "";
console.log("三、从 Editor.bin 还原成 docx：");
console.log(
  back.ok
    ? `   ⚠ 成功，${back.output.length} 字节，正文 ${text.length} 个字符：「${text.slice(0, 24)}…」`
    : `   ✅ 失败 rc=${back.rc}`,
);
console.log(
  "   → 而且**这一步不需要另外准备工具**：浏览器自己就带着同一份 x2t.wasm，\n" +
    "     这正是导出按钮本来就在做的事。\n",
);

console.log(
  "结论：把转换搬到后端，换掉的是**浏览器收到哪一种容器**，不是它拿不拿得到文档。\n" +
    "      要让浏览器真的拿不到内容，只有一条路——服务端渲染成像素、浏览器只收图，\n" +
    "      代价是不能编辑。⚠ 发 PDF 不算：PDF 里的文字是可提取的。",
);
