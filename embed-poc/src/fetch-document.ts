/**
 * 经接入后端取件：**分段取，某一段断了只重取那一段**。
 *
 * 为什么：整份几十上百 MB 的演示文稿一次取，有的浏览器插件会在响应头之后把它掐断
 * （开发者工具里是 `200` 之后 `net::ERR_FAILED`，页面拿到 `TypeError: Failed to fetch`），
 * 网络不稳时也是一断全白下。分段之后每个请求都不大，断了的那一段重来就行。
 *
 * 做法：
 *   1. 第一个请求带 `Range: bytes=0-<段大小-1>`。
 *   2. 回 `200`：接入后端不支持分段（Range 是可选的），这就是整份，照旧用。
 *   3. 回 `206`：从 `Content-Range` 读出总长，剩下的段几段同时取，每段失败重试几次。
 *   4. 每段都核对起点与长度，拼完再核总长；对不上就算失败，不把残件交给编辑器。
 *
 * 非 2xx（401、404、宿主拒了……）不重试，原样交回去，由调用方照协议报 `failed{stage:"download"}`。
 */

export type 取件结果 =
  | { 结果: "好"; blob: Blob }
  /** 接入后端答了非 2xx：原样交回，照协议报。 */
  | { 结果: "拒"; response: Response }
  /** 网络断了、重试也不行，或者拼出来不对。 */
  | { 结果: "断"; message: string };

export interface 取件选项 {
  /** 每段多少字节。默认 8 MB；0 = 不分段，整份一次取（不带 Range）。 */
  段大小?: number;
  /** 同时取几段。默认 4。 */
  并发?: number;
  /** 一段失败后再试几次（不含第一次）。默认 3。 */
  重试?: number;
  /** 两次重试之间等多久（毫秒），第 n 次重试等 n 倍。默认 1000。 */
  重试间隔?: number;
  /** 拼文件时用的类型（`File` 的 type）；不给就用响应头里的。 */
  类型?: string;
  /** 进度：已收到、总长（总长不知道时为 null）。 */
  进度?: (已收到: number, 总长: number | null) => void;
  fetch?: typeof fetch;
}

const MB = 1024 * 1024;

class 段失败 extends Error {}

/** `bytes 0-8388607/87828326` → {start, end, total}；认不出返回 null。 */
export function 读ContentRange(v: string | null) {
  const m = v?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!m) return null;
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return end >= start && total > end ? { start, end, total } : null;
}

export async function 分段取件(地址: string, 头: Record<string, string>, 选项: 取件选项 = {}): Promise<取件结果> {
  const 段大小 = 选项.段大小 ?? 8 * MB;
  const 并发 = Math.max(1, 选项.并发 ?? 4);
  const 重试 = Math.max(0, 选项.重试 ?? 3);
  const 间隔 = 选项.重试间隔 ?? 1000;
  const f = 选项.fetch ?? fetch;
  const 等 = (ms: number) => new Promise((r) => setTimeout(r, ms));

  if (段大小 <= 0) {
    // 不分段：和 0.3.3 以前一样整份取一次，不重试（整份重来代价太大，交给用户刷新）。
    try {
      const r = await f(地址, { headers: 头, cache: "no-store" });
      if (!r.ok) return { 结果: "拒", response: r };
      const blob = await r.blob();
      const 类型 = 选项.类型 || r.headers.get("content-type") || "application/octet-stream";
      选项.进度?.(blob.size, blob.size);
      return { 结果: "好", blob: 选项.类型 ? new Blob([blob], { type: 类型 }) : blob };
    } catch (e) {
      return { 结果: "断", message: "取件中断（没分段）：" + String(e) };
    }
  }

  let 已收到 = 0;
  let 总长: number | null = null;

  /** 取一段；网络错误、206 但范围不对、读到一半断了都重试。非 2xx 直接把答复交回去。 */
  async function 取一段(start: number, end: number, 头一段: boolean): Promise<{ bytes: ArrayBuffer; r: Response } | Response> {
    let 最后的错: unknown;
    for (let 第几次 = 0; 第几次 <= 重试; 第几次++) {
      if (第几次 > 0) await 等(间隔 * 第几次);
      try {
        const r = await f(地址, { headers: { ...头, range: `bytes=${start}-${end}` }, cache: "no-store" });
        if (!r.ok) return r;
        if (r.status === 200) {
          // 只有第一段允许回整份（接入后端不支持分段）；后面的段回整份说明后端变卦了，算错。
          if (!头一段) {
            await r.body?.cancel().catch(() => {});
            throw new 段失败("接入后端对分段请求回了整份");
          }
          return { bytes: await r.arrayBuffer(), r };
        }
        const cr = 读ContentRange(r.headers.get("content-range"));
        const 应收 = cr ? cr.end - cr.start + 1 : -1;
        if (r.status !== 206 || !cr || cr.start !== start || (总长 !== null && cr.total !== 总长)) {
          await r.body?.cancel().catch(() => {});
          throw new 段失败("分段答复不对：" + r.status + " " + r.headers.get("content-range"));
        }
        const bytes = await r.arrayBuffer();
        if (bytes.byteLength !== 应收) throw new 段失败(`这一段收到 ${bytes.byteLength} 字节，应为 ${应收}`);
        return { bytes, r };
      } catch (e) {
        最后的错 = e;
      }
    }
    throw 最后的错;
  }

  try {
    const 头段 = await 取一段(0, 段大小 - 1, true);
    if (头段 instanceof Response) return { 结果: "拒", response: 头段 };
    const 类型 = 选项.类型 || 头段.r.headers.get("content-type") || "application/octet-stream";
    if (头段.r.status === 200) {
      选项.进度?.(头段.bytes.byteLength, 头段.bytes.byteLength);
      return { 结果: "好", blob: new Blob([头段.bytes], { type: 类型 }) };
    }

    总长 = 读ContentRange(头段.r.headers.get("content-range"))!.total;
    const 段数 = Math.ceil(总长 / 段大小);
    const 各段: ArrayBuffer[] = new Array(段数);
    各段[0] = 头段.bytes;
    已收到 = 头段.bytes.byteLength;
    选项.进度?.(已收到, 总长);

    let 下一段 = 1;
    let 拒了: Response | null = null;
    let 出错: { e: unknown } | null = null;
    // 一段彻底失败（或被拒）后，别的几路取完手上那段就停，不再领新的。
    const 干活 = async () => {
      while (下一段 < 段数 && !拒了 && !出错) {
        const i = 下一段++;
        const start = i * 段大小;
        let got: Awaited<ReturnType<typeof 取一段>>;
        try {
          got = await 取一段(start, Math.min(start + 段大小, 总长!) - 1, false);
        } catch (e) {
          出错 ??= { e };
          return;
        }
        if (got instanceof Response) {
          拒了 ??= got;
          return;
        }
        各段[i] = got.bytes;
        已收到 += got.bytes.byteLength;
        选项.进度?.(已收到, 总长);
      }
    };
    await Promise.all(Array.from({ length: Math.min(并发, 段数 - 1) }, 干活));
    if (拒了) return { 结果: "拒", response: 拒了 };
    if (出错) throw (出错 as { e: unknown }).e;

    const blob = new Blob(各段, { type: 类型 });
    if (blob.size !== 总长) return { 结果: "断", message: `拼起来 ${blob.size} 字节，应为 ${总长}` };
    return { 结果: "好", blob };
  } catch (e) {
    const 位置 = 总长 === null ? "" : `（已收到 ${(已收到 / MB).toFixed(1)} / ${(总长 / MB).toFixed(1)} MB）`;
    return { 结果: "断", message: `取件中断，重试 ${重试} 次仍不行${位置}：${String(e instanceof 段失败 ? e.message : e)}` };
  }
}
