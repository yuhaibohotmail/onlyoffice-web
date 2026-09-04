/**
 * HS256 的签发与校验，手写，零依赖。
 *
 * 为什么不用库：这个 PoC 要证明的是「取件与存件那两道门真的在挡」，
 * 而不是「某个 jwt 库能用」。手写三十行反而让**校验到底查了哪几样**一眼看得见
 * ——过期、签名、以及下面那两条交叉核对，缺哪一条都能当场指出来。
 *
 * 真实的 doc-server 用的是 RS256 + 一对密钥文件（mp.jwt），claims 的形状照抄了它的
 * TokenService：iss / sub / scope / documentIds / exp。换回去时只有算法这一层要改。
 */
import crypto from "node:crypto";

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** 签一张票。`ttlSeconds` 必填——**没有到期时间的令牌不叫令牌**。 */
export function sign(payload, secret, ttlSeconds) {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("sign() 要求一个正的 ttlSeconds");
  }
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = head + "." + b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", secret).update(data).digest());
  return data + "." + sig;
}

/**
 * 校验。**回的是 `{ok:false, reason}` 而不是抛异常**：调用方要按 reason 分出
 * 401（你没有票 / 票过期了）与 403（票是真的，但不是这份文件的），
 * 混成一个码的话，排查的人分不出「重新登录」和「你走错门了」。
 */
export function verify(token, secret) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const data = parts[0] + "." + parts[1];
  const expect = b64url(crypto.createHmac("sha256", secret).update(data).digest());
  // 定长比较：签名比对用 timingSafeEqual，长度不同时先短路（它要求等长）。
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }
  let claims;
  try {
    claims = JSON.parse(unb64url(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}
