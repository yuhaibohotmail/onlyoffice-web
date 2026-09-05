/**
 * 组件用到的这个全局，上游那棵树里没有声明（它整个项目 `strict: false`，
 * 且 Next.js 构建会放过类型错误）。我们这边补上，好让 `npm run build` 真的能过。
 *
 * `DocEditor` 用组件自己那份定义，别在这里另写一个——写窄了的话，
 * 组件里 `new window.DocsAPI.DocEditor(...)` 的返回值会对不上它自己声明的类型，
 * 而报错指着组件，不指着这个文件。
 */
import type { DocEditor } from "../src/internal/editor/types";

declare global {
  interface Window {
    /** OnlyOffice 的 api.js 加载后挂在这里 */
    DocsAPI?: {
      DocEditor: {
        new (containerId: string, config: unknown): DocEditor;
        version(): string;
      };
    };
  }
}

/**
 * 本次构建对应的版本号（`package.json` 的 `version`），由 vite 的 `define` 注入
 * （见 `embed-poc/vite.config.ts`）。
 *
 * 接入页拿它拼「获取源代码」那条链接指向的标签。**别在代码里另写一个版本号**：
 * 许可证第 13 条要的是「本版本」的对应源码，两处各写一个必然漂，
 * 而漂了之后那条链接会指向另一个版本的源码、且照样回 200。
 */
// ⚠ 必须写在 `declare global` 里：本文件顶上有 import，所以它是**模块**，
// 直接写 `declare const` 只在本文件里可见，而报错是「找不到这个名字」，
// 指向用它的那一行，不指向这里。
declare global {
  const __OOW_VERSION__: string;
}
