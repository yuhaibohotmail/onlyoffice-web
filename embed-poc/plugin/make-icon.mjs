/**
 * 现画插件图标。**图标是必填的**——漏了编辑器内部会抛错，外面显示成
 * 「使用文档时出错」，看着像文档坏了。
 *
 * 为什么现画而不是提交一张图：这个 PoC 的硬约束之一是自足，
 * 而一张 png 是二进制、看不出改了什么。现画的话，颜色和尺寸都在代码里写着。
 *
 * 颜色取纯洋红——正文里不会有第二处这个颜色，肉眼一眼能认出来。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CRC表 = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC表[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** PNG 的每一块都是：长度(4) + 类型(4) + 数据 + CRC(4)，**CRC 算的是「类型+数据」**。 */
function 块(类型, 数据) {
  const 头 = Buffer.alloc(4);
  头.writeUInt32BE(数据.length, 0);
  const 体 = Buffer.concat([Buffer.from(类型, "ascii"), 数据]);
  const 尾 = Buffer.alloc(4);
  尾.writeUInt32BE(crc32(体), 0);
  return Buffer.concat([头, 体, 尾]);
}

function 画一张纯色png(边长, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(边长, 0);
  ihdr.writeUInt32BE(边长, 4);
  ihdr[8] = 8; // 每通道 8 位
  ihdr[9] = 2; // 真彩色（无 alpha）
  // 10/11/12 全 0：压缩法 deflate、滤波法 0、不隔行

  // 每一行前面要有一个滤波字节。**漏了它整张图会错位**，而解码器多半只说「图坏了」。
  const 行 = Buffer.alloc(1 + 边长 * 3);
  for (let x = 0; x < 边长; x++) {
    行[1 + x * 3] = r;
    行[1 + x * 3 + 1] = g;
    行[1 + x * 3 + 2] = b;
  }
  const 像素 = Buffer.concat(Array.from({ length: 边长 }, () => 行));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    块("IHDR", ihdr),
    块("IDAT", zlib.deflateSync(像素)),
    块("IEND", Buffer.alloc(0)),
  ]);
}

const 目录 = path.join(HERE, "resources");
fs.mkdirSync(目录, { recursive: true });
for (const [名, 边长] of [["icon.png", 32], ["icon@2x.png", 64]]) {
  const 落点 = path.join(目录, 名);
  fs.writeFileSync(落点, 画一张纯色png(边长, [255, 0, 255]));
  console.log("画了 " + path.relative(path.join(HERE, ".."), 落点) + "（" + 边长 + "×" + 边长 + " 洋红）");
}
