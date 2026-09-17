# API Reference

> English | [中文](api-reference.zh.md)

[← Full Examples](./full-examples.md) | [Notes →](./notes-and-formats.md)

## Constants

### `ONLYOFFICE_ID`

DOM ID of the editor container; defaults to `'iframe-office-id'`.

### `ONLYOFFICE_CONTAINER_CONFIG`

| Field | Description |
|------|------|
| `PARENT_SELECTOR` | Parent element selector `.onlyoffice-container` |
| `PARENT_CLASS_NAME` | Parent element class name `onlyoffice-container` |
| `STYLE` | Absolute positioning style for the container `{ position, inset }` |

### `ONLYOFFICE_EVENT_KEYS`

| Constant | Value | Description |
|------|-----|------|
| `SAVE_DOCUMENT` | `saveDocument` | Save completed, includes `binData` |
| `DOCUMENT_READY` | `documentReady` | Document ready |
| `LOADING_CHANGE` | `loadingChange` | Loading state |
| `ONSAVE` | `onSave` | Save flow finished (lightweight) |

### `FILE_TYPE`

- `FILE_TYPE.DOCX` — Word
- `FILE_TYPE.XLSX` — Excel
- `FILE_TYPE.PPTX` — PowerPoint

### `ONLYOFFICE_LANG_KEY`

- `ONLYOFFICE_LANG_KEY.ZH` — `zh` (**default language**)
- `ONLYOFFICE_LANG_KEY.EN` — `en`

### `OFFICE_THEME`

OnlyOffice editor UI theme (`customization.uiTheme`).

| Constant | Value | Description |
|------|-----|------|
| `OFFICE_THEME.WHITE` | `theme-white` | Light (**default**) |
| `OFFICE_THEME.CLASSIC_LIGHT` | `theme-classic-light` | Classic light |
| `OFFICE_THEME.LIGHT` | `theme-light` | Light |
| `OFFICE_THEME.DARK` | `theme-dark` | Dark |
| `OFFICE_THEME.NIGHT` | `theme-night` | Night |
| `OFFICE_THEME.CONTRAST_DARK` | `theme-contrast-dark` | High-contrast dark |

Related exports:

- `DEFAULT_OFFICE_THEME` — defaults to `OFFICE_THEME.WHITE`
- `OFFICE_THEME_OPTIONS` — `{ id, label }[]`, for demo pages / UI dropdowns

### `READONLY_SWITCH_MIN_DELAY_MS`

Minimum time loading is shown when switching between read-only and edit mode; the value is `200` (ms).

### `STATIC_RESOURCE`

Main entry point for the static resource paths of the OnlyOffice SDK and x2t.

```typescript
import { STATIC_RESOURCE } from "@/components/onlyoffice-web-comp";

STATIC_RESOURCE.onlyoffice.root     // Defaults to /packages/onlyoffice/9.4.0-develop
STATIC_RESOURCE.onlyoffice.apiUrl     // Absolute URL of api.js
STATIC_RESOURCE.x2t.script            // x2t.js path
STATIC_RESOURCE.x2t.wasm              // x2t.wasm path
```

The SDK root path can be overridden with the environment variable `NEXT_PUBLIC_APP_ROOT`.

### `__custom_font_registry__`

SDK-side font registry, defined in `public/packages/onlyoffice/9.4.0-develop/sdkjs/common/AllFonts.js`. Keys are catalog file ids (e.g. `"1001"`); values are arrays of font aliases used in documents. For the full configuration process, see [Font Configuration](./fonts.md).

## Type Definitions

### `OnlyOfficeManagerOptions`

```typescript
type OnlyOfficeManagerOptions = {
  containerId?: string;
  fileType: FileType;
  defaultFileName: string;
  readOnly?: boolean;
  lang?: OnlyOfficeLang;
  theme?: OfficeTheme;
  officeXmlEvent?: OfficeXmlEventConfig;
};
```

### `OpenDocumentInput`

```typescript
type OpenDocumentInput = {
  fileName: string;
  file?: File;
  isNew?: boolean;
  readOnly?: boolean;
  officeXmlEvent?: OfficeXmlEventConfig;
};
```

### `OfficeXmlEventConfig`

```typescript
type OfficeXmlEventConfig = {
  isEnable?: boolean;   // Default false
  limitBytes?: number;  // Default 2GB
};
```

`OFFICE_XML_EVENT_CONFIG.default` is the default configuration. When enabled, before an Office ZIP file is opened, the total decompressed size of its `.xml` / `.rels` entries is calculated; if it exceeds the threshold, the `OFFICE_XML_SIZE_LIMIT_EXCEEDED` event fires and the default error layer is shown.

### `DocumentReadyData`

```typescript
type DocumentReadyData = {
  fileName: string;
  fileType: string;
  instanceId?: string;
};
```

### `SaveDocumentData`

```typescript
type SaveDocumentData = {
  fileName: string;
  fileType: string;
  binData: Uint8Array;
  instanceId: string;
  media?: Record<string, Uint8Array>;
};
```

### `OnSaveData`

```typescript
type OnSaveData = {
  fileName: string;
  instanceId: string;
};
```

### `LoadingChangeData`

```typescript
type LoadingChangeData = {
  loading: boolean;
};
```

### `OfficeTheme`

Editor UI theme ID, matching the `OFFICE_THEME` constant values, e.g. `"theme-white"`, `"theme-dark"`. The type is exported from `const/index.ts` as `OfficeThemeId` and written as `OfficeTheme` in `EditorManager` / `OnlyOfficeManager`.

### `AscWordApiMethod`

Union type of SDK method names inside the Word editor iframe, defined in `type/word-api.ts`. Used as the `type` parameter of `EditorManager.subscribe({ type, fn })`.

Common entries (excerpt):

```typescript
// Comments
| 'asc_onAddComment'
| 'asc_onChangeCommentData'
| 'asc_onRemoveComment'
// Revisions
| 'asc_onShowRevisionsChange'
// Document state
| 'asc_onDocumentModifiedChanged'
| 'asc_onSaveCallback'
```

For the full list, see the source `type/word-api.ts`.

## Export List

Import everything from the package entry point:

```typescript
import {
  // Facade
  OnlyOfficeManager,
  onlyOfficeManagerFactory,
  // Low level
  EditorManager,
  EditorLogger,
  editorManager,
  editorManagerFactory,
  createEditorView,
  initializeOnlyOffice,
  convertBinToDocument,
  // Events
  onlyofficeEventbus,
  ONLYOFFICE_EVENT_KEYS,
  // Constants
  FILE_TYPE,
  ONLYOFFICE_ID,
  ONLYOFFICE_CONTAINER_CONFIG,
  ONLYOFFICE_LANG_KEY,
  OFFICE_THEME,
  DEFAULT_OFFICE_THEME,
  OFFICE_THEME_OPTIONS,
  STATIC_RESOURCE,
  // store
  setDocumentObj,
  getDocumentObj,
} from "@/components/onlyoffice-web-comp";
```

`EditorLogger` records the socket, downloadAs, x2t worker, and operation logs of a single editor instance. Read or print the current instance's logs via `manager.getLogger()` / `manager.printLogs()`.

Types are exported via `export type *` from `type/word-api.ts` and `type/sdk-internal.ts`.
