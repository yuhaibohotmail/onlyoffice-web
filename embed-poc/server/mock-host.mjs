/**
 * mock 的那一半：**替讲 ONLYOFFICE Docs 接入协议的宿主后端**，外加发宿主页面本身。
 *
 * 它只有几十行业务，而且**不抄任何真实后端的端点形状**——真抄了，
 * 这个 PoC 就从「谁都能嵌」变成「只能配那一家」，而这个仓库是要发出去给别人用的。
 *
 * ── 为什么它跟静态那一半分两个进程 ────────────────────────────────────────
 *
 * 因为它们答的是两个不同的问题：静态那半问「nginx 发得出去吗」，
 * 这半问「接入页与宿主之间那套约定成不成立」。合成一个之后，
 * 「插件面板出来了」就分不清是静态那半够用、还是这半顺手补了什么。
 *
 * **而且分开才有跨源。** 宿主页面在这个源上，接入页在静态那个源上——
 * 这正是真实部署的样子，也让「两道来源校验真的在拦」这一问变得可验。
 *
 * ── 它答的三件事 ────────────────────────────────────────────────────────
 *
 * 宿主不递地址与头，只签一张**配置令牌**；取件与存件经接入后端（实测里是
 * `fake-backend.mjs`），接入后端带着签名来取 `document.url`、存件时带签名回调 `callbackUrl`。
 * 这一半就答这三件：`POST /oo/config` 签令牌、`GET /oo/file` 核取件签名再给字节、
 * `POST /oo/callback` 核回调令牌、比 `baseVersion`、去取暂存的那份、存下。
 * 这几条路径是这个 mock 自己起的名字，**不抄任何真实后端的**；签名与回调的形状照的是
 * `INTEGRATION.md` 里写的那份公开约定。
 *
 * 密钥从环境变量 `OOW_JWT_SECRET` 读（与接入后端共用）；没设时这三条回 500。
 *
 * 第一版协议用的那几条（`GET /meta`、`GET/POST /file`、「用过的凭据一律拒」）随第一版
 * 在 0.3.0 删了。探针要直接看宿主手里那份字节时走 `GET /_probe/file`。
 *
 * 跑法：node embed-poc/server/mock-host.mjs [端口]
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sign, verify } from "./hs256.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

// ── 现造一份最小的 docx ─────────────────────────────────────────────────
//
// **自己写，不从仓库里别处拿。** 自足是这个 PoC 的硬约束之一，而且它也不该
// 依赖「谁的机器上正好有一个 docx」。docx 就是一个 zip，装三份 XML 就能打开。

/** 标准 CRC-32。zip 每一条目都要它，算错的话解压器会说「文件损坏」。 */
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

/**
 * 打一个 zip。**用 stored（不压缩）**——省掉一个依赖，而 docx 不要求压缩。
 *
 * ⚠ 三处写错了都不会当场报，只会让 Word/编辑器说「文件损坏」：
 * CRC、两个 size 字段、以及中央目录里那个**本地头偏移**。
 */
function 打包zip(条目) {
  const 本地块 = [];
  const 目录块 = [];
  let 偏移 = 0;

  for (const { 名, 内容 } of 条目) {
    const 名字节 = Buffer.from(名, "utf8");
    const 数据 = Buffer.isBuffer(内容) ? 内容 : Buffer.from(内容, "utf8");
    const crc = crc32(数据);

    const 本地头 = Buffer.alloc(30);
    本地头.writeUInt32LE(0x04034b50, 0);
    本地头.writeUInt16LE(20, 4); // version needed
    本地头.writeUInt16LE(0x0800, 6); // 名字是 UTF-8
    本地头.writeUInt16LE(0, 8); // stored
    本地头.writeUInt16LE(0, 10); // mod time
    本地头.writeUInt16LE(0x21, 12); // mod date（1980-01-01，固定值 = 产物可复现）
    本地头.writeUInt32LE(crc, 14);
    本地头.writeUInt32LE(数据.length, 18);
    本地头.writeUInt32LE(数据.length, 22);
    本地头.writeUInt16LE(名字节.length, 26);
    本地头.writeUInt16LE(0, 28);
    本地块.push(本地头, 名字节, 数据);

    const 目录项 = Buffer.alloc(46);
    目录项.writeUInt32LE(0x02014b50, 0);
    目录项.writeUInt16LE(20, 4);
    目录项.writeUInt16LE(20, 6);
    目录项.writeUInt16LE(0x0800, 8);
    目录项.writeUInt16LE(0, 10);
    目录项.writeUInt16LE(0, 12);
    目录项.writeUInt16LE(0x21, 14);
    目录项.writeUInt32LE(crc, 16);
    目录项.writeUInt32LE(数据.length, 20);
    目录项.writeUInt32LE(数据.length, 24);
    目录项.writeUInt16LE(名字节.length, 28);
    目录项.writeUInt32LE(偏移, 42); // ← 本地头在文件里的位置
    目录块.push(目录项, 名字节);

    偏移 += 30 + 名字节.length + 数据.length;
  }

  const 目录 = Buffer.concat(目录块);
  const 尾 = Buffer.alloc(22);
  尾.writeUInt32LE(0x06054b50, 0);
  尾.writeUInt16LE(条目.length, 8);
  尾.writeUInt16LE(条目.length, 10);
  尾.writeUInt32LE(目录.length, 12);
  尾.writeUInt32LE(偏移, 16);

  return Buffer.concat([...本地块, 目录, 尾]);
}

const 种子文字 = "这是 PoC 的种子文档。存件之后这一行还在，说明编辑器没有把原文吃掉。";

function 造docx(正文) {
  const 段落 = 正文
    .split("\n")
    .map((行) => `<w:p><w:r><w:t xml:space="preserve">${行.replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</w:t></w:r></w:p>`)
    .join("");
  return 打包zip([
    {
      名: "[Content_Types].xml",
      内容:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    },
    {
      名: "_rels/.rels",
      内容:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    },
    {
      名: "word/document.xml",
      内容:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${段落}<w:sectPr/></w:body></w:document>`,
    },
  ]);
}

// ── 状态 ────────────────────────────────────────────────────────────────

const 文档 = { 版本: 1, 字节: 造docx(种子文字), 文件名: "poc-种子.docx" };
const 事件 = [];

const 密钥 = process.env.OOW_JWT_SECRET || "";
/** 发出去的配置令牌里的 document.key。回调带来的 key 必须是其中之一。 */
const 发过的key = new Set();
/** 取件签名核过几次、几次对几次错。判据取这两个数。 */
const 取件签名 = { 对: 0, 错: 0, 错因: [] };
/** 收到的回调（解开之后的载荷），按顺序。 */
const 回调 = [];
/** 被要过、但这里没有的路径。出了 404 时查是谁要了什么用它。 */
const 没有的路径 = [];

function 记(名, 详) {
  事件.push({ 时刻: new Date().toISOString(), 名, ...详 });
  console.log("[mock] " + 名 + (详 ? " " + JSON.stringify(详) : ""));
}

function json(res, code, body) {
  const b = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": b.length,
    "cache-control": "no-store",
    // 不发跨源头：会来这里的只有同源的宿主页、接入后端（服务器对服务器）和探针，
    // 接入页从不直接找宿主后端。
  });
  res.end(b);
}

const PORT = Number(process.argv[2] || process.env.OOW_MOCK_PORT || 3043);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  const p = decodeURIComponent(url.pathname);

  // ── 签配置令牌 ──
  // ⚠ 真实宿主里签令牌的是宿主自己的后端，前端只是转递；这里收下前端说的插件配置与
  // 「许不许下载」再签，只是为了让实测能切换这两格。
  if (p === "/oo/config" && req.method === "POST") {
    if (!密钥) return json(res, 500, { error: "这个 mock 没配 OOW_JWT_SECRET，签不了令牌" });
    const 块 = [];
    for await (const c of req) 块.push(c);
    let 要 = {};
    try { 要 = JSON.parse(Buffer.concat(块).toString("utf8") || "{}"); } catch { /* 当空的 */ }
    const 本源 = "http://" + req.headers.host;
    const key = "poc-" + 文档.版本 + "-" + Math.random().toString(36).slice(2, 10);
    发过的key.add(key);
    const t = Math.floor(Date.now() / 1000);
    const token = sign({
      document: {
        fileType: "docx",
        key,
        title: 文档.文件名,
        url: 本源 + "/oo/file",
        permissions: { edit: true, download: 要.download !== false },
        baseVersion: 文档.版本,
      },
      documentType: "word",
      editorConfig: {
        callbackUrl: 本源 + "/oo/callback",
        mode: "edit",
        lang: "zh-CN",
        user: { id: "poc-user", name: "实测" },
        ...(要.plugins ? { plugins: 要.plugins } : {}),
      },
      iat: t,
      exp: t + 1200,
    }, 密钥);
    记("签配置令牌", { key, 基准版: 文档.版本, 许下载: 要.download !== false });
    return json(res, 200, { token });
  }

  // ── 取件，核签名头 ──
  if (p === "/oo/file" && req.method === "GET") {
    const h = req.headers.authorization || "";
    const v = 密钥 ? verify(h.startsWith("Bearer ") ? h.slice(7) : "", 密钥) : { ok: false, why: "没配密钥" };
    // 接入后端签进去的地址，必须逐字等于这边看到的这一个（协议 + Host 头 + 请求行原样）。
    const 看到的 = "http://" + req.headers.host + req.url;
    const 错因 = !v.ok ? v.why
      : v.payload.payload?.url !== 看到的 ? "payload.url 是 " + v.payload.payload?.url + "，这边看到的是 " + 看到的
      : v.payload.use !== "fetch" ? "use 不是 fetch"
      : null;
    if (错因) {
      取件签名.错++;
      取件签名.错因.push(错因);
      记("取件被拒", { 错因 });
      return json(res, 403, { error: 错因 });
    }
    取件签名.对++;
    记("取件", { 版本: 文档.版本 });
    res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-length": 文档.字节.length,
      "cache-control": "no-store",
    });
    return res.end(文档.字节);
  }

  // ── 回调 ──
  // 成功照 ONLYOFFICE Docs 的约定回 {"error":0}，外加新版本号；冲突回 409 与一段给人看的话，
  // 接入后端要把它原样转给接入页。
  if (p === "/oo/callback" && req.method === "POST") {
    const 块 = [];
    for await (const c of req) 块.push(c);
    let token = "";
    try { token = JSON.parse(Buffer.concat(块).toString("utf8")).token; } catch { /* 下面拒 */ }
    const v = 密钥 ? verify(token, 密钥) : { ok: false, why: "没配密钥" };
    if (!v.ok) { 记("回调令牌不对", { why: v.why }); return json(res, 401, { error: 1, message: "回调令牌不对：" + v.why }); }
    const 载荷 = v.payload;
    回调.push({ status: 载荷.status, forcesavetype: 载荷.forcesavetype, baseVersion: 载荷.baseVersion, key: 载荷.key, users: 载荷.users });
    if (!发过的key.has(载荷.key)) return json(res, 403, { error: 1, message: "不认得这个 key" });
    if (载荷.status !== 6) return json(res, 200, { error: 0 });
    if (载荷.baseVersion !== 文档.版本) {
      记("存件撞冲突", { 基准: 载荷.baseVersion, 当前: 文档.版本 });
      return json(res, 409, {
        error: 1,
        message:
          "这份文档在你编辑期间已经被保存过（你打开的是第 " + 载荷.baseVersion + " 版，现在是第 " + 文档.版本 +
          " 版）。这个编辑器不支持多人同时编辑，直接覆盖会把别人的改动整份丢掉。你的这一份可以先存到本地。",
      });
    }
    const r = await fetch(载荷.url).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) {
      记("取暂存件失败", { 状态: r.status });
      return json(res, 502, { error: 1, message: "取不到暂存的那份：" + r.status });
    }
    const 字节 = Buffer.from(await r.arrayBuffer());
    if (!字节.length) return json(res, 400, { error: 1, message: "空的" });
    文档.字节 = 字节;
    文档.版本 += 1;
    记("存件", { 新版本: 文档.版本, 字节: 字节.length });
    return json(res, 200, { error: 0, version: 文档.版本 });
  }

  // ── 判据用：它到底看到了什么 ──
  if (p === "/_probe/state") {
    return json(res, 200, {
      版本: 文档.版本,
      字节数: 文档.字节.length,
      取件签名,
      回调,
      没有的路径,
      事件,
    });
  }
  if (p === "/_probe/reset" && req.method === "POST") {
    文档.版本 = 1;
    文档.字节 = 造docx(种子文字);
    事件.length = 0;
    发过的key.clear();
    取件签名.对 = 0;
    取件签名.错 = 0;
    取件签名.错因.length = 0;
    回调.length = 0;
    没有的路径.length = 0;
    记("复位");
    return json(res, 200, { ok: true });
  }
  /**
   * 宿主手里此刻那份字节，原样给。判据取的是它，不取界面上写了什么。
   * **只给探针用**：不核签名，所以真实的宿主后端不该有这样一条。
   */
  if (p === "/_probe/file" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-length": 文档.字节.length,
      "cache-control": "no-store",
    });
    return res.end(文档.字节);
  }
  /** 种子那行字，判据脚本拿它做「旧版里没有新字」那条反向断言。 */
  if (p === "/_probe/seed-text") return json(res, 200, { text: 种子文字 });

  // ── 宿主页面本身 ──
  const 文件 = p === "/" ? "index.html" : p.replace(/^\//, "");
  const 落点 = path.resolve(path.join(DIST, 文件));
  if (落点.startsWith(path.resolve(DIST)) && fs.existsSync(落点) && fs.statSync(落点).isFile()) {
    const 类型 = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                   ".css": "text/css; charset=utf-8" }[path.extname(落点)] || "application/octet-stream";
    const b = fs.readFileSync(落点);
    res.writeHead(200, { "content-type": 类型, "content-length": b.length, "cache-control": "no-store" });
    return res.end(b);
  }

  没有的路径.push(p);
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found: " + p);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[mock] " + PORT + "  （这一半替宿主后端，另外发宿主页面）");
  console.log("        种子文档 " + 文档.字节.length + " 字节，第 " + 文档.版本 + " 版");
  if (!密钥) console.log("        ⚠ 没设 OOW_JWT_SECRET —— /oo/* 一律回 500");
});
