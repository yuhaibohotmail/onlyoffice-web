/**
 * 第 5 问：**两道来源校验真的在拦吗；已经删掉的第一版协议真的不认了吗。**
 *
 * 契约里说了两条：
 *   · 宿主发消息时 `targetOrigin` 写死接入页那个源，**永不写 `"*"`**；
 *   · 接入页收消息时校验 `event.origin`。
 *
 * 第一条由浏览器执行（targetOrigin 对不上，消息根本不投递），不用测我们自己。
 * **第二条是我们自己写的代码，必须测**——漏了它，任何开着这一页的页面都能塞一张
 * 自己的令牌进来，或者伪造一条「已保存」。
 *
 * ── 怎么测 ──────────────────────────────────────────────────────────────
 *
 * 直接开接入页，但把 `hostOrigin` 声明成**另一个源**，然后从这一页自己
 * （也就是接入页所在的那个源）发一条 open 过去。它必须**被忽略**。
 *
 * ⚠ **必须配一个对照组**：把 `hostOrigin` 改成这一页自己的源，同样发一条，
 * 它必须**被收下**。没有这一组的话，「被忽略」可能只是因为消息压根没发出去、
 * 或者格式写错了——那样这条断言恒真，而恒真的断言和正确的断言长得一模一样。
 *
 * ── 【0.3.0】第一版协议删掉之后 ──────────────────────────────────────────
 *
 * 第一版（`onlyoffice-web-embed/1`，宿主递取件、存件地址与请求头）在 0.3.0 删了。
 * 这里再验两件事，都借上面那个对照组的设置（信本页那个源），所以「没反应」不会是来源校验拦的：
 *   · 从本页发一条**第一版**的 open，接入页必须不动；
 *   · 接入页一加载发出的 `ready` 里**没有第一版那条**，而第二版那条在（对照：不是什么都没发）。
 * 接入页直接开、不在 iframe 里时，`window.parent` 就是它自己，所以它发给「宿主」的消息
 * 会回到本页，在页面脚本跑之前挂一个监听就收得到。
 *
 * 跑法（静态服务器起着就行，不需要 mock）：
 *   node embed-poc/probe/origin-guard.mjs [静态地址]
 */

import { chromium } from "playwright";

const 静态 = (process.argv[2] || "http://127.0.0.1:3042").replace(/\/+$/, "");
const 别处 = "http://127.0.0.1:9999"; // 一个没人在听的源，仅用来声明「我只信它」

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

const 浏览器 = await chromium.launch();

/** 第二版的 open。接入后端指到静态那边一个不存在的地址：只看接入页动没动，不要它打开成功。 */
const 第二版open = (静态) => ({
  protocol: "onlyoffice-web-embed/2",
  type: "open",
  token: "试探",
  backendUrl: 静态 + "/不存在的接入后端",
});
/** 第一版（0.3.0 已删）的 open，字段照当时的契约写全。 */
const 第一版open = (静态) => ({
  protocol: "onlyoffice-web-embed/1",
  type: "open",
  fileName: "试探.docx",
  fileType: "DOCX",
  downloadUrl: 静态 + "/不存在的取件地址",
  saveUrl: 静态 + "/不存在的取件地址",
  baseVersion: 1,
});

/**
 * 开一次接入页，声明只信 `声明的源`，然后从页面自己发一条 `消息`。
 * 回「接入页有没有动」，以及它一加载自己发出来的那几条消息。
 *
 * 判据取**状态行文字变没变**：接入页收下 open 之后第一件事就是去验配置，
 * 状态会从「已就绪，等 open。」变成「正在验配置…」或后面的样子。
 */
async function 试一次(声明的源, 消息) {
  const 页 = await 浏览器.newPage();
  await 页.addInitScript(() => {
    window.__发出的 = [];
    window.addEventListener("message", (e) => window.__发出的.push(e.data));
  });
  await 页.goto(
    静态 + "/embed.html?hostOrigin=" + encodeURIComponent(声明的源),
    { waitUntil: "domcontentloaded", timeout: 60000 },
  );
  await 页.waitForFunction(
    () => document.getElementById("状态")?.textContent?.includes("已就绪"),
    null,
    { timeout: 30000 },
  );
  const 起点 = await 页.textContent("#状态");

  // 从这一页自己发。它的源就是静态那个源。
  await 页.evaluate((m) => window.postMessage(m, window.location.origin), 消息);

  // 给它一点时间去动。**等的时间要说出来**——只等 100ms 就说「没动」，
  // 和它真的没动长得一样。
  await 页.waitForTimeout(2500);
  const 之后 = await 页.textContent("#状态");
  const 发出的 = await 页.evaluate(() => window.__发出的);
  await 页.close();
  return { 起点, 之后, 动了: 起点 !== 之后, 发出的 };
}

console.log("① 声明只信别处（" + 别处 + "），然后从本页发一条 —— 应该被忽略");
const 甲 = await 试一次(别处, 第二版open(静态));
断言("来源对不上的消息被忽略了", !甲.动了, "状态：「" + 甲.之后 + "」");

console.log("\n② 对照组：声明信本页那个源，同样发一条 —— 应该被收下");
// ⚠ **要的是「源」，不是这套东西的基地址。** 挂在前缀下时 `静态` 是
// `http://127.0.0.1:3042/oow`，而接入页比的是 `event.origin`（永远不带路径）。
// 把带路径的那个交进去，对照组会永远不成立，
// 于是①那条「被忽略了」变成恒真——**一道守卫看着还在，其实什么都没在守**。
const 本源 = new URL(静态).origin;
const 乙 = await 试一次(本源, 第二版open(静态));
断言(
  "来源对得上的消息真的被收下了（证明上一条不是恒真）",
  乙.动了,
  乙.动了
    ? "状态变成了「" + 乙.之后 + "」"
    : "它也没动 —— 说明这条消息压根没发到，①那条「被忽略」什么都没证明",
);

console.log("\n③ 第一版（0.3.0 已删）：同样信本页那个源，发一条第一版的 open —— 应该被忽略");
const 丙 = await 试一次(本源, 第一版open(静态));
断言(
  "第一版的 open 不理（②那条同样设置下第二版的被收下了，所以这里不是来源校验拦的）",
  !丙.动了,
  "状态：「" + 丙.之后 + "」",
);
const 自己发的 = 乙.发出的.filter((m) => m && typeof m === "object" && m.type === "ready");
断言(
  "接入页只宣告第二版：ready 里没有第一版那条",
  !自己发的.some((m) => m.protocol === "onlyoffice-web-embed/1"),
  JSON.stringify(自己发的),
);
断言(
  "（对照）第二版那条 ready 发出来了，而且 protocols 里没有第一版",
  自己发的.some(
    (m) =>
      m.protocol === "onlyoffice-web-embed/2" &&
      Array.isArray(m.protocols) &&
      !m.protocols.includes("onlyoffice-web-embed/1"),
  ),
  JSON.stringify(自己发的),
);

await 浏览器.close();

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
