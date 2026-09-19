# Core API

> English | [中文](core-api.zh.md)

[← Getting Started](./getting-started.md) | [Event System →](./event-system.md)

## Business Facade

`OnlyOfficeManager` is aimed at business pages and consolidates calls for initialization, opening documents, export, read-only mode, language, theme, and so on.

### Create a Blank Document

Call `OnlyOfficeManager.create(options)` to load DocsAPI and create a new blank document named `defaultFileName`.

```typescript
import {
  OnlyOfficeManager,
  ONLYOFFICE_ID,
  FILE_TYPE,
  DEFAULT_OFFICE_THEME,
} from "@/components/onlyoffice-web-comp";

const manager = await OnlyOfficeManager.create({
  containerId: ONLYOFFICE_ID,   // Optional, defaults to ONLYOFFICE_ID
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
  readOnly: false,
  lang: "zh",                   // Optional, defaults to zh
  theme: DEFAULT_OFFICE_THEME,  // Optional, defaults to theme-white
});
```

### Open a Local File

Call `OnlyOfficeManager.createWithFile(options, file)`: obtain the `File` first, then mount the editor in one go (a blank document is not opened first).

```typescript
const manager = await OnlyOfficeManager.createWithFile(
  {
    containerId: ONLYOFFICE_ID,
    fileType: FILE_TYPE.XLSX,
    defaultFileName: "test.xlsx",
  },
  file,
);
```

### Registering Static Resource Addresses at Runtime

Static resources such as the OnlyOffice SDK, x2t, and PDF fonts are loaded from `public/packages` by default. To switch to a CDN or a separate static server at runtime, register the resource address before creating the editor.

```typescript
import {
  FILE_TYPE,
  OnlyOfficeManager,
  getStaticResource,
  isOnlyOfficeCdnMode,
} from "@/components/onlyoffice-web-comp";

// packages root address; the directory should contain onlyoffice/{version}/...
OnlyOfficeManager.registerStaticResource({
  cdnOrigin: "https://ca0eac5f.onlyoffice-packages.pages.dev",
});

const resource = getStaticResource();
console.log(resource.onlyoffice.apiUrl);
console.log(resource.x2t.script);
console.log(isOnlyOfficeCdnMode());

const manager = await OnlyOfficeManager.create({
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
});

// Restore the default public/packages configuration
OnlyOfficeManager.resetStaticResource();
```

`registerStaticResource` supports the following parameters:

```typescript
type OnlyOfficeStaticResourceOptions = {
  /** CDN packages root address, e.g. https://ca0eac5f.onlyoffice-packages.pages.dev */
  cdnOrigin?: string | null;
  /** SDK version on the CDN; defaults to the current 9.4 SDK */
  onlyofficeVersion?: string | null;
};
```

To switch an existing instance at runtime, first destroy the old instance, then register the new address and create the editor again. The DocsAPI script, the preload iframe, and the x2t worker are all re-initialized using the new static resource address.

### Instance Methods

| Method | Description |
|------|------|
| `openDocument(input)` | Open/switch documents (upload, new, reopen) |
| `openFile(file, readOnly?)` | Open a local file |
| `openNew(fileName, readOnly?)` | Create a new document |
| `isReady()` | Whether a document has been opened |
| `getReadOnly()` / `setReadOnly()` / `toggleReadOnly()` | Read-only toggle (synchronous, uses `asc_setRestriction` underneath) |
| `getLanguage()` / `setLanguage()` / `toggleLanguage()` | Language switching |
| `getTheme()` / `setTheme(theme)` / `toggleTheme()` | UI theme switching (see below) |
| `exportDocument()` | Export bin data |
| `exportAsBlob()` | Export as a Blob |
| `downloadExport()` | Export and trigger a browser download |
| `createConnector(options?)` | Get the single Developer Edition Connector of the current editor; automatically disconnected when the editor is destroyed or reopened |
| `onLoadingChange(handler)` | Listen for loading; returns an unsubscribe function |
| `getEditor()` | Get the underlying `EditorManager` |
| `getLogger()` | Get the current instance's `EditorLogger` |
| `printLogs()` | Print the current instance's log history to the console |
| `destroy()` | Destroy the instance |

### Developer Edition Connector

`createConnector()` returns the single OnlyOffice Connector of the current editor, used to call the editor's Automation API from the parent page. Repeated calls return the same instance (the same lifecycle as `getLogger()`). The connector uses the real `frameEditorId` of the current iframe and works in both local mode and cross-origin CDN mode; when the editor is destroyed or the document is reopened, the component automatically disconnects and releases it.

```typescript
const connector = manager.createConnector();

connector.executeMethod("GetEditorType", [], () => {
  console.log("Connector request completed");
});

// Can be released early; if not called, it is automatically disconnected on manager.destroy().
connector.disconnect();
```

### Instance Logs

Each `EditorManager` holds an `EditorLogger` that records the current instance's socket, downloadAs, x2t worker, and key operation logs. Logs are still written to the console with the original arguments, so e2e/CDP can keep listening to them; you can also print the current instance's history with `manager.printLogs()`.

### Theme Switching

The theme corresponds to OnlyOffice `customization.uiTheme`. Switching briefly remounts the iframe (uncommitted edits are saved first); you can listen for loading via `onLoadingChange`.

```typescript
import {
  OnlyOfficeManager,
  OFFICE_THEME,
  OFFICE_THEME_OPTIONS,
  DEFAULT_OFFICE_THEME,
  type OfficeTheme,
} from "@/components/onlyoffice-web-comp";

// Specify the initial theme at creation
const manager = await OnlyOfficeManager.create({
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
  theme: OFFICE_THEME.DARK,
});

// Switch at runtime
await manager.setTheme(OFFICE_THEME.NIGHT);
const current = manager.getTheme();

// Quickly toggle between light / dark
await manager.toggleTheme();

// A UI dropdown can iterate over OFFICE_THEME_OPTIONS
OFFICE_THEME_OPTIONS.map(({ id, label }) => (
  <option key={id} value={id}>{label}</option>
));
```

For the available theme constants, see [API Reference · OFFICE_THEME](./api-reference.md#office_theme).

### Open Document Parameters

```typescript
type OpenDocumentInput = {
  fileName: string;
  file?: File;
  isNew?: boolean;
  readOnly?: boolean;
};
```

## Multi-Instance Management

`OnlyOfficeManagerFactory` is used for multi-container scenarios and caches `OnlyOfficeManager` facades by `containerId`. The singleton exported by the component is `onlyOfficeManagerFactory`.

```typescript
import {
  onlyOfficeManagerFactory,
  FILE_TYPE,
} from "@/components/onlyoffice-web-comp";

const manager = await onlyOfficeManagerFactory.open(
  {
    containerId: "editor-1",
    fileType: FILE_TYPE.DOCX,
    defaultFileName: "New_Document.docx",
    readOnly: false,
  },
  {
    fileName: "New_Document.docx",
    isNew: true,
  },
);

onlyOfficeManagerFactory.get("editor-1");
onlyOfficeManagerFactory.destroy("editor-1");
onlyOfficeManagerFactory.destroyAll();
```

## Low-Level Capabilities

### Initializing Resources

Call `initializeOnlyOffice()` to initialize the OnlyOffice static resources manually.

```typescript
import { initializeOnlyOffice } from "@/components/onlyoffice-web-comp";

await initializeOnlyOffice();
```

- Singleton: multiple calls initialize only once
- Called automatically inside `OnlyOfficeManager.create` / `EditorManager.create`
- An explicit call is only needed in advanced scenarios such as manual `fromEditor` binding
- It takes an optional document type: `initializeOnlyOffice(DocumentType.Cell)`. It decides **which editor's
  bundles are warmed up** in the hidden frame before the editor mounts. With no argument it warms the word
  editor, matching what `getDocumentType()` returns for an unrecognised extension. Passing the wrong type is
  not an error — it just warms the wrong bundles, and the editor downloads its own afterwards.

### Creating the Editor View

Call `createEditorView(options)` to create the low-level editor view directly.

```typescript
import { createEditorView } from "@/components/onlyoffice-web-comp";

await createEditorView({
  isNew: boolean;
  fileName: string;
  file?: File;
  url?: string;
  loader?: (url: string) => Promise<ArrayBuffer>;
  fileType?: string;
  readOnly?: boolean;
  lang?: string;              // Follows the store by default; initially zh
  containerId?: string;
  editorManager?: EditorManager;
  theme?: OfficeTheme;
});
```

**Return value:** `Promise<EditorManager>`

**Supported file types:**

- Word: `.docx`, `.doc`, `.odt`, `.rtf`, `.txt`
- Excel: `.xlsx`, `.xls`, `.ods`, `.csv`
- PowerPoint: `.pptx`, `.ppt`, `.odp`

### Editor Manager

`editorManagerFactory` and `EditorManager` provide lower-level editor control.

#### Single Instance

```typescript
import { editorManagerFactory } from "@/components/onlyoffice-web-comp";

const editorManager = editorManagerFactory.getDefault();

if (editorManager.exists()) {
  // The editor has been created
}

const binData = await editorManager.export();

editorManager.setReadOnly(true);   // Synchronous method
editorManager.setReadOnly(false);

const isReadOnly = editorManager.getReadOnly();

editorManager.destroy();
```

#### Multiple Instances

```typescript
const manager1 = editorManagerFactory.create("editor-1");
const manager2 = editorManagerFactory.get("editor-2"); // Created automatically if it does not exist

const allManagers = editorManagerFactory.getAll();

editorManagerFactory.destroy("editor-1");
editorManagerFactory.destroyAll();
```

#### `EditorManager` Instance Methods

| Method | Description |
|------|------|
| `exists()` | Check whether the editor exists |
| `export()` | Export the document's binary data |
| `setReadOnly(readOnly)` | Toggle read-only/editable (synchronous) |
| `getReadOnly()` | Get the current read-only state |
| `getInstanceId()` | Get the instance's unique ID |
| `getContainerId()` | Get the container ID |
| `getFileName()` | Get the current file name |
| `getTheme()` / `setTheme(theme)` | Get / switch the UI theme |
| `updateMedia(key, url)` | Update the media file mapping |
| `getMedia()` | Get the media file mapping |
| `destroy()` | Destroy the editor instance |
| `subscribe({ type, fn })` | Subscribe to Word SDK callbacks; see [Comments, Revisions, and Word API](./comments-revisions-word-api.md) |

**`export()` return value:**

```typescript
{
  fileName: string;
  fileType: string;
  binData: Uint8Array;
  instanceId?: string;
  media?: Record<string, Uint8Array>;
}
```

With multiple instances, `export()` filters `SAVE_DOCUMENT` events by `instanceId` (always equal to the current `containerId`). In read-only mode it returns the cached `binData` directly.

### Document Format Conversion

Call `convertBinToDocument()` to convert `Editor.bin` back to the target Office document format.

```typescript
import { convertBinToDocument, FILE_TYPE } from "@/components/onlyoffice-web-comp";

const result = await convertBinToDocument(
  binData.binData,
  binData.fileName,
  FILE_TYPE.DOCX,
  binData.media,
);

// result: { fileName: string, data: ArrayBuffer }
```

For export on business pages, prefer `OnlyOfficeManager.downloadExport()`; no manual conversion is needed.
