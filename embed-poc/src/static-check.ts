/**
 * 第 1 问：**把这套东西交给一个只会发文件的服务器，它还正常吗？**
 *
 * 这一条决定「生产上走纯 nginx、不部署任何进程」这个方向站不站得住。
 * 所以它刻意做成**零夹具、零 mock**：只有组件本体 + 静态资源 + 那个笨服务器。
 * 文档用 `OnlyOfficeManager.create()` 开一份空白的，连一个 .docx 都不需要。
 *
 * ── 这一页**只开编辑器，一个字节都不额外去取** ──────────────────────────
 *
 * 这条很要紧，是第一版写错之后改过来的：原来这一页自己也去 fetch 那些插件地址，
 * 想顺便验一下「取不取得到」。结果是**网络面板里分不清哪条请求是编辑器发的、
 * 哪条是这一页自己发的**——两边打的是同样的地址。
 *
 * 而这一问要的恰恰是**编辑器自己的行为**：它按哪个 base 去解析登记表里那些相对地址。
 * 所以这一页现在什么都不取，浏览器里出现的任何插件请求都只可能是编辑器发的。
 * 「那些地址取不取得到」是另一问，用 node 一句 fetch 就能答，
 * 放在 `probe/static-check.mjs` 里，与这一页互不干扰。
 *
 * **一个探针只答一个问题**——混在一起的那一版，两个答案会互相污染。
 */

import {
  OnlyOfficeManager,
  ONLYOFFICE_ID,
  FILE_TYPE,
  getStaticResource,
} from "../../src";

const 结论框 = document.getElementById("结论")!;
const 行: string[] = [];

function 说(s: string) {
  行.push(s);
  结论框.textContent = 行.join("\n");
}

async function 跑() {
  // 取组件自己算出来的那个根，**不在这里另写一份版本号**。
  const 根 = getStaticResource().onlyoffice.root;
  说("静态根（组件自己算的）：" + 根);

  说("正在开一份空白文档…（第一次要下不少东西，慢）");
  let 打开耗时 = -1;
  let 打开出错 = "";
  const t0 = performance.now();
  try {
    await OnlyOfficeManager.create({
      containerId: ONLYOFFICE_ID,
      fileType: FILE_TYPE.DOCX,
      defaultFileName: "静态检查.docx",
      lang: "zh",
    });
    打开耗时 = Math.round(performance.now() - t0);
    说("文档打开了，" + 打开耗时 + "ms");
  } catch (e) {
    打开出错 = String(e);
    说("文档没打开：" + 打开出错);
  }

  /**
   * 看一眼编辑器里的样子。
   *
   * ⚠ **按 `#iframe-office-id` 是找不到编辑器的**——组件把那个 div 换掉了，
   * 编辑器 iframe 是 `.onlyoffice-container` 的**直接子节点**。
   * 按 id 找永远找不到，而那是个不报错的空等。
   */
  function 看一眼() {
    const 容器 = document.querySelector(".onlyoffice-container");
    // ⚠ **要排掉预载那个 iframe**：组件会另开一个 iframe 预热资源，
    // 不排的话可能拿到它——而它里面什么都没有，于是「编辑器在，但里面是空的」。
    const 编辑器 = 容器?.querySelector(
      ":scope > iframe:not([data-onlyoffice-preload])",
    ) as HTMLIFrameElement | null;
    if (!编辑器) return { 有编辑器: false, 跑起来的插件: -1, 标签页: -1 };
    const d = 编辑器.contentDocument;
    if (!d) return { 有编辑器: true, 跑起来的插件: -1, 标签页: -1 };
    return {
      有编辑器: true,
      /**
       * ⚠ 这个数**是「跑起来的」，不是「登记上的」**——每个真正被打开的插件才会有
       * 一个 `iframe_<guid>`。没配 autostart 时它本来就是 0，
       * **所以别拿它当「登记表工不工作」的判据**（第一版就是这么错的）。
       * 那一问的判据是编辑器发出去的那些请求，在 node 那边看。
       */
      跑起来的插件: d.querySelectorAll('iframe[id^="iframe_"]').length,
      /** 功能区那排标签。它 > 0 才说明加载的是完整编辑器而不是查看器。 */
      标签页: d.querySelectorAll(".ribtab").length,
    };
  }

  // 编辑器那些东西是异步起来的，等一会儿再看，并**报出等了多久**——
  // 一个只等 200ms 就下结论的判断，和真的没有长得一样。
  let 视图 = 看一眼();
  const 截止 = performance.now() + 20000;
  while (performance.now() < 截止 && 视图.标签页 <= 0) {
    await new Promise((r) => setTimeout(r, 500));
    视图 = 看一眼();
  }
  说(
    "编辑器：" + (视图.有编辑器 ? "在" : "不在") +
      "，功能区标签 " + 视图.标签页 +
      " 个，跑起来的插件 " + 视图.跑起来的插件 + " 个",
  );

  const 结果 = { 根, 打开耗时, 打开出错, ...视图 };
  (window as unknown as { __probe: unknown }).__probe = 结果;
  (window as unknown as { __probeDone: boolean }).__probeDone = true;
  console.log("[静态检查]", 结果);
}

跑().catch((e) => {
  说("跑挂了：" + String(e));
  (window as unknown as { __probeDone: boolean }).__probeDone = true;
});
