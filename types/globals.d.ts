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
