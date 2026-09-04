#!/usr/bin/env node
/**
 * 现生成一份中文测试 docx，**不从别处拷现成文件**——这个项目从零拉下来就得能跑起来。
 *
 * 手写 OOXML 而不是用库，是为了能**钉死每一个 `w:rFonts` 的值**：
 * 「导出之后字体名还在不在」是本轮要验的一条，用库生成的话字体是它挑的，
 * 那条断言就变成了在验那个库。
 *
 * zip 只用 store（不压缩）：省掉一个 deflate 的正确性问题，几 KB 的文件也不在乎大小。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 最小 zip（store 模式）。entries: [{name, data:Buffer}] */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // flag: UTF-8 名字
    lh.writeUInt16LE(0, 8);           // method: store
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);  // 固定时间戳，产物可复现
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const B = (s) => Buffer.from(s, "utf8");

/** 一段带字体名的中文段落。字体名是本轮断言要在导出字节里找回来的东西。 */
function para(text, font, size = 24) {
  return `<w:p><w:pPr><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/><w:sz w:val="${size}"/></w:rPr></w:pPr>`
    + `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/><w:sz w:val="${size}"/></w:rPr>`
    + `<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export function buildLessonPlanDocx() {
  const body = [
    para("八年级数学 · 一次函数 教学设计", "微软雅黑", 36),
    para("一、教学目标：理解一次函数的概念，会用待定系数法求解析式。", "宋体"),
    para("二、教学重点：一次函数图象与性质的对应关系。", "黑体"),
    para("三、教学难点：从实际问题中抽象出一次函数模型。", "仿宋"),
    para("The quick brown fox jumps over the lazy dog.", "Calibri"),
  ].join("");

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return zip([
    { name: "[Content_Types].xml", data: B(contentTypes) },
    { name: "_rels/.rels", data: B(rels) },
    { name: "word/document.xml", data: B(document) },
  ]);
}

/** PDF 里那行字。自动实测靠它判「这份 PDF 真的被打开并画出来了」。 */
export const PDF_PROBE_TEXT = "PDFPROBE-3K7M onlyoffice-web";

/**
 * 现生成一份最小的 PDF。
 *
 * 一样是手写不用库，理由和上面那份 docx 相同：这份夹具是用来验
 * **「缺 pdfeditor 时 PDF 打不开且不出声」这件事有没有被修好**的，
 * 拿库生成的话，出问题时得先排除库。
 *
 * 只用 Helvetica 这种 PDF 内置字体、只放一行 ASCII，
 * 避免把「中文字体嵌入」那一大摊也拖进这条断言里——那是另一件事，该另有一条验它。
 */
export function buildMinimalPdf() {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]" +
      "/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    null, // 4 号是内容流，下面单独拼
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
  ];
  const stream = `BT /F1 18 Tf 60 760 Td (${PDF_PROBE_TEXT}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  // xref 表记的是每个对象在文件里的字节偏移，所以只能边拼边记。
  const parts = ["%PDF-1.4\n"];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(offset);
    parts.push(chunk);
    offset += chunk.length;
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(xref);

  return Buffer.from(parts.join(""), "latin1");
}

// 直接跑时写到 fixtures/ 下，方便手工看一眼
if (process.argv[1] && process.argv[1].endsWith("make-fixtures.mjs")) {
  for (const [name, build] of [
    ["lesson-plan-zh.docx", buildLessonPlanDocx],
    ["probe.pdf", buildMinimalPdf],
  ]) {
    const out = path.join(HERE, name);
    fs.writeFileSync(out, build());
    console.log("[fixtures] " + out + "  " + fs.statSync(out).size + " 字节");
  }
}
