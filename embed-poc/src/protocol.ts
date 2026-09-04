/**
 * 宿主页面 ↔ 接入页之间的全部约定。**两边只经这一份说话。**
 *
 * ── 这份契约刻意不知道后端是谁 ────────────────────────────────────────────
 *
 * 它只说四件中性的事：**去哪儿取件、存到哪儿去、这是第几版、发请求要带什么头**。
 * 没有任何一处提到某个具体的文档服务。
 *
 * 这不是风格问题，是这个 PoC 能不能被第三方用的分界：
 * 一旦这里出现某家后端的端点或数据形状，这个组件就从「谁都能嵌」变成
 * 「只能配那一家」，而这个仓库是按 AGPL 发出去给别人用的。
 *
 * ── 一条硬规矩：**凭据不进这份 open 命令** ──────────────────────────────
 *
 * 接入页**每次要发请求之前**问宿主要一次头（`need-headers` → `headers`），
 * 而不是开场收一份留着用。两个理由：
 *
 *   ① **令牌会过期，而编辑一份文档的时间没有上限。** 开场那份用到第 16 分钟就成了
 *      一张废纸，而症状是**存件那一下被拒**——那时用户的成果只在浏览器里。
 *   ② 一枚能写的凭据在这个 iframe 里停留的时间，从「整场编辑」缩到「一次请求」。
 *
 * ⚠ 这里最容易写错的一种：宿主把令牌存进一个变量、快过期时换掉它，
 * 而接入页早就把开场那份收进自己的闭包了。**类型对、编译过、页面不报错**，
 * 而它手里那张永远是第一张。所以这份契约里**根本没有放令牌的地方**——
 * 唯一的通道是那个一问一答，写不出上面那种错。
 *
 * ── 为什么走 postMessage，不走查询串 ────────────────────────────────────
 *
 * 查询串会落进 web 服务器的访问日志、浏览器历史、以及页面对外请求的 Referer。
 * 一枚能覆盖文档正文的凭据不该出现在那三个地方的任何一个。
 *
 * ⚠ **两个方向都必须校验来源**：宿主发的时候 `targetOrigin` 要写死接入页那个源
 * （**永远不要写 `"*"`**，那是把凭据广播给此刻恰好占着那个 frame 的任何文档）；
 * 接入页收的时候要校验 `event.origin`，否则任何一个开着它的页面都能伪造
 * 「已保存」或者塞一份自己的头进来。
 */

/** 协议名带版本。两边对不上就当场拒绝，而不是按半懂的字段往下走。 */
export const PROTOCOL = "onlyoffice-web-embed/1" as const;

/** 组件支持的三种主格式。与 `src/const` 的 `FILE_TYPE` 同值，这里再写一遍是为了自足。 */
export type EmbedFileType = "DOCX" | "XLSX" | "PPTX";

/** 要一份头是为了干什么。宿主可以据此签一份刚好够用的凭据，不想区分就忽略它。 */
export type HeaderPurpose = "download" | "save";

// ── 宿主 → 接入页 ────────────────────────────────────────────────────────

/**
 * 打开一份文档。
 *
 * ⚠ `downloadUrl` / `saveUrl` **要给绝对地址或与接入页同源的路径**。
 * 接入页在 iframe 里，它自己那个源多半不是后端那个源，
 * 所以**相对地址会解析到发这套静态资源的地方去**，而那儿没有后端。
 */
export type OpenCommand = {
  protocol: typeof PROTOCOL;
  type: "open";
  /** 显示用，也决定导出时的文件名。 */
  fileName: string;
  fileType: EmbedFileType;
  /** 接入页会 GET 它，期望回文件字节本身。 */
  downloadUrl: string;
  /** 接入页会把导出的字节 POST 到它。 */
  saveUrl: string;
  /**
   * 「我这次编辑基于第几版」。接入页原样带回给 `saveUrl`，自己不解释它。
   *
   * 它存在的理由是：这个编辑器**不支持多人同时编辑**——两个人同时打开各自保存，
   * 后保存的会把先保存的整个盖掉，**而且两边都显示成功**。带上它，后端才有机会
   * 在覆盖之前说一句「这份文档在你编辑期间被别人存过」。
   * 给 `null` 表示宿主不做这个检查。
   */
  baseVersion: number | null;
  lang?: string;
  readOnly?: boolean;
  /**
   * 文档解压之后的内容超过这么多字节就不转换了。不给＝不设这道闸。
   *
   * 转换跑在浏览器里，所以「文档太大」是这条路特有的、真会发生的事。
   * ⚠ **它触发之后的行为要知道**：导出会回**打开时那份原文件**，
   * 而不是这次编辑的结果，只在返回值里多一格标记。接入页会查那一格并**拒绝上传**
   * ——不查的话，「保存成功」会把用户这次的改动悄悄换回原样。
   */
  officeXmlLimitBytes?: number;
  /**
   * 插件配置，**接入页原样递给组件，一个字段都不看**。
   *
   * 它是不透明的，因为里面可能带着插件访问它自己后端要用的凭证
   * ——那是宿主与插件之间的事，接入页不该看懂，也就不会不小心记到日志里。
   */
  plugins?: unknown;
};

/** 对 `need-headers` 的答复。`requestId` 必须原样回来，否则接入页认不出是答哪一问。 */
export type HeadersReply = {
  protocol: typeof PROTOCOL;
  type: "headers";
  requestId: number;
  headers: Record<string, string>;
};

/**
 * 「存一下」。
 *
 * ⚠ **这一条是必须的，不是顺手加的。** 接入页与宿主**几乎一定不同源**
 * （接入页要与那一大堆静态资源同源，而宿主是业务应用），
 * 于是宿主**够不到** `iframe.contentWindow` 上的任何东西——
 * 想「直接调用接入页里那个保存函数」是行不通的。
 *
 * 这一点是搭这个 PoC 的时候撞出来的：第一版的宿主就是那么写的，
 * 结果是**点保存什么都不发生，一个错都不报**（跨源读属性拿到的是 undefined，
 * 而 `undefined?.save?.()` 是合法的）。
 */
export type SaveCommand = {
  protocol: typeof PROTOCOL;
  type: "save";
};

export type HostMessage = OpenCommand | HeadersReply | SaveCommand;

// ── 接入页 → 宿主 ────────────────────────────────────────────────────────

/**
 * 「我加载好了，可以收 open 了」。
 *
 * ⚠ **宿主必须等这一条再发 `open`，不能在 `iframe.onload` 里就发。**
 * `onload` 只说明那个 HTML 到了，里面的脚本还没挂上监听
 * ——那时发过去的消息**不会报错，只是没人收**，而症状是「一直停在等配置」。
 */
export type ReadySignal = {
  protocol: typeof PROTOCOL;
  type: "ready";
};

/** 「给我一份头，我要发请求了」。 */
export type HeadersRequest = {
  protocol: typeof PROTOCOL;
  type: "need-headers";
  requestId: number;
  purpose: HeaderPurpose;
};

/** 存件成功。`version` 是后端回的新版本号，宿主据此更新自己手里的基准版。 */
export type SavedSignal = {
  protocol: typeof PROTOCOL;
  type: "saved";
  version: number | null;
  size: number;
};

/**
 * 出事了。`stage` 说是在哪一步出的，宿主据此决定怎么跟用户讲。
 *
 * ⚠ **`save` 那一步失败要单独讲清楚**：此刻用户的成果只存在于这个 iframe 里的一段字节中，
 * 唯一不丢数的动作是**趁标签页还开着把它导出到本地**。一个自动消失的提示条 = 直接丢数。
 */
export type FailedSignal = {
  protocol: typeof PROTOCOL;
  type: "failed";
  stage: "open" | "download" | "export" | "save";
  message: string;
  /** 后端回的状态码（有的话）。宿主用它区分「凭据过期」与「版本冲突」这两种完全不同的事。 */
  status?: number;
  /** 后端回的报文原文（有的话），宿主要展示给人看。 */
  body?: string;
};

export type EmbedMessage = ReadySignal | HeadersRequest | SavedSignal | FailedSignal;

// ── 两边都用的小工具 ────────────────────────────────────────────────────

/** 是不是这份协议的消息。**先过这一关再看 type**，别拿别人的消息往下解析。 */
export function isProtocolMessage(data: unknown): data is { protocol: string; type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { protocol?: unknown }).protocol === PROTOCOL &&
    typeof (data as { type?: unknown }).type === "string"
  );
}
