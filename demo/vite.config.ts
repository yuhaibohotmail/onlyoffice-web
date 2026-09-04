import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 前端 3040，后端 3041。
 *
 * ⚠ **三条反代都不能省，理由是同源。** 编辑器本体跑在一个 iframe 里，那个 iframe 的
 * src 是 SDK 自己的 index.html；插件又在编辑器里再开一个 iframe。这几层只要有一层
 * 跨了源，父页面就什么都读不到——**而症状是「编辑器一直不出来」，看着像编辑器坏了，
 * 不像被同源策略挡住**。所以 /packages、/plugins、/api 全部经 vite 反代到 3041，
 * 浏览器眼里只有 127.0.0.1:3040 一个源。
 *
 * changeOrigin 保持 false：后端要按原始 Host 记账与拼地址。
 */
const api = { target: "http://127.0.0.1:3041", changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  /**
   * ⚠ **worker 必须打成 es 模块。**
   *
   * 格式转换那半跑在一个 Web Worker 里（`internal/editor/x2t.worker.ts`），
   * 而它内部有懒加载（brotli 解码那一份是用的时候才 import 的）。
   * vite 默认把 worker 打成 iife，**那个格式不支持代码分割**，于是生产构建直接失败：
   *
   *   Invalid value "iife" for option "worker.format"
   *   — UMD and IIFE output formats are not supported for code-splitting builds
   *
   * ⚠ **dev 下不会报**：开发服务器不打包，worker 是原样加载的。
   * 也就是说这条只在 `npm run build` 时现形——**「跑得起来」与「构建得出来」是两件事**。
   */
  worker: {
    format: "es",
  },
  /**
   * ⚠ **产物要落到项目根的 `dist/`，不是 `demo/dist/`。**
   * root 是 `demo/`，而 `.gitignore` 里写的是 `/dist/`——不指过去的话
   * 构建产物会变成一堆未跟踪文件，**一次宽路径 `git add` 就扫进去了**。
   */
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 3040,
    strictPort: true,
    proxy: {
      "/api": api,
      "/packages": api,
      "/plugins": api,
      /**
       * ⚠ **这一条 2026-09-04 才补上，在那之前 dev 下那四条许可链接全是 404。**
       *
       * `src/legal/notice.ts` 里 `legalRoot` 默认就是 `/legal`，而全仓没有任何地方
       * 传过这个参数——也就是说面板里「获取源代码 / 许可证原文 / 第三方组件声明 /
       * 修改说明」四条，在 3040 上点开全是 404。
       *
       * **而实测逮不住它**：`demo/e2e/run.mjs` 的 B16 只断言那个按钮**在、且没被盖住**，
       * 从不点开链接。许可的附加条款第三条要的是「用户拿得到许可信息」，
       * 而**入口点开之后 404 与没有入口是一回事**。
       */
      "/legal": api,
    },
  },
});
