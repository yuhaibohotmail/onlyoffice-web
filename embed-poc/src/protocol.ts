/**
 * 宿主页面 ↔ 接入页之间的全部约定。**两边只经这一份说话。**
 *
 * ── 这份契约刻意不知道后端是谁 ────────────────────────────────────────────
 *
 * 宿主只递一张**配置令牌**（宿主按 ONLYOFFICE Docs 的接入协议签的那份编辑器配置）
 * 和**接入后端**的地址。取件、存件都由接入后端代办。**接入后端不在这个仓库里**，由使用方
 * 自己实现；它要提供哪几个 HTTP 接口、各自怎么答，全写在仓库根的 `INTEGRATION.md`，
 * 那份是接入页与它之间唯一的约定。没有任何一处提到某个具体的文档服务。
 *
 * 这不是风格问题，是这个 PoC 能不能被第三方用的分界：
 * 一旦这里出现某家后端的端点或数据形状，这个组件就从「谁都能嵌」变成
 * 「只能配那一家」，而这个仓库是按 AGPL 发出去给别人用的。
 *
 * **用户的令牌不进这个 iframe。** 接入页手里只有接入后端发的会话凭据，宿主不认它。
 *
 * ── 为什么走 postMessage，不走查询串 ────────────────────────────────────
 *
 * 查询串会落进 web 服务器的访问日志、浏览器历史、以及页面对外请求的 Referer。
 * 一张能打开、能存回文档的配置令牌不该出现在那三个地方的任何一个。
 *
 * ⚠ **两个方向都必须校验来源**：宿主发的时候 `targetOrigin` 要写死接入页那个源
 * （**永远不要写 `"*"`**，那是把令牌广播给此刻恰好占着那个 frame 的任何文档）；
 * 接入页收的时候要校验 `event.origin`，否则任何一个开着它的页面都能伪造
 * 「已保存」或者塞一张自己的令牌进来。
 *
 * ── 只认令牌里的值 ────────────────────────────────────────────────────────
 *
 * 文件名、类型、能不能编辑、能不能下载、插件、基准版**全在令牌里**，open 里没有这些明文。
 * open 里就算带着别的字段，接入页也一个都不看，接入后端也只认令牌。
 *
 * ── 沿革 ────────────────────────────────────────────────────────────────
 *
 * 第一版协议（`onlyoffice-web-embed/1`：宿主递取件、存件地址，接入页每次发请求前
 * 向宿主要一份请求头）已于 0.3.0 删除。接入页不再宣告它，收到它的消息一律不理。
 */

/** 协议名带版本。两边对不上就当场拒绝，而不是按半懂的字段往下走。 */
export const PROTOCOL = "onlyoffice-web-embed/2" as const;

/** 这个接入页认得的全部协议名（`ready` 里报给宿主）。 */
export const PROTOCOLS = [PROTOCOL] as const;

/** 组件支持的三种主格式。与 `src/const` 的 `FILE_TYPE` 同值，这里再写一遍是为了自足。 */
export type EmbedFileType = "DOCX" | "XLSX" | "PPTX";

// ── 宿主 → 接入页 ────────────────────────────────────────────────────────

/** 打开一份文档。 */
export type OpenCommand = {
  protocol: typeof PROTOCOL;
  type: "open";
  /**
   * 配置令牌：宿主按 ONLYOFFICE Docs 的接入协议签的那份编辑器配置（HS256 JWT，
   * 载荷里有 `document.url`、`document.key`、`document.permissions`、
   * `editorConfig.callbackUrl`、`editorConfig.mode`、`editorConfig.user` 等）。
   * 接入页**不解析它**，原样交给接入后端，由那边验签。
   */
  token: string;
  /**
   * 接入后端在哪（它的 `/api/...` 前面那一截）。不给＝与接入页同源、同一挂载前缀，
   * 也就是部署时的样子。给相对地址时按接入页自己的地址解析。
   */
  backendUrl?: string;
  /**
   * 文档解压之后的内容超过这么多字节就不转换了。不给＝不设这道闸。
   * 这是宿主对这一页的设置，不是文档的属性，所以不进令牌。
   *
   * 转换跑在浏览器里，所以「文档太大」是这条路特有的、真会发生的事。
   * ⚠ **它触发之后的行为要知道**：导出会回**打开时那份原文件**，
   * 而不是这次编辑的结果，只在返回值里多一格标记。接入页会查那一格并**拒绝上传**
   * ——不查的话，「保存成功」会把用户这次的改动悄悄换回原样。
   */
  officeXmlLimitBytes?: number;
  /** 界面语言偏好。**令牌里有 `editorConfig.lang` 时以令牌为准。** */
  lang?: string;
};

/**
 * 「存一下」。
 *
 * ⚠ **这一条是必须的，不是顺手加的。** 接入页与宿主**几乎一定不同源**
 * （接入页要与那一大堆静态资源同源，而宿主是业务应用），
 * 于是宿主**够不到** `iframe.contentWindow` 上的任何东西——
 * 想「直接调用接入页里那个保存函数」是行不通的。
 *
 * 这一点是搭这个 PoC 的时候撞出来的：最早的宿主就是那么写的，
 * 结果是**点保存什么都不发生，一个错都不报**（跨源读属性拿到的是 undefined，
 * 而 `undefined?.save?.()` 是合法的）。
 */
export type SaveCommand = {
  protocol: typeof PROTOCOL;
  type: "save";
};

/**
 * 「把上次没存上的那一份存到我本地」。
 *
 * 只在上一条 `failed` 带着 `unsavedKept: true` 之后才有意义：那一份字节还留在接入页内存里，
 * 收到这条就在浏览器里把它存成一个本地文件。**不许下载的会话也照做**——那是用户自己刚改的内容，
 * 不给就等于丢数（浏览器版的「不许下载」本来就只是藏按钮）。
 */
export type DownloadUnsavedCommand = {
  protocol: typeof PROTOCOL;
  type: "download-unsaved";
};

export type HostMessage = OpenCommand | SaveCommand | DownloadUnsavedCommand;

// ── 接入页 → 宿主 ────────────────────────────────────────────────────────

/**
 * 「我加载好了，可以收 open 了」。顺带说明这一页认得哪几版。
 *
 * ⚠ **宿主必须等这一条再发 `open`，不能在 `iframe.onload` 里就发。**
 * `onload` 只说明那个 HTML 到了，里面的脚本还没挂上监听
 * ——那时发过去的消息**不会报错，只是没人收**，而症状是「一直停在等配置」。
 */
export type ReadySignal = {
  protocol: typeof PROTOCOL;
  type: "ready";
  protocols: string[];
};

/** 文档打开了。三格都取自接入后端验过的令牌，宿主据此画按钮（比如不许下载就不画导出）。 */
export type OpenedSignal = {
  protocol: typeof PROTOCOL;
  type: "opened";
  mode: "edit" | "view";
  allowDownload: boolean;
  baseVersion: number | null;
};

/** 存件成功。基准版由接入页自己往前推，宿主不用再管。 */
export type SavedSignal = {
  protocol: typeof PROTOCOL;
  type: "saved";
  version: number | null;
  size: number;
};

/**
 * 出事了。`stage` 说是在哪一步出的，宿主据此决定怎么跟用户讲。
 *
 * ⚠ **`save` 那一步失败要单独讲清楚**：此刻用户的成果只存在于这个 iframe 里的一段字节中。
 * `unsavedKept` 为 true 时宿主要给人一个「存到本地」的按钮；一个自动消失的提示条 = 直接丢数。
 */
export type FailedSignal = {
  protocol: typeof PROTOCOL;
  type: "failed";
  stage: "open" | "session" | "download" | "export" | "save" | "download-unsaved";
  message: string;
  /** 状态码。宿主拒绝时是**宿主自己回的那个**（接入后端原样转交），比如版本冲突的 409。 */
  status?: number;
  /** 报文原文（截到 800 字节），宿主要展示给人看。 */
  body?: string;
  /** 这个失败是宿主说的，还是接入后端自己说的（没有就是接入页自己）。 */
  from?: "host" | "backend";
  /**
   * 这次没存上的那一份字节还留在接入页里。为 true 时宿主应当给人一个「存到本地」的按钮，
   * 点了就发 `download-unsaved`。
   */
  unsavedKept: boolean;
};

export type EmbedMessage = ReadySignal | OpenedSignal | SavedSignal | FailedSignal;

// ── 两边都用的小工具 ────────────────────────────────────────────────────

/**
 * 是不是这份协议的消息。**先过这一关再看 type**，别拿别人的消息往下解析。
 * 协议名比的是全等，所以第一版（已删）和别的什么东西的消息在这里就被筛掉了。
 */
export function isProtocolMessage(data: unknown): data is { protocol: typeof PROTOCOL; type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { protocol?: unknown }).protocol === PROTOCOL &&
    typeof (data as { type?: unknown }).type === "string"
  );
}
