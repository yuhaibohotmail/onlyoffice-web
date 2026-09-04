/**
 * 够用的 zip 读取：只为把产物里的正文抠出来看一眼。
 *
 * 为什么需要它：**「是个合法的 docx」和「里面还有字」是两回事。**
 * fb2 那一格实测就是前者成立后者不成立——转换报成功、文件结构完好、
 * 正文一个字都没有。只认魔数的判据会给它开绿灯。
 */

import zlib from "node:zlib";

/** 读出 zip 里全部条目（名字 → 解开后的字节）。只认 store 与 deflate 两种。 */
export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = {};

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) return entries;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);

    try {
      entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch {
      entries[name] = null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const textIn = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g"))].map((m) => m[1]).join("");

/** 从 OOXML 产物里把正文抠出来。抠不到就回空串。 */
export function extractText(buf, kind) {
  const entries = readZipEntries(buf);
  if (!entries) return "";
  const read = (name) => (entries[name] ? entries[name].toString("utf8") : "");

  if (kind === "docx") return textIn(read("word/document.xml"), "w:t");
  if (kind === "xlsx") {
    // 字符串可能在共享表里，也可能内联在单元格里；两处都看，另加数值单元格。
    const shared = textIn(read("xl/sharedStrings.xml"), "t");
    const sheet = read("xl/worksheets/sheet1.xml");
    return shared + textIn(sheet, "t") + textIn(sheet, "v");
  }
  if (kind === "pptx") {
    let out = "";
    for (const name of Object.keys(entries)) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) out += textIn(read(name), "a:t");
    }
    return out;
  }
  return "";
}
