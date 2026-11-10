#!/usr/bin/env node
/**
 * 给 CryptPad 的 x2t.wasm 补上空图片回调（认得 v9.3.0+0 与 v9.3.2+4 两份构建）。
 *
 *   node scripts/patch-x2t-null-callback.mjs
 *   node scripts/patch-x2t-null-callback.mjs vendor/x2t/x2t.wasm
 *
 * 旧版 ppt 转到某一张图时，一个序列化函数会 call_indirect 一个空的函数指针
 * （v9.3.0+0 里是函数 62523，v9.3.2+4 里是函数 86409）。
 * Node 里这次转换能走完，Chrome 会在这里陷阱成 RuntimeError: null function，
 * 编辑器只显示「未知错误」。
 *
 * 这一处把那个 call_indirect 换成：指针是 0 就不调（丢掉参数），否则照原样调用。
 * 有效回调仍然执行。按解开后的长度认是哪一份构建，每一份都核对周围的字节；
 * 对不上就停，不去改别的构建。已经补过的文件原样返回。
 * v9.3.2+4 开了函数指针强转的模拟，间接调用的样子不同，补法见下面 V932 那一段。
 *
 * wasm 本体不进 git。`scripts/fetch-x2t.mjs` 在校验和通过之后调用这里。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WASM = path.join(ROOT, "vendor/x2t/x2t.wasm");

const UPSTREAM_LEN = 35985703;
const PATCHED_LEN = 35985714;
const BODY_SIZE_AT = 21543987;
const CALL_AT = 21544122;
const OLD_BODY_LEN = 184;
const NEW_BODY_LEN = 195;

const BEFORE = Buffer.from([0x28, 0x02, 0x1c]);
const AFTER = Buffer.from([0x20, 0x01, 0x10, 0xc9]);
const CHECK = Buffer.from([
  0x22, 0x03, // local.tee 3
  0x45, // i32.eqz
  0x04, 0x01, // if，类型 1 是 (i32, i32) -> void。空类型 0x40 看不见外层参数。
  0x1a, 0x1a, // drop drop
  0x05, // else
  0x20, 0x03, // local.get 3
  0x11, 0x01, 0x00, // call_indirect 类型 1
  0x0b, // end
]);

function encodeUleb(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    let b = rest & 0x7f;
    rest >>>= 7;
    if (rest) b |= 0x80;
    bytes.push(b);
  } while (rest);
  return Buffer.from(bytes);
}

function readUleb(buf, at) {
  let value = 0;
  let shift = 0;
  let o = at;
  let b;
  do {
    b = buf[o++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value: value >>> 0, start: at, len: o - at };
}

function same(buf, at, bytes) {
  return buf.subarray(at, at + bytes.length).equals(bytes);
}

// ── CryptPad v9.3.2+4（Euro-Office 9.3.2）──────────────────────────────────
//
// 同一个函数（一个序列化函数：写两个字符串，再对一组 68 字节的对象逐个调虚函数表第 7 格）
// 在这一版是第 86236 个函数体（算上 173 个导入是 86409）。这一版开了函数指针强转的模拟，
// 间接调用一律走同一个签名：16 个 i64 参数、返回值丢掉。所以旧版那几个字节在这里不存在，
// 要换一种补法：先把要调的函数指针取出来存进一个新加的局部变量，**不是 0 才压参数、才调**。
const V932 = {
  upstreamLen: 38383474,
  patchedLen: 38383483,
  sizeAt: 23540830, // 函数体长度（uleb，2 字节）的位置
  oldBodyLen: 215,
  newBodyLen: 224,
};
// 原来：（上一步算出元素地址）local.tee 3, i64.extend_i32_u, local.get 1, i64.extend_i32_u, i64.const 0 ×14,
//       local.get 3, i32.load, i32.load offset=28, call_indirect 类型 0, drop
const V932_OLD = Buffer.from(
  "2203ad2001ad" + "4200".repeat(14) + "2003280200" + "28021c" + "110000" + "1a",
  "hex",
);
// 改成：local.set 3, local.get 3, i32.load, i32.load offset=28, local.tee 5,
//       if（无参无返回）
//         local.get 3, i64.extend_i32_u, local.get 1, i64.extend_i32_u, i64.const 0 ×14,
//         local.get 5, call_indirect 类型 0, drop
//       end
const V932_NEW = Buffer.from(
  "2103" + "2003280200" + "28021c" + "2205" + "0440" +
    "2003ad2001ad" + "4200".repeat(14) + "2005" + "110000" + "1a" +
    "0b",
  "hex",
);

function patchV932(wasm) {
  const bodyStart = V932.sizeAt + 2;
  // 那一段在函数体里找，只许出现一次；没有或不止一处都不改。
  const 找 = (pat, len) => {
    const body = wasm.subarray(bodyStart, bodyStart + len);
    const i = body.indexOf(pat);
    if (i < 0 || body.indexOf(pat, i + 1) >= 0) return -1;
    return bodyStart + i;
  };
  if (wasm.length === V932.patchedLen && 找(V932_NEW, V932.newBodyLen) >= 0) return wasm;
  const at = 找(V932_OLD, V932.oldBodyLen);
  if (readUleb(wasm, V932.sizeAt).value !== V932.oldBodyLen || readUleb(wasm, V932.sizeAt).len !== 2) {
    throw new Error("v9.3.2+4：函数体长度对不上，不去改");
  }
  // 局部变量声明：一组、3 个 i32。加一个给函数指针用（编号 5：参数 0、1，原有局部 2、3、4）。
  if (!same(wasm, bodyStart, Buffer.from([0x01, 0x03, 0x7f]))) throw new Error("v9.3.2+4：局部变量声明对不上，不去改");
  if (at < 0) throw new Error("v9.3.2+4：call_indirect 周围的字节对不上，不去改");

  let o = 8;
  while (o < wasm.length) {
    const id = wasm[o++];
    const size = readUleb(wasm, o);
    o = size.start + size.len;
    const payload = o;
    if (id !== 10) {
      o = payload + size.value;
      continue;
    }
    const extra = V932.newBodyLen - V932.oldBodyLen;
    const grown = encodeUleb(size.value + extra);
    if (grown.length !== size.len) throw new Error("代码段长度的编码变长了，补丁停在这里");
    const body = Buffer.concat([
      Buffer.from([0x01, 0x04, 0x7f]),
      wasm.subarray(bodyStart + 3, at),
      V932_NEW,
      wasm.subarray(at + V932_OLD.length, bodyStart + V932.oldBodyLen),
    ]);
    if (body.length !== V932.newBodyLen) throw new Error(`补完的函数体是 ${body.length} 字节`);
    const sizeBytes = encodeUleb(V932.newBodyLen);
    if (sizeBytes.length !== 2) throw new Error("函数体长度的编码变长了");
    return Buffer.concat([
      wasm.subarray(0, size.start),
      grown,
      wasm.subarray(payload, V932.sizeAt),
      sizeBytes,
      body,
      wasm.subarray(bodyStart + V932.oldBodyLen),
    ]);
  }
  throw new Error("没有找到代码段");
}

/**
 * 认得两份构建：CryptPad v9.3.0+0 与 v9.3.2+4，按解开后的长度分辨。别的构建一律不改、直接报错。
 * @param {Buffer} wasm 解开后的 wasm
 * @returns {Buffer}
 */
export function patchX2tNullCallback(wasm) {
  if (wasm.length === V932.upstreamLen || wasm.length === V932.patchedLen) return patchV932(wasm);
  if (wasm.length === PATCHED_LEN && same(wasm, CALL_AT, CHECK)) {
    return wasm;
  }
  if (wasm.length !== UPSTREAM_LEN) {
    throw new Error(
      `解开后是 ${wasm.length} 字节，这份补丁只认 CryptPad v9.3.0+0（${UPSTREAM_LEN}）与 v9.3.2+4（${V932.upstreamLen}）`,
    );
  }
  if (wasm[BODY_SIZE_AT] !== 0xb8 || wasm[BODY_SIZE_AT + 1] !== 0x01) {
    throw new Error("函数体长度对不上，不去改");
  }
  if (!same(wasm, CALL_AT - BEFORE.length, BEFORE) || wasm[CALL_AT] !== 0x11 || wasm[CALL_AT + 1] !== 0x01 || wasm[CALL_AT + 2] !== 0x00 || !same(wasm, CALL_AT + 3, AFTER)) {
    throw new Error("call_indirect 周围的字节对不上，不去改");
  }

  let o = 8;
  while (o < wasm.length) {
    const id = wasm[o++];
    const size = readUleb(wasm, o);
    o = size.start + size.len;
    const payload = o;
    if (id !== 10) {
      o = payload + size.value;
      continue;
    }
    const extra = CHECK.length - 3;
    const grown = encodeUleb(size.value + extra);
    if (grown.length !== size.len) {
      throw new Error("代码段长度的编码变长了，补丁停在这里");
    }
    const bodyStart = BODY_SIZE_AT + 2;
    const body = Buffer.concat([
      wasm.subarray(bodyStart, CALL_AT),
      CHECK,
      wasm.subarray(CALL_AT + 3, bodyStart + OLD_BODY_LEN),
    ]);
    if (body.length !== NEW_BODY_LEN) {
      throw new Error(`补完的函数体是 ${body.length} 字节`);
    }
    return Buffer.concat([
      wasm.subarray(0, size.start),
      grown,
      wasm.subarray(payload, BODY_SIZE_AT),
      encodeUleb(NEW_BODY_LEN),
      body,
      wasm.subarray(bodyStart + OLD_BODY_LEN),
    ]);
  }
  throw new Error("没有找到代码段");
}

export function decompressWasm(raw) {
  if (raw.length >= 4 && raw.readUInt32LE(0) === 0x6d736100) return raw;
  return zlib.brotliDecompressSync(raw);
}

function main() {
  const target = path.resolve(process.argv[2] || DEFAULT_WASM);
  if (!fs.existsSync(target)) {
    console.error("✗ 没有 " + target + "。先跑 npm run x2t。");
    process.exit(1);
  }
  const raw = fs.readFileSync(target);
  const wasm = decompressWasm(raw);
  const patched = patchX2tNullCallback(wasm);
  if (patched === wasm) {
    console.log("✓ 已经补过：" + target);
    return;
  }
  const br = zlib.brotliCompressSync(patched, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
  });
  fs.writeFileSync(target, br);
  console.log(`✓ 已写入 ${target}（解开 ${patched.length} 字节，压缩 ${br.length} 字节）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
