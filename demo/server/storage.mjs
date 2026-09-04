/**
 * 落盘与版本。一份文档一个目录，每存一次多一个版本文件，**旧版本永不覆盖**。
 *
 *   storage/<docId>/v1.docx  v2.docx  ...
 *   storage/<docId>/meta.json   {docId, title, fileType, version, size, sha256, updatedAt}
 *
 * 为什么每次都写新文件而不是原地覆盖：这个 PoC 的整个判据就是「服务端那份**真的变了**」。
 * 原地覆盖的话，v1 就没了，也就没法证明「改动之前那份里确实没有我刚敲进去的字」
 * ——而那条恰恰是防止断言恒真的那个免费探针。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_ROOT = path.resolve(HERE, "..", "storage");

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function docDir(docId) {
  // docId 只允许数字：它直接参与拼路径，放开就是目录穿越。
  if (!/^\d+$/.test(String(docId))) throw new Error("bad docId: " + docId);
  return path.join(STORAGE_ROOT, String(docId));
}

function metaPath(docId) {
  return path.join(docDir(docId), "meta.json");
}

export function exists(docId) {
  return fs.existsSync(metaPath(docId));
}

export function readMeta(docId) {
  return JSON.parse(fs.readFileSync(metaPath(docId), "utf8"));
}

/**
 * 某一版在盘上的文件。**扩展名跟着文档自己的类型走，不写死 docx**——
 * 写死的话一份 PDF 会被存成 `v1.docx`，而它照样能读能写、什么都不报错，
 * 只在有人去盘上看一眼时才发现不对。
 */
export function versionFile(docId, version, fileType) {
  const ext = fileType ?? (exists(docId) ? readMeta(docId).fileType : "docx");
  return path.join(docDir(docId), `v${version}.${ext}`);
}

/** 读某个版本的字节；不给版本号就读当前那版。 */
export function readBytes(docId, version) {
  const meta = readMeta(docId);
  return fs.readFileSync(versionFile(docId, version ?? meta.version));
}

/**
 * 写入新版本。返回新的 meta。
 *
 * ⚠ 先写文件再写 meta.json，顺序不能反：中途崩了的话，多一个没人引用的版本文件
 * 是无害的，而 meta 指向一个不存在的文件是坏的。
 */
export function save(docId, buf, extra = {}) {
  const dir = docDir(docId);
  fs.mkdirSync(dir, { recursive: true });
  const prev = exists(docId) ? readMeta(docId) : null;
  const version = (prev?.version ?? 0) + 1;
  const fileType = extra.fileType ?? prev?.fileType ?? "docx";
  fs.writeFileSync(versionFile(docId, version, fileType), buf);
  const meta = {
    docId: Number(docId),
    title: extra.title ?? prev?.title ?? `文档${docId}.${fileType}`,
    fileType,
    version,
    size: buf.length,
    sha256: sha256(buf),
    updatedAt: new Date().toISOString(),
    history: [...(prev?.history ?? []), { version, size: buf.length, sha256: sha256(buf), at: new Date().toISOString() }],
  };
  fs.writeFileSync(metaPath(docId), JSON.stringify(meta, null, 2));
  return meta;
}
