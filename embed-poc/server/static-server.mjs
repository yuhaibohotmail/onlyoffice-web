/**
 * 笨的那一半：**只发文件，不做任何别的事**。
 *
 * 它替的是将来的 nginx。整个 PoC 里最要紧的一条判据挂在它身上：
 * **如果编辑器在它后面能正常工作（包括插件面板），那 nginx 就能发这套东西。**
 *
 * ── 唯一的一条纪律 ────────────────────────────────────────────────────────
 *
 * **这个文件里不许出现任何「按请求改写内容」的代码。** 一行都不行。
 * 它只做三件 nginx 也做的事：把 URL 前缀映射到磁盘目录、按扩展名回 Content-Type、
 * 挡住目录穿越。
 *
 * ⚠ 为什么这条不是洁癖：仓库里那个 `demo/server/` **会按请求现编插件登记表**
 * （把盘上那份相对地址换成绝对地址）。拿一个会改写登记表的服务器去验
 * 「纯静态发得出插件面板吗」，验的是它自己。所以这里必须笨。
 *
 * ⚠ 反过来也是结论：**如果为了让插件面板出来，不得不往这个文件里加东西，
 * 那就是「纯静态不成立」的证据**，而不是这个文件写得不好。真到那一步，
 * 请把加的那一段单独记下来——它等于告诉运维「装机时要预生成什么」。
 *
 * ── 三条挂载，以及它们为什么必须是三条 ──────────────────────────────────
 *
 * 组件从一个根推出所有地址（见 `src/const/index.ts` 的 buildStaticResource）：
 *
 *     onlyofficeRoot  = /packages/onlyoffice/<版本>
 *     x2tRoot         = <onlyofficeRoot>/x2t
 *     x2tPdfFontsRoot = <onlyofficeRoot>/x2t-fonts
 *
 * 也就是说浏览器会去 `<根>/x2t/...` 找格式转换引擎、去 `<根>/x2t-fonts/...` 找字体。
 * 而盘上它们**不在**那个根底下，是 `vendor/` 下并列的两棵树——
 * 它们与静态资源是两条各自独立的版本线（引擎基于 core 9.3.0.140，静态资源 9.4.0.129），
 * 混在一个目录里那个差别就看不见了。
 *
 * 所以要三条挂载把它们贴到浏览器要找的位置上。**这是路径映射，不是内容改写**
 * ——nginx 用两个 location 就能表达同一件事，所以它不违反上面那条纪律。
 *
 * ⚠ **长前缀优先**。`/packages/onlyoffice/<版本>/x2t` 必须排在
 * `/packages/onlyoffice/<版本>` 前面，否则 x2t 的请求会先被后者接走、
 * 然后在版本目录里找不到——**而症状是「编辑器一直转圈」，不指向这里**。
 *
 * 跑法：node embed-poc/server/static-server.mjs [端口]
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

/**
 * 静态资源的版本目录名。
 *
 * ⚠ **这里刻意读盘，不从 `config.mjs` import**：那会让这个 PoC 依赖仓库里的既有代码，
 * 而「自足」是它的两条硬约束之一。读盘还有个好处——它证明的是**盘上真有的那一份**，
 * 而不是某个常量说应该有的那一份。
 */
function 探出版本目录() {
  const 根 = path.join(PROJECT_ROOT, "vendor", "onlyoffice");
  if (!fs.existsSync(根)) {
    throw new Error(
      "vendor/onlyoffice 不在。先在这个仓库里跑一次 `npm run assets` 把静态资源抽出来。",
    );
  }
  const 目录 = fs.readdirSync(根).filter((n) => fs.statSync(path.join(根, n)).isDirectory());
  if (目录.length !== 1) {
    throw new Error(
      "vendor/onlyoffice 底下应该恰好一个版本目录，实际有 " + 目录.length + " 个：" + 目录.join(", "),
    );
  }
  return 目录[0];
}

const 版本 = 探出版本目录();
const 根前缀 = "/packages/onlyoffice/" + 版本;

/**
 * 装机时预生成的那份插件登记表，在的话就用它顶掉盘上那份。
 *
 * ⚠ **这仍然是「发文件」，不是「改内容」**——改写发生在 `pregenerate-plugins.mjs` 里、
 * 装机时做一次，这里只是把一个更具体的地址指到另一个文件上。nginx 用一条更具体的
 * location 表达的是同一件事。
 *
 * ⚠ 它**在不在都要在启动日志里说一声**。这一份的有无直接决定插件面板空不空，
 * 而那是个不出声的失败——不打出来的话，两次跑出不同结果时没人知道差在哪。
 */
const 预生成登记表 = path.join(HERE, "..", "assembled", "plugins.json");
/**
 * `OOW_NO_PREGEN=1` 时假装没有预生成那份，改用盘上原样那一份（相对地址）。
 *
 * **这是对照组的开关，不是配置项。** 有了它，「预生成之后插件才取得到」这句话
 * 才是可复现的对照，而不是只活在某个人跑过的那一次里。
 * 两档的实际读数写在 `embed-poc/README.md`。
 */
const 用了预生成 = fs.existsSync(预生成登记表) && process.env.OOW_NO_PREGEN !== "1";

/** URL 前缀 → 磁盘目录（或单个文件）。**长的排前面**，理由见文件头。 */
const 挂载 = [
  ...(用了预生成 ? [[根前缀 + "/plugins.json", 预生成登记表, "文件"]] : []),
  /**
   * 插件引导脚本的**稳定别名**。
   *
   * 它真身在 `<静态根>/sdkjs-plugins/v1/plugins.js`，路径里带着静态资源的版本号。
   * 挂一个不带版本的别名出来，插件那份 HTML 里就不必写死版本
   * ——写死等于给那个「只有盘上一处真相」的号造第二份，
   * 而两份对不上的样子是**插件一片空白，不报错**。nginx 那边同样是一条 location。
   */
  [
    "/plugins-bootstrap.js",
    path.join(PROJECT_ROOT, "vendor", "onlyoffice", 版本, "sdkjs-plugins", "v1", "plugins.js"),
    "文件",
  ],
  /** 这个 PoC 自己那个插件。**与编辑器同源**，省掉一层跨源的麻烦。 */
  ["/plugin", path.join(HERE, "..", "plugin")],
  [根前缀 + "/x2t-fonts", path.join(PROJECT_ROOT, "vendor", "x2t-fonts")],
  [根前缀 + "/x2t", path.join(PROJECT_ROOT, "vendor", "x2t")],
  [根前缀, path.join(PROJECT_ROOT, "vendor", "onlyoffice", 版本)],
  ["/", path.join(HERE, "..", "dist")],
];

/**
 * ⚠ **`.wasm` 那一行不能少也不能写错。**
 * 回错类型时浏览器的 `instantiateStreaming` 会拒绝那份字节，报的是
 * 「Incorrect response MIME type」——听起来像 wasm 文件坏了，其实是这张表的事。
 */
const 类型表 = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** 目录穿越守卫：解析之后必须还在根底下。 */
function 落点(根目录, 相对) {
  const p = path.resolve(path.join(根目录, 相对));
  return p.startsWith(path.resolve(根目录)) ? p : null;
}

function 找文件(urlPath) {
  for (const [前缀, 目录, 种类] of 挂载) {
    if (种类 === "文件") {
      if (urlPath === 前缀) return fs.existsSync(目录) ? 目录 : null;
      continue;
    }
    if (前缀 === "/") {
      const f = 落点(目录, urlPath === "/" ? "index.html" : urlPath.slice(1));
      if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
      continue;
    }
    if (urlPath === 前缀 || urlPath.startsWith(前缀 + "/")) {
      const 相对 = urlPath.slice(前缀.length).replace(/^\//, "");
      const f = 落点(目录, 相对 || "index.html");
      if (!f) return null;
      // 命中前缀就到此为止：命中了却没有那个文件，答案就是 404，
      // **不要再往后面的挂载里找**。往后找会让「资源没铺全」表现成
      // 「拿到了另一棵树里同名的那一份」——那种错比 404 难查得多。
      return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
    }
  }
  return null;
}

const PORT = Number(process.argv[2] || process.env.OOW_STATIC_PORT || 3042);

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    return res.end("bad url");
  }

  const f = 找文件(urlPath);
  if (!f) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found: " + urlPath);
  }

  const st = fs.statSync(f);
  const 带版本 = urlPath.startsWith(根前缀 + "/");
  res.writeHead(200, {
    "content-type": 类型表[path.extname(f).toLowerCase()] || "application/octet-stream",
    "content-length": st.size,
    // 带版本号的那棵树是不可变资源，真部署一定是长缓存；别的都不缓存。
    "cache-control": 带版本 ? "public, max-age=31536000, immutable" : "no-store",
    /**
     * 跨源放行。
     *
     * ⚠ **这不算破了「只发文件」那条纪律**：它是一个响应头，不是按请求改写内容，
     * nginx 发静态资源时本来就常配这一条。
     *
     * 为什么需要：这个 PoC 里宿主在一个源、静态资源在另一个源，
     * 而宿主要 `fetch` 插件的 `config.json` 去读它的 guid。没有这个头，
     * 那次 fetch 直接 `TypeError: Failed to fetch`，**结果是插件静静地不下发**
     * ——页面上什么都不少，只是没有插件。
     *
     * ⚠ **生产上单域名部署时这一条用不着**：那时静态资源与业务应用同源。
     */
    "access-control-allow-origin": "*",
  });
  fs.createReadStream(f).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[静态] " + PORT + "  （这一半替 nginx，只发文件）");
  for (const [前缀, 目录] of 挂载) {
    console.log("        " + 前缀.padEnd(52) + " → " + path.relative(PROJECT_ROOT, 目录));
  }
  console.log(
    "        插件登记表：" +
      (用了预生成
        ? "**用预生成那份**（assembled/plugins.json）"
        : "用盘上原样那份（相对地址 —— 实测编辑器取不到，见 pregenerate-plugins.mjs）"),
  );
});
