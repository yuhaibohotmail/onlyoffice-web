/**
 * 界面上的法律声明入口。
 *
 * 【本项目新增 2026-08-30】
 *
 * ── 为什么这个文件必须存在 ──────────────────────────────────────────────────
 *
 * 我们用的 ONLYOFFICE 按 AGPL-3.0 发布，另带五条附加条款。第三条是这么要求的：
 *
 *   界面里要有一个**清晰可达、显著可见**的入口，让用户能
 *   (i) 认出 ONLYOFFICE 是原始开发者
 *   (ii) 知道自己用的可能是一个修改过的版本
 *   (iii) 拿到许可信息
 *
 * **这是对运行界面的要求，在源码里写一段注释不算数。**
 *
 * ── 为什么放在组件里，而不是放在页面里 ──────────────────────────────────────
 *
 * 因为这个组件是给别人引用的。声明放在示例页里，别人引用组件时就丢了，
 * 而丢了不会有任何东西报错——**下一个引用它的人不会知道自己少了一样必须有的东西**。
 * 放在组件里，只要编辑器挂起来了，这个入口就在。
 *
 * 组件本身零框架依赖，所以这里也不用任何框架，就是几行 DOM。
 */

/** 本项目对上游做了哪些改动。**改了东西就往这里加一条，附加条款第二条要求写明修改内容与日期。** */
export const MODIFICATIONS: ReadonlyArray<{ 日期: string; 改了什么: string }> = [
  {
    日期: "2026-08-30",
    改了什么:
      "编辑器左上角原本被换成了微软 Office 的图标，已去掉，恢复显示 ONLYOFFICE 自带的标识",
  },
  {
    日期: "2026-08-30",
    改了什么:
      "浏览器内那个假服务发给编辑器的授权消息降到最小：五个对应商业版能力的开关全部关闭",
  },
  {
    日期: "2026-08-30",
    改了什么:
      "导出 PDF 用的字体换成可自由分发的 Liberation Sans 与 Carlito，并修正了上游粗体与斜体文件装反的问题",
  },
  {
    日期: "2026-08-30",
    改了什么: "静态资源改为从社区版镜像抽取；新增本法律声明入口",
  },
  {
    日期: "2026-08-30",
    改了什么:
      "组件新增一格插件配置并下发给编辑器（上游从不下发，插件因此拿不到配置）",
  },
  {
    日期: "2026-08-30",
    改了什么:
      "修正带可编辑内容的 PDF：原本会被当成普通 PDF 打开、丢掉可编辑性且不报错。" +
      "现在由组件自己认一次，结果既用于转换、也告诉编辑器该用哪个编辑界面",
  },
  {
    日期: "2026-08-30",
    改了什么:
      "组件新增一格 variant，可以用查看器（embed）打开文档：上游把挑应用入口的那一格" +
      "写死成 desktop，于是永远只加载完整编辑器",
  },
];

export type LegalNoticeOptions = {
  /** 许可原文放在哪个地址下。默认 `/legal`。 */
  legalRoot?: string;
  /** 我们自己这个修改版叫什么。 */
  productName?: string;
};

const BADGE_ATTR = "data-onlyoffice-legal-notice";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildPanel(legalRoot: string, productName: string) {
  const mask = el("div", {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,.45)",
    zIndex: "2147483646",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const panel = el("div", {
    background: "#fff",
    color: "#1f2328",
    maxWidth: "560px",
    maxHeight: "80vh",
    overflow: "auto",
    padding: "22px 26px",
    borderRadius: "10px",
    boxShadow: "0 12px 40px rgba(16,22,26,.28)",
    font: '14px/1.7 system-ui, "Microsoft YaHei", sans-serif',
  });

  const h = el("div", { fontSize: "16px", fontWeight: "600", marginBottom: "12px" }, "关于与许可");
  panel.appendChild(h);

  // (i) 认出原始开发者
  const p1 = el("p", { margin: "0 0 10px" });
  p1.innerHTML =
    "本编辑器基于 <b>ONLYOFFICE</b>，原始开发者是 <b>Ascensio System SIA</b>。" +
    "ONLYOFFICE 是 Ascensio System SIA 的商标，本项目未获得任何商标授权。";
  panel.appendChild(p1);

  // (ii) 这是修改过的版本
  const p2 = el("p", { margin: "0 0 6px" });
  p2.innerHTML =
    "<b>这是一个修改过的版本</b>（" +
    productName +
    "），不是 Ascensio System SIA 发布的原版。已做的修改：";
  panel.appendChild(p2);

  const ul = el("ul", { margin: "0 0 12px", paddingLeft: "22px" });
  for (const m of MODIFICATIONS) {
    ul.appendChild(el("li", { margin: "2px 0" }, m.日期 + "　" + m.改了什么));
  }
  panel.appendChild(ul);

  // (iii) 拿到许可信息
  const p3 = el("p", { margin: "0 0 10px" });
  p3.innerHTML =
    "本程序按 <b>GNU Affero 通用公共许可证第 3 版</b>发布，并遵守 Ascensio System SIA " +
    "补充的五条附加条款。非代码内容（图标、插图、文档）按 " +
    "<b>知识共享 署名-相同方式共享 4.0 国际</b> 许可。";
  panel.appendChild(p3);

  const links = el("p", { margin: "0 0 14px" });
  const link = (href: string, label: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    a.style.marginRight = "14px";
    return a;
  };
  // 【本项目新增 2026-08-30】「获取源代码」这一条。
  // ⚠ **它不是可选的**：许可证第 13 条要求，凡通过网络与本程序交互的用户，
  // 都必须能免费取得本版本的完整对应源码。在这条加上之前，这个面板里
  // 只有「按什么条款」（许可证原文）而没有「东西本身」，那一半不成立。
  // 放在第一个，因为它是这四条里唯一一条**给东西**的。
  links.appendChild(link(legalRoot + "/source", "获取源代码"));
  links.appendChild(link(legalRoot + "/LICENSE.txt", "许可证原文"));
  links.appendChild(link(legalRoot + "/3rd-Party.txt", "第三方组件声明"));
  links.appendChild(link(legalRoot + "/NOTICE.md", "修改说明"));
  panel.appendChild(links);

  const close = el(
    "button",
    {
      padding: "6px 18px",
      cursor: "pointer",
      font: "inherit",
      color: "#fff",
      background: "#2f6feb",
      border: "1px solid transparent",
      borderRadius: "6px",
    },
    "关闭",
  );
  close.addEventListener("click", () => mask.remove());
  panel.appendChild(close);

  mask.appendChild(panel);
  mask.addEventListener("click", (e) => {
    if (e.target === mask) mask.remove();
  });
  return mask;
}

/**
 * 在容器里挂上法律声明入口。同一个容器重复调用只会挂一次。
 *
 * @returns 一个函数，调用它就把入口摘掉（组件卸载时用）
 */
export function mountLegalNotice(
  container: HTMLElement,
  options: LegalNoticeOptions = {},
): () => void {
  const legalRoot = (options.legalRoot ?? "/legal").replace(/\/+$/, "");
  const productName = options.productName ?? "onlyoffice-web";

  const existing = container.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
  if (existing) return () => existing.remove();

  // 样子可以调，**但不许调到不显眼**——附加条款第三条要的是「清晰可达、显著可见」。
  // 所以这里只动了圆角、描边与投影，位置、字号与那行字都没动。
  const badge = el(
    "button",
    {
      position: "absolute",
      right: "10px",
      bottom: "10px",
      zIndex: "2147483645",
      padding: "4px 11px",
      border: "1px solid rgba(16,22,26,.14)",
      borderRadius: "6px",
      background: "rgba(255,255,255,.96)",
      boxShadow: "0 1px 4px rgba(16,22,26,.16)",
      color: "#1f2328",
      font: '12px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      cursor: "pointer",
    },
    "ONLYOFFICE · 修改版 · 许可",
  );
  badge.setAttribute(BADGE_ATTR, "1");
  badge.title = "查看原始开发者、修改说明与许可信息";
  badge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.appendChild(buildPanel(legalRoot, productName));
  });

  // 容器没定位过的话，绝对定位会跑到页面别处去——那就不「显著可见」了。
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  container.appendChild(badge);
  return () => badge.remove();
}
