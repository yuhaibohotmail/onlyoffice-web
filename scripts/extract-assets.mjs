#!/usr/bin/env node
/**
 * 从**社区版** OnlyOffice 镜像抽出浏览器要用的静态资源。
 *
 *   node scripts/extract-assets.mjs            # 抽一份到 vendor/onlyoffice/<版本>/
 *   node scripts/extract-assets.mjs --force    # 已经有了也重抽
 *   node scripts/extract-assets.mjs --keep-gz  # 连 nginx 那份预压缩副本一起留着
 *
 * ── 为什么是这个形状 ────────────────────────────────────────────────────────
 *
 * **只从社区版取。** 上游那个组件包的静态资源是从 `documentserver-de`
 * （Developer Edition，商业授权）里拷的，而我们按 AGPL 发布，只能用社区版。
 * 两边的许可声明头逐字一致，代码是同一份，差别在分发条款不在代码，所以换源不丢功能。
 * 镜像名里出现 `-de` / `-ee` 时这个脚本会直接停。
 *
 * **产物要可复现，判据是镜像 ID 不是镜像名。** `9.4.0.1` 这种标签是会被重推的，
 * 而 ID 不会。抽之前先核 ID 与 config.mjs 里记的那个一致，对不上就停，
 * 抽完把 ID 写进产物旁边的 SOURCE.json——那份文件才是「这堆东西是从哪来的」的答案。
 *
 * **本机没有 docker，所以走 ssh 到跑着镜像的那台机器上抽。**
 * 而且是从**活着的容器**里只读地 tar 出来，不在目标机上写一个字节
 * （那台只剩几个 G，容器写层放不下 700 MB 字体）。
 * 从活容器取还顺带解决一件事：`AllFonts.js` 与 fonts/ 下那几百个字体产物
 * 是容器启动时生成的，镜像层里没有；从镜像新建容器再生成一遍要占盘也要时间。
 * 本机装好 docker 之后把 config 里的 host 设成空字符串，这里自动改走本地 docker。
 *
 * **tar 必须经 bash 调。** 这台机器上从 Node 直接调 `tar` 会挑到 Windows 自带的那个，
 * 报「gzip: stdin: unexpected end of file」，看着像归档包坏了。
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENT_SERVER as DS, VENDOR_DIR } from "../config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 要抽的东西。
 *
 * 四个目录是编辑器本体要用的；`LICENSE.txt` 与 `3rd-Party.txt` 是合规要一起发的许可原件。
 *
 * 最后那四份是**「新建文档」的模板**（合计不到 60 KB），两个用处：
 *
 * - `new.pdf` 是我们唯一一份真的**可编辑 PDF**（头部带 `/ONLYOFFICEFORM` 标记、
 *   流里嵌着一个 OOXML 包）。**「打开可编辑 PDF 该进 documenteditor」这条断言，
 *   用手写的最小 PDF 是证明不了的**——那种 PDF 的正确答案本来就是「不是可编辑 PDF」。
 * - `new.pptx` 等是「各种格式」那一摊的源文件之一
 *   （`scripts/make-format-fixtures.mjs` 拿它转出 ppt 与 odp）。
 */
const DIRS = ["fonts", "sdkjs", "web-apps", "sdkjs-plugins"];
const FILES = [
  "LICENSE.txt",
  "3rd-Party.txt",
  "document-templates/new/default/new.pdf",
  "document-templates/new/default/new.docx",
  "document-templates/new/default/new.xlsx",
  "document-templates/new/default/new.pptx",
];

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const KEEP_GZ = argv.includes("--keep-gz");
/** 树已经在了，只重跑后处理——改了后处理之后不必再传一趟 2 GB。 */
const NO_EXTRACT = argv.includes("--no-extract");

const log = (...a) => console.log("→", ...a);
const die = (m) => {
  console.error("✗ " + m);
  process.exit(1);
};

/** `E:\a\b` → `/e/a/b`；Git Bash 只认后一种。 */
function toBashPath(p) {
  const win = path.resolve(p);
  const drive = win[0].toLowerCase();
  const rest = win.slice(2).split(path.sep).join("/");
  return "/" + drive + rest;
}

/** 在 bash 里跑一条命令行，输出直通终端。 */
function bash(script, { check = true } = {}) {
  const r = spawnSync("bash", ["-c", script], { stdio: ["ignore", "inherit", "inherit"] });
  if (check && r.status !== 0) die(`命令失败（退出码 ${r.status}）：\n${script}`);
  return r.status;
}

/** 在 bash 里跑一条命令并把 stdout 收回来。 */
function bashOut(script) {
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  if (r.status !== 0) die(`命令失败（退出码 ${r.status}）：\n${script}\n${r.stderr ?? ""}`);
  return r.stdout.trim();
}

/**
 * 把一条要在 docker 主机上跑的命令包起来。
 * host 为空 = 本机就有 docker，直接跑；否则套一层 ssh。
 */
function onDockerHost(cmd) {
  if (!DS.host) return cmd;
  const ssh = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${DS.sshUser}@${DS.host}`;
  return `${ssh} ${JSON.stringify(cmd)}`;
}

function refuseNonCommunityImage() {
  if (/-de(:|$)|-ee(:|$)|documentserver-de|documentserver-ee/.test(DS.image)) {
    die(
      `config.mjs 里的镜像是 ${DS.image}——那是商业授权版。\n` +
        `  本项目按 AGPL 发布，静态资源只能从社区版镜像来。见 README「两条不要越过的线」。`,
    );
  }
}

function verifyImageId() {
  log(`核镜像 ID：${DS.image}`);
  const actual = bashOut(onDockerHost(`docker image inspect ${DS.image} --format {{.Id}}`));
  if (actual !== DS.imageId) {
    die(
      `镜像 ID 对不上，抽出来的东西就不可复现了。\n` +
        `  config.mjs 记的：${DS.imageId}\n` +
        `  机器上实际的：  ${actual}\n` +
        `  确认那台上的镜像是对的之后，把 config.mjs 里的 imageId 改成实际这个值。`,
    );
  }
  log(`  一致：${actual}`);
  return actual;
}

/** 容器里 x2t 自报的版本；同时用来当产物目录名。 */
function readCoreVersion() {
  const out = bashOut(
    onDockerHost(`docker exec ${DS.container} ${DS.root}/server/FileConverter/bin/x2t 2>&1 | head -5`) +
      " || true",
  );
  const m = out.match(/Version:\s*([0-9.]+)/);
  if (!m) die(`没从容器里读出 x2t 版本。原始输出：\n${out}`);
  return m[1];
}

function extract(destDir) {
  const dest = toBashPath(destDir);
  const members = [...DIRS, ...FILES].join(" ");
  // 从活容器里只读地 tar 出来，直接管进本机的 GNU tar，中间不落临时文件。
  const remote = `docker exec ${DS.container} tar -C ${DS.root} -cf - ${members}`;
  const script = `set -o pipefail; ${onDockerHost(remote)} | tar -C ${JSON.stringify(dest)} --no-same-owner --no-same-permissions -xf -`;
  log(`抽取中（约 2 GB，走局域网，请等几分钟）…`);
  bash(script);
}

/**
 * 把整棵树改成可写。
 *
 * 容器里那些文件是 `r--r--r--`，tar 出来之后在 Windows 上变成「只读」属性，
 * 于是后面每一步覆盖写都会撞 EPERM。⚠ **报错指着被覆盖的那个文件，
 * 看着像那个文件有问题**，而真正的原因是整棵树都是只读的。
 */
function makeWritable(destDir) {
  bash(`chmod -R u+rwX ${JSON.stringify(toBashPath(destDir))}`);
  log("整棵树改成可写");
}

/**
 * Document Server 是靠 nginx 把 `api.js.tpl` 渲染成 `api.js` 的；
 * 纯静态托管没有那一步，不补的话每个页面都少一个入口脚本。
 * 官方 Dockerfile 里做的也是这一句 cp。
 */
function installApiJs(destDir) {
  const tpl = path.join(destDir, "web-apps/apps/api/documents/api.js.tpl");
  const js = path.join(destDir, "web-apps/apps/api/documents/api.js");
  if (!fs.existsSync(tpl)) die(`缺少 ${tpl}`);
  fs.copyFileSync(tpl, js);
  log("api.js.tpl → api.js");
}

/**
 * 补上静态根目录下那两份配置：`themes.json` 与 `plugins.json`。
 *
 * Document Server 是靠 nginx 现给这两个文件的，镜像里并没有。纯静态托管不补的话，
 * 编辑器每次启动都会去取、每次 404——**而它不报错，只是少一块功能**。
 * 上游那个包也补了，但补的是两个空壳，其中 `plugins.json` 是
 * `{"pluginsData": []}`，打包脚本的注释原话就是「否则会产生 404」。
 *
 * ⚠ **那个空壳正是「插件用不了」的第一个原因。** 编辑器是拿这份登记表里的字符串
 * 直接去取插件配置的，表是空的就一个插件都不会出现——包括镜像里自带的那 11 个官方插件。
 * 所以这里不写空壳，而是**把自带的那些真的登记上**。
 *
 * 登记用的是相对地址，这样整棵树拷到任意静态服务器都能用。
 * （后端跑起来时会拦下这个地址、换成绝对地址再加上我们自己那个插件，见 server/index.mjs。）
 */
function installRootConfigs(destDir) {
  // 编辑器自带六套主题；这份表是给**额外**的自定义主题用的，空的就是对的。
  fs.writeFileSync(path.join(destDir, "themes.json"), JSON.stringify({ themes: [] }, null, 2) + "\n");

  const pluginsDir = path.join(destDir, "sdkjs-plugins");
  const 自带的 = fs
    .readdirSync(pluginsDir)
    .filter((d) => d.startsWith("{") && fs.existsSync(path.join(pluginsDir, d, "config.json")))
    .sort();
  fs.writeFileSync(
    path.join(destDir, "plugins.json"),
    JSON.stringify({ pluginsData: 自带的.map((d) => `sdkjs-plugins/${d}/config.json`) }, null, 2) + "\n",
  );
  log(`themes.json（空的，编辑器自带的主题不走这里）+ plugins.json（登记了 ${自带的.length} 个自带插件）`);
}

/**
 * 关掉 Service Worker。
 * Document Server 用它做离线缓存，作用域是整个站点；我们是嵌在别人页面里的
 * 静态资源，注册一个这么大作用域的 worker 会接管宿主页面的请求。
 */
function disableServiceWorkers(destDir) {
  const webapps = toBashPath(path.join(destDir, "web-apps"));
  bash(
    `find ${JSON.stringify(webapps)} -type f \\( -name '*.html' -o -name '*.js' \\) -exec ` +
      `perl -0pi -e 's#[+]function registerServiceWorker\\(\\)\\s*\\{.*?\\}\\s*\\(\\);#void 0;#gs' {} +`,
  );
  const swDir = path.join(destDir, "sdkjs/common/serviceworker");
  if (fs.existsSync(swDir)) fs.rmSync(swDir, { recursive: true, force: true });
  log("已关掉 Service Worker 注册");
}

/**
 * nginx 那份预压缩副本（每个文件旁边一个 .gz）对我们没用——静态服务器要么自己压，
 * 要么不压，没有一个会去读这些。默认删掉，能省掉将近一半体积。
 * 想留着就加 --keep-gz。**删了多少要打出来，不能悄悄少东西。**
 */
function dropGzDuplicates(destDir) {
  if (KEEP_GZ) {
    log("按 --keep-gz 保留 nginx 预压缩副本");
    return;
  }
  const d = toBashPath(destDir);
  const before = Number(bashOut(`find ${JSON.stringify(d)} -name '*.gz' -type f | wc -l`));
  const bytes = Number(
    bashOut(`find ${JSON.stringify(d)} -name '*.gz' -type f -printf '%s\\n' | awk '{s+=$1} END {print s+0}'`),
  );
  bash(`find ${JSON.stringify(d)} -name '*.gz' -type f -delete`);
  log(`删掉 ${before} 个 nginx 预压缩副本，省 ${(bytes / 1048576).toFixed(0)} MB（要留用 --keep-gz）`);
}

function writeSourceJson(destDir, imageId, coreVersion) {
  const du = (sub) => {
    const p = path.join(destDir, sub);
    if (!fs.existsSync(p)) return null;
    const d = toBashPath(p);
    return {
      文件数: Number(bashOut(`find ${JSON.stringify(d)} -type f | wc -l`)),
      字节: Number(bashOut(`du -sb ${JSON.stringify(d)} | cut -f1`)),
    };
  };
  const source = {
    说明: "这堆静态资源是从哪来的。别手改这份文件——它由 scripts/extract-assets.mjs 生成。",
    镜像: DS.image,
    镜像ID: imageId,
    引擎版本: coreVersion,
    抽取时间: new Date().toISOString(),
    抽自: DS.host ? `${DS.sshUser}@${DS.host} 上的容器 ${DS.container}` : `本机容器 ${DS.container}`,
    已做的后处理: [
      "api.js.tpl → api.js（nginx 那一步的替代）",
      "补上 themes.json 与 plugins.json（nginx 那两份，镜像里没有）",
      "关掉 Service Worker 注册",
      KEEP_GZ ? "保留 nginx 预压缩副本" : "删掉 nginx 预压缩副本（--keep-gz 可留）",
    ],
    各目录: Object.fromEntries(DIRS.map((d) => [d, du(d)])),
  };
  fs.writeFileSync(path.join(destDir, "SOURCE.json"), JSON.stringify(source, null, 2) + "\n");
  return source;
}

function main() {
  refuseNonCommunityImage();
  const imageId = verifyImageId();
  const coreVersion = readCoreVersion();
  log(`引擎版本：${coreVersion}`);
  if (coreVersion !== DS.coreVersion) {
    log(`⚠ 与 config.mjs 记的 ${DS.coreVersion} 不一致，按机器上实际的走`);
  }

  const destDir = path.join(ROOT, VENDOR_DIR, coreVersion);
  if (NO_EXTRACT) {
    if (!fs.existsSync(destDir)) die(`${destDir} 不在，--no-extract 没东西可处理`);
    log(`按 --no-extract 复用已有的树：${destDir}`);
  } else {
    if (fs.existsSync(destDir) && !FORCE) {
      die(`${destDir} 已经有了。要重抽加 --force，只重跑后处理加 --no-extract。`);
    }
    if (fs.existsSync(destDir)) {
      // 容器里那些文件是只读的，直接 rm 会撞 EPERM，先放开权限。
      bash(`chmod -R u+rwX ${JSON.stringify(toBashPath(destDir))}`, { check: false });
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });
    extract(destDir);
  }

  // 抽完先数一遍该有的东西在不在——半路断掉的 tar 会留下一棵看着挺像的树。
  for (const d of DIRS) {
    if (!fs.existsSync(path.join(destDir, d))) die(`抽完之后缺目录：${d}`);
  }
  for (const f of FILES) {
    if (!fs.existsSync(path.join(destDir, f))) die(`抽完之后缺文件：${f}`);
  }
  const allFonts = path.join(destDir, "sdkjs/common/AllFonts.js");
  if (!fs.existsSync(allFonts)) die("缺 sdkjs/common/AllFonts.js——字体清单没跟出来，编辑器起不来");

  makeWritable(destDir);
  installApiJs(destDir);
  installRootConfigs(destDir);
  disableServiceWorkers(destDir);
  dropGzDuplicates(destDir);
  const source = writeSourceJson(destDir, imageId, coreVersion);

  console.log("\n✓ 抽好了：" + destDir);
  for (const [name, info] of Object.entries(source.各目录)) {
    if (!info) continue;
    console.log(`  ${name.padEnd(14)} ${String(info.文件数).padStart(7)} 个文件  ${(info.字节 / 1048576).toFixed(0)} MB`);
  }
  console.log(`\n  编辑器应用：${fs.readdirSync(path.join(destDir, "web-apps/apps")).join(" ")}`);
  console.log(`  来源记录：${path.join(destDir, "SOURCE.json")}`);
}

main();
