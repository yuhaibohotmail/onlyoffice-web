// 接入页分段取件（embed-poc/src/fetch-document.ts）的单测：用假的 fetch 演接入后端，
// 演支持分段、不支持分段、某段断几次、一直断、被拒、范围答错这几种。
// 跑：node --test scripts/test/fetch-document.test.mjs（Node 24 直接读 .ts）
import assert from "node:assert/strict";
import { test } from "node:test";
import { 分段取件, 读ContentRange } from "../../embed-poc/src/fetch-document.ts";

const 文件 = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
const 快 = { 段大小: 1000, 并发: 3, 重试间隔: 1 };

/** 假接入后端。断: (start) => 这一段要不要假装断（返回 true 就抛 TypeError）。 */
function 后端({ 支持分段 = true, 断 = () => false, 改答复 } = {}) {
  const 记录 = [];
  const f = async (_url, init) => {
    const range = init?.headers?.range;
    记录.push(range);
    const m = range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!支持分段 || !m) return new Response(文件, { status: 200, headers: { "content-type": "application/x-whole" } });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), 文件.length - 1);
    if (断(start)) throw new TypeError("Failed to fetch");
    const r = new Response(文件.subarray(start, end + 1), {
      status: 206,
      headers: { "content-type": "application/x-part", "content-range": `bytes ${start}-${end}/${文件.length}` },
    });
    return 改答复 ? 改答复(r, start) : r;
  };
  return { f, 记录 };
}

const 拿字节 = async (r) => Buffer.from(await r.blob.arrayBuffer());

test("支持分段：分十段取，拼起来逐字节相同，类型用调用方给的", async () => {
  const { f, 记录 } = 后端();
  const 进度 = [];
  const r = await 分段取件("/api/document", { authorization: "Bearer s" }, { ...快, fetch: f, 类型: "application/x-given", 进度: (a, b) => 进度.push([a, b]) });
  assert.equal(r.结果, "好");
  assert.deepEqual(await 拿字节(r), 文件);
  assert.equal(r.blob.type, "application/x-given");
  assert.equal(记录.length, 10);
  assert.deepEqual(进度.at(-1), [10_000, 10_000]);
});

test("不支持分段：第一次就回整份 200，照旧用，只请求一次", async () => {
  const { f, 记录 } = 后端({ 支持分段: false });
  const r = await 分段取件("/api/document", {}, { ...快, fetch: f });
  assert.equal(r.结果, "好");
  assert.deepEqual(await 拿字节(r), 文件);
  assert.equal(r.blob.type, "application/x-whole");
  assert.equal(记录.length, 1);
});

test("某几段断了两次：重试后取全", async () => {
  const 次数 = new Map();
  const { f } = 后端({
    断: (start) => {
      if (start !== 0 && start !== 4000) return false;
      const n = (次数.get(start) ?? 0) + 1;
      次数.set(start, n);
      return n <= 2;
    },
  });
  const r = await 分段取件("/api/document", {}, { ...快, fetch: f });
  assert.equal(r.结果, "好");
  assert.deepEqual(await 拿字节(r), 文件);
});

test("一段一直断：重试用完报「断」，说出断在哪、收到多少", async () => {
  const { f, 记录 } = 后端({ 断: (start) => start === 5000 });
  const r = await 分段取件("/api/document", {}, { ...快, 重试: 2, fetch: f });
  assert.equal(r.结果, "断");
  assert.match(r.message, /重试 2 次/);
  assert.match(r.message, /Failed to fetch/);
  assert.match(r.message, /MB/);
  assert.equal(记录.filter((x) => x === "bytes=5000-5999").length, 3);
  assert.ok(记录.length < 10 + 2 + 3, "出错后别的几路不该再领新段");
});

test("被拒（401）：不重试，原样交回答复", async () => {
  const f = async () => new Response("过期了", { status: 401, headers: { "x-oow-from": "backend" } });
  const r = await 分段取件("/api/document", {}, { ...快, fetch: f });
  assert.equal(r.结果, "拒");
  assert.equal(r.response.status, 401);
  assert.equal(await r.response.text(), "过期了");
});

test("中间某段被拒：交回那个答复", async () => {
  const { f } = 后端({ 改答复: (r, start) => (start === 3000 ? new Response("没了", { status: 404 }) : r) });
  const r = await 分段取件("/api/document", {}, { ...快, fetch: f });
  assert.equal(r.结果, "拒");
  assert.equal(r.response.status, 404);
});

test("范围答错、少给字节、后面的段回整份：都算这一段失败，重试不好就报「断」", async () => {
  for (const 改 of [
    (r, s) => (s === 2000 ? new Response(文件.subarray(0, 1000), { status: 206, headers: { "content-range": `bytes 0-999/${文件.length}` } }) : r),
    (r, s) => (s === 2000 ? new Response(文件.subarray(2000, 2500), { status: 206, headers: { "content-range": `bytes 2000-2999/${文件.length}` } }) : r),
    (r, s) => (s === 2000 ? new Response(文件, { status: 200 }) : r),
    (r, s) => (s === 2000 ? new Response(文件.subarray(2000, 3000), { status: 206, headers: { "content-range": `bytes 2000-2999/99999` } }) : r),
  ]) {
    const { f } = 后端({ 改答复: 改 });
    const r = await 分段取件("/api/document", {}, { ...快, 重试: 1, fetch: f });
    assert.equal(r.结果, "断");
  }
});

test("Content-Range 解析", () => {
  assert.deepEqual(读ContentRange("bytes 0-8388607/87828326"), { start: 0, end: 8388607, total: 87828326 });
  assert.equal(读ContentRange("bytes */100"), null);
  assert.equal(读ContentRange("bytes 5-2/100"), null);
  assert.equal(读ContentRange("bytes 0-100/100"), null);
  assert.equal(读ContentRange(null), null);
});
