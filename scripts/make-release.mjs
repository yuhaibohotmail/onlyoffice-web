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
// 【2026-09-17】仓库的文档缺省用英文，这份随包走的说明也一样，文件名改成 DEPLOY.md。

const 说明文件 = "DEPLOY.md";
const 说明 = `# Deployment guide (${包名})

This is the **fully assembled package**: source code + the front-end bundle \`dist/\` + \`vendor/\` (the editors,
the conversion engine and fonts). The back end has no third-party dependencies, so **no npm install is needed**.

## Running it

\`\`\`sh
export OOW_TOKEN_SECRET=<a random string of at least 16 characters>   # if unset, a new one is generated at every restart and all old tickets become invalid
export OOW_SOURCE_URL=<URL of the source repository>                   # optional, see "License" below
node demo/server/index.mjs                                            # port 3041 by default
\`\`\`

The front-end half is the static files under \`dist/\`. A web server must serve them at \`/\`
and forward these four paths to the back end:

\`\`\`
/api        →  http://127.0.0.1:3041
/packages   →  http://127.0.0.1:3041
/plugins    →  http://127.0.0.1:3041
/legal      →  http://127.0.0.1:3041
\`\`\`

⚠ **Everything must be same-origin.** The editor runs in an iframe and plugins open another iframe inside the editor;
if any layer is cross-origin, the parent page cannot read anything. **The symptom is "the editor never shows up",
which looks like a broken editor rather than the same-origin policy.**

⚠ The reverse proxy must pass \`Host\` through unchanged (or set \`X-Forwarded-Host\` / \`X-Forwarded-Proto\`).
The back end uses it to build the absolute URLs in the plugin registry; if it is wrong, **plugins silently do not appear**,
while documents still open and export, and nothing on the first screen shows the problem.

## License (not optional)

This program is released under AGPL-3.0. **Section 13 of the license requires** that every user interacting with it
over a network can obtain the complete corresponding source of this version free of charge. This is already in place:
the entry at the bottom right of the UI has a "Get source code" link pointing to \`/legal/source\`,
where the back end builds an archive of this directory on the fly.

**So do not delete the source code in this directory.** Without it, that endpoint serves an incomplete archive,
and still returns 200. If you have your own code repository, setting \`OOW_SOURCE_URL\` to point at it is better.

## Self-check

\`\`\`sh
curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3041/legal/source
curl -s http://127.0.0.1:3041/legal/source.tar.gz | tar tz | head -3
\`\`\`
`;
fs.writeFileSync(path.join(出到, 说明文件), 说明);

// ── 四、装完自证 ────────────────────────────────────────────────────────────

const 该有的 = [
  "demo/server/index.mjs",
  "demo/server/source-archive.mjs",
  "config.mjs",
  "dist/index.html",
  "NOTICE.md",
  "LICENSE",
  说明文件,
  ...(带VENDOR ? ["vendor/onlyoffice/" + SDK_VERSION + "/web-apps/apps/api/documents/api.js", "vendor/x2t/x2t.wasm"] : []),
];
const 没装上的 = 该有的.filter((f) => !fs.existsSync(path.join(出到, f)));
if (没装上的.length) {
  console.error("\n✗ 装完之后这几样不在：" + 没装上的.join("、"));
  process.exit(1);
}

console.log("\n合计 " + 人读(量大小(出到)));
console.log("✓ 装好了：" + 出到);
console.log("  跑起来看 " + path.join(出到, 说明文件));
