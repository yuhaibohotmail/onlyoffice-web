import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

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
