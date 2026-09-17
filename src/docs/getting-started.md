# Getting Started

> English | [中文](getting-started.zh.md)

[← Overview](./overview.md) | [Core API →](./core-api.md)

## Recommended Approach: `OnlyOfficeManager`

Business pages should prefer the **`OnlyOfficeManager`** facade. `create` / `createWithFile` automatically call `initializeOnlyOffice()` internally, so no manual initialization is needed.

### 1. Add the Editor Container

```tsx
import {
  ONLYOFFICE_ID,
  ONLYOFFICE_CONTAINER_CONFIG,
} from "@/components/onlyoffice-web-comp";

export function EditorHost() {
  return (
    <div
      className={`${ONLYOFFICE_CONTAINER_CONFIG.PARENT_CLASS_NAME} relative flex-1`}
    >
      <div id={ONLYOFFICE_ID} className="absolute inset-0" />
    </div>
  );
}
```

### 2. Create a Blank Document

```typescript
import {
  OnlyOfficeManager,
  ONLYOFFICE_ID,
  FILE_TYPE,
} from "@/components/onlyoffice-web-comp";

const manager = await OnlyOfficeManager.create({
  containerId: ONLYOFFICE_ID,
  fileType: FILE_TYPE.DOCX,
  defaultFileName: "New_Document.docx",
  readOnly: false,
});
```

### 3. Open an Existing File (Fetch the File First, Then Mount)

```typescript
const file = await fetch("/test.xlsx")
  .then((r) => r.blob())
  .then((blob) => new File([blob], "test.xlsx", { type: blob.type }));

const manager = await OnlyOfficeManager.createWithFile(
  {
    containerId: ONLYOFFICE_ID,
    fileType: FILE_TYPE.XLSX,
    defaultFileName: "test.xlsx",
  },
  file,
);
```

### 4. Common Operations

```typescript
import { OFFICE_THEME } from "@/components/onlyoffice-web-comp";

await manager.openFile(uploadedFile);       // Switch document
await manager.openNew("New_Document.docx"); // New document
await manager.downloadExport();             // Export and download
manager.toggleReadOnly();                   // Toggle read-only
await manager.toggleLanguage();             // Toggle Chinese/English
await manager.setTheme(OFFICE_THEME.DARK);  // Switch UI theme
manager.destroy();                          // Destroy
```

## Multi-Instance Containers

Each instance uses a unique `containerId`, and its parent element sets `data-onlyoffice-container-id`:

```tsx
import { ONLYOFFICE_CONTAINER_CONFIG } from "@/components/onlyoffice-web-comp";

export function MultiEditorPage() {
  return (
    <div className="grid grid-cols-3 gap-4">
      {["editor-1", "editor-2", "editor-3"].map((id) => (
        <div
          key={id}
          className={`${ONLYOFFICE_CONTAINER_CONFIG.PARENT_CLASS_NAME} relative`}
          data-onlyoffice-container-id={id}
        >
          <div id={id} className="absolute inset-0" />
        </div>
      ))}
    </div>
  );
}
```

To open documents with multiple instances, use `onlyOfficeManagerFactory.open()`; see [Core API](./core-api.md#multi-instance-management).

**Note**: With multiple instances, you must use `data-onlyoffice-container-id` to locate the container precisely, so that operations such as image upload are not routed to the wrong instance.

## Low-Level Approach (Advanced)

When you need direct control over `EditorManager`, you can use `createEditorView` or `editorManagerFactory`. See [Core API](./core-api.md#low-level-capabilities) for details.

`EditorManager.create()` likewise calls `initializeOnlyOffice()` internally, so there is generally no need to initialize manually in advance. Only when you bind it yourself with `OnlyOfficeManager.fromEditor()` do you need to make sure the SDK has been loaded.
