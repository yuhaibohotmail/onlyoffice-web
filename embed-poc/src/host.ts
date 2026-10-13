/**
 * **宿主页**——外层那一个，替将来真正嵌入编辑器的那个应用。
 *
 * 它做三件事：把接入页放进一个 iframe、等它说「好了」之后向 mock 要一张**配置令牌**
 * （mock 那边按 ONLYOFFICE Docs 的接入协议签），连同接入后端的地址一起递进去、
 * 以及在人点保存时发一条 `save`。宿主不发取件存件地址、不给请求头：取件存件都经接入后端。
 *
 * 存件被拒、接入页说它还留着那一份时，页面上冒出「把我这一份存到本地」那个按钮。
 *
 * 第一版协议（宿主递地址、每次现给请求头）已于 0.3.0 删除，这一页只按第二版当宿主。
 */

import { PROTOCOL, isProtocolMessage, type HostMessage } from "./protocol";

const 参数 = new URL(location.href).searchParams;
/** 接入页在哪个源上。默认笨静态服务器那个口，可用查询串覆盖，方便换端口试。 */
const 接入页源 = 参数.get("embedOrigin") || "http://" + location.hostname + ":3042";
const 接入页地址 =
  接入页源.replace(/\/+$/, "") + "/embed.html?hostOrigin=" + encodeURIComponent(location.origin);
/**
 * 把「文档解压后体积上限」压到一个必然触发的小数，用来验那条
 * 「导出回落成原文件时必须拒绝上传」。不给就是不设闸。
 */
const 体积上限 = 参数.has("officeXmlLimitBytes") ? Number(参数.get("officeXmlLimitBytes")) : null;
/**
 * `?noPlugin=1` 时不下发插件。**这是对照组**：
 * 证明插件面板是**因为我们下发了那格配置**才出现的，而不是它本来就在。
 * 没有这一档的话，「插件出来了」可能只是镜像自带那 11 个里的某一个，
 * 而那条断言就成了恒真。
 */
const 无插件 = 参数.get("noPlugin") === "1";
/** 接入后端在哪。默认本机 3044（实测里那个假后端的端口）。 */
const 接入后端 = 参数.get("backend") || "http://" + location.hostname + ":3044";
/** `?download=0`：请 mock 在令牌里写「不许下载」。 */
const 不许下载 = 参数.get("download") === "0";

const 日志框 = document.getElementById("日志")!;
const 状态框 = document.getElementById("状态")!;
const iframe = document.getElementById("接入页") as HTMLIFrameElement;
const 保存钮 = document.getElementById("保存") as HTMLButtonElement;
const 存到本地钮 = document.getElementById("存到本地") as HTMLButtonElement;

const 插件状态框 = document.getElementById("插件状态")!;
/**
 * 插件那一格的状态要**在页面上看得见**，不能只写进右边的日志。
 *
 * 「怎么看不到插件」是第一个会被问的问题，而它有好几种完全不同的原因：
 * 还没轮到它、宿主没下发、取插件配置失败、下发了但它没报到。
 * 页面上没有状态时，这几种长得一模一样——只能去读日志，而人不会去读。
 */
function 说插件(文字: string, 档: "等" | "好" | "糟") {
  插件状态框.textContent = "插件：" + 文字;
  插件状态框.className = "chip " + 档;
}

const 日志: string[] = [];
function 记(s: string) {
  日志.push(new Date().toLocaleTimeString() + "  " + s);
  日志框.textContent = 日志.slice(-40).join("\n");
  日志框.scrollTop = 日志框.scrollHeight;
  console.log("[宿主]", s);
}
function 说(s: string) {
  状态框.textContent = s;
}

// ── 收接入页的消息 ──────────────────────────────────────────────────────

const 收到的: Array<Record<string, unknown>> = [];
/** 接入页打开之后报回来的那三格（全取自接入后端验过的令牌）。 */
let 打开信息: Record<string, unknown> | null = null;
/** 「我这次编辑基于第几版」。只用来显示：真正往前推它的是接入页（见 protocol.ts 的 `saved`）。 */
let 基准版: number | null = null;
let 就绪 = false;
let 上次存件: { version: number | null; size: number } | null = null;
let 上次失败: Record<string, unknown> | null = null;

/** 插件报回来的东西。判据用它断言「宿主放进去的那格 options，插件真的收到了」。 */
let 插件报告: Record<string, unknown> | null = null;

window.addEventListener("message", (e) => {
  // ⚠ 这一条不能省，理由与接入页那边同：不校验来源，任何页面都能伪造「已保存」。
  if (e.origin !== new URL(接入页地址).origin) return;

  /**
   * 插件发回来的消息**不走这份协议**——它是 OnlyOffice 插件，不是我们的接入页，
   * 而且它发的时候只能用 `targetOrigin: "*"`（它拿不到最外层是谁）。
   * 所以单独认一下，别拿它去过 `isProtocolMessage` 然后被静静丢掉。
   *
   * ⚠ 它是**从插件 iframe 里发给 window.top 的**，而插件 iframe 嵌在编辑器 iframe 里、
   * 编辑器又嵌在接入页里——所以它的 `e.origin` 是静态那个源，与接入页同源。
   */
  const 原始 = e.data as { __pocPlugin?: string } | null;
  if (原始 && typeof 原始 === "object" && 原始.__pocPlugin) {
    插件报告 = 原始 as Record<string, unknown>;
    const 收到了 = (原始 as Record<string, unknown>).有没有收到options === true;
    记("插件报到：" + String(原始.__pocPlugin) + "，收到 options=" + String(收到了));
    说插件(
      收到了 ? "已展开，收到配置了 ✔" : "已展开，但没收到配置",
      收到了 ? "好" : "糟",
    );
    return;
  }

  if (!isProtocolMessage(e.data)) return;
  const m = e.data as { type: string } & Record<string, unknown>;
  收到的.push(m);

  if (m.type === "ready") {
    就绪 = true;
    记("接入页说它好了（认得 " + JSON.stringify(m.protocols) + "）→ 向 mock 要一张配置令牌");
    void 发open();
    return;
  }
  if (m.type === "opened") {
    打开信息 = m;
    if (typeof m.baseVersion === "number") 基准版 = m.baseVersion;
    记("打开了：mode=" + m.mode + "，allowDownload=" + m.allowDownload + "，基准版 " + m.baseVersion);
    说("已打开（" + m.mode + (m.allowDownload ? "" : "，不许下载") + "）");
    return;
  }
  if (m.type === "saved") {
    上次存件 = { version: (m.version as number) ?? null, size: (m.size as number) ?? 0 };
    if (typeof m.version === "number") 基准版 = m.version;
    存到本地钮.hidden = true;
    记("存回去了：第 " + String(m.version) + " 版，" + m.size + " 字节");
    说("已保存（第 " + String(m.version) + " 版）");
    保存钮.disabled = false;
    return;
  }
  if (m.type === "failed") {
    上次失败 = m;
    记("出事了（" + m.stage + "，" + String(m.status ?? "") + "，来自 " + String(m.from ?? "接入页") + "）：" + String(m.message));
    // ⚠ 存件失败要**阻断式**地讲清楚，不能一闪而过：此刻用户的成果只在那个 iframe 里。
    // 接入页说它还留着那一份，才给「存到本地」。**不看 allowDownload**：那是这个人自己刚改的内容。
    存到本地钮.hidden = m.unsavedKept !== true;
    说(
      m.stage === "save"
        ? "⚠ 没存上（" + (m.status ?? "?") + "）。" +
            (m.unsavedKept ? "你的这一份还在编辑器里 —— 点「把我这一份存到本地」。" : "") +
            "原文：" + String(m.body ?? m.message).slice(0, 300)
        : "出事了（" + m.stage + "）：" + String(m.message),
    );
    保存钮.disabled = false;
  }
});

/**
 * 这个 PoC 自己那个插件的地址。
 *
 * ⚠ **必须是带 origin 的绝对地址。** 实测过：登记表里的相对地址，
 * 编辑器会解析到**它自己那个应用目录**下面去（见 embed-poc/README.md）。
 * 何况插件在静态那个源上，而这份配置是宿主（另一个源）发出去的。
 */
const 插件配置地址 = 接入页源.replace(/\/+$/, "") + "/plugin/config.json";

/**
 * 读插件的 guid。**从 config.json 里读，不在这边再写一份。**
 * 两处各写一份的话，改了 guid 而这边没跟上——插件照样登记得上、
 * 但 `options` 那一格按 guid 分段，对不上号就是**收不到配置而不报错**。
 */
async function 取插件guid(): Promise<string | null> {
  try {
    const c = await (await fetch(插件配置地址)).json();
    return typeof c?.guid === "string" ? c.guid : null;
  } catch (e) {
    记("取插件配置失败（" + String(e) + "）—— 这一趟不下发插件");
    // ⚠ 这一条真出过：静态服务器不发跨源头时，这次 fetch 直接失败，
    // 结果是**插件静静地不下发，页面上什么都不少**。所以这里必须在页面上说一声。
    说插件("取配置失败，没下发（看右边日志）", "糟");
    return null;
  }
}

/**
 * 向 mock 要一张配置令牌，连同接入后端的地址递进去。
 *
 * ⚠ **必须等接入页说「我好了」再发，不能在 `iframe.onload` 里就发**：
 * onload 只说明那个 HTML 到了，里面的脚本还没挂上监听——
 * 那时发过去的消息**不会报错，只是没人收**，症状是「一直停在等配置」。
 *
 * ⚠ 真实的宿主里**签令牌的是宿主的后端**，前端只是转递；基准版也是那边签进令牌的，
 * 不由前端写死。这里 mock 收下前端说的插件配置与「许不许下载」再签，只是为了让实测能切换这两格。
 */
async function 发open() {
  // ── 通道二：把插件下发给编辑器，并给它一格配置（经令牌里的 editorConfig.plugins）──
  const guid = 无插件 ? null : await 取插件guid();
  const 插件配置 = guid
    ? {
        pluginsData: [插件配置地址],
        // 打开文档就自动展开它，省得人去插件面板里找。
        autostart: [guid],
        /**
         * ⚠ **`options` 是宿主给插件下发配置的唯一通道**，静态登记表那条路没有这一格。
         * 真实部署里这里放的是插件访问它自己后端要用的凭证。
         * 这里放几个能认出来的值，实测据此断言「宿主放进去的，插件真的收到了」。
         */
        options: { [guid]: { 来自: "宿主页", 记号: "options-" + Date.now(), 文档: "poc-种子.docx" } },
      }
    : undefined;
  if (guid) {
    记("下发插件 " + guid + "（带一格 options）");
    说插件("已下发，等它自己展开（十几秒）", "等");
  } else if (无插件) {
    // 对照组那一档。**说清楚是「没下发」不是「坏了」**——两者一个要查、一个不用。
    说插件("这一趟刻意不下发（对照组）", "等");
  }
  let token = "";
  try {
    const r = await fetch(location.origin + "/oo/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plugins: 插件配置, download: !不许下载 }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    token = (await r.json()).token;
  } catch (e) {
    记("要配置令牌失败（" + String(e) + "）");
    说("要不到配置令牌：" + String(e));
    return;
  }
  记("拿到配置令牌，递给接入页（接入后端在 " + 接入后端 + "）");
  发给接入页({
    protocol: PROTOCOL,
    type: "open",
    token,
    backendUrl: 接入后端,
    // 实测那条「导出回落成原文件时必须拒绝上传」用它把闸门压到一个必然触发的值。
    // 平时不给，就是不设这道闸。
    ...(体积上限 !== null ? { officeXmlLimitBytes: 体积上限 } : {}),
  });
  说("已发 open，等它打开…");
}

function 发给接入页(m: HostMessage) {
  // ⚠ targetOrigin 写死接入页那个源，**永远不要写 "*"**
  // ——那是把令牌广播给此刻恰好占着那个 frame 的任何文档。
  iframe.contentWindow?.postMessage(m, new URL(接入页地址).origin);
}

// ── 开跑 ────────────────────────────────────────────────────────────────

保存钮.addEventListener("click", () => {
  保存钮.disabled = true;
  说("正在保存…");
  上次存件 = null;
  上次失败 = null;
  // ⚠ **只能发消息，够不到 iframe 里的东西。**
  // 接入页与宿主几乎一定不同源（接入页要与那一大堆静态资源同源），
  // 跨源读 `iframe.contentWindow.__embed` 拿到的是 undefined，
  // 而 `undefined?.save?.()` 是合法的 —— 于是**点了什么都不发生，一个错都不报**。
  // 最早的宿主就是那么写的，这条注释是那次的产物。
  发给接入页({ protocol: PROTOCOL, type: "save" });
});

存到本地钮.addEventListener("click", () => {
  发给接入页({ protocol: PROTOCOL, type: "download-unsaved" });
  记("请接入页把没存上的那一份存到本地");
});

/** 自动实测从这里驱动，走的路与人点按钮完全一样。 */
(window as unknown as { __host: unknown }).__host = {
  ready: () => 就绪,
  save: () => 保存钮.click(),
  /** 请接入页把没存上的那一份存到本地（与点那个按钮同一条路）。 */
  downloadUnsaved: () => 存到本地钮.click(),
  state: () => ({
    就绪,
    打开信息,
    基准版,
    插件报告,
    下发了插件: !无插件,
    上次存件,
    上次失败,
    收到的: 收到的.map((m) => m.type),
    存到本地钮可见: !存到本地钮.hidden,
  }),
  /** 原样发一条消息给接入页。只给实测用：验「第一版（已删）的消息接入页不理」。 */
  sendRaw: (m: unknown) => 发给接入页(m as HostMessage),
};

记("接入页地址：" + 接入页地址);
iframe.src = 接入页地址;
说("正在加载接入页…");
