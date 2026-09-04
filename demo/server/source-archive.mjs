/**
 * 把本项目的源码现打成一个 `.tar.gz`，供界面上那条「获取源码」下载。
 *
 * ── 为什么要有这个东西 ──────────────────────────────────────────────────────
 *
 * AGPL-3.0 **第 13 条**（许可原文 540 行）：改过的版本，只要用户通过计算机网络
 * 与它交互，就必须**显著地**给这些用户一个途径，**从网络服务器上免费**取得
 * 该版本的完整对应源码。我们确实改过（改了什么见 NOTICE.md），
 * 所以只要这个服务被人访问，这条就适用——**内网部署给本单位的人用也算**。
 *
 * 在这之前，界面上那个法律声明入口里只有「许可证原文 / 第三方组件声明 / 修改说明」
 * 三条，**一条都不是「拿到源码」**。这个文件补的就是那一条。
 *
 * ── 为什么自己写 tar，不调系统的 ────────────────────────────────────────────
 *
 * 一是不想为这件事引一个第三方依赖；二是这台开发机上**从 Node 里调 `tar` 会挑到
 * Windows 自带的那个**，报「gzip: stdin: unexpected end of file」，看着像归档包坏了。
 * tar 的格式很简单（512 字节一个头），自己写反而是最稳的那条路。
 * 压缩那一半用 Node 自带的 zlib。
 *
 * ── 打进去什么 ──────────────────────────────────────────────────────────────
 *
 * 我们自己写的全部：组件、页面、后端、插件、脚本、构建配方、许可与说明。
 * **不打进去**的是三样，各有各的理由，见 `不要的`。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * 不打进归档的东西。
 *
 * ⚠ **每一条都要说得出理由**——一份「对应源码」少了东西而没人说得清为什么少，
 * 就不再是对应源码了。
 */
const 不要的 = [
  { 名: "node_modules", 为什么: "第三方依赖，由 package-lock.json 精确锁定，装一次就有" },
  { 名: ".git", 为什么: "版本库本身，不是源码" },
  { 名: "vendor", 为什么: "ONLYOFFICE 与 x2t 的产物，不是我们的源码。它们各自的出处与版本写在归档里的 README/NOTICE 与 vendor 各自的 SOURCE.json 里" },
  { 名: "dist", 为什么: "构建产物，由源码现生成" },
  { 名: "out", 为什么: "自动实测跑出来的截图与报告" },
  // ⚠ **这一条是被咬过一次才加上的。** 装配脚本把发布包写进项目根的 release/，
  // 而它自己又拿这张表去拷源码——漏了这一条就会递归进自己的输出目录，
  // 一层套一层拷到磁盘满。同一张表也管着 /legal/source.tar.gz，
  // 漏了的话那个「源码包」里会塞进一整份 1.5 GB 的发布包。
  { 名: "release", 为什么: "装配出来的发布包，本身就是由源码与 vendor 拼出来的" },
  { 名: "storage", 为什么: "运行期落盘的文档，是数据不是源码" },
  { 名: "formats", 为什么: "现生成的测试文档，其中三份取自 ONLYOFFICE core，不该躺在我们的分发包里" },
  { 名: "tsconfig.tsbuildinfo", 为什么: "增量编译缓存" },
];
const 不要的名字 = new Set(不要的.map((x) => x.名));

// ── 最小 tar 写入器（ustar） ────────────────────────────────────────────────

/** 八进制定长字段，末尾补一个 NUL。 */
function 八进制(n, 宽) {
  return Buffer.from(n.toString(8).padStart(宽 - 1, "0") + "\0", "ascii");
}

/**
 * 一个 512 字节的文件头。
 *
 * ⚠ 校验和的算法有个坑：**算的时候要把校验和那 8 个字节当成空格**，
 * 算完再写回去。写反了的话 tar 解得开一部分然后报「checksum error」。
 */
function 文件头(名字, 字节数, mtime, 是目录) {
  const h = Buffer.alloc(512);
  const 名 = Buffer.from(名字, "utf8");
  if (名.length > 100) throw new Error("路径超过 100 字节，这个最小实现没做长名支持：" + 名字);
  名.copy(h, 0);
  八进制(是目录 ? 0o755 : 0o644, 8).copy(h, 100);   // mode
  八进制(0, 8).copy(h, 108);                        // uid
  八进制(0, 8).copy(h, 116);                        // gid
  八进制(字节数, 12).copy(h, 124);                   // size
  八进制(Math.floor(mtime / 1000), 12).copy(h, 136); // mtime
  h.write(是目录 ? "5" : "0", 156, 1, "ascii");      // typeflag
  h.write("ustar\0" + "00", 257, 8, "ascii");        // magic + version

  h.fill(0x20, 148, 156);                            // 先当成空格
  let 和 = 0;
  for (const b of h) 和 += b;
  h.write(和.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** 补齐到 512 的倍数。 */
function 补齐(n) {
  const 余 = n % 512;
  return 余 === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - 余);
}

// ── 走一遍源码树 ────────────────────────────────────────────────────────────

function 收集(根, 相对 = "", 出 = []) {
  for (const e of fs.readdirSync(path.join(根, 相对), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (不要的名字.has(e.name)) continue;
    const 这条 = 相对 ? 相对 + "/" + e.name : e.name;
    if (e.isDirectory()) 收集(根, 这条, 出);
    else if (e.isFile()) 出.push(这条);
  }
  return 出;
}

/**
 * 现打一个 tar.gz 出来。
 *
 * @param 根 项目根
 * @param 顶层名 归档解开之后最外面那个目录叫什么（省得解在当前目录里撒一地）
 * @returns {{buf: Buffer, 文件数: number}}
 */
export function 打包源码(根, 顶层名) {
  const 文件 = 收集(根);
  const 块 = [];
  for (const 相对 of 文件) {
    const 全 = path.join(根, 相对);
    const st = fs.statSync(全);
    const 名字 = 顶层名 + "/" + 相对;
    块.push(文件头(名字, st.size, st.mtimeMs, false));
    const 内容 = fs.readFileSync(全);
    块.push(内容, 补齐(内容.length));
  }
  块.push(Buffer.alloc(1024));   // 结尾两个空块
  return { buf: zlib.gzipSync(Buffer.concat(块), { level: 9 }), 文件数: 文件.length };
}

/** 给那个说明页用：不打进去的都有哪些、各自为什么。 */
export const 归档里没有的 = 不要的;

// ── 说明页 ──────────────────────────────────────────────────────────────────

const 转义 = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 那一页 HTML。
 *
 * **只放一个下载链接是不够的**：这个分发包里有三家的东西，我们只是其中一家。
 * 少了另外两家的出处，拿到包的人没法把手里这堆字节跟源码对上，
 * 而「对得上」正是「对应源码」这四个字的意思。
 */
export function 源码说明页HTML({ sdkVersion, 镜像, 源码地址, 归档名 }) {
  const 我们那份 = 源码地址
    ? `<a href="${转义(源码地址)}">${转义(源码地址)}</a>`
    : `<a href="/legal/source.tar.gz">下载 ${转义(归档名)}.tar.gz</a>（本服务现打，约 1 MB）`;

  const 行 = 归档里没有的
    .map((x) => `<tr><td><code>${转义(x.名)}</code></td><td>${转义(x.为什么)}</td></tr>`)
    .join("");

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>源代码</title>
<style>
body{font:15px/1.75 system-ui,"Microsoft YaHei",sans-serif;max-width:52em;margin:3em auto;padding:0 1.2em;color:#1f2328}
h1{font-size:1.4em;margin-bottom:.2em} h2{font-size:1.05em;margin-top:2em}
table{border-collapse:collapse;width:100%;font-size:.92em;margin-top:.5em}
td{border-top:1px solid #e3e6ea;padding:.45em .6em;vertical-align:top}
code{background:#f2f4f7;border:1px solid #e3e6ea;border-radius:4px;padding:1px 5px;font-size:.9em}
a{color:#2f6feb} .foot{margin-top:2.5em;padding-top:1em;border-top:1px solid #e3e6ea;font-size:.92em}
</style>
<h1>源代码</h1>
<p>本程序按 <b>GNU Affero 通用公共许可证第 3 版</b>发布。许可证<b>第 13 条</b>要求：
凡通过网络与本程序交互的用户，都必须能<b>免费取得本版本的完整对应源码</b>。这一页就是那个途径。</p>

<h2>一、我们自己的那一份（含对上游的全部修改）</h2>
<p>${我们那份}</p>
<p>改了什么、什么时候改的，见 <a href="/legal/NOTICE.md">修改说明</a>。</p>

<h2>二、ONLYOFFICE 本体</h2>
<p>编辑器的界面与内核（<code>/packages/onlyoffice/${转义(sdkVersion)}/</code> 下那一整棵）<b>不是我们写的</b>，
取自<b>社区版</b>镜像 <code>${转义(镜像)}</code>，版本 <code>${转义(sdkVersion)}</code>。
它由 Ascensio System SIA 按同一个许可发布，源码在
<a href="https://github.com/ONLYOFFICE">github.com/ONLYOFFICE</a>。</p>

<h2>三、浏览器里那个格式转换引擎</h2>
<p><code>x2t</code>（WebAssembly）取自 CryptPad 的公开配方
<a href="https://github.com/cryptpad/onlyoffice-x2t-wasm">onlyoffice-x2t-wasm</a>，同样按 AGPL 发布。
我们自己从源码构建它的做法，写在归档里的 <code>build/x2t/README.md</code>。</p>

<h2>归档里没有什么，以及为什么</h2>
<table>${行}</table>

<p class="foot"><a href="/legal/LICENSE.txt">许可证原文</a> ·
<a href="/legal/3rd-Party.txt">第三方组件声明</a> ·
<a href="/legal/NOTICE.md">修改说明</a></p>
</html>`;
}
