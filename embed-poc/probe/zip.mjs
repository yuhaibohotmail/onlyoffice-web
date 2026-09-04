/**
 * 从一个 zip（也就是 docx）里读出某一条目的内容。**只读，几十行，零依赖。**
 *
 * 为什么要它：判据要取**服务端那份字节**，而不是界面上写了什么。
 * 存件之后要回答「这次敲进去的字真的进去了吗」「上一版里确实没有这几个字吗」，
 * 就得把 `word/document.xml` 从 docx 里抠出来。
 *
 * ⚠ **必须能处理 deflate**：编辑器导出的 docx 是压缩的，
 * 而 mock 那边现造的种子是不压缩的（stored）。只支持一种的话，
 * 两头有一头会安静地读不出东西 —— 而「读不出」和「里面没有那句话」长得一样。
 */

import zlib from "node:zlib";

/**
 * 按中央目录找条目。**不从头顺着本地头扫**——那样遇到带数据描述符的条目会算错长度，
 * 而算错的表现是读出一段乱码，不是报错。
 */
export function 读zip条目(buf, 目标名) {
  // 从尾部倒着找 EOCD（结尾目录记录）。注释段最长 65535，所以最多往回找这么多。
  let eocd = -1;
  const 下限 = Math.max(0, buf.length - 65535 - 22);
  for (let i = buf.length - 22; i >= 下限; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("这不是一个 zip：找不到 EOCD");

  const 条目数 = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // 中央目录起点

  for (let n = 0; n < 条目数; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录第 " + n + " 条坏了");
    const 压缩法 = buf.readUInt16LE(p + 10);
    const 压缩后 = buf.readUInt32LE(p + 20);
    const 名长 = buf.readUInt16LE(p + 28);
    const 扩展长 = buf.readUInt16LE(p + 30);
    const 注释长 = buf.readUInt16LE(p + 32);
    const 本地头偏移 = buf.readUInt32LE(p + 42);
    const 名 = buf.toString("utf8", p + 46, p + 46 + 名长);

    if (名 === 目标名) {
      // 本地头里的名长/扩展长可能与中央目录里的不同，**必须按本地头那份算数据起点**。
      const l名长 = buf.readUInt16LE(本地头偏移 + 26);
      const l扩展长 = buf.readUInt16LE(本地头偏移 + 28);
      const 起 = 本地头偏移 + 30 + l名长 + l扩展长;
      const 数据 = buf.subarray(起, 起 + 压缩后);
      if (压缩法 === 0) return 数据; // stored
      if (压缩法 === 8) return zlib.inflateRawSync(数据); // deflate
      throw new Error("不认识的压缩法 " + 压缩法 + "（只处理 stored 与 deflate）");
    }
    p += 46 + 名长 + 扩展长 + 注释长;
  }
  return null;
}

/** 把 docx 的正文抠成纯文字，只为了「里面有没有这句话」这种判断。 */
export function docx正文(buf) {
  const xml = 读zip条目(buf, "word/document.xml");
  if (!xml) return null;
  return xml
    .toString("utf8")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
