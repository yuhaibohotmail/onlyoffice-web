# OnlyOffice Web Comp

> 📖 English | [中文](readme.zh.md)

A **browser-side document editor component library** built on the OnlyOffice static SDK. Supports online editing, read-only preview, export, and x2t conversion for Word, Excel, and PowerPoint. **No self-hosted Document Server required**—only static SDK assets on your site.

> This file is an **entry point**. Full documentation lives in [`docs/`](./docs/overview.md). On the demo site, these Markdown files are rendered at `/docs`.

## Documentation

| # | Doc | Description |
|---|-----|-------------|
| - | [Overview](./docs/overview.md) | Index and reading path |
| - | [Quick Start](./docs/getting-started.md) | Init, container mount, create editor |
| - | [Core API](./docs/core-api.md) | `OnlyOfficeManager`, `EditorManager`, multi-instance |
| - | [Event System](./docs/event-system.md) | EventBus, event types, listeners |
| - | [Full Examples](./docs/full-examples.md) | React integration patterns |
| - | [API Reference](./docs/api-reference.md) | Constants and types |
| - | [Notes & Formats](./docs/notes-and-formats.md) | Prerequisites, formats, pitfalls |
| - | [Comments, Revisions & Word API](./docs/comments-revisions-word-api.md) | Comments, revisions, SDK callbacks |
| - | [Fonts](./docs/fonts.md) | `__custom_font_registry__`, catalog conversion |
| - | [Single-instance Demo](./docs/single-instance-demo.md) | Single editor demo + source walkthrough |
| - | [Multi-instance Demo](./docs/multi-instance-demo.md) | Full Tab demo source |

**Suggested paths**

| Scenario | Path |
|----------|------|
| First integration | [Quick Start](./docs/getting-started.md) → [Core API](./docs/core-api.md) |
| Try live demos | [Single-instance Demo](./docs/single-instance-demo.md) · [Multi-instance Demo](./docs/multi-instance-demo.md) |
| React page integration | [Full Examples](./docs/full-examples.md) |
| Multi-instance / export | [Core API](./docs/core-api.md) · [Event System](./docs/event-system.md) |

## Package Layout

```
onlyoffice-web-comp/
├── const/       Constants, static paths, file types, themes
├── store/       Document / language state
├── util/        SDK init, x2t conversion, download
├── core/        EditorManager, OnlyOfficeManager, EventBus
├── feature/     Comments, revisions
├── docs/        Full documentation (Markdown source of truth)
└── internal/    Mock server / x2t worker (not exported)
```

## Minimal Example

```typescript
import {
  OnlyOfficeManager,
  ONLYOFFICE_ID,
  FILE_TYPE,
} from "@/components/onlyoffice-web-comp";

// Create a blank document
const manager = await OnlyOfficeManager.create({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
});

// Open an existing File (fetch first, then mount)
const file = await fetch("/test.xlsx").then((r) => r.blob())
  .then((blob) => new File([blob], "test.xlsx", { type: blob.type }));
await OnlyOfficeManager.createWithFile({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.XLSX,
  defaultFileName: "test.xlsx",
}, file);
```

See [docs/core-api.md](./docs/core-api.md) for events, export, multi-instance, theme, language, and read-only toggling.

## Demos in This Repo

Documentation Markdown under `docs/` is rendered by the demo site. Live editors are embedded on the demo pages below.

| Route | Description |
|-------|-------------|
| `/docs` | All docs from this `docs/` folder |
| `/docs/demos?tab=single` | Single-instance demo ([Single-instance Demo](./docs/single-instance-demo.md)) |
| `/docs/demos?tab=multi` | Multi-instance Tab demo ([Multi-instance Demo](./docs/multi-instance-demo.md)) |

Demo components: `src/features/demo/` (`office-preview-page.tsx`, `tabs-multi-page.tsx`)

Run locally: `pnpm dev` → http://localhost:3001

## Links

- [Repository README (project overview)](../README.md)
- [OnlyOffice official API](https://api.onlyoffice.com/docs/docs-api/usage-api/config/document/)
