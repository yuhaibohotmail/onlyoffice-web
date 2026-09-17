# Single-Instance Demo

> English | [中文](single-instance-demo.zh.md)

[← Getting Started](./getting-started.md) | [Multi-Instance Demo →](./multi-instance-demo.md)

The single-instance scenario uses the **`OnlyOfficeManager`** facade: one page, one `containerId`, one editor instance. It suits document detail pages, previews, and simple editing pages.

**Live demo**: site route [`/docs/demos/single`](/docs/demos/single)  
**Full source**: `src/features/demo/office-preview-page.tsx`

## Live Demo

Below is an interactive single-instance editor.

<!-- demo:single -->

## Core Approach

1. Mount a DOM container with a fixed `containerId`  
2. `OnlyOfficeManager.create` initializes a blank document, or `createWithFile` opens a local file  
3. The toolbar calls `openDocument` / `downloadExport` / `toggleReadOnly` / `setTheme` / `toggleLanguage` / `printLogs`  
4. Call `manager.destroy()` when the page unmounts

## Container Component

```tsx
"use client";

import { memo } from "react";
import {
  ONLYOFFICE_CONTAINER_CONFIG,
  ONLYOFFICE_ID,
} from "@/components/onlyoffice-web-comp";

const OnlyOfficeHost = memo(function OnlyOfficeHost() {
  return (
    <div
      className={`${ONLYOFFICE_CONTAINER_CONFIG.PARENT_CLASS_NAME} absolute inset-0`}
    >
      <div id={ONLYOFFICE_ID} className="absolute inset-0" />
    </div>
  );
});
```

## Initialization and Destruction

```tsx
useEffect(() => {
  let unsubscribeLoading: (() => void) | undefined;
  let disposed = false;
  const containerId = ONLYOFFICE_ID;

  const init = async () => {
    editorManagerFactory.destroy(containerId);
    const loadSession = editorManagerFactory.beginLoadSession(containerId);

    const manager = await OnlyOfficeManager.create({
      containerId,
      fileType: FILE_TYPE.DOCX,
      defaultFileName: "New_Document.docx",
      readOnly,
      theme: currentTheme,
      loadSession,
    });

    if (
      disposed ||
      !editorManagerFactory.isLoadSessionActive(containerId, loadSession)
    ) {
      return;
    }

    managerRef.current = manager;
    setEditorReady(true);
    unsubscribeLoading = manager.onLoadingChange(({ loading: next }) => {
      setLoading(next);
    });
  };

  init().catch(() => setError("无法加载编辑器组件"));

  return () => {
    disposed = true;
    unsubscribeLoading?.();
    managerRef.current?.destroy();
    editorManagerFactory.destroy(containerId);
    managerRef.current = null;
  };
}, []);
```

## Toolbar Actions

```tsx
const handleOpenDocument = (fileName: string, file?: File) =>
  managerRef.current?.openDocument({ fileName, file, readOnly });

const handleExport = () => managerRef.current?.downloadExport();

const handleToggleReadOnly = async () => {
  await managerRef.current?.toggleReadOnly();
  setReadOnly(managerRef.current?.getReadOnly() ?? false);
};

const handleThemeChange = async (theme: OfficeTheme) => {
  await managerRef.current?.setTheme(theme);
  setCurrentThemeState(managerRef.current?.getTheme() ?? theme);
};

const handleLanguageSwitch = async () => {
  const nextLang = await managerRef.current?.toggleLanguage();
  setCurrentLangState(nextLang);
};
```

## Page Structure

```tsx
export function OfficePreviewPage({ embedded = false, ...props }) {
  return (
    <div className={`flex flex-col bg-white ${embedded ? "h-full min-h-0" : "h-screen"}`}>
      <header>{/* Language / Theme / Upload / New / Export / Read-only */}</header>
      <div className="relative min-h-0 flex-1">
        <OnlyOfficeHost />
        {loading && <LoadingOverlay />}
      </div>
      <input ref={fileInputRef} type="file" className="hidden" onChange={...} />
    </div>
  );
}
```

## Supported Capabilities

| Capability | API |
|------|-----|
| Upload a file | `manager.openDocument({ fileName, file })` |
| New blank document | `manager.openDocument({ fileName: defaultFileName })` |
| Export | `manager.downloadExport()` |
| Toggle read-only | `manager.toggleReadOnly()` |
| Theme | `manager.setTheme(theme)` |
| Language | `manager.toggleLanguage()` |
| Print logs | `manager.printLogs()` |
