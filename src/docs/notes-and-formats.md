# Notes and Supported Formats

> English | [中文](notes-and-formats.zh.md)

[← API Reference](./api-reference.md) | [Font Configuration →](./fonts.md) · [Comments and Revisions →](./comments-revisions-word-api.md)

## Prerequisites

1. **Static resources**: Place the OnlyOffice SDK (including `web-apps/`, `sdkjs/`, `fonts/`, `x2t/`) in a directory the site can serve; the default is `public/packages/onlyoffice/9.4.0-develop/`. Custom fonts must be registered in `__custom_font_registry__` in `AllFonts.js`; see [Font Configuration](./fonts.md) for details.
2. **Environment variable** (optional): `NEXT_PUBLIC_APP_ROOT=/packages/onlyoffice/9.4.0-develop`, consistent with `STATIC_RESOURCE.onlyoffice.root`.
3. **x2t resources**: `x2t/x2t.js` is plain JS text and `x2t.wasm` is a Brotli pre-compressed file; there is **no need** to configure `Content-Encoding: br` for `x2t.wasm`, because `x2t-assets` inside the Worker decompresses it automatically.
4. **DOM container**: The page must reserve a mount point for the editor (see [Getting Started](./getting-started.md)).

## Notes

1. **Initialization**: `OnlyOfficeManager.create` / `createWithFile` and `EditorManager.create` call `initializeOnlyOffice()` internally, so manual initialization is generally not needed.
2. **Container elements**:
   - Single instance: the page contains a node with `id={ONLYOFFICE_ID}`, and its parent uses the `onlyoffice-container` class name.
   - Multiple instances: each instance uses a unique `containerId`, and its parent sets `data-onlyoffice-container-id`.
3. **File type**: The file extension must match the content.
4. **Event cleanup**: When the component unmounts, remove EventBus listeners and `destroy()` the editor instance.
5. **Asynchronous operations**: `create` / `openDocument` / `export` / `downloadExport` and similar are asynchronous; use `await`.
6. **Resource isolation between instances**: Each instance maintains its own `media` mapping; image uploads are routed through the instance-level `writeFile`.
7. **Unique container IDs**: With multiple instances, `containerId` values must not repeat.
8. **Choosing a save event**: Use `SAVE_DOCUMENT` / `export()` when you need the binary data; listen for `ONSAVE` if you only need a save-success message.
9. **Read-only export**: In read-only mode `export()` returns the cached data directly and does not call `downloadAs`.
10. **Order when opening a file**: When using `createWithFile`, first `fetch` to obtain the `File`, then call the mount API.

## Supported File Formats

### Word Documents

- `.docx` — Word 2007+
- `.doc` — Word 97-2003
- `.odt` — OpenDocument Text
- `.rtf` — Rich Text Format
- `.txt` — Plain text

### Excel Spreadsheets

- `.xlsx` — Excel 2007+
- `.xls` — Excel 97-2003
- `.ods` — OpenDocument Spreadsheet
- `.csv` — CSV

### PowerPoint Presentations

- `.pptx` — PowerPoint 2007+
- `.ppt` — PowerPoint 97-2003
- `.odp` — OpenDocument Presentation
