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
 *
 * ── 【2026-10-07 新增】第二版协议，与第一版并存 ─────────────────────────
 *
 * 第二版（`onlyoffice-web-embed/2`）要一个**接入后端**：宿主不再递取件、存件地址与请求头，
 * 只递一张**配置令牌**（宿主按 ONLYOFFICE Docs 的接入协议签的那份编辑器配置）和接入后端的地址。
 * 取件、存件都由接入后端代办。**接入后端不在这个仓库里**，由使用方自己实现；它要提供哪几个
 * HTTP 接口、各自怎么答，全写在仓库根的 `INTEGRATION.md`，那份是接入页与它之间唯一的约定。
 * 于是**用户的令牌不再进这个 iframe**，「每次现要头」那一问一答在第二版里也就没有了。
 *
 * ⚠ **两版怎么并存**：接入页一加载就**用两个协议名各发一条 `ready`**。宿主比协议名是全等，
 * 所以第一版的宿主只认得第一版那条，第二版的只认得第二版那条，各自只收到一条。
 * 之后**第一条 `open` 用的是哪个协议名，这一页就按哪个走到底**，另一个名字的消息一律不理。
 * 第一版那一套原样保留，到所有宿主都换成第二版之后再去掉。
 *
 * 第二版里**只认令牌里的值**：`open` 里就算带着 `fileName`、`downloadUrl`、`readOnly`、
 * `allowDownload`、`plugins` 这些第一版的明文字段，也一个都不看。
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
   * 【2026-09-17 新增】编辑器界面上给不给下载 / 另存。不给＝允许（与加这一格之前一样）。
   *
   * 设为 `false`：文件菜单里没有「下载为」和另存面板；
   * 预览、编辑、以及宿主发 `save` 存回去都照常。
   *
   * ⚠ **它只关界面入口，挡不住有心人**：接入页要把原文件整个取到浏览器里才能打开，
   * 开发者工具里照样看得到那次请求。真要防拿走文件，得在后端那一侧想办法。
   */
  allowDownload?: boolean;
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

/**
 * 是不是这份协议的消息。**先过这一关再看 type**，别拿别人的消息往下解析。
 *
 * 不给第二个参数时只认第一版——第一版的宿主这么调，行为与加第二版之前逐字相同。
 */
export function isProtocolMessage(
  data: unknown,
  protocol: string = PROTOCOL,
): data is { protocol: string; type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { protocol?: unknown }).protocol === protocol &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

// ══ 第二版（2026-10-07 新增）════════════════════════════════════════════

export const PROTOCOL_V2 = "onlyoffice-web-embed/2" as const;

/** 这个接入页认得的全部协议名。 */
export const PROTOCOLS = [PROTOCOL, PROTOCOL_V2] as const;
export type ProtocolName = (typeof PROTOCOLS)[number];

/** 是两版里的哪一版（都不是就回 null）。 */
export function protocolOf(data: unknown): ProtocolName | null {
  for (const p of PROTOCOLS) if (isProtocolMessage(data, p)) return p;
  return null;
}

// ── 宿主 → 接入页 ──

/**
 * 打开一份文档（第二版）。
 *
 * 文件名、类型、能不能编辑、能不能下载、插件、基准版**全在令牌里**，这里不再有明文。
 */
export type OpenCommandV2 = {
  protocol: typeof PROTOCOL_V2;
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
  /** 与第一版同义。这是宿主对这一页的设置，不是文档的属性，所以不进令牌。 */
  officeXmlLimitBytes?: number;
  /** 界面语言偏好。**令牌里有 `editorConfig.lang` 时以令牌为准。** */
  lang?: string;
};

/** 「存一下」（第二版）。 */
export type SaveCommandV2 = {
  protocol: typeof PROTOCOL_V2;
  type: "save";
};

/**
 * 「把上次没存上的那一份存到我本地」。
 *
 * 只在上一条 `failed` 带着 `unsavedKept: true` 之后才有意义：那一份字节还留在接入页内存里，
 * 收到这条就在浏览器里把它存成一个本地文件。**不许下载的会话也照做**——那是用户自己刚改的内容，
 * 不给就等于丢数（浏览器版的「不许下载」本来就只是藏按钮，见 `allowDownload`）。
 */
export type DownloadUnsavedCommand = {
  protocol: typeof PROTOCOL_V2;
  type: "download-unsaved";
};

export type HostMessageV2 = OpenCommandV2 | SaveCommandV2 | DownloadUnsavedCommand;

// ── 接入页 → 宿主 ──

/** 「我加载好了」（第二版）。顺带说明这一页认得哪几版。 */
export type ReadySignalV2 = {
  protocol: typeof PROTOCOL_V2;
  type: "ready";
  protocols: string[];
};

/** 文档打开了。三格都取自接入后端验过的令牌，宿主据此画按钮（比如不许下载就不画导出）。 */
export type OpenedSignal = {
  protocol: typeof PROTOCOL_V2;
  type: "opened";
  mode: "edit" | "view";
  allowDownload: boolean;
  baseVersion: number | null;
};

/** 存件成功（第二版）。基准版由接入页自己往前推，宿主不用再管。 */
export type SavedSignalV2 = {
  protocol: typeof PROTOCOL_V2;
  type: "saved";
  version: number | null;
  size: number;
};

export type FailedSignalV2 = {
  protocol: typeof PROTOCOL_V2;
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

export type EmbedMessageV2 = ReadySignalV2 | OpenedSignal | SavedSignalV2 | FailedSignalV2;
