# OnlyOffice Web Comp Documentation

> English | [中文](overview.zh.md)

OnlyOffice Web Comp is a web document-editing component library built on the OnlyOffice static SDK. It supports online editing, read-only preview, export, and x2t format conversion for Word, Excel, and PowerPoint.

**Package path**: `src/components/onlyoffice-web-comp`  
**Import**: `import { ... } from "@/components/onlyoffice-web-comp"`

## Contents

| No. | Document | Description |
|------|------|------|
| - | [Getting Started](./getting-started.md) | `OnlyOfficeManager`, mounting the container, introduction to multiple instances |
| - | [Core API](./core-api.md) | `OnlyOfficeManager`, `onlyOfficeManagerFactory`, low-level API |
| - | [Event System](./event-system.md) | EventBus, event types and listening |
| - | [Full Examples](./full-examples.md) | Full React component examples |
| - | [API Reference](./api-reference.md) | Constants, type definitions |
| - | [Notes and Supported Formats](./notes-and-formats.md) | Prerequisites, file formats, common points to note |
| - | [Comments, Revisions, and Word API](./comments-revisions-word-api.md) | Comments, revisions, `subscribe`, and SDK callbacks |
| - | [Font Configuration](./fonts.md) | `__custom_font_registry__`, catalog conversion, and alias registration |
| - | [Single-Instance Demo](./single-instance-demo.md) | Single-editor demo and source code |
| - | [Multi-Instance Demo](./multi-instance-demo.md) | Full source code and demo for multiple instances in tabs |

## Recommended Reading Paths

| Scenario | Path |
|------|------|
| First-time integration | [Getting Started](./getting-started.md) → [Core API](./core-api.md) |
| Try it online | [Single-Instance Demo](./single-instance-demo.md) · [Multi-Instance Demo](./multi-instance-demo.md) |
| Integrating into a React page | [Full Examples](./full-examples.md) |
| Multiple instances / export | [Core API](./core-api.md) · [Event System](./event-system.md) |
| Official document review (comments/revisions) | [Comments, Revisions, and Word API](./comments-revisions-word-api.md) |
| Looking up constants and types | [API Reference](./api-reference.md) |
| Custom fonts / official document fonts | [Font Configuration](./fonts.md) |

## High-Level API at a Glance

Business pages should prefer **`OnlyOfficeManager`** (the facade); the low-level **`EditorManager`** is available for direct control in advanced scenarios.

```typescript
import { OnlyOfficeManager, FILE_TYPE, ONLYOFFICE_ID } from "@/components/onlyoffice-web-comp";

// Create a new blank document
await OnlyOfficeManager.create({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
});

// Get the File first, then mount (e.g. a default file in the public directory)
const blob = await fetch("/test.xlsx").then((r) => r.blob());
const file = new File([blob], "test.xlsx", { type: blob.type });
await OnlyOfficeManager.createWithFile({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.XLSX,
  defaultFileName: "test.xlsx",
}, file);
```

## Site Demo Routes

| Route | Description |
|------|------|
| `/` | Product home page |
| `/docs` | Component library documentation (Markdown in this directory, rendered) |
| `/docs/demos/single` | Single-instance online demo |
| `/docs/demos/multi` | Multi-instance tabs online demo |

Demo implementation: `src/features/demo/` (`office-preview-page.tsx` · `tabs-multi-page.tsx`)
