/**
 * A **fake** integration backend, for the end-to-end run of protocol version 2 only.
 *
 * The real one is not part of this repository: whoever embeds the page implements it, in any
 * language, against the contract in `INTEGRATION.md` at the repository root. This file exists so
 * that `npm run poc:e2e` can drive the embed page through version 2 without one. It follows the
 * contract closely enough for the assertions to mean something (it verifies the config token,
 * signs the fetch and the callback, relays a refusal unchanged), but it is **not a reference
 * implementation and must not be deployed**: staged files live in memory, there is no cleanup
 * sweep, no upload limit tuning, no logging worth the name.
 *
 *   OOW_JWT_SECRET=<shared with the host> OOW_HOST_FETCH_BASE=http://127.0.0.1:3044 \
 *   node embed-poc/server/fake-backend.mjs [port]
 *
 * `OOW_ALLOWED_ORIGINS` (comma-separated) turns on CORS for the embed page's origin: in the test
 * run the page and this process sit on two ports. A real deployment serves both from one origin.
 */
import crypto from "node:crypto";
import http from "node:http";

import { derive, sign, verify } from "./hs256.mjs";

const PORT = Number(process.argv[2] || process.env.OOW_BACKEND_PORT || 3044);
const SECRET = process.env.OOW_JWT_SECRET || "";
const HOST_FETCH_BASE = (process.env.OOW_HOST_FETCH_BASE || "http://127.0.0.1:" + PORT).replace(/\/+$/, "");
const ALLOWED = (process.env.OOW_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const SESSION_TTL = 12 * 3600;
const MAX_UPLOAD = 100 * 1024 * 1024;

if (SECRET.length < 32) {
  console.error("[fake-backend] OOW_JWT_SECRET must be set (at least 32 characters)");
  process.exit(1);
}
const SESSION_KEY = derive(SECRET, "onlyoffice-web session v1");
const STAGED_KEY = derive(SECRET, "onlyoffice-web staged v1");

/** id -> { bytes, exp }. In memory: this is a test fake. */
const staged = new Map();

const now = () => Math.floor(Date.now() / 1000);

function send(res, status, body, headers = {}) {
  const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "content-length": b.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(b);
}
/** The backend's own error: JSON `{error, message}` and `x-oow-from: backend`. */
const fail = (res, status, error, message) => send(res, status, { error, message }, { "x-oow-from": "backend" });

/** A refusal from the host, passed on unchanged (status and body), as the contract requires. */
function relay(res, hostStatus, text) {
  // A host 3xx, or a 2xx that is not `error: 0`, is not a refusal the page can show as such: 502.
  const status = hostStatus >= 400 && hostStatus <= 599 ? hostStatus : 502;
  send(res, status, text.slice(0, 800), { "x-oow-from": "host", "x-oow-host-status": String(hostStatus) });
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Only the token's values count; nothing sent next to it is consulted. */
function sessionFromConfig(cfg) {
  const d = cfg.document || {};
  const e = cfg.editorConfig || {};
  const p = d.permissions || {};
  const mode = e.mode === "view" || p.edit === false ? "view" : "edit";
  return {
    v: 1,
    sid: crypto.randomBytes(12).toString("base64url"),
    key: String(d.key),
    url: String(d.url),
    callbackUrl: typeof e.callbackUrl === "string" ? e.callbackUrl : null,
    fileType: typeof d.fileType === "string" ? d.fileType : "",
    title: typeof d.title === "string" ? d.title : "",
    baseVersion: typeof d.baseVersion === "number" ? d.baseVersion : null,
    user: { id: String(e.user?.id ?? ""), name: String(e.user?.name ?? "") },
    mode,
    allowDownload: p.download !== false,
    exp: now() + SESSION_TTL,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-expose-headers", "x-oow-from, x-oow-host-status");
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    });
    return res.end();
  }
  const p = url.pathname;

  if (p === "/api/health") return send(res, 200, { ok: true });

  // ── POST /api/session: verify the config token, hand out a session credential ──
  if (p === "/api/session" && req.method === "POST") {
    const raw = await readBody(req, 64 * 1024);
    let token;
    try {
      token = JSON.parse(String(raw)).token;
    } catch {
      return fail(res, 400, "bad-request", "Body must be JSON {\"token\": \"...\"}.");
    }
    const v = verify(token, SECRET);
    if (!v.ok) return fail(res, 401, "bad-token", "Config token rejected: " + v.why);
    const cfg = v.payload;
    if (typeof cfg.document?.url !== "string" || !/^https?:\/\//.test(cfg.document.url) || !cfg.document?.key) {
      return fail(res, 400, "missing-field", "Config token needs document.url and document.key.");
    }
    const s = sessionFromConfig(cfg);
    if (s.mode === "edit" && !s.callbackUrl) {
      return fail(res, 400, "missing-field", "An editing session needs editorConfig.callbackUrl.");
    }
    return send(res, 200, {
      session: sign(s, SESSION_KEY),
      expiresIn: SESSION_TTL,
      document: { title: s.title, fileType: s.fileType },
      mode: s.mode,
      allowDownload: s.allowDownload,
      baseVersion: s.baseVersion,
      user: s.user,
      lang: cfg.editorConfig?.lang ?? null,
      plugins: cfg.editorConfig?.plugins ?? null,
    });
  }

  // ── GET /api/staged/<id>: the host collects a staged file (signed, short-lived, once) ──
  if (p.startsWith("/api/staged/") && req.method === "GET") {
    const id = p.slice("/api/staged/".length);
    const exp = Number(url.searchParams.get("exp"));
    const want = crypto.createHmac("sha256", STAGED_KEY).update(id + "|" + exp).digest("base64url");
    const got = url.searchParams.get("sig") || "";
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)) || exp <= now()) {
      return fail(res, 403, "bad-signature", "Staged URL signature invalid or expired.");
    }
    const item = staged.get(id);
    if (!item) return fail(res, 404, "gone", "Already collected or removed.");
    staged.delete(id);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": item.length });
    return res.end(item);
  }

  // Everything below needs a session credential.
  const sv = verify(bearer(req), SESSION_KEY);
  if (!sv.ok) return fail(res, 401, "bad-session", "Session credential rejected: " + sv.why);
  const s = sv.payload;

  // ── GET /api/document: fetch document.url with a request signature ──
  if (p === "/api/document" && req.method === "GET") {
    const t = now();
    const auth = sign({ payload: { url: s.url }, iat: t, exp: t + 300, use: "fetch" }, SECRET);
    let r;
    try {
      r = await fetch(s.url, { headers: { authorization: "Bearer " + auth }, redirect: "manual" });
    } catch (e) {
      return fail(res, 502, "host-unreachable", "Could not fetch document.url: " + String(e));
    }
    if (!r.ok) return relay(res, r.status, await r.text().catch(() => ""));
    const bytes = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      "content-type": r.headers.get("content-type") || "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "no-store",
    });
    return res.end(bytes);
  }

  // ── POST /api/save: stage the bytes, call the host back, pass its answer on ──
  if (p === "/api/save" && req.method === "POST") {
    if (s.mode !== "edit") return fail(res, 403, "read-only", "This session cannot save.");
    const bytes = await readBody(req, MAX_UPLOAD);
    if (bytes === null) return fail(res, 413, "too-large", "File larger than the limit.");
    if (!bytes.length) return fail(res, 400, "empty", "Empty file.");

    const id = crypto.randomBytes(16).toString("hex");
    const t = now();
    const exp = t + 300;
    const sig = crypto.createHmac("sha256", STAGED_KEY).update(id + "|" + exp).digest("base64url");
    staged.set(id, bytes);
    const stagedUrl = HOST_FETCH_BASE + "/api/staged/" + id + "?exp=" + exp + "&sig=" + sig;
    const created = new Date().toISOString().replace("T", " ").slice(0, 19);
    const payload = {
      key: s.key,
      status: 6,
      forcesavetype: 1,
      url: stagedUrl,
      filetype: s.fileType,
      users: [s.user.id],
      actions: [{ type: 2, userid: s.user.id }],
      history: { changes: [{ user: { id: s.user.id, name: s.user.name }, created }] },
      lastsave: new Date().toISOString(),
      ...(s.baseVersion !== null ? { baseVersion: s.baseVersion } : {}),
      iat: t,
      exp,
    };
    let r, text;
    try {
      r = await fetch(s.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: sign(payload, SECRET) }),
        redirect: "manual",
        signal: AbortSignal.timeout(180_000),
      });
      text = await r.text();
    } catch (e) {
      const timeout = e?.name === "TimeoutError";
      return fail(res, timeout ? 504 : 502, timeout ? "host-timeout" : "host-unreachable", String(e));
    } finally {
      staged.delete(id);
    }
    let answer = null;
    try {
      answer = JSON.parse(text);
    } catch {
      /* not JSON: a failure below */
    }
    if (!(r.status >= 200 && r.status < 300 && answer && answer.error === 0)) return relay(res, r.status, text);
    const version = typeof answer.version === "number" ? answer.version : null;
    const next = { ...s, baseVersion: version ?? s.baseVersion };
    return send(res, 200, { session: sign(next, SESSION_KEY), version, baseVersion: next.baseVersion });
  }

  return fail(res, 404, "not-found", "Not found: " + p);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[fake-backend] " + PORT + "  (test fake of the integration backend; never deploy it)");
});
