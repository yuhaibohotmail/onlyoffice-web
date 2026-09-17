# OnlyOffice Web Comp 文档

> [English](overview.md) | 中文

OnlyOffice Web Comp 是基于 OnlyOffice 静态 SDK 的 Web 端文档编辑组件库，支持 Word、Excel、PowerPoint 的在线编辑、只读预览、导出与 x2t 格式转换。

**包路径**：`src/components/onlyoffice-web-comp`  
**导入方式**：`import { ... } from "@/components/onlyoffice-web-comp"`

## 文档目录

| 编号 | 文档 | 说明 |
|------|------|------|
| - | [快速开始](./getting-started.zh.md) | `OnlyOfficeManager`、容器挂载、多实例入门 |
| - | [核心 API](./core-api.zh.md) | `OnlyOfficeManager`、`onlyOfficeManagerFactory`、底层 API |
| - | [事件系统](./event-system.zh.md) | EventBus、事件类型与监听 |
| - | [完整示例](./full-examples.zh.md) | React 组件完整示例 |
| - | [API 参考](./api-reference.zh.md) | 常量、类型定义 |
| - | [注意事项与支持格式](./notes-and-formats.zh.md) | 前置条件、文件格式、常见注意点 |
| - | [批注修订与 Word API](./comments-revisions-word-api.zh.md) | 批注、修订、`subscribe` 与 SDK 回调 |
| - | [字体配置](./fonts.zh.md) | `__custom_font_registry__`、catalog 转换与别名注册 |
| - | [单实例示例](./single-instance-demo.zh.md) | 单编辑器 Demo 与源码 |
| - | [多实例示例](./multi-instance-demo.zh.md) | Tab 多实例完整源码与 Demo |

## 推荐阅读路径

| 场景 | 路径 |
|------|------|
| 首次接入 | [快速开始](./getting-started.zh.md) → [核心 API](./core-api.zh.md) |
| 在线体验 | [单实例示例](./single-instance-demo.zh.md) · [多实例示例](./multi-instance-demo.zh.md) |
| React 页面集成 | [完整示例](./full-examples.zh.md) |
| 多实例 / 导出 | [核心 API](./core-api.zh.md) · [事件系统](./event-system.zh.md) |
| 公文审校（批注/修订） | [批注修订与 Word API](./comments-revisions-word-api.zh.md) |
| 查常量与类型 | [API 参考](./api-reference.zh.md) |
| 自定义字体 / 公文字体 | [字体配置](./fonts.zh.md) |

## 上层 API 速览

业务页面优先使用 **`OnlyOfficeManager`**（门面），底层 **`EditorManager`** 供高级场景直接控制。

```typescript
import { OnlyOfficeManager, FILE_TYPE, ONLYOFFICE_ID } from "@/components/onlyoffice-web-comp";

// 新建空白文档
await OnlyOfficeManager.create({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
});

// 先取 File，再挂载（如 public 目录下的默认文件）
const blob = await fetch("/test.xlsx").then((r) => r.blob());
const file = new File([blob], "test.xlsx", { type: blob.type });
await OnlyOfficeManager.createWithFile({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.XLSX,
  defaultFileName: "test.xlsx",
}, file);
```

## 站点演示路由

| 路由 | 说明 |
|------|------|
| `/` | 产品主页 |
| `/docs` | 组件库文档（本目录 Markdown 渲染） |
| `/docs/demos/single` | 单实例在线示例 |
| `/docs/demos/multi` | 多实例 Tab 在线示例 |

演示实现：`src/features/demo/`（`office-preview-page.tsx` · `tabs-multi-page.tsx`）
