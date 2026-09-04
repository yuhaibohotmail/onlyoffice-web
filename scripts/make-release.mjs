#!/usr/bin/env node
/**
 * 把「能拷到一台机器上就跑起来」的那一整套装配出来。
 *
 *   npm run build                       # 先构建前端
 *   node scripts/make-release.mjs       # 装配（默认带 vendor，约 1.5 GB，要几分钟）
 *   node scripts/make-release.mjs --no-vendor    # 目标机上已经有 vendor 时
 *   node scripts/make-release.mjs --out D:/somewhere
 *
 * ── 为什么必须有这一步 ──────────────────────────────────────────────────────
 *
 * `npm run build` 只出 `dist/`（约 1.5 MB 的前端）。**那个东西自己跑不起来**，
 * 还差两样：后端进程，以及 `vendor/` 那 1.5 GB —— 编辑器本体、转换引擎与字体
 * 全在里面，而它**不进 git**，取它的 `npm run assets` 要 ssh 到跑着社区版镜像的机器上。
 * 目标机上跑不了那条，所以 vendor 必须跟着包走。
 *
 * ── 装配出来的是什么形状 ────────────────────────────────────────────────────
 *
 * **整棵源码树 + dist/ + vendor/**，目录结构与仓库里一模一样。
 * ⚠ **源码那一份不能省，这是硬要求**：后端的 `/legal/source.tar.gz` 是拿
 * 运行时的项目根现打包的（AGPL 第 13 条那条义务），发布包里少了源码，
 * 那个端点就会发出一个残缺的「对应源码」——**而它照样回 200，没有任何东西报错**。
 *
 * 排除表**跟后端那个源码归档共用同一份**（`demo/server/source-archive.mjs`），
 * 不在这里另抄一遍：抄下来的那份会与它分叉，而分叉的样子是「两个源码包不一样」。
 *
 * 后端是**零第三方依赖**的（只用 `node:` 内置），所以发布包里不需要 `node_modules`。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT, SDK_ROOT, SDK_VERSION, X2T_DIR, X2T_FONTS_DIR } from "../config.mjs";
import { 归档里没有的 } from "../demo/server/source-archive.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const 带VENDOR = !process.argv.includes("--no-vendor");
const 版本 = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
const 包名 = "onlyoffice-web-" + 版本;
const 出到 = path.resolve(argOf("--out", path.join(PROJECT_ROOT, "release")), 包名);

const 人读 = (n) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + " GB"
    : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + " MB"
      : (n / 1024).toFixed(0) + " KB";

function 量大小(p) {
  let 和 = 0;
  const 走 = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) 走(q);
      else if (e.isFile()) 和 += fs.statSync(q).size;
    }
  };
  if (fs.existsSync(p)) fs.statSync(p).isDirectory() ? 走(p) : (和 = fs.statSync(p).size);
  return 和;
}

// ── 一、开跑前的检查 ────────────────────────────────────────────────────────

const 少了什么 = [];
const DIST = path.join(PROJECT_ROOT, "dist", "index.html");
if (!fs.existsSync(DIST)) 少了什么.push({ 是什么: "前端构建产物 dist/", 怎么办: "npm run build" });

// 部署要用的那几样，与后端启动时自查的是同一张表。缺哪一样，
// 症状都是「编辑器一直不出来」或「打开了但导不出」，而报错不指向缺的那一样。
for (const x of [
  { p: path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "web-apps/apps/api/documents/api.js"), 是什么: "编辑器静态资源", 怎么办: "npm run assets" },
  { p: path.join(X2T_DIR, "x2t.wasm"), 是什么: "格式转换引擎", 怎么办: "npm run x2t" },
  { p: path.join(X2T_FONTS_DIR, "Carlito-Regular.ttf"), 是什么: "导出 PDF 用的字体", 怎么办: "npm run fonts" },
]) {
  if (带VENDOR && !fs.existsSync(x.p)) 少了什么.push(x);
}
if (少了什么.length) {
  console.error("✗ 装不了，这几样还没有：");
  for (const x of 少了什么) console.error("  缺 " + x.是什么 + "  →  跑这条：" + x.怎么办);
  process.exit(1);
}

// ⚠ **构建产物比源码旧，是这一步最容易静静出错的地方**：装出来的包能跑，
// 只是跑的是上一版的前端，而没有任何东西会说一句。
{
  const 产物时间 = fs.statSync(DIST).mtimeMs;
  const 更新的 = [];
  const 走 = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const q = path.join(d, e.name);
      if (e.isDirectory()) 走(q);
      else if (e.isFile() && fs.statSync(q).mtimeMs > 产物时间) 更新的.push(path.relative(PROJECT_ROOT, q));
    }
  };
  for (const d of ["src", "demo"]) 走(path.join(PROJECT_ROOT, d));
  const 只看代码 = 更新的.filter((f) => /[.](ts|tsx|html|css)$/.test(f) && !f.includes("e2e"));
  if (只看代码.length) {
    console.error("✗ dist/ 比源码旧——装出来的包会跑上一版的前端，而且不会有任何东西说一句。");
    console.error("  比它新的有 " + 只看代码.length + " 个，前三个：");
    for (const f of 只看代码.slice(0, 3)) console.error("    " + f);
    console.error("  先跑：npm run build");
    process.exit(1);
  }
}

// ── 二、装配 ────────────────────────────────────────────────────────────────

fs.rmSync(出到, { recursive: true, force: true });
fs.mkdirSync(出到, { recursive: true });
console.log("装到 " + 出到 + "\n");

/** 源码那一份的排除表**取后端那份**，两处共用，不在这儿另抄一遍。 */
const 源码不要的 = new Set(归档里没有的.map((x) => x.名));

let 源码文件数 = 0;
function 拷源码(相对 = "") {
  const 从 = path.join(PROJECT_ROOT, 相对);
  for (const e of fs.readdirSync(从, { withFileTypes: true })) {
    if (源码不要的.has(e.name)) continue;
    const 这条 = 相对 ? path.join(相对, e.name) : e.name;
    const 目标 = path.join(出到, 这条);
    if (e.isDirectory()) {
      fs.mkdirSync(目标, { recursive: true });
      拷源码(这条);
    } else if (e.isFile()) {
      fs.copyFileSync(path.join(从, e.name), 目标);
      源码文件数 += 1;
    }
  }
}
拷源码();
console.log("  源码      " + String(源码文件数).padStart(5) + " 个文件  " + 人读(量大小(出到)));

fs.cpSync(path.join(PROJECT_ROOT, "dist"), path.join(出到, "dist"), { recursive: true });
console.log("  前端产物  dist/           " + 人读(量大小(path.join(出到, "dist"))));

if (带VENDOR) {
  // 一棵一棵拷，好让人看见进度——整棵 1.5 GB，闷着拷会让人以为卡住了。
  for (const 名 of fs.readdirSync(path.join(PROJECT_ROOT, "vendor"))) {
    const 从 = path.join(PROJECT_ROOT, "vendor", 名);
    process.stdout.write("  vendor/" + 名 + " …");
    fs.cpSync(从, path.join(出到, "vendor", 名), { recursive: true });
    console.log("\r  vendor/" + 名.padEnd(12) + "        " + 人读(量大小(path.join(出到, "vendor", 名))));
  }
} else {
  console.log("  vendor    跳过（--no-vendor）——目标机上必须已经有一份，否则起不来");
}

// ── 三、写一份部署说明进去 ──────────────────────────────────────────────────

const 说明 = `# 部署说明（${包名}）

这一份是**装配好的整套**：源码 + 前端产物 \`dist/\` + \`vendor/\`（编辑器本体、
转换引擎、字体）。后端零第三方依赖，**不需要 npm install**。

## 跑起来

\`\`\`sh
export OOW_TOKEN_SECRET=<一串至少 16 位的随机串>   # 不设的话每次重启换一把，旧票全失效
export OOW_SOURCE_URL=<源码仓库地址>               # 可选，见下面「许可」
node demo/server/index.mjs                        # 默认 3041
\`\`\`

前端那一半是 \`dist/\` 下的静态文件，要有一个 web 服务器把它伺服在 \`/\`，
并且把下面四条转到后端去：

\`\`\`
/api        →  http://127.0.0.1:3041
/packages   →  http://127.0.0.1:3041
/plugins    →  http://127.0.0.1:3041
/legal      →  http://127.0.0.1:3041
\`\`\`

⚠ **必须同源。** 编辑器在一个 iframe 里，插件又在编辑器里再开一个 iframe，
任何一层跨了源，父页面就什么都读不到——**而症状是「编辑器一直不出来」，
看着像编辑器坏了，不像被同源策略挡住**。

⚠ 反代要把 \`Host\` 原样传过去（或者设 \`X-Forwarded-Host\` / \`X-Forwarded-Proto\`）。
后端拿它拼插件登记表里的绝对地址；传错了的话**插件会静悄悄地不出现**，
而文档照样打开、照样导出，首页上一点看不出来。

## 许可（不是可选项）

本程序按 AGPL-3.0 发布。**许可证第 13 条要求**：凡通过网络与它交互的用户，
都必须能免费取得本版本的完整对应源码。这一套已经做好了：
界面右下角那个入口里有「获取源代码」，指向 \`/legal/source\`，
由后端拿这个目录现打一个包给人下。

**所以这个目录里的源码不能删**——删了那个端点会发出一个残缺的包，
而它照样回 200。如果你另有代码仓库，设 \`OOW_SOURCE_URL\` 指过去更好。

## 自证

\`\`\`sh
curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3041/legal/source
curl -s http://127.0.0.1:3041/legal/source.tar.gz | tar tz | head -3
\`\`\`
`;
fs.writeFileSync(path.join(出到, "部署说明.md"), 说明);

// ── 四、装完自证 ────────────────────────────────────────────────────────────

const 该有的 = [
  "demo/server/index.mjs",
  "demo/server/source-archive.mjs",
  "config.mjs",
  "dist/index.html",
  "NOTICE.md",
  "LICENSE",
  "部署说明.md",
  ...(带VENDOR ? ["vendor/onlyoffice/" + SDK_VERSION + "/web-apps/apps/api/documents/api.js", "vendor/x2t/x2t.wasm"] : []),
];
const 没装上的 = 该有的.filter((f) => !fs.existsSync(path.join(出到, f)));
if (没装上的.length) {
  console.error("\n✗ 装完之后这几样不在：" + 没装上的.join("、"));
  process.exit(1);
}

console.log("\n合计 " + 人读(量大小(出到)));
console.log("✓ 装好了：" + 出到);
console.log("  跑起来看 " + path.join(出到, "部署说明.md"));
