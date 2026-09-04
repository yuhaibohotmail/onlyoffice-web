/**
 * 装机时该做的那一步：**把插件登记表里的相对地址换成绝对路径，预生成一份**。
 *
 * ── 为什么需要它（这是实测出来的，不是推的）────────────────────────────────
 *
 * 盘上那份 `plugins.json` 写的是相对地址（`sdkjs-plugins/{GUID}/config.json`）。
 * `probe/static-check.mjs` 实测的结果是：**编辑器把它们解析到自己那个应用目录下面去**——
 *
 *     /packages/onlyoffice/<版本>/web-apps/apps/documenteditor/main/sdkjs-plugins/{GUID}/config.json  → 404
 *
 * 而文件其实在 `<根>/sdkjs-plugins/{GUID}/config.json`。11 条全 404，
 * **而且一句错都不报**：文档照常打开、照常导出、法律入口照常在，只有插件面板是空的。
 *
 * 这就是仓库里那个 `demo/server/` 要按请求现编这份表的原因。而我们生产上不打算跑那个进程，
 * 所以这一步挪到**装机时**做一次。
 *
 * ── 一处比 demo 那边更好的做法：**写路径，不写 origin** ────────────────────
 *
 * `demo/server/` 是按每次请求的 Host 拼**完整地址**（`http://主机:端口/packages/...`）。
 * 那是它必须的——它面对的是任意 Host。但装机时我们知道产物挂在哪个路径下，
 * 所以可以只写**以斜杠开头的路径**：
 *
 *     /packages/onlyoffice/<版本>/sdkjs-plugins/{GUID}/config.json
 *
 * 它不含协议、不含域名、不含端口，于是**换域名、换端口、http 换 https 都不会失效**
 * ——2026-08-30 那个「产物起在另一个端口时插件面板变 0 个」的坑，从根上没有了。
 *
 * ⚠ 它仍然含着**挂载前缀**。产物要是挂在 `/oow/` 底下，前缀就得跟着变。
 * 所以这个脚本收一个 `--prefix`，默认空（= 挂在站点根上）。
 *
 * 跑法：
 *   node embed-poc/server/pregenerate-plugins.mjs [--prefix /oow] [--out <文件>]
 *
 * ⚠ **它读盘上那份，不自己列一份名单。** 另列一份的话，镜像里加减了插件而这边不会跟着变，
 * 而两边对不上不报错——那正是这个脚本要修的那一类毛病。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

function 取参(名, 默认值) {
  const i = process.argv.indexOf(名);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 默认值;
}

const 前缀 = 取参("--prefix", "").replace(/\/+$/, "");

const 资源根 = path.join(PROJECT_ROOT, "vendor", "onlyoffice");
if (!fs.existsSync(资源根)) {
  console.error("vendor/onlyoffice 不在。先跑一次 `npm run assets`。");
  process.exitCode = 1;
} else {
  const 目录 = fs.readdirSync(资源根).filter((n) => fs.statSync(path.join(资源根, n)).isDirectory());
  if (目录.length !== 1) {
    console.error("vendor/onlyoffice 底下应该恰好一个版本目录，实际 " + 目录.length + " 个");
    process.exitCode = 1;
  } else {
    const 版本 = 目录[0];
    const 源文件 = path.join(资源根, 版本, "plugins.json");
    const 默认落点 = path.join(HERE, "..", "assembled", "plugins.json");
    const 落点 = 取参("--out", 默认落点);

    if (!fs.existsSync(源文件)) {
      console.error("盘上没有 " + 源文件 + " —— 抽取脚本没生成它？");
      process.exitCode = 1;
    } else {
      const 原 = JSON.parse(fs.readFileSync(源文件, "utf8"));
      const 原表 = Array.isArray(原.pluginsData) ? 原.pluginsData : [];
      const 根路径 = 前缀 + "/packages/onlyoffice/" + 版本;

      const 新表 = 原表.map((条) => {
        // 已经是绝对的（带协议或以斜杠开头）就别动它——那多半是有人有意配进来的。
        if (/^https?:\/\//i.test(条) || 条.startsWith("/")) return 条;
        return 根路径 + "/" + 条.replace(/^\/+/, "");
      });

      const 改了 = 新表.filter((v, i) => v !== 原表[i]).length;
      fs.mkdirSync(path.dirname(落点), { recursive: true });
      fs.writeFileSync(落点, JSON.stringify({ ...原, pluginsData: 新表 }, null, 2) + "\n", "utf8");

      console.log("读 " + path.relative(PROJECT_ROOT, 源文件));
      console.log("写 " + path.relative(PROJECT_ROOT, 落点));
      console.log("共 " + 原表.length + " 条，改写了 " + 改了 + " 条；根路径 " + 根路径);
      if (改了 === 0 && 原表.length > 0) {
        // 一条都没改说明盘上那份本来就是绝对的。**说一声**，别让人以为它干了活。
        console.log("⚠ 一条都没改 —— 盘上那份本来就是绝对地址，这一步是空操作。");
      }
    }
  }
}
