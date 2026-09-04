#!/usr/bin/env node
/**
 * 本项目的后端（3041）。`node:http`，零框架、零依赖。
 *
 * 它提供**两样能力**，其余端点都是为这两样服务的：
 *   取件  GET  /api/internal/download/{docId}/{cacheKey}/{name}?token=...
 *   存件  POST /api/documents/{docId}/content        （octet-stream + Bearer）
 *
 * 路径名照 doc-server 的形状取，将来好换；但**代码是新写的，不连它、也不连别的任何服务**。
 * 与 doc-server 的对应关系逐条写在各处理函数的注释里，其中有一条对不上，见 saveContent()。
 *
 * 顺带伺服两样静态资源，都是**只读**：
 *   /packages/**  从社区版镜像抽出来的静态资源，外加转换引擎与它的字体（plugins.json 现编，见下）
 *   /legal/**     许可原件与修改说明（界面上那个法律声明入口指到这里）
 *   /plugins/**   本项目自己写的那个插件
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCUMENT_SERVER, PROJECT_ROOT,
  SDK_ROOT, SDK_VERSION, X2T_DIR, X2T_FONTS_DIR,
  API_PORT, WEB_ORIGIN,
} from "../../config.mjs";
import { sign, verify } from "./jwt.mjs";
import * as storage from "./storage.mjs";
import { buildLessonPlanDocx, buildMinimalPdf, PDF_PROBE_TEXT } from "../fixtures/make-fixtures.mjs";
import { 打包源码, 源码说明页HTML } from "./source-archive.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * ⚠ **两个根，别混。**
 * `DEMO_ROOT` 是 demo/（插件、夹具、落盘都在这底下）；
 * `PROJECT_ROOT` 从 config.mjs 来，是仓库根（许可原件与 NOTICE.md 在那儿）。
 * 从前这里只有一个 `PROJECT_ROOT = HERE/..`，两样东西恰好同一个目录；
 * 搬完 demo/ 之后它算出来的是 demo/，**名字与值就对不上了**。
 */
const DEMO_ROOT = path.resolve(HERE, "..");
const PLUGIN_DIR = path.join(DEMO_ROOT, "plugin");
const SDK_PLUGINS_JSON = "/packages/onlyoffice/" + SDK_VERSION + "/plugins.json";

/** 自己的版本号，源码归档名要用。**读 package.json，不在这儿抄一份。** */
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
).version;
const SOURCE_ARCHIVE_NAME = "onlyoffice-web-" + PKG_VERSION;

/**
 * 源码放在哪。
 *
 * AGPL 第 13 条要的是「从网络服务器上免费取得」，**最常见的做法是给一个代码仓库地址**：
 * 设了 `OOW_SOURCE_URL` 就用它。没设的话由这个服务自己现打一个包给人下
 * ——**不能因为还没建仓库就把这条落下**，落下了就是违约，而且不会有任何东西报错。
 */
const SOURCE_URL = process.env.OOW_SOURCE_URL || null;

/**
 * 转换引擎与它的字体贴在这两个地址上。
 *
 * 组件写死了到 `<静态根>/x2t/` 与 `<静态根>/x2t-fonts/` 去找它们，
 * 而盘上这两样**刻意不放在版本目录里面**——它们与静态资源是两条各自独立的版本线
 * （今天引擎 9.3.0.140、静态资源 9.4.0.129）。分开放才看得见这个差别。
 * 所以这里做一次地址上的贴合：浏览器看到的位置不变，盘上各归各的。
 */
/**
 * 那份**真的可编辑 PDF**（OnlyOffice 的「新建 PDF 表单」模板），由抽取脚本从社区版镜像取来。
 * 3 号文档用它当种子——手写的最小 PDF 证明不了「可编辑 PDF 该进 documenteditor」那条，
 * 因为那种 PDF 的正确答案本来就是「不是可编辑 PDF」。
 */
const PDF_FORM_FIXTURE = path.join(
  SDK_ROOT, "onlyoffice", SDK_VERSION, "document-templates/new/default/new.pdf",
);

/**
 * 各种格式的测试文档。由 scripts/make-format-fixtures.mjs 现生成，**没有就当没有**
 * ——这一摊只服务于「哪些类型打得开」那条实测，不生成也不影响别的。
 *
 * 文档号从 101 起，与 1/2/3 那三份手写的分开，一眼看得出哪些是这一摊的。
 */
const FORMAT_FIXTURE_DIR = path.join(DEMO_ROOT, "fixtures/formats");
const FORMAT_FIXTURE_BASE_ID = 101;

/**
 * 这台服务上现在有哪些文档，**一份清单，两个消费方**：
 *
 *   页面上的下拉框（人点着看各种格式长什么样）
 *   scripts/check-formats.mjs（逐个打开出一张表）
 *
 * 每条带一格 `组`，消费方按它筛。**分组是数据不是逻辑**——
 * 让两个消费方各写一份「哪些算格式夹具」的判断，它们迟早不一致。
 */
function 列出全部文档() {
  const 手写的 = [
    { docId: 1, 文件名: "一次函数教学设计.docx", fileType: "docx", 组: "手写", 说明: "中文教案，四个中文字体名" },
    { docId: 2, 文件名: "探针.pdf", fileType: "pdf", 组: "手写", 说明: "普通 PDF（该进 pdfeditor）" },
    { docId: 3, 文件名: "表单模板.pdf", fileType: "pdf", 组: "手写", 说明: "可编辑 PDF（该进 documenteditor）" },
  ].filter((d) => storage.exists(d.docId));
  const 格式 = 列出格式夹具().map(({ docId, 文件名, fileType }) => ({
    docId,
    文件名,
    fileType,
    组: "各种格式",
    说明: "",
  }));
  return [...手写的, ...格式];
}

function 列出格式夹具() {
  if (!fs.existsSync(FORMAT_FIXTURE_DIR)) return [];
  return fs
    .readdirSync(FORMAT_FIXTURE_DIR)
    .filter((f) => !f.endsWith(".json"))
    .sort()
    .map((文件名, i) => ({
      docId: FORMAT_FIXTURE_BASE_ID + i,
      文件名,
      fileType: (文件名.split(".").pop() || "").toLowerCase(),
      路径: path.join(FORMAT_FIXTURE_DIR, 文件名),
    }));
}

const X2T_PREFIX = "/packages/onlyoffice/" + SDK_VERSION + "/x2t/";
const X2T_FONTS_PREFIX = "/packages/onlyoffice/" + SDK_VERSION + "/x2t-fonts/";

/**
 * 界面上那个法律声明入口点开之后，三个链接指向的文件。
 *
 * ⚠ **两份许可原件取的是抽取出来的那一份，不是我们仓库里的副本。**
 * 判据要取实际发出去的那堆东西自带的声明——仓库里另放一份的话，
 * 换一次镜像它就与实际发的对不上了，而对不上不会有任何东西报错。
 */
const LEGAL_FILES = {
  "LICENSE.txt": path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "LICENSE.txt"),
  "3rd-Party.txt": path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "3rd-Party.txt"),
  // ⚠ 这一份在**仓库根**，不在 demo/ 底下。指错了的后果是界面上那个法律声明入口里
  // 「修改说明」变 404，**而页面照样打得开、一句错都不报**——那是许可要求的东西。
  "NOTICE.md": path.join(PROJECT_ROOT, "NOTICE.md"),
};

/**
 * 签票用的密钥。
 *
 * 【本项目修改 2026-08-30】从前这是 `config.mjs` 里一行**写死并且提交进仓库**的字符串。
 * ⚠ 而这个服务是监听在 `0.0.0.0` 上的——也就是说局域网里任何人都能照着仓库里那行字
 * 自己签一张票，取件与存件那两道门就都形同虚设，**而且不会有任何日志说它被绕过了**。
 *
 * 现在两档：
 *   - 设了环境变量 `OOW_TOKEN_SECRET` 就用它（真实部署走这条，配一次就行）；
 *   - 没设就**每次启动现生成一把随机的**。
 *
 * 现生成的代价是**重启之后旧票全失效**（页面刷新一下重新拿票就好），
 * 换来的是仓库里不再躺着一把能用的钥匙。**本机开发仍然零配置。**
 */
function 解析签票密钥() {
  const 来自环境 = process.env.OOW_TOKEN_SECRET;
  if (来自环境) {
    // 短密钥比没有密钥更糟：它给人一种配过了的错觉。当场拦住，别将就。
    if (来自环境.length < 16) {
      console.error("[fatal] OOW_TOKEN_SECRET 只有 " + 来自环境.length + " 位，太短了（要 16 位以上）。");
      process.exit(1);
    }
    return { secret: 来自环境, 来源: "环境变量 OOW_TOKEN_SECRET" };
  }
  return {
    secret: crypto.randomBytes(32).toString("hex"),
    来源: "本次启动现生成（重启后旧票失效；真实部署请设 OOW_TOKEN_SECRET）",
  };
}
const { secret: TOKEN_SECRET, 来源: 密钥来源 } = 解析签票密钥();

/** 插件收到的那格配置里放这个记号，导出的字节里找得到它就说明这条通道通。 */
export const PLUGIN_OPTIONS_PROBE = "OPTIONSPROBE-7Q4X";

/**
 * 插件登记表这个开关**只为测试存在**：要证明「我们那个插件是被我们的登记招出来的」，
 * 就得能把登记关掉再看一眼。关掉之后回的是**只有镜像自带那些插件**的登记表，
 * 也就是「我们没登记过」时的真实状态——不是造一个假状态。
 */
let pluginRegistryEnabled = process.env.POC_PLUGIN_REGISTRY !== "0";

const MIME = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // 许可原件与修改说明。**必须带 charset=utf-8**：不带的话浏览器按本地编码猜，
  // 修改说明里的中文会变成乱码——那就等于「拿不到许可信息」。
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function text(res, code, s) {
  const buf = Buffer.from(String(s), "utf8");
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

/** 读整个请求体，带上限——没有上限的读体是拒绝服务的入口。 */
function readBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── 令牌 ──────────────────────────────────────────────────────────────────
// 两种票，故意分开：
//   session  给浏览器用，走 Authorization 头，管「你能动哪几份文档、能做什么」
//   download 给取件用，**走 query 参数**，只管一次取件，短命
// doc-server 就是这么分的。合成一种的话，一个能贴进地址栏、会被日志与 Referer
// 带出去的字符串就有了写权限。

const SESSION_TTL = 900;
const DOWNLOAD_TTL = 300;

function issueSession(opts) {
  const o = opts || {};
  return sign({
    iss: "onlyoffice-web",
    sub: o.userId || "poc",
    userName: o.userName || "poc-user",
    scope: o.scope || "document:edit",
    documentIds: o.documentIds || [1],
  }, TOKEN_SECRET, SESSION_TTL);
}

function bearerOf(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** 回 {ok, code, claims, reason}——code 已经按语义分好 401/403，调用方直接用。 */
function requireSession(req, docId, needScope) {
  const r = verify(bearerOf(req), TOKEN_SECRET);
  if (!r.ok) return { ok: false, code: 401, reason: r.reason };
  const c = r.claims;
  if (needScope && c.scope !== needScope) return { ok: false, code: 403, reason: "scope" };
  if (docId != null && !(c.documentIds || []).includes(Number(docId))) {
    return { ok: false, code: 403, reason: "doc-not-in-token" };
  }
  return { ok: true, claims: c };
}

// ── 静态 ──────────────────────────────────────────────────────────────────

function serveFile(res, file, cacheable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return text(res, 404, "not found");
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": st.size,
      // SDK 是带版本号的不可变资源，真部署一定是长缓存；别的都不缓存。
      "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * 这次请求该拿哪个地址去拼绝对 URL。
 *
 * ⚠ **取的是「页面」那个 origin，不是后端自己的。** 浏览器必须全程同源：
 * 编辑器在 iframe 里、插件又在编辑器里再开一个 iframe，任何一层跨源，
 * 父页面就什么都读不到。dev 下页面在 3040、后端在 3041，而 vite 的反代
 * **刻意设了 `changeOrigin: false`**，所以 Host 头里带过来的正是页面那个地址。
 *
 * 前面挂了 nginx 时认 `x-forwarded-*`。两样都取不到才回落 config.mjs 里那个值。
 *
 * 【本项目修改 2026-08-30】从前这里直接用 config.mjs 里写死的 `WEB_ORIGIN`。
 * 那是个只在开发机上成立的假设：**换个端口或域名，插件就静悄悄地没了**
 * ——编辑器照着旧地址去取插件配置，取不到，而文档照样打开、照样导出、
 * 首页上一点看不出来。实测过：产物起在 3050 时插件面板 0 个（3040 上是 2 个）。
 */
function originOf(req) {
  const 取头 = (k) => String(req.headers[k] || "").split(",")[0].trim();
  const proto = 取头("x-forwarded-proto") || "http";
  const host = 取头("x-forwarded-host") || 取头("host");
  return host ? proto + "://" + host : WEB_ORIGIN;
}

/** 目录穿越守卫：解析之后必须还在根底下。 */
function under(root, rel) {
  const p = path.resolve(path.join(root, rel));
  return p.startsWith(path.resolve(root)) ? p : null;
}

/**
 * 镜像里自带的那些官方插件，登记成编辑器能取的绝对地址。
 *
 * 盘上那份 `plugins.json` 由抽取脚本生成、写的是相对地址；这里读它、换成绝对地址。
 * **判据取盘上那份，不在这里另列一遍名单**——另列一份的话，
 * 镜像里加减了插件而这边不会跟着变，而两边对不上不报错。
 */
/**
 * ⚠ **缓存的是盘上那份相对地址，不是拼好的绝对地址。**
 * 绝对地址里含 origin，而 origin 随请求走——缓存下来的话，
 * 第一个访问者用什么地址，后面所有人就都被发到那个地址去。
 */
let bundledPluginRelCache = null;
function bundledPluginUrls(origin) {
  if (!bundledPluginRelCache) {
    const f = path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "plugins.json");
    if (!fs.existsSync(f)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      bundledPluginRelCache = data.pluginsData || [];
    } catch (e) {
      console.error("[warn] 盘上那份 plugins.json 解不动：" + e.message);
      return [];
    }
  }
  const base = origin + "/packages/onlyoffice/" + SDK_VERSION + "/";
  return bundledPluginRelCache.map((rel) =>
    /^https?:\/\//i.test(rel) ? rel : base + String(rel).replace(/^\/+/, ""),
  );
}

let pluginManifestCache = null;
function pluginManifest() {
  if (pluginManifestCache) return pluginManifestCache;
  const f = path.join(PLUGIN_DIR, "config.json");
  if (!fs.existsSync(f)) return null;
  pluginManifestCache = JSON.parse(fs.readFileSync(f, "utf8"));
  return pluginManifestCache;
}

// ── 端点 ──────────────────────────────────────────────────────────────────

/** 编辑器配置。对齐 doc-server 的 GET /docserver/api/editor/config/{docId}。 */
function editorConfig(req, res, docId, query) {
  const auth = requireSession(req, docId, null);
  if (!auth.ok) return json(res, auth.code, { error: auth.reason });
  if (!storage.exists(docId)) return json(res, 404, { error: "no such document" });

  const meta = storage.readMeta(docId);
  // cacheKey 取内容摘要的前 12 位：内容变了地址就变，浏览器缓存不会拿旧的糊弄人。
  // doc-server 那边同样是内容摘要（contentMd5），作用一样。
  const cacheKey = meta.sha256.slice(0, 12);
  const downloadToken = sign({
    iss: "onlyoffice-web",
    sub: "download:" + docId,
    scope: "download",
    docId: Number(docId),
    cacheKey,
    version: meta.version,
  }, TOKEN_SECRET, DOWNLOAD_TTL);

  const urlName = "doc-" + docId + "." + meta.fileType;
  const body = {
    document: {
      docId: Number(docId),
      key: docId + "-" + meta.version + "-" + cacheKey,
      title: meta.title,
      fileType: meta.fileType,
      version: meta.version,
      url: "/api/internal/download/" + docId + "/" + cacheKey + "/" + urlName + "?token=" + downloadToken,
    },
    documentType: "word",
    editorConfig: {
      lang: "zh",
      user: { id: auth.claims.sub, name: auth.claims.userName || auth.claims.sub },
    },
    // 存件地址一并给出来，前端不必自己拼——将来换真 doc-server 时换的就是这一格。
    saveUrl: "/api/documents/" + docId + "/content",
  };

  // 插件配置。`?plugins=off` 是给测试用的对照档：同一次会话里能开一次关一次，
  // 用来分清「面板出来了」是因为下发了配置，还是本来就会出来。
  if (query.get("plugins") !== "off") {
    const man = pluginManifest();
    if (man) {
      body.editorConfig.plugins = {
        pluginsData: [originOf(req) + "/plugins/config.json"],
        autostart: [man.guid],
        // ⚠ options 是**给插件下发配置的唯一通道**，登记表那条路没有这一格。
        // 真实那条路上，doc-server 往这里放的是插件访问后端要用的凭证。
        options: {
          [man.guid]: {
            probe: PLUGIN_OPTIONS_PROBE,
            docId: Number(docId),
            issuedAt: new Date().toISOString(),
          },
        },
      };
    }
  }
  json(res, 200, body);
}

/**
 * **取件。** 对齐 doc-server 的 InternalDownloadResource：
 * 令牌走 query 不走头（这条地址是要交给编辑器/浏览器直接去取的，加不了自定义头），
 * 并且照它那样做两条交叉核对——票上写的 docId / cacheKey 必须与地址里的那两段一致。
 *
 * 少了那两条核对的话，一张给 A 文档签的票能去取 B 文档，而签名校验照样通过。
 */
function download(req, res, docId, cacheKey, query) {
  const token = query.get("token");
  if (!token) return text(res, 401, "missing token");
  const r = verify(token, TOKEN_SECRET);
  if (!r.ok) return text(res, 401, "bad token: " + r.reason);
  const c = r.claims;
  if (c.scope !== "download") return text(res, 403, "wrong scope");
  if (Number(c.docId) !== Number(docId)) return text(res, 403, "docId mismatch");
  if (c.cacheKey !== cacheKey) return text(res, 403, "cacheKey mismatch");
  if (!storage.exists(docId)) return text(res, 404, "not found");

  const meta = storage.readMeta(docId);
  const buf = storage.readBytes(docId, c.version != null ? c.version : meta.version);
  res.writeHead(200, {
    "content-type": MIME[".docx"],
    "content-length": buf.length,
    // 文件名刻意只用 ASCII：这条头历史上是各家实现最容易互相踩的一处。
    "content-disposition": 'attachment; filename="doc-' + docId + "." + meta.fileType + '"',
    "cache-control": "no-store",
  });
  res.end(buf);
}

/**
 * **存件。**
 *
 * ⚠ **doc-server 今天没有这个接口。** 它只有两条写路径：
 *   ① POST /docserver/api/documents —— multipart，建**新文档**，不是给已有文档加版本；
 *   ② 文档服务器自己回调 POST /docserver/api/editor/callback —— 它给一段带 url 的 JSON，
 *      我们再回头去 GET 那个 url 把字节取回来。
 * 版本、审计、配额全挂在②上。纯前端这条路是**浏览器直接把字节推过来**，方向相反，
 * 所以这一格是我们凭空加的。真要落地，doc-server 得新增这个接口，
 * 并且把挂在②上的那些东西一起搬过来——这条写进报告。
 */
async function saveContent(req, res, docId) {
  const auth = requireSession(req, docId, "document:edit");
  if (!auth.ok) return json(res, auth.code, { error: auth.reason });
  if (!storage.exists(docId)) return json(res, 404, { error: "no such document" });

  let buf;
  try {
    buf = await readBody(req);
  } catch (e) {
    return json(res, 413, { error: String(e && e.message ? e.message : e) });
  }
  if (buf.length === 0) return json(res, 400, { error: "empty body" });
  // docx 是 zip，头两个字节是 PK。**空文件与半截文件都要在落盘之前挡住**，
  // 否则服务端那份会被一个打不开的文件顶掉，而前端那边显示的是「保存成功」。
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    return json(res, 400, { error: "not a zip/docx" });
  }

  const before = storage.readMeta(docId);
  const meta = storage.save(docId, buf);
  console.log("[save] doc " + docId + ": v" + before.version + " -> v" + meta.version
    + "  " + meta.size + " 字节  " + meta.sha256.slice(0, 12));
  json(res, 200, {
    version: meta.version,
    size: meta.size,
    sha256: meta.sha256,
    updatedAt: meta.updatedAt,
  });
}

// ── 路由 ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + API_PORT);
  const p = decodeURIComponent(url.pathname);
  const q = url.searchParams;

  try {
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // —— 静态：许可与声明 ——
    // 界面上那个法律声明入口里的三个链接指到这里。**这条路由不能省**：
    // 许可的附加条款第三条要求用户能「拿到许可信息」，而入口点开之后链接 404
    // 与没有入口是一回事。三份文件各有出处，见 LEGAL_FILES 那张表。
    // —— 源码（AGPL 第 13 条）——
    // ⚠ 这两条与上面那三份许可原件是**同一件事的两半**：原件说「按什么条款」，
    // 这里给「东西本身」。缺了后一半，前一半不成立。
    if (p === "/legal/source") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(源码说明页HTML({
        sdkVersion: SDK_VERSION,
        镜像: DOCUMENT_SERVER.image,
        源码地址: SOURCE_URL,
        归档名: SOURCE_ARCHIVE_NAME,
      }));
    }
    if (p === "/legal/source.tar.gz") {
      try {
        const { buf, 文件数 } = 打包源码(PROJECT_ROOT, SOURCE_ARCHIVE_NAME);
        console.log("[api]  发出源码包 " + 文件数 + " 个文件 " + buf.length + " 字节");
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": buf.length,
          "content-disposition": "attachment; filename=" + SOURCE_ARCHIVE_NAME + ".tar.gz",
          "cache-control": "no-store",
        });
        return res.end(buf);
      } catch (e) {
        // ⚠ 这条坏了等于许可那条义务断了，**必须吵**，不能静静回个 500 完事。
        console.error("[fatal] 打源码包失败，AGPL 第 13 条那条路断了：" + e.message);
        return text(res, 500, "source archive failed: " + e.message);
      }
    }

    if (p.startsWith("/legal/")) {
      const name = p.slice("/legal/".length);
      const src = LEGAL_FILES[name];
      if (!src) return text(res, 404, "not found");
      return serveFile(res, src, false);
    }

    // —— 静态：插件 ——
    if (p.startsWith("/plugins/")) {
      const f = under(PLUGIN_DIR, p.slice("/plugins/".length));
      if (!f) return text(res, 403, "forbidden");
      return serveFile(res, f, false);
    }

    // —— 静态：SDK ——
    if (p.startsWith("/packages/")) {
      // 登记表现编，不读盘上那份——那棵 1.06 GB 的树一个字节都不动。
      if (p === SDK_PLUGINS_JSON) {
        // 登记表现编：盘上那份写的是相对地址（好让整棵树拷到任意静态服务器都能用），
        // 这里换成绝对地址，再把我们自己那个插件加在后面。
        const origin = originOf(req);
        const 自带的 = bundledPluginUrls(origin);
        const man = pluginManifest();
        const 我们的 = (pluginRegistryEnabled && man) ? [origin + "/plugins/config.json"] : [];
        // 关掉时回的是**只有自带插件**那份，也就是「我们没登记过」时的真实状态。
        // 对照实测靠这个证明「我们那个插件是被我们招出来的」。
        return json(res, 200, { pluginsData: [...自带的, ...我们的] });
      }
      if (p.startsWith(X2T_PREFIX)) {
        const f = under(X2T_DIR, p.slice(X2T_PREFIX.length));
        if (!f) return text(res, 403, "forbidden");
        return serveFile(res, f, true);
      }
      if (p.startsWith(X2T_FONTS_PREFIX)) {
        const f = under(X2T_FONTS_DIR, p.slice(X2T_FONTS_PREFIX.length));
        if (!f) return text(res, 403, "forbidden");
        return serveFile(res, f, true);
      }
      const f = under(SDK_ROOT, p.slice("/packages/".length));
      if (!f) return text(res, 403, "forbidden");
      return serveFile(res, f, true);
    }

    // —— 测试用：把 1 号文档复位成种子那一版 ——
    // 每趟实测都从同一个起点开始，否则文档会一轮轮堆积上一轮插进去的东西，
    // 「旧版里没有这些字」那条免费探针就会随机地失效。
    if (p === "/api/_probe/reset" && req.method === "POST") {
      fs.rmSync(path.join(storage.STORAGE_ROOT, "1"), { recursive: true, force: true });
      fs.rmSync(path.join(storage.STORAGE_ROOT, "2"), { recursive: true, force: true });
      fs.rmSync(path.join(storage.STORAGE_ROOT, "3"), { recursive: true, force: true });
      storage.save(2, buildMinimalPdf(), { title: "探针.pdf", fileType: "pdf" });
      storage.save(3, fs.readFileSync(PDF_FORM_FIXTURE), { title: "表单模板.pdf", fileType: "pdf" });
      const meta = storage.save(1, buildLessonPlanDocx(), { title: "一次函数教学设计.docx", fileType: "docx" });
      console.log("[reset] 1 号文档复位到 v" + meta.version + "  " + meta.sha256.slice(0, 12));
      return json(res, 200, meta);
    }

    // —— 测试用：各种格式那一摊有哪些文档 ——
    // 实测脚本先问这个，再逐个打开。**清单由盘上实际有什么决定**，
    // 不在两处各写一份——两份会各自漂，而漂了的样子是「少测了一个格式而全绿」。
    if (p === "/api/_probe/fixtures") {
      return json(res, 200, 列出全部文档());
    }

    // —— 测试用的对照开关（只影响登记表那条路） ——
    if (p === "/api/_probe/plugin-registry") {
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        pluginRegistryEnabled = Boolean(body.enabled);
      }
      return json(res, 200, { enabled: pluginRegistryEnabled });
    }

    // —— 会话 ——
    if (p === "/api/session" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      return json(res, 200, { token: issueSession(body), expiresIn: SESSION_TTL });
    }

    // —— 编辑器配置 ——
    let m = p.match(/^\/api\/editor\/config\/(\d+)$/);
    if (m && req.method === "GET") return editorConfig(req, res, m[1], q);

    // —— 取件 ——
    m = p.match(/^\/api\/internal\/download\/(\d+)\/([^/]+)\/([^/]+)$/);
    if (m && req.method === "GET") return download(req, res, m[1], m[2], q);

    // —— 存件 ——
    m = p.match(/^\/api\/documents\/(\d+)\/content$/);
    if (m && req.method === "POST") return saveContent(req, res, m[1]);

    // —— 元信息（判据用：服务端那份到底是第几版、多大、摘要是什么） ——
    m = p.match(/^\/api\/documents\/(\d+)$/);
    if (m && req.method === "GET") {
      const auth = requireSession(req, m[1], null);
      if (!auth.ok) return json(res, auth.code, { error: auth.reason });
      if (!storage.exists(m[1])) return json(res, 404, { error: "no such document" });
      return json(res, 200, storage.readMeta(m[1]));
    }

    return text(res, 404, "not found");
  } catch (e) {
    console.error("[500]", p, e);
    return json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

// 种子：storage 里没有 1 号文档就现生成一份。**现生成而不是从别处拷**——
// 这个项目从零拉下来就该能跑，不该依赖谁的机器上正好有一个 docx。
if (!storage.exists(1)) {
  const meta = storage.save(1, buildLessonPlanDocx(), { title: "一次函数教学设计.docx", fileType: "docx" });
  console.log("[seed] 生成 1 号文档 v" + meta.version + "  " + meta.size + " 字节  " + meta.sha256.slice(0, 12));
}
// 2 号是一份 PDF。**它是用来验「缺 pdfeditor 时 PDF 打不开且不出声」有没有被修好的**：
// 上游那个包只带三个编辑器应用，而 sdkjs 里的 pdf 解析那一半是全的，
// 所以症状是接口回报就绪、页面白着。
if (!storage.exists(2)) {
  const meta = storage.save(2, buildMinimalPdf(), { title: "探针.pdf", fileType: "pdf" });
  console.log("[seed] 生成 2 号文档（普通 PDF）v" + meta.version + "  " + meta.size + " 字节，里面那行字是 " + PDF_PROBE_TEXT);
}
// 3 号是一份**可编辑 PDF**（OnlyOffice 的表单模板）。它与 2 号是一对：
// 同样是 PDF，一份该进 pdfeditor、另一份该进 documenteditor。
// **少了这一份，「判断真的在读文件」这条就证明不了**——一个永远回「不是」的判断，
// 在只有普通 PDF 的测试里表现得和正确的判断一模一样。
// 各种格式那一摊。**没生成就跳过**，不当成错误——它只服务于一条实测。
for (const 条 of 列出格式夹具()) {
  if (storage.exists(条.docId)) continue;
  storage.save(条.docId, fs.readFileSync(条.路径), { title: 条.文件名, fileType: 条.fileType });
}
{
  const n = 列出格式夹具().length;
  if (n) console.log("[seed] 各种格式那一摊 " + n + " 份，文档号 " + FORMAT_FIXTURE_BASE_ID + " 起");
  else console.log("[seed] 没有各种格式那一摊（跑 node scripts/make-format-fixtures.mjs 生成）");
}

if (!storage.exists(3)) {
  const meta = storage.save(3, fs.readFileSync(PDF_FORM_FIXTURE), {
    title: "表单模板.pdf",
    fileType: "pdf",
  });
  console.log("[seed] 生成 3 号文档（可编辑 PDF）v" + meta.version + "  " + meta.size + " 字节");
}

// 启动前先确认 SDK 那条路径是对的。这是最容易配错、且报错最不指向自己的一处：
// 路径错了的话浏览器报的是「DocsAPI 脚本加载失败」，人会去查 SDK 而不是查这一行。
const 开跑前必须在的东西 = [
  {
    路径: path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "web-apps/apps/api/documents/api.js"),
    是什么: "编辑器静态资源",
    怎么办: "node scripts/extract-assets.mjs",
  },
  {
    路径: path.join(X2T_DIR, "x2t.wasm"),
    是什么: "格式转换引擎",
    怎么办: "node scripts/fetch-x2t.mjs",
  },
  {
    路径: path.join(X2T_FONTS_DIR, "Carlito-Regular.ttf"),
    是什么: "导出 PDF 用的字体",
    怎么办: "node scripts/build-x2t-fonts.mjs",
  },
  {
    路径: PDF_FORM_FIXTURE,
    是什么: "可编辑 PDF 的实测夹具",
    怎么办: "node scripts/extract-assets.mjs（它会把这份模板一起抽出来）",
  },
];
const 缺的 = 开跑前必须在的东西.filter((x) => !fs.existsSync(x.路径));
if (缺的.length) {
  // 这三样缺哪一样，症状都是「编辑器一直不出来」或「打开了但导不出」，
  // 而浏览器里报的是脚本加载失败之类**不指向缺的那一样**的话。所以在这里当场拦住，
  // 并直接给出该跑哪条命令。
  console.error("[fatal] 开跑前该有的东西没齐：");
  for (const x of 缺的) {
    console.error("  缺 " + x.是什么 + "：" + x.路径);
    console.error("     跑这条补上：" + x.怎么办);
  }
  process.exit(1);
}

server.listen(API_PORT, "0.0.0.0", () => {
  console.log("[api]  静态资源  " + path.join(SDK_ROOT, "onlyoffice", SDK_VERSION));
  console.log("[api]  转换引擎  " + X2T_DIR);
  console.log("[api]  导出字体  " + X2T_FONTS_DIR);
  console.log("[api]  插件      " + PLUGIN_DIR);
  console.log("[api]  签票密钥  " + 密钥来源);
  console.log("[api]  文档落盘  " + storage.STORAGE_ROOT);
  console.log("[api]  登记表    " + (pluginRegistryEnabled ? "开" : "关"));
  console.log("[api]  ready     http://127.0.0.1:" + API_PORT);
});
