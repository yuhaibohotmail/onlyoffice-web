/**
 * 第 1 问的自动实测：**把这套东西交给一个只会发文件的服务器，它还正常吗？**
 *
 * 这一条决定「生产上走纯 nginx、不部署任何进程」这个方向站不站得住。
 *
 * ── 两个各自独立的判据，别混 ────────────────────────────────────────────
 *
 *   ① **那些地址取不取得到**（node 直接 fetch）。盘上那份 `plugins.json` 写的是
 *      **相对地址**，而仓库里那个 `demo/server/` 会在发它的时候换成绝对地址
 *      ——也就是说「相对地址行不行」一直有人替它兜底，**从来没被真问过**。
 *   ② **编辑器自己按哪个 base 去解析它们**（看浏览器发出去的请求）。
 *      ①绿②红 与 ①红②红 是两件完全不同的事。
 *
 * ⚠ **②的判据取「编辑器请求了哪些地址、回了什么」，不取「面板里跑起来几个插件」。**
 * 后者数的是 `iframe_<guid>`，那是**被打开的**插件——没配 autostart 时它本来就是 0，
 * 拿它当判据的话，「登记表好好的」会被报成红。第一版就是这么错的。
 *
 * ⚠ 也正因为②要的是编辑器自己的行为，**那一页刻意什么都不额外去取**
 * ——它自己也去 fetch 的话，网络面板里就分不清哪条是谁发的了。
 *
 * ── 反向探针（不能省）──────────────────────────────────────────────────
 *
 * 「这些地址取得到」这句话，只有在「一个编造的地址取不到」也成立时才有意义。
 * 笨服务器万一有个兜底分支把 404 写成了 200，①就恒真——而恒真的检查
 * 和正确的检查长得一模一样。
 *
 * 跑法（要先起笨静态服务器）：
 *   node embed-poc/server/static-server.mjs 3042 &
 *   node embed-poc/probe/static-check.mjs [基地址]
 *
 * 退出码：0 全过；1 有条目没过；**2 = 一条断言都没跑**
 * （「没过」与「根本没跑」是两回事，混成一个码的话，人看到红会去查被测的东西，
 *  而该查的是自己那条命令）。
 */

import { chromium } from "playwright";

const 基地址 = (process.argv[2] || "http://127.0.0.1:3042").replace(/\/+$/, "");
const 超时 = Number(process.env.OOW_PROBE_TIMEOUT || 180000);

const 条目 = [];
function 断言(名, 真, 详 = "") {
  条目.push({ 名, 过: !!真, 详 });
  console.log((真 ? "  ✔ " : "  ✘ ") + 名 + (详 ? "  —— " + 详 : ""));
}

// ══ ① 那些地址取不取得到（不开浏览器）═══════════════════════════════════

/**
 * 打一个地址，只关心状态码。
 *
 * ⚠ 静态根不在这里另写一份——**由页面报回来**（它调的是组件自己的
 * `getStaticResource()`，全仓那个版本号只有一处真相）。探针自己拼一份的话，
 * 组件哪天改了根路径，这里会安静地继续探一个没人用的地址然后报绿。
 */
async function 取(地址) {
  try {
    const r = await fetch(地址);
    return r.status;
  } catch (e) {
    return "连不上：" + String(e);
  }
}

// ══ ② 编辑器自己的行为（开真浏览器）═════════════════════════════════════

const 浏览器 = await chromium.launch();
// ⚠ **不要用 newContext()**：那是无痕上下文，只有内存缓存。这一条对本探针无害
// （我们不量下载量），但换成量下载量时它会让暖载与冷载分毫不差——而那正好长得像
// 「长缓存没配上」这个真缺陷。留一句，免得下一个人照抄去量。
const 页 = await 浏览器.newPage();

const 控制台错误 = [];
页.on("console", (m) => {
  if (m.type() === "error") 控制台错误.push(m.text().slice(0, 200));
});
/** 编辑器发出去的、与插件有关的请求。**这一页什么都不额外取，所以这些全是编辑器的。** */
const 插件请求 = new Map();
const 全部失败 = [];
页.on("response", (r) => {
  const u = decodeURIComponent(r.url().replace(基地址, ""));
  if (u.includes("plugin")) 插件请求.set(u, r.status());
  if (r.status() >= 400) 全部失败.push(r.status() + " " + u.slice(0, 140));
});

const 页地址 = 基地址 + "/static-check.html";
console.log("打开 " + 页地址);
await 页.goto(页地址, { waitUntil: "domcontentloaded", timeout: 60000 });

let 结果 = null;
try {
  await 页.waitForFunction(() => window.__probeDone === true, null, { timeout: 超时 });
  结果 = await 页.evaluate(() => window.__probe);
} catch {
  console.error("页面没跑完（" + 超时 + "ms）。页面上写的是：");
  console.error(await 页.textContent("#结论"));
  await 浏览器.close();
  process.exit(2);
}
// 插件是编辑器起来之后才去取的，多等一会儿再收网。
await 页.waitForTimeout(4000);
await 浏览器.close();

if (!结果) {
  console.error("页面没留下结果 —— 一条断言都没跑。");
  process.exit(2);
}

// 根由页面报回来（它调的是组件自己那个 getStaticResource，全仓只有那一处真相）
const 根 = 结果.根;
console.log("\n静态根：" + 根);

// ── ① ──
const 登记表地址 = 基地址 + 根 + "/plugins.json";
const 登记表状态 = await 取(登记表地址);
let 条目表 = [];
if (登记表状态 === 200) {
  条目表 = (await (await fetch(登记表地址)).json()).pluginsData || [];
}
const 相对条数 = 条目表.filter((u) => !/^https?:/i.test(u) && !u.startsWith("/")).length;
/**
 * 这一趟跑的是哪一档，**由登记表自己的内容决定，不由命令行开关决定**。
 * 开关会撒谎（有人忘了带），而内容不会。
 */
const 档 = 相对条数 > 0 ? "盘上原样那份（相对地址）" : "装机预生成那份（绝对路径）";

/** 登记表里那一条，按它自己的写法算成绝对路径。 */
function 条目路径(c) {
  if (/^https?:/i.test(c)) return new URL(c).pathname;
  return c.startsWith("/") ? c : 根 + "/" + c;
}

let 通 = 0;
const 不通 = [];
for (const c of 条目表) {
  const s = await 取(基地址 + 条目路径(c));
  if (s === 200) 通++;
  else 不通.push([c, s]);
}
const 反向 = await 取(基地址 + 根 + "/sdkjs-plugins/{00000000-0000-0000-0000-000000000000}/config.json");

console.log("\n① 那些地址取不取得到（node 直接问，与浏览器无关）");
console.log("   这一趟的登记表是：" + 档);
断言("反向探针有效（编造的地址取不到）", 反向 !== 200, "编造的地址回了 " + 反向);
断言("登记表发得出去", 登记表状态 === 200, "HTTP " + 登记表状态);
断言("登记表里有条目", 条目表.length > 0, 条目表.length + " 条，其中相对地址 " + 相对条数 + " 条");
断言(
  "登记表里每一条，文件都在盘上",
  条目表.length > 0 && 通 === 条目表.length,
  通 + "/" + 条目表.length + (不通.length ? "，不在的：" + JSON.stringify(不通.slice(0, 3)) : ""),
);

// ── ② ──
const 编辑器取的登记表 = [...插件请求.entries()].filter(([u]) => u.endsWith("plugins.json"));
/**
 * **按集合算，不按次数算。** 编辑器对同一条配置可能取不止一次
 * （列表一次、真加载时又一次），按次数比会得出 12/11 这种没法解释的数，
 * 而它既不说明多也不说明少。要问的是「登记表里每一条，编辑器都取到了吗」。
 */
const 编辑器取到的路径 = new Set(
  [...插件请求.entries()].filter(([, s]) => s === 200).map(([u]) => u),
);
const 编辑器没取到的 = 条目表.filter((c) => !编辑器取到的路径.has(条目路径(c)));

console.log("\n② 编辑器自己的行为（浏览器里那些请求全是它发的）");
断言("文档打开了", 结果.打开耗时 >= 0, 结果.打开出错 || 结果.打开耗时 + "ms");
断言("编辑器在", 结果.有编辑器 === true);
断言("加载的是完整编辑器（功能区有标签页）", 结果.标签页 > 0, 结果.标签页 + " 个标签");
断言(
  "编辑器自己去取了登记表",
  编辑器取的登记表.some(([, s]) => s === 200),
  JSON.stringify(编辑器取的登记表),
);
断言(
  "**编辑器把登记表里每一条都取到了**",
  条目表.length > 0 && 编辑器没取到的.length === 0,
  条目表.length - 编辑器没取到的.length + "/" + 条目表.length +
    (编辑器没取到的.length
      ? "，没取到：" + JSON.stringify(编辑器没取到的.slice(0, 2)) +
        " —— 这条红了就是「纯静态发不出插件」，装机那一批要预生成登记表"
      : ""),
);

if (全部失败.length) {
  console.log("\n这一趟有 " + 全部失败.length + " 条请求 4xx/5xx（前 10 条）：");
  全部失败.slice(0, 10).forEach((s) => console.log("   " + s));
}
if (控制台错误.length) {
  console.log("\n控制台错误 " + 控制台错误.length + " 条（前 5 条）：");
  控制台错误.slice(0, 5).forEach((s) => console.log("   " + s));
}
console.log(
  "\n（顺带一提：编辑器里**跑起来**的插件 " + 结果.跑起来的插件 +
    " 个。没配 autostart 时它本来就是 0，**不是判据**。）",
);

const 没过 = 条目.filter((x) => !x.过);
console.log("\n" + (条目.length - 没过.length) + "/" + 条目.length + " 过");
// ⚠ 用 exitCode 而不是 process.exit()：playwright 关掉之后还有句柄在收尾，
// 硬退会让 libuv 抛一句 `UV_HANDLE_CLOSING` 断言失败，**盖在真正的结论后面**，
// 看着像这个脚本自己崩了。
process.exitCode = !条目.length ? 2 : 没过.length ? 1 : 0;
