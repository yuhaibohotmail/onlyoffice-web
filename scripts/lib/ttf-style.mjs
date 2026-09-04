/**
 * 读一个 TrueType 字体里**自己声明的**样式：常规 / 粗 / 斜 / 粗斜。
 *
 * 两个消费方共用这一份：配字体的 `build-x2t-fonts.mjs` 与核字体的 `check-x2t-fonts.mjs`。
 * 同一件事别写两遍——两份会各自漂，而漂了不报错。
 *
 * 取两处标志位：OS/2 的 fsSelection 与 head 的 macStyle。**两处都要**，
 * 因为有的字体只填对一处，而只看一处的检查会漏掉装反的那一半。
 */

/** @returns {{样式:"常规"|"粗"|"斜"|"粗斜", 子族:string, fsSelection:number, macStyle:number}|null} */
export function readStyle(buf) {
  if (buf.length < 12) return null;
  const numTables = buf.readUInt16BE(4);
  let os2 = 0;
  let head = 0;
  let name = 0;
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    if (p + 16 > buf.length) return null;
    const tag = buf.toString("latin1", p, p + 4);
    if (tag === "OS/2") os2 = buf.readUInt32BE(p + 8);
    if (tag === "head") head = buf.readUInt32BE(p + 8);
    if (tag === "name") name = buf.readUInt32BE(p + 8);
  }
  if (!os2 || !head) return null;

  const fsSelection = buf.readUInt16BE(os2 + 62);
  const macStyle = buf.readUInt16BE(head + 44);
  const 粗 = Boolean(fsSelection & 0x20) || Boolean(macStyle & 0x1);
  const 斜 = Boolean(fsSelection & 0x01) || Boolean(macStyle & 0x2);
  const 样式 = 粗 && 斜 ? "粗斜" : 粗 ? "粗" : 斜 ? "斜" : "常规";

  // 子族名只用来让报错读得懂，判据不取它——有的字体这一格是本地化过的。
  let 子族 = "";
  if (name) {
    const count = buf.readUInt16BE(name + 2);
    const strOff = name + buf.readUInt16BE(name + 4);
    for (let i = 0; i < count; i++) {
      const r = name + 6 + i * 12;
      if (buf.readUInt16BE(r + 6) !== 2) continue;
      const platform = buf.readUInt16BE(r);
      const len = buf.readUInt16BE(r + 8);
      const o = buf.readUInt16BE(r + 10);
      const raw = buf.subarray(strOff + o, strOff + o + len);
      if (platform === 1) 子族 = raw.toString("latin1");
      else {
        const sw = Buffer.alloc(raw.length);
        for (let k = 0; k + 1 < raw.length; k += 2) {
          sw[k] = raw[k + 1];
          sw[k + 1] = raw[k];
        }
        子族 = sw.toString("utf16le");
      }
      break;
    }
  }
  return { 样式, 子族, fsSelection, macStyle };
}

/** 从文件名推出它应该是什么样式：`Xxx-BoldItalic.ttf` → 粗斜。 */
export function styleFromFileName(fileName) {
  const stem = fileName.replace(/[.]ttf$/i, "");
  const suffix = stem.includes("-") ? stem.slice(stem.lastIndexOf("-") + 1) : "";
  if (/^BoldItalic$/i.test(suffix)) return "粗斜";
  if (/^Bold$/i.test(suffix)) return "粗";
  if (/^Italic$/i.test(suffix)) return "斜";
  return "常规";
}
