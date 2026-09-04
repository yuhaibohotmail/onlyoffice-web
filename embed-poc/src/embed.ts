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
} from "../../src";
import {
  PROTOCOL,
  isProtocolMessage,
  type EmbedMessage,
  type HeaderPurpose,
  type OpenCommand,
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

function 发给宿主(m: EmbedMessage) {
  // ⚠ targetOrigin 写死，**永远不要写 "*"**。
  window.parent.postMessage(m, 宿主源);
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

window.addEventListener("message", (e) => {
  // ⚠ 这一条不能省：不校验来源的话，任何开着这一页的页面都能塞一份自己的头进来。
  if (e.origin !== 宿主源) return;
  if (!isProtocolMessage(e.data)) return;

  const m = e.data as { type: string } & Record<string, unknown>;
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
    void 打开(m as unknown as OpenCommand);
    return;
  }
  if (m.type === "save") {
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
  const out = await manager.exportAsBlob();

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

/** 页面上那个保存按钮与自动实测走**同一条路**——否则「手点着好使」和「脚本跑绿」会变成两件事。 */
(window as unknown as { __embed: unknown }).__embed = {
  save: () => 存件(),
  state: () => ({ 打开过, 基准版: 当前?.baseVersion ?? null, 有编辑器: !!manager }),
};

发给宿主({ protocol: PROTOCOL, type: "ready" });
说("已就绪，等 open。");
