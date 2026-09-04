import { useEffect, useRef, useState } from "react";
import {
  OnlyOfficeManager,
  ONLYOFFICE_ID,
  editorManagerFactory,
  isOnlyOfficeCdnMode,
} from "../src";

/**
 * 带后端的 PoC 页面。整条链路是：
 *
 *   POST /api/session                 拿一张会话票
 *   GET  /api/editor/config/{docId}   拿到带签的取件地址 + 插件配置
 *   fetch(那个取件地址)                **原始文件必须下到浏览器**——x2t 在浏览器里解析它
 *   OnlyOfficeManager.createWithFile  打开
 *   ……编辑……
 *   exportAsBlob()                    拿回字节
 *   POST /api/documents/{docId}/content   **存件（人点按钮触发，没有自动保存）**
 *
 * ⚠ 与真实 doc-server 那条路**方向相反**：那边是文档服务器自己回调我们、
 * 由服务端去取字节；这边是浏览器把字节推上来。代价写在 README 与报告里。
 *
 * 页面上那排按钮调的就是 window.__poc 上这几个方法，**和自动化脚本走同一条路**
 * ——否则「手点着好使」与「脚本跑绿」会变成两件事。
 */

type SaveResult = { version: number; size: number; sha256: string; updatedAt: string };

/** 服务端有哪些文档。清单由服务端给（`/api/_probe/fixtures`），页面不自己列一份。 */
type DocItem = {
  docId: number;
  文件名: string;
  fileType: string;
  组: string;
  说明: string;
};

/**
 * 用哪一档界面打开。**与「哪一份文档」正交**，所以是两个控件不是一个下拉框。
 *
 * `editor` = 完整编辑器（`main`）；`viewer` = 查看器（`embed`，另一个应用）。
 * ⚠ 别把它读成 `readOnly`：只读是编辑器关掉编辑，仍有工具栏与插件面板；
 * 查看器是换了个应用，两样都没有。组件那边的完整对照见 `OnlyOfficeEditorVariant`。
 */
type Variant = "editor" | "viewer";

type PocApi = {
  openFromServer: (
    docId?: number,
    opts?: { plugins?: "off"; variant?: Variant },
  ) => Promise<{ ms: number; version: number; key: string; variant: Variant }>;
  saveToServer: (docId?: number) => Promise<SaveResult>;
  /**
   * 就地切只读。**它与上面那个 `variant` 是两档，页面上也是两个控件**：
   * 只读是同一个应用（`main`）关掉编辑，工具栏与插件面板都还在；
   * 查看器是换成另一个应用。放在这里也是为了让第二处 `type` 有东西走得到
   * ——组件切编辑权限时会用 `refreshFile` 重发一次配置，那份配置里也有 `type` 一格。
   */
  setReadOnly: (readOnly: boolean) => Promise<{ readOnly: boolean; variant: Variant }>;
  serverMeta: (docId?: number) => Promise<unknown>;
  exportBase64: () => Promise<{ size: number; base64: string; fallback: boolean }>;
  pluginReady: () => { guid: string; options: Record<string, unknown> } | null;
  lastError: () => string | null;
  /** 只为核实一句旧说法：设了同源的绝对地址，会不会被当成跨源。见 README。 */
  probeCdnMode: (origin: string) => { cdnOrigin: string; isCdnMode: boolean };
};

declare global {
  interface Window {
    __poc: PocApi;
    __pocReady?: boolean;
  }
}

export function App() {
  const [status, setStatus] = useState("闲着，还没打开文档");
  /**
   * 状态行那个小圆点的颜色。**只管显示，不参与任何判据**——
   * 自动实测取的是磁盘字节、导出内容与画布像素，从不看这里写了什么。
   * 界面上分个色只是为了「正在忙」与「出错了」一眼分得开，
   * 在这之前两者都是同一行灰字。
   */
  const [statusKind, setStatusKind] = useState<"idle" | "busy" | "ok" | "err">("idle");
  /** 一处改两样，省得下次加一条消息时忘了配颜色。 */
  const say = (kind: "idle" | "busy" | "ok" | "err", text: string) => {
    setStatusKind(kind);
    setStatus(text);
  };
  const [saved, setSaved] = useState<SaveResult | null>(null);
  /** 页面上那个下拉框：有哪些文档、现在选的是哪一份。 */
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [docId, setDocId] = useState(1);
  /**
   * 编辑器还是查看器。
   * **同时存一份 ref**：`window.__poc` 是在只跑一次的 effect 里装上去的，
   * 它闭包里的 state 永远停在初始值——不留 ref 的话，切了控件而脚本读到的还是「编辑器」。
   */
  const [variant, setVariant] = useState<Variant>("editor");
  const variantRef = useRef<Variant>("editor");
  /** 只读按钮上写什么。**与 variant 无关**——它们是两档。 */
  const [readOnly, setReadOnly] = useState(false);
  /**
   * 开过文档没有。只用来决定那句空状态提示还挂不挂着。
   * **一旦开过就不再收回**：编辑器容器里那块地方从此归组件管，
   * 我们不该再往上盖东西。
   */
  const [opened, setOpened] = useState(false);
  const managerRef = useRef<OnlyOfficeManager | null>(null);
  const tokenRef = useRef<string>("");
  const errRef = useRef<string | null>(null);
  const pluginRef = useRef<{ guid: string; options: Record<string, unknown> } | null>(null);

  useEffect(() => {
    /** 插件初始化完之后会 postMessage 过来。DOM 出现早于 init 跑完，所以判据取这条消息。 */
    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      try {
        const m = JSON.parse(ev.data);
        if (m && m.__pocPlugin === "ready") {
          pluginRef.current = { guid: m.guid, options: m.options || {} };
        }
      } catch {
        /* 编辑器自己也在用 postMessage 传一堆东西，解不动的直接跳过 */
      }
    };
    window.addEventListener("message", onMessage);

    // 文档清单问服务端要。取不到也不影响用——只是下拉框里只剩默认那一份。
    fetch("/api/_probe/fixtures")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: DocItem[]) => setDocs(list))
      .catch(() => setDocs([]));

    const session = async () => {
      if (tokenRef.current) return tokenRef.current;
      // 会话票里要列出这次能动哪几份文档。
      // 1 是中文教案，2 是普通 PDF，3 是可编辑 PDF；101 起是「各种格式」那一摊。
      // **那一摊的号问服务端要，不在这里抄一份**——抄的那份会与盘上实际有什么漂开。
      let 格式夹具号: number[] = [];
      try {
        const fr = await fetch("/api/_probe/fixtures");
        if (fr.ok) {
          格式夹具号 = ((await fr.json()) as Array<{ docId: number }>).map((x) => x.docId);
        }
      } catch {
        /* 没生成那一摊也能正常用，只是少一条实测 */
      }
      const r = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "poc",
          userName: "poc-user",
          scope: "document:edit",
          documentIds: [1, 2, 3, ...格式夹具号],
        }),
      });
      if (!r.ok) throw new Error("拿会话票失败：HTTP " + r.status);
      tokenRef.current = (await r.json()).token;
      return tokenRef.current;
    };

    window.__poc = {
      async openFromServer(docId = 1, opts = {}) {
        errRef.current = null;
        pluginRef.current = null;
        setSaved(null);
        // 显式传进来的优先；没传就用界面上现在选的那一档（取 ref，不取闭包里的 state）。
        const 这一档: Variant = opts.variant ?? variantRef.current;
        // 提示先撤掉：**组件一开始挂载就会往容器里插东西**，让它在那之前就不在了，
        // 免得两边同时动同一块 DOM。
        setOpened(true);
        say("busy", "正在用" + (这一档 === "viewer" ? "查看器" : "编辑器") + "打开 " + docId + " 号文档…");
        const t0 = performance.now();
        try {
          const token = await session();
          const qs = opts.plugins === "off" ? "?plugins=off" : "";
          const cr = await fetch("/api/editor/config/" + docId + qs, {
            headers: { authorization: "Bearer " + token },
          });
          if (!cr.ok) throw new Error("取编辑器配置失败：HTTP " + cr.status);
          const cfg = await cr.json();

          // 取件。**这一步是纯前端方案与文档服务器方案最大的差别**：
          // 原始文件必须下到浏览器，因为解析它的 x2t 就跑在这里。
          const fr = await fetch(cfg.document.url);
          if (!fr.ok) throw new Error("取件失败：HTTP " + fr.status);
          const blob = await fr.blob();
          const fileName = cfg.document.title as string;
          const file = new File([blob], fileName, { type: blob.type });

          editorManagerFactory.destroy(ONLYOFFICE_ID);
          const loadSession = editorManagerFactory.beginLoadSession(ONLYOFFICE_ID);
          managerRef.current = await OnlyOfficeManager.createWithFile(
            {
              containerId: ONLYOFFICE_ID,
              fileType: cfg.document.fileType,
              defaultFileName: fileName,
              lang: "zh",
              loadSession,
              user: cfg.editorConfig.user,
              // 【本 PoC 给组件加的那一格】没有它，插件拿不到 options。
              plugins: cfg.editorConfig.plugins,
              // 【本项目给组件加的那一格】编辑器还是查看器。
              // ⚠ 插件配置照旧传：查看器该不该有插件面板，由那个应用自己决定，
              // 不由我们这边少传一格来「造」出结论——否则反向断言验的是我们自己的手法。
              variant: 这一档,
            },
            file,
          );
          const ms = Math.round(performance.now() - t0);
          // 重开就回到可编辑。不复位的话按钮上的字会与实际状态对不上。
          setReadOnly(false);
          say(
            "ok",
            "已用" + (这一档 === "viewer" ? "查看器" : "编辑器") + "打开 " + fileName +
            "（服务端第 " + cfg.document.version + " 版）" + ms + "ms",
          );
          return { ms, version: cfg.document.version, key: cfg.document.key, variant: 这一档 };
        } catch (e) {
          errRef.current = String(e);
          say("err", "打开失败：" + String(e));
          throw e;
        }
      },

      /**
       * 存件。**人点按钮才走这里，没有定时保存**。
       *
       * ⚠ 上传之前必须查 `isOriginalFileFallback`：组件在超过 office-xml 体积上限时
       * 回的是**打开时那份原文件**，只在返回值里多一格标记。不查的话，
       * 「保存成功」会把用户这次的改动悄悄换回原样——一个不报错的数据丢失。
       */
      async saveToServer(docId = 1) {
        const m = managerRef.current;
        if (!m) throw new Error("还没打开文档");
        errRef.current = null;
        say("busy", "正在导出…");
        const out = await m.exportAsBlob();
        if (out.isOriginalFileFallback) {
          const why = "导出回落成了原文件（" + (out.fallbackReason || "未知原因") + "），"
            + "**拒绝上传**：传上去等于把这次的改动丢掉，而服务端会显示保存成功。";
          errRef.current = why;
          say("err", why);
          throw new Error(why);
        }
        say("busy", "正在上传 " + out.blob.size + " 字节…");
        const token = await session();
        const r = await fetch("/api/documents/" + docId + "/content", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/octet-stream" },
          body: out.blob,
        });
        if (!r.ok) {
          const why = "存件失败：HTTP " + r.status + " " + (await r.text()).slice(0, 200);
          errRef.current = why;
          say("err", why);
          throw new Error(why);
        }
        const result: SaveResult = await r.json();
        setSaved(result);
        say("ok", "已存回服务端：第 " + result.version + " 版，" + result.size + " 字节");
        return result;
      },

      /**
       * 切只读。⚠ **别把它当成「切到查看器」**——两件事：
       * 只读还是 `main` 那个应用，工具栏与插件面板都在，只是不让改；
       * 查看器是 `embed`，另一个应用。页面上两个控件各管各的。
       */
      async setReadOnly(readOnly) {
        const m = managerRef.current;
        if (!m) throw new Error("还没打开文档");
        await m.setReadOnly(readOnly);
        const 现在 = { readOnly: m.getReadOnly(), variant: m.getVariant() };
        say(
          "ok",
          (现在.readOnly ? "已切成只读" : "已切回可编辑") +
          "（当前是" + (现在.variant === "viewer" ? "查看器" : "编辑器") + "那一档）",
        );
        return 现在;
      },

      async serverMeta(docId = 1) {
        const token = await session();
        const r = await fetch("/api/documents/" + docId, { headers: { authorization: "Bearer " + token } });
        if (!r.ok) throw new Error("取元信息失败：HTTP " + r.status);
        return r.json();
      },

      /**
       * 把当前文档导出成 base64 交出去，给自动化核对内容。
       *
       * ⚠ 回 base64 而不是数组：几十万个数字的数组过 CDP 序列化会把页面上下文拖垮，
       * 症状是 evaluate 抛「Resulting promise was garbage collected」——看着像页面崩了。
       */
      async exportBase64() {
        const m = managerRef.current;
        if (!m) throw new Error("还没打开文档");
        const out = await m.exportAsBlob();   // ⚠ 回的是 {blob, fileName}，不是 Blob
        const buf = new Uint8Array(await out.blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
        }
        return { size: out.blob.size, base64: btoa(bin), fallback: Boolean(out.isOriginalFileFallback) };
      },

      pluginReady() { return pluginRef.current; },
      lastError() { return errRef.current; },

      probeCdnMode(origin) {
        OnlyOfficeManager.registerStaticResource({ cdnOrigin: origin });
        // 【本项目修改 2026-08-30】这里原本照着组件内部的逻辑重算了一遍，
        // 依据是一句注释：「组件内部那个判断函数没有导出」。**那句话是错的**，
        // `isOnlyOfficeCdnMode` 一直经 barrel 导出着。
        //
        // 照抄一遍的害处不是多写几行，而是**这条断言验的是我们的复制品、不是产品本身**：
        // 产品那边改了判断规则，这里照样绿。现在直接调产品的那个函数。
        const isCdnMode = isOnlyOfficeCdnMode();
        OnlyOfficeManager.resetStaticResource();
        return { cdnOrigin: origin, isCdnMode };
      },
    };
    window.__pocReady = true;

    return () => window.removeEventListener("message", onMessage);
  }, []);

  const run = (label: string, fn: () => Promise<unknown>) => () => {
    fn().catch(() => { /* 状态已由各方法自己写进 setStatus */ });
  };

  /** 当前选中那份文档的样子，只用来在界面上显示，取不到就退回一句话。 */
  const 当前文档 = docs.find((d) => d.docId === docId);

  return (
    <>
      <header className="app-head">
        <span className="name">
          浏览器版 <em>ONLYOFFICE</em>
        </span>
        <span className="sub">编辑器跑在浏览器里，不需要文档服务器</span>
        <span className="spacer" />
        <span className="port" title="页面（vite）">页面 3040</span>
        <span className="port" title="后端：取件 / 存件 / 伺服静态资源">后端 3041</span>
      </header>

      <div id="bar">
        <div className="row">
        {/* 选哪一份文档。**各种格式那一摊就是靠这个下拉框看的**——
            在这之前，那些文档只有脚本开得了，页面上一份都看不到。 */}
        <span className="field">
        <label htmlFor="doc-pick">文档</label>
        <select
          id="doc-pick"
          value={docId}
          onChange={(e) => {
            const id = Number(e.target.value);
            setDocId(id);
            setSaved(null);
            void window.__poc.openFromServer(id).catch(() => {});
          }}
        >
          {docs.length === 0 ? (
            <option value={1}>1 · 一次函数教学设计.docx</option>
          ) : (
            ["手写", "各种格式"].map((组) => {
              const 这一组 = docs.filter((d) => d.组 === 组);
              if (!这一组.length) return null;
              return (
                <optgroup key={组} label={组 === "手写" ? "手写的（链路与 PDF 分派）" : "各种格式（现生成）"}>
                  {这一组.map((d) => (
                    <option key={d.docId} value={d.docId}>
                      {d.docId + " · " + d.fileType + " · " + d.文件名 + (d.说明 ? "（" + d.说明 + "）" : "")}
                    </option>
                  ))}
                </optgroup>
              );
            })
          )}
        </select>
        </span>

        <span className="sep" />

        {/* 界面档位。**与上面那个下拉框正交**——选哪一份文档、用哪一档界面是两件事，
            所以是两个控件。切换即用新的那一档重开当前这份。 */}
        <span className="field">
        <label htmlFor="variant-pick">界面</label>
        <select
          id="variant-pick"
          value={variant}
          onChange={(e) => {
            const v = e.target.value as Variant;
            setVariant(v);
            variantRef.current = v;
            setSaved(null);
            void window.__poc.openFromServer(docId, { variant: v }).catch(() => {});
          }}
        >
          <option value="editor">编辑器（完整，可编辑、有插件面板）</option>
          <option value="viewer">查看器（embed，只看，没有工具栏与插件面板）</option>
        </select>
        </span>
        </div>

        <div className="row">
        <button className="primary" onClick={run("打开", () => window.__poc.openFromServer(docId))}>
          打开
        </button>
        <button onClick={run("保存", () => window.__poc.saveToServer(docId))}>
          保存到服务器
        </button>
        {/* ⚠ 这是**另一件事**，不是上面那个「界面」下拉框的简写：
            只读＝同一个应用关掉编辑（工具栏与插件面板都还在），
            查看器＝换成另一个应用。放两个控件就是为了让这个差别看得见。 */}
        <button
          title="只读仍是编辑器那个应用（main），工具栏与插件面板都还在，只是不让改；查看器是换成另一个应用（embed），两样都没有。"
          onClick={run("只读", async () => {
            const 现在 = await window.__poc.setReadOnly(!readOnly);
            setReadOnly(现在.readOnly);
          })}
        >
          {readOnly ? "切回可编辑" : "切成只读（仍是编辑器那一档）"}
        </button>
        <button onClick={run("元信息", async () => {
          const meta = (await window.__poc.serverMeta(docId)) as { version: number; size: number; sha256: string };
          say("ok", "服务端：第 " + meta.version + " 版，" + meta.size + " 字节，摘要 " + meta.sha256.slice(0, 12));
        })}>
          看服务端那份现在是什么
        </button>

        <span className="sep" />

        {/* 这个是对照用的探针，不是日常按的，所以样子上也让它退一步 */}
        <button
          className="ghost"
          title="关掉插件配置的下发再打开一次。插件不出现才说明上一次是被我们的下发招出来的——这是个对照组，不是日常操作。"
          onClick={run("打开(无插件)", () => window.__poc.openFromServer(docId, { plugins: "off" }))}
        >
          打开（不下发插件配置）
        </button>
        </div>

        <div className={"statusline s-" + statusKind}>
          <span className="dot" />
          <span id="status" title={status}>{status}</span>
          <span className="chips">
            {当前文档 ? <span className="chip">{当前文档.fileType}</span> : null}
            <span className="chip">{variant === "viewer" ? "查看器 embed" : "编辑器 main"}</span>
            {readOnly ? <span className="chip">只读</span> : null}
            {saved ? <span className="chip">第 {saved.version} 版</span> : null}
            {saved ? <span className="chip">{saved.size} 字节</span> : null}
            {saved ? <span className="chip">摘要 {saved.sha256.slice(0, 12)}</span> : null}
          </span>
        </div>
      </div>
      {/*
        ⚠ **那句提示是 `.onlyoffice-container` 的兄弟，不是它的孩子，这一条不能改。**
        组件会把容器里那个 div 换掉、并把编辑器 iframe 直接插进容器里。
        React 要是在同一个父节点里按条件挂/摘一个兄弟节点，commit 期那次
        `insertBefore` 会崩掉整棵树——**不走 onError，类型与单测全绿**，
        只在编辑器重建的时候显形。所以外面套一层 .stage，提示挂在这一层上。
        另外两条也是硬的：容器的类名不能改，编辑器 iframe 必须是它的**直接子节点**
        （组件与全部自动实测都按 `.onlyoffice-container > iframe` 找它）。
      */}
      <div className="stage">
        {!opened ? (
          <div className="empty-hint">
            <div className="empty-card">
              <div className="empty-title">还没有打开文档</div>
              <p className="empty-p">
                上面选一份，或者点<b>「打开」</b>。文档都在后端那儿，
                页面不自己列一份清单。
              </p>
              <dl className="legend">
                <dt>编辑器 / 查看器</dt>
                <dd>两个不同的应用：完整编辑器（<code>main</code>）对只读的查看器（<code>embed</code>）。</dd>
                <dt>只读 ≠ 查看器</dt>
                <dd>只读还是编辑器那个应用，工具栏与插件面板都在，只是不让改。</dd>
              </dl>
            </div>
          </div>
        ) : null}
        <div className="onlyoffice-container">
          <div id={ONLYOFFICE_ID} style={{ position: "absolute", inset: 0 }} />
        </div>
      </div>
    </>
  );
}
