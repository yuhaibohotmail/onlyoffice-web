/**
 * HS256 JWT, the smallest version that is still strict. Used by the two test servers of the
 * embed example (the mock host and the fake integration backend); nothing here ships.
 *
 * Strict on purpose, because a fake that accepts anything makes every assertion about tokens
 * vacuous: the header's `alg` must be exactly `HS256`, the signature is compared in constant
 * time, and `exp` is required unless the caller says otherwise.
 */
import crypto from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function sign(payload, secret) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

/** Returns `{ ok: true, payload }` or `{ ok: false, why }`. Never throws. */
export function verify(token, secret, { requireExp = true, now = Date.now() / 1000 } = {}) {
  if (typeof token !== "string") return { ok: false, why: "no token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, why: "not a JWT" };
  let head, payload;
  try {
    head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, why: "not a JWT" };
  }
  if (!head || head.alg !== "HS256") return { ok: false, why: "alg must be HS256" };
  const want = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: "bad signature" };
  if (!payload || typeof payload !== "object") return { ok: false, why: "payload is not an object" };
  if (requireExp && typeof payload.exp !== "number") return { ok: false, why: "exp is required" };
  if (typeof payload.exp === "number" && payload.exp <= now) return { ok: false, why: "expired" };
  return { ok: true, payload };
}

/** A second key derived from the shared one, for things the browser gets to hold. */
export function derive(secret, label) {
  return crypto.createHmac("sha256", secret).update(label).digest();
}
