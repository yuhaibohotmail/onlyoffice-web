/**
 * **接入页**——住在 iframe 里的那一个。这个 PoC 真正的产出物。
 *
 * 它做的事很少，而且**刻意不知道后端是谁**：
 *
 *   1. 跟宿主说一声「我好了」
 *   2. 收下一条 open：取件地址、存件地址、这是第几版、插件配置
 *   3. 每次要发请求之前，向宿主要一份头
 *   4. 取件 → 交给组件打开 → 人编辑 → 导出 → 存回去
 *
 * 全部约定在 `protocol.ts`，那份文件里没有任何一处提到某个具体的后端。
 * 将来换后端，改的是宿主，不是这一页。
 *
 * 【2026-10-07 新增】**第二版协议**：open 里只有一张配置令牌和接入后端的地址，
 * 取件、存件都经接入后端（由使用方实现，接口约定见仓库根的 `INTEGRATION.md`），不再向宿主要头。两版并存的判法见 `protocol.ts` 头注释：
 * 一加载就各发一条 `ready`，**第一条 open 是哪一版就按哪一版走到底**。
 *
 * ── 为什么只有 hostOrigin 走查询串 ────────────────────────────────────────
 *
 * 因为它是**在能相信任何消息之前**就得知道的东西：不知道该信哪个源，
 * 就没法判断第一条消息是不是伪造的。其余全部经 postMessage
 * ——一个通道比两个少一半出错的地方，而且凭据本来就不能进查询串。
 */

import {
  OnlyOfficeManager,
  ONLYOFFICE_ID,
  editorManagerFactory,
  registerLegalNotice,
} from "../../src";
import { 按本页位置登记静态资源, 本页挂载前缀 } from "./mount-prefix";
import {
  PROTOCOL,
  PROTOCOL_V2,
  PROTOCOLS,
  protocolOf,
  type EmbedFileType,
  type EmbedMessage,
  type EmbedMessageV2,
  type HeaderPurpose,
  type OpenCommand,
  type OpenCommandV2,
  type ProtocolName,
} from "./protocol";

const 状态框 = document.getElementById("状态")!;
function 说(s: string) {
  状态框.textContent = s;
  console.log("[接入页]", s);
}

/**
 * 该信哪个源。
 *
 * ⚠ **取不到就停在这里，不要回落成 `"*"`**。回落之后这一页照样能跑，
 * 只是任何页面都能塞消息进来、也能收走我们发出去的东西——
 * 一个不报错的敞口比一个打不开的页面糟得多。
 */
const 宿主源 = new URL(location.href).searchParams.get("hostOrigin");
if (!宿主源) {
  说("没给 hostOrigin，不知道该信谁 —— 停在这里。");
  throw new Error("missing hostOrigin");
}

/**
 * 告诉法律声明入口「获取源代码」该指哪儿。**在建编辑器之前注册。**
 *
 * ⚠ **这一步在纯静态部署下是必须的，不是可选的。**
 * 不给的话那条链接指的是 `<legalRoot>/source`，而纯静态部署里没有进程去现打源码包
 * ——点开就是 404。许可证第 13 条要的是「凡通过网络与本程序交互的用户都能免费取得
 * **本版本**的完整对应源码」，**入口点开之后 404 与没有入口是一回事**。
 *
 * 而这个 PoC 演的正是纯静态那一档（笨服务器只发文件），所以它必须在这儿给。
 *
 * ⚠ **指的是标签，不是仓库当前状态**（2026-09-05 改）。
 * 许可证要的是「**本版本**」的对应源码，而仓库随时是个更新的版本
 * ——指默认分支的话，用户拿到的是**另一份**代码，而那条链接照样打得开。
 *
 * 标签名由 `package.json` 的 `version` 推出来（构建期经 vite 的 `define` 注入），
 * **不在这里再抄一个版本号**：两处各写一个必然漂，而漂了之后
 * 那条链接指向另一个版本的源码，且照样回 200，没有任何东西会说不对。
 *
 * ⚠ **发布一版的规矩因此是两步，缺一不可**：
 *   ① 改 `package.json` 的 `version`；
 *   ② 提交之后，**在那个提交上打同名标签** `v<version>` 并推上去。
 * 少了 ②，这条链接指向一个不存在的标签 —— GitHub 回 404，
 * 而那正是「入口点开之后 404 与没有入口是一回事」那一条。
 */
registerLegalNotice({
  // ⚠ **这三份原件的地址也要带上挂载前缀。** 默认是站点根下的 `/legal`，
  // 挂在 `/oow` 底下时那三条链接会去站点根要，**点开就是 404**——
  // 而附加条款第三条要的是「用户拿得到许可信息」，**入口点开之后 404 与没有入口是一回事**。
  // 页面本身照常打得开，所以这一条不真去点一下是看不见的。
  legalRoot: 本页挂载前缀() + "/legal",
  sourceUrl:
    "https://github.com/yuhaibohotmail/onlyoffice-web/tree/v" + __OOW_VERSION__,
});

// 按本页所在位置告诉组件去哪儿取静态资源。**必须在开编辑器之前**。
// 为什么是推出来的、为什么末尾要拼 /packages，见 mount-prefix.ts。
按本页位置登记静态资源();

function 发给宿主(m: EmbedMessage | EmbedMessageV2) {
  // ⚠ targetOrigin 写死，**永远不要写 "*"**。
  window.parent.postMessage(m, 宿主源);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 发一条第二版的消息（省得每处都写一遍协议名）。 */
function 发给宿主v2(m: DistributiveOmit<EmbedMessageV2, "protocol">) {
  发给宿主({ protocol: PROTOCOL_V2, ...m } as EmbedMessageV2);
}

// ── 要一份头：一问一答，每次请求前都问 ────────────────────────────────────

let 请求号 = 0;
const 等着的 = new Map<number, (h: Record<string, string>) => void>();

/**
 * 向宿主要一份请求头。
 *
 * ⚠ **每次发请求之前都要调一次，不要把结果存起来复用。** 存起来就等于回到了
 * 「开场拿一张用到底」，而那张会过期——症状是存件那一下被拒，
 * 而那时用户的成果只在这个页面的内存里。
 */
function 要一份头(purpose: HeaderPurpose): Promise<Record<string, string>> {
  const id = ++请求号;
  return new Promise((resolve, reject) => {
    const 超时 = window.setTimeout(() => {
      等着的.delete(id);
      reject(new Error("宿主没有答复第 " + id + " 次要头（10 秒）"));
    }, 10000);
    等着的.set(id, (h) => {
      window.clearTimeout(超时);
      等着的.delete(id);
      resolve(h);
    });
    发给宿主({ protocol: PROTOCOL, type: "need-headers", requestId: id, purpose });
  });
}

// ── 收消息 ──────────────────────────────────────────────────────────────

let 打开过 = false;
let 当前: OpenCommand | null = null;
let manager: OnlyOfficeManager | null = null;
/**
 * 这一页按哪一版走。**由第一条 open 定下，之后不再变**；定下之前是 null。
 * 定下之后另一版的消息一律不理——两版各有一套状态，混着收的话，
 * 比如第二版打开、第一版发 save，会走到一条没有存件地址的路上去。
 */
let 协议: ProtocolName | null = null;

window.addEventListener("message", (e) => {
  // ⚠ 这一条不能省：不校验来源的话，任何开着这一页的页面都能塞一份自己的头进来。
  if (e.origin !== 宿主源) return;
  const 这条 = protocolOf(e.data);
  if (!这条) return;
  if (协议 && 这条 !== 协议) {
    console.log("[接入页] 这一页按 " + 协议 + " 走，忽略一条 " + 这条 + " 的消息");
    return;
  }

  const m = e.data as { type: string } & Record<string, unknown>;
  if (这条 === PROTOCOL_V2) {
    收第二版(m);
    return;
  }
  if (m.type === "headers") {
    const cb = 等着的.get(m.requestId as number);
    if (cb) cb((m.headers as Record<string, string>) || {});
    return;
  }
  if (m.type === "open") {
    if (打开过) {
      说("已经打开过一份了，忽略重复的 open。");
      return;
    }
    打开过 = true;
    协议 = PROTOCOL;
    void 打开(m as unknown as OpenCommand);
    return;
  }
  if (m.type === "save") {
    if (协议 !== PROTOCOL) return; // 还没打开
    // 失败会经 failed 消息回给宿主，这里不重复报，也不要让它变成未处理的 rejection。
    void 存件().catch(() => {});
  }
});

// ── 打开 ────────────────────────────────────────────────────────────────

async function 打开(cmd: OpenCommand) {
  当前 = cmd;
  try {
    说("正在取件…");
    const 头 = await 要一份头("download");
    const r = await fetch(cmd.downloadUrl, { headers: 头 });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      发给宿主({
        protocol: PROTOCOL, type: "failed", stage: "download",
        message: "取件失败 HTTP " + r.status, status: r.status, body: body.slice(0, 500),
      });
      说("取件失败：HTTP " + r.status);
      return;
    }
    const blob = await r.blob();
    // **原始文件必须下到浏览器**——解析它的转换引擎就跑在这里。
    // 这是纯浏览器方案与「后端跑一个文档服务器」最大的差别。
    const file = new File([blob], cmd.fileName, { type: blob.type });

    说("正在打开…（第一次要下不少东西）");
    editorManagerFactory.destroy(ONLYOFFICE_ID);
    const loadSession = editorManagerFactory.beginLoadSession(ONLYOFFICE_ID);
    manager = await OnlyOfficeManager.createWithFile(
      {
        containerId: ONLYOFFICE_ID,
        fileType: cmd.fileType,
        defaultFileName: cmd.fileName,
        lang: (cmd.lang as "zh") || "zh",
        readOnly: cmd.readOnly,
        // 【2026-09-17 新增】不给就是允许，见 protocol.ts。
        allowDownload: cmd.allowDownload,
        loadSession,
        // 原样递过去，一个字段都不看——见 protocol.ts 里那段说明。
        plugins: cmd.plugins as never,
        ...(typeof cmd.officeXmlLimitBytes === "number"
          ? { officeXmlEvent: { isEnable: true, limitBytes: cmd.officeXmlLimitBytes } }
          : {}),
      },
      file,
    );
    说("打开了：" + cmd.fileName + "（基准版 " + String(cmd.baseVersion) + "）");
  } catch (err) {
    发给宿主({
      protocol: PROTOCOL, type: "failed", stage: "open", message: String(err),
    });
    说("打开失败：" + String(err));
  }
}

// ── 存件 ────────────────────────────────────────────────────────────────

async function 存件() {
  if (!manager || !当前) throw new Error("还没打开文档");
  说("正在导出…");
  /**
   * 【2026-09-17 修改】导出抛错要告诉宿主。
   *
   * 原来这一步抛出去之后，被下面收消息那里的 `.catch(() => {})` 吞掉，宿主一个字都收不到，
   * 只能一直停在「正在保存」。`allowDownload: false` 时导出多了一种失败（够不到编辑器、
   * 放不开下载权限），所以这里补上。
   */
  let out: Awaited<ReturnType<OnlyOfficeManager["exportAsBlob"]>>;
  try {
    out = await manager.exportAsBlob();
  } catch (err) {
    发给宿主({ protocol: PROTOCOL, type: "failed", stage: "export", message: "导出失败：" + String(err) });
    说("导出失败：" + String(err));
    throw err;
  }

  /**
   * ⚠ **这一格必须查。**
   *
   * 组件在超过 office-xml 体积上限时，回的**不是这次编辑的结果，
   * 而是打开时那份原文件**，只在返回值里多一格标记。不查就传上去的话，
   * 服务端会显示「保存成功」，而用户这次的改动被悄悄换回了原样
   * ——一个不报错的数据丢失。
   */
  if (out.isOriginalFileFallback) {
    const 说明 =
      "导出回落成了打开时那份原文件（" + (out.fallbackReason || "未知原因") +
      "）。**拒绝上传**：传上去等于把这次的改动丢掉，而界面上会显示保存成功。";
    发给宿主({ protocol: PROTOCOL, type: "failed", stage: "export", message: 说明 });
    说(说明);
    throw new Error(说明);
  }

  说("正在上传 " + out.blob.size + " 字节…");
  const 头 = await 要一份头("save");
  const 地址 = new URL(当前.saveUrl, location.href);
  if (当前.baseVersion !== null && 当前.baseVersion !== undefined) {
    地址.searchParams.set("baseVersion", String(当前.baseVersion));
  }
  const r = await fetch(地址.toString(), {
    method: "POST",
    headers: { ...头, "content-type": "application/octet-stream" },
    body: out.blob,
  });
  const 文本 = await r.text().catch(() => "");
  if (!r.ok) {
    发给宿主({
      protocol: PROTOCOL, type: "failed", stage: "save",
      message: "存件失败 HTTP " + r.status, status: r.status, body: 文本.slice(0, 800),
    });
    说("存件失败：HTTP " + r.status + " " + 文本.slice(0, 200));
    throw new Error("save failed " + r.status);
  }

  let 版本: number | null = null;
  try {
    const j = JSON.parse(文本);
    if (typeof j?.version === "number") 版本 = j.version;
  } catch {
    // 后端不回 JSON 也不算错——版本号只是让宿主能更新基准版，取不到就让它自己去查。
  }
  // 存成功之后基准版要往前走，否则同一次会话里的第二次保存必然撞冲突。
  if (版本 !== null) 当前.baseVersion = 版本;
  发给宿主({ protocol: PROTOCOL, type: "saved", version: 版本, size: out.blob.size });
  说("存回去了：第 " + String(版本) + " 版，" + out.blob.size + " 字节");
  return { version: 版本, size: out.blob.size };
}

// ══ 第二版：配置令牌 + 接入后端（2026-10-07 新增）════════════════════════

/** 接入后端的 `/api` 前面那一截，打开时定下。 */
let 连接端 = "";
/**
 * 接入后端发的会话凭据。**每次存件成功都会换一张新的**（里面的基准版往前走了），
 * 所以存完要换用回来的那一张。它不是宿主的令牌，宿主不认它。
 */
let 会话 = "";
let 会话信息: {
  mode: "edit" | "view";
  allowDownload: boolean;
  baseVersion: number | null;
  fileName: string;
} | null = null;
/**
 * 上次没存上的那一份。存件被拒时留着，等宿主发 `download-unsaved` 再存到本地；
 * 下一次存成功就清掉（那时它已经过时了）。
 */
let 未存上的: Blob | null = null;

function 收第二版(m: { type: string } & Record<string, unknown>) {
  if (m.type === "open") {
    if (打开过) {
      说("已经打开过一份了，忽略重复的 open。");
      return;
    }
    打开过 = true;
    协议 = PROTOCOL_V2;
    void 打开v2(m as unknown as OpenCommandV2);
    return;
  }
  if (协议 !== PROTOCOL_V2) return; // 还没打开：save、download-unsaved 都没有意义
  if (m.type === "save") {
    void 存件v2().catch(() => {});
    return;
  }
  if (m.type === "download-unsaved") 存到本地();
}

/** 读一个接入后端的答复：状态码优先取宿主的那个（接入后端原样转交时放在头里）。 */
async function 读答复(r: Response) {
  const 文本 = await r.text().catch(() => "");
  const 宿主码 = Number(r.headers.get("x-oow-host-status"));
  const 谁说的 = r.headers.get("x-oow-from");
  return {
    文本,
    status: Number.isInteger(宿主码) && 宿主码 > 0 ? 宿主码 : r.status,
    from: 谁说的 === "host" || 谁说的 === "backend" ? (谁说的 as "host" | "backend") : undefined,
  };
}

const 组件认的类型: Record<string, EmbedFileType> = { docx: "DOCX", xlsx: "XLSX", pptx: "PPTX" };

/** 组件只认 zh / en。令牌里写的是 `zh-CN`、`en-US` 这类时取前两个字母。 */
function 界面语言(...候选: unknown[]): "zh" | "en" {
  for (const c of 候选) {
    if (typeof c !== "string") continue;
    const k = c.toLowerCase().slice(0, 2);
    if (k === "zh" || k === "en") return k;
  }
  return "zh";
}

type 失败详情 = { status?: number; body?: string; from?: "host" | "backend" };

async function 打开v2(cmd: OpenCommandV2) {
  const 失败 = (stage: "open" | "session" | "download", message: string, 详: 失败详情 = {}) => {
    发给宿主v2({ type: "failed", stage, message, ...详, unsavedKept: false });
    说(message);
  };
  try {
    if (typeof cmd.token !== "string" || !cmd.token) return 失败("open", "open 里没有配置令牌（token）");
    // 不给就是与本页同源、同一挂载前缀——部署时的样子。
    连接端 = new URL(cmd.backendUrl || 本页挂载前缀() || "/", location.href).href.replace(/\/+$/, "");

    说("正在验配置…");
    const r = await fetch(连接端 + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // **只递令牌**。open 里别的字段一个都不往外带——接入后端也只认令牌里的。
      body: JSON.stringify({ token: cmd.token }),
    });
    if (!r.ok) {
      const a = await 读答复(r);
      return 失败("session", "配置被拒：HTTP " + a.status, { status: a.status, body: a.文本.slice(0, 800), from: a.from });
    }
    const j = await r.json();
    会话 = j.session;
    const 类型 = 组件认的类型[String(j.document?.fileType || "").toLowerCase()];
    if (!类型) return 失败("open", "这个组件打不开这种文件：" + String(j.document?.fileType));
    会话信息 = {
      mode: j.mode === "edit" ? "edit" : "view",
      allowDownload: j.allowDownload !== false,
      baseVersion: typeof j.baseVersion === "number" ? j.baseVersion : null,
      fileName:
        typeof j.document?.title === "string" && j.document.title ? j.document.title : "document." + 类型.toLowerCase(),
    };

    说("正在取件…");
    const d = await fetch(连接端 + "/api/document", { headers: { authorization: "Bearer " + 会话 } });
    if (!d.ok) {
      const a = await 读答复(d);
      return 失败("download", "取件失败 HTTP " + a.status, { status: a.status, body: a.文本.slice(0, 500), from: a.from });
    }
    const blob = await d.blob();
    const file = new File([blob], 会话信息.fileName, { type: blob.type });

    说("正在打开…（第一次要下不少东西）");
    editorManagerFactory.destroy(ONLYOFFICE_ID);
    const loadSession = editorManagerFactory.beginLoadSession(ONLYOFFICE_ID);
    manager = await OnlyOfficeManager.createWithFile(
      {
        containerId: ONLYOFFICE_ID,
        fileType: 类型,
        defaultFileName: 会话信息.fileName,
        lang: 界面语言(j.lang, cmd.lang),
        readOnly: 会话信息.mode !== "edit",
        allowDownload: 会话信息.allowDownload,
        loadSession,
        // 令牌里的插件配置，原样递过去，一个字段都不看——理由同第一版。
        plugins: (j.plugins ?? undefined) as never,
        ...(typeof cmd.officeXmlLimitBytes === "number"
          ? { officeXmlEvent: { isEnable: true, limitBytes: cmd.officeXmlLimitBytes } }
          : {}),
      },
      file,
    );
    发给宿主v2({
      type: "opened",
      mode: 会话信息.mode,
      allowDownload: 会话信息.allowDownload,
      baseVersion: 会话信息.baseVersion,
    });
    说("打开了：" + 会话信息.fileName + "（基准版 " + String(会话信息.baseVersion) + "，" + 会话信息.mode + "）");
  } catch (err) {
    失败("open", "打开失败：" + String(err));
  }
}

async function 存件v2() {
  if (!manager || !会话信息) throw new Error("还没打开文档");
  if (会话信息.mode !== "edit") {
    const m = "这个会话是只读的，不能存。";
    发给宿主v2({ type: "failed", stage: "save", message: m, unsavedKept: false });
    说(m);
    throw new Error(m);
  }
  说("正在导出…");
  let out: Awaited<ReturnType<OnlyOfficeManager["exportAsBlob"]>>;
  try {
    out = await manager.exportAsBlob();
  } catch (err) {
    发给宿主v2({ type: "failed", stage: "export", message: "导出失败：" + String(err), unsavedKept: false });
    说("导出失败：" + String(err));
    throw err;
  }
  // ⚠ 与第一版同一道闸，理由见那边：回落成原文件时传上去等于把这次的改动丢掉。
  if (out.isOriginalFileFallback) {
    const 说明 =
      "导出回落成了打开时那份原文件（" + (out.fallbackReason || "未知原因") +
      "）。**拒绝上传**：传上去等于把这次的改动丢掉，而界面上会显示保存成功。";
    发给宿主v2({ type: "failed", stage: "export", message: 说明, unsavedKept: false });
    说(说明);
    throw new Error(说明);
  }

  说("正在上传 " + out.blob.size + " 字节…");
  let r: Response;
  try {
    r = await fetch(连接端 + "/api/save", {
      method: "POST",
      headers: { authorization: "Bearer " + 会话, "content-type": "application/octet-stream" },
      body: out.blob,
    });
  } catch (err) {
    未存上的 = out.blob;
    发给宿主v2({ type: "failed", stage: "save", message: "存件失败：" + String(err), unsavedKept: true });
    说("存件失败：" + String(err) + "。你的这一份还在这一页里，可以存到本地。");
    throw err;
  }
  if (!r.ok) {
    // ⚠ **被拒时留住这一份**。此刻用户的成果只在这一页的内存里，宿主据 unsavedKept 给人一个
    // 「存到本地」的按钮——不留的话，被拒那一下就是丢数。
    未存上的 = out.blob;
    const a = await 读答复(r);
    发给宿主v2({
      type: "failed",
      stage: "save",
      message: "存件失败 HTTP " + a.status,
      status: a.status,
      body: a.文本.slice(0, 800),
      from: a.from,
      unsavedKept: true,
    });
    说("没存上（HTTP " + a.status + "）：" + a.文本.slice(0, 200) + "。你的这一份还在这一页里，可以存到本地。");
    throw new Error("save failed " + a.status);
  }
  const j = await r.json();
  // 存成功之后换用新的会话凭据：里面的基准版往前走了。不换的话第二次存必然撞冲突。
  会话 = j.session;
  会话信息.baseVersion = typeof j.baseVersion === "number" ? j.baseVersion : 会话信息.baseVersion;
  未存上的 = null;
  const 版本 = typeof j.version === "number" ? j.version : null;
  发给宿主v2({ type: "saved", version: 版本, size: out.blob.size });
  说("存回去了：第 " + String(版本) + " 版，" + out.blob.size + " 字节");
  return { version: 版本, size: out.blob.size };
}

/**
 * 把上次没存上的那一份存成本地文件。**不看 allowDownload**：那是用户自己刚改的内容，
 * 不给就等于丢数，而浏览器版的「不许下载」本来就只是藏按钮。
 */
function 存到本地() {
  if (!未存上的 || !会话信息) {
    const m = "没有没存上的那一份可以存。";
    发给宿主v2({ type: "failed", stage: "download-unsaved", message: m, unsavedKept: false });
    说(m);
    return;
  }
  const 地址 = URL.createObjectURL(未存上的);
  const a = document.createElement("a");
  a.href = 地址;
  a.download = 会话信息.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(地址), 60000);
  说("已把没存上的那一份（" + 未存上的.size + " 字节）存到本地：" + 会话信息.fileName);
}

/** 页面上那个保存按钮与自动实测走**同一条路**——否则「手点着好使」和「脚本跑绿」会变成两件事。 */
(window as unknown as { __embed: unknown }).__embed = {
  save: () => (协议 === PROTOCOL_V2 ? 存件v2() : 存件()),
  state: () => ({
    打开过,
    协议,
    基准版: 协议 === PROTOCOL_V2 ? (会话信息?.baseVersion ?? null) : (当前?.baseVersion ?? null),
    有编辑器: !!manager,
    未存上的字节数: 未存上的 ? 未存上的.size : 0,
  }),
};

// 两版各发一条 ready。宿主比协议名是全等，所以每个宿主只会收到它认得的那一条。
发给宿主({ protocol: PROTOCOL, type: "ready" });
发给宿主({ protocol: PROTOCOL_V2, type: "ready", protocols: [...PROTOCOLS] });
说("已就绪，等 open。");
