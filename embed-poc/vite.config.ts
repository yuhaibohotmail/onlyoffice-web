import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 本次构建对应的版本号，取自 `package.json`。
 *
 * 接入页拿它拼「获取源代码」那条链接指向的**标签**（见 `embed-poc/src/embed.ts`）。
 * ⚠ **从这里推、不在代码里再写一个**：许可证第 13 条要的是「**本版本**」的对应源码，
 * 而两处各写一个版本号必然漂——漂了之后那条链接会指向**另一个版本**的源码，
 * 而它照样是 200，没有任何东西会说不对。
 */
const 版本 = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

/** 入口路径要用绝对的：rollup 的 `input` 是**相对当前工作目录**解析的，不是相对这份配置。 */
const 这里 = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 这个 PoC 自己的构建配置。**与 `demo/vite.config.ts` 无关，也不引用它**
 * ——自足是这个 PoC 的两条硬约束之一，理由见 README。
 *
 * 三个入口，各答一件事：
 *
 *   static-check.html  只开一份空白文档。**零夹具、零 mock**，
 *                      用来单独回答「笨静态服务器后面这套东西能不能正常工作」。
 *   index.html         宿主页（外层），替将来的控制台/门户。
 *   embed.html         **接入页**——iframe 里那一个，这个 PoC 真正的产出物。
 *
 * ⚠ **worker 必须打成 es 模块。** 格式转换那半跑在一个 Web Worker 里，
 * 而它内部有懒加载。vite 默认把 worker 打成 iife，**那个格式不支持代码分割**，
 * 于是生产构建直接失败：
 *   Invalid value "iife" for option "worker.format"
 * ⚠ **dev 下不会报**：开发服务器不打包，worker 是原样加载的。
 * 也就是说这条只在 `build` 时现形——「跑得起来」与「构建得出来」是两件事。
 */
export default defineConfig({
  /**
   * **产物里的地址一律相对本页，不写站点根。**
   *
   * vite 默认 `base: "/"`，于是页面里写的是 `<script src="/assets/xxx.js">`。
   * 那在挂到站点根上时没问题，而装机时这一套挂在 `/oow` 底下
   *（单域名那个站的根归门户）——那时 HTML 打得开，**它自己的 JS 全 404**，
   * 于是页面停在「正在跑…」不动。
   *
   * ⚠ **这个症状与「静态资源根没设对」一模一样**，而两者根本不是一回事：
   * 那一个是 `mount-prefix.ts` 管的（组件去哪儿取那 1.6 GB），
   * 这一个是页面自己的脚本取不到——**脚本没跑，所以那个模块连运行的机会都没有**。
   * 2026-09-04 头一次挂前缀跑，七条全红，先修了前者、再跑还是全红，
   * 才发现红的其实是这一条。
   *
   * 改成 `"./"` 之后两种挂法走同一条路：根上 → `/assets/…`，
   * 挂 `/oow` → `/oow/assets/…`，都不需要有人告诉它挂在哪。
   */
  base: "./",
  define: {
    __OOW_VERSION__: JSON.stringify(版本),
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "static-check": 这里("./static-check.html"),
        index: 这里("./index.html"),
        embed: 这里("./embed.html"),
      },
    },
  },
});
