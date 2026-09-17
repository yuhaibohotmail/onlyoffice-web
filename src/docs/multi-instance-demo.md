# Multi-Instance Demo

> English | [中文](multi-instance-demo.zh.md)

[← Single-Instance Demo](./single-instance-demo.md) | [Core API →](./core-api.md)

Multi-instance scenarios use **`onlyOfficeManagerFactory`**: each Tab has its own unique `containerId`, and switching Tabs **hides the DOM instead of destroying the instance**, so each editor's state is preserved.

**Live demo**: site route [`/docs/demos/multi`](/docs/demos/multi)  
**Full source**: `src/features/demo/tabs-multi-page.tsx`

## Live Demo

Below is an interactive multi-instance Tab editor.

<!-- demo:multi -->

## Design Points

| Point | Description |
|------|------|
| Independent containers | Each Tab generates `tab-editor-${id}` as its `containerId` |
| Lazy loading | `onlyOfficeManagerFactory.open` is called when a Tab is activated for the first time |
| State preservation | Inactive Tabs are hidden with `invisible`, not `destroy`ed |
| Closing a Tab | `onlyOfficeManagerFactory.destroy(containerId)` releases the instance |
| Page unmount | `onlyOfficeManagerFactory.destroyAll()` |
| Printing logs | Call `manager.printLogs()` on the currently active Tab; only that instance's logs are output |

### Tab Data Model

```tsx
type TabItem = {
  id: string;
  label: string;
  containerId: string;
  fileName: string;
  readOnly: boolean;
  docKind: "word" | "excel" | "ppt";
};

function createTab(index: number, docKind: DocKind): TabItem {
  const id = nanoid(6);
  const preset = DOC_PRESETS[docKind];
  return {
    id,
    label: `${preset.label} ${index}`,
    containerId: `tab-editor-${id}`,
    fileName: preset.defaultFileName,
    readOnly: false,
    docKind,
  };
}
```

### Opening the Editor (Per Tab)

```tsx
const openTabEditor = async (tab: TabItem) => {
  const preset = getPreset(tab.docKind);

  await onlyOfficeManagerFactory.open(
    {
      containerId: tab.containerId,
      fileType: preset.fileType,
      defaultFileName: preset.defaultFileName,
      readOnly: tab.readOnly,
      theme,
    },
    {
      fileName: tab.fileName,
      isNew: isNewDocument(tab),
      readOnly: tab.readOnly,
    },
  );

  initializedRef.current.add(tab.id);
};
```

### Tab Bar UI (Switch / Close / New)

```tsx
{tabs.map((tab) => {
  const isActive = activeId === tab.id;
  return (
    <div key={tab.id} className={isActive ? "active-tab" : "inactive-tab"}>
      <button type="button" onClick={() => setActiveId(tab.id)}>
        {tab.label}
      </button>
      {tabs.length > 1 && (
        <button type="button" onClick={() => closeTab(tab.id)}>×</button>
      )}
    </div>
  );
})}

{(Object.keys(DOC_PRESETS) as DocKind[]).map((kind) => (
  <button key={kind} type="button" onClick={() => addTab(kind)}>
    + {getPreset(kind).label}
  </button>
))}
```

### Multi-Container Rendering (Hide Instead of Unmount)

```tsx
{tabs.map((tab) => (
  <div
    key={tab.id}
    className={`absolute inset-0 ${
      activeId === tab.id ? "visible z-10" : "invisible z-0"
    }`}
  >
    <OnlyOfficeTabHost containerId={tab.containerId} />
  </div>
))}
```

## Full Tab Page Source

The following is kept identical to the repository's `src/features/demo/tabs-multi-page.tsx` and can be copied directly as a Demo page:

```tsx
"use client";

import { memo, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  DemoButton,
  DemoField,
  DemoSelect,
  demoHeaderClass,
  demoHeaderInnerClass,
  demoSubtitleClass,
  demoTitleClass,
  demoToolbarClass,
} from "./demo-toolbar";
import {
  DEFAULT_OFFICE_THEME,
  FILE_TYPE,
  ONLYOFFICE_CONTAINER_CONFIG,
  ONLYOFFICE_EVENT_KEYS,
  OFFICE_THEME_OPTIONS,
  onlyOfficeManagerFactory,
  onlyofficeEventbus,
  type FileType,
  type OfficeTheme,
} from "@/components/onlyoffice-web-comp";

type DocKind = "word" | "excel" | "ppt";

type DocPreset = {
  label: string;
  badge: string;
  fileType: FileType;
  defaultFileName: string;
  accept: string;
};

type TabItem = {
  id: string;
  label: string;
  containerId: string;
  fileName: string;
  readOnly: boolean;
  docKind: DocKind;
};

const DOC_PRESETS: Record<DocKind, DocPreset> = {
  word: {
    label: "Word",
    badge: "W",
    fileType: FILE_TYPE.DOCX,
    defaultFileName: "New_Document.docx",
    accept: ".docx,.doc,.docm,.odt,.rtf,.txt",
  },
  excel: {
    label: "Excel",
    badge: "E",
    fileType: FILE_TYPE.XLSX,
    defaultFileName: "New_Spreadsheet.xlsx",
    accept: ".xlsx,.xls,.ods,.csv",
  },
  ppt: {
    label: "PPT",
    badge: "P",
    fileType: FILE_TYPE.PPTX,
    defaultFileName: "New_Presentation.pptx",
    accept: ".pptx,.ppt,.odp",
  },
};

const OnlyOfficeTabHost = memo(function OnlyOfficeTabHost({
  containerId,
}: {
  containerId: string;
}) {
  return (
    <div
      className={`${ONLYOFFICE_CONTAINER_CONFIG.PARENT_CLASS_NAME} absolute inset-0`}
      data-onlyoffice-container-id={containerId}
    >
      <div id={containerId} className="absolute inset-0" />
    </div>
  );
});

function getPreset(docKind: DocKind) {
  return DOC_PRESETS[docKind];
}

function isNewDocument(tab: TabItem) {
  return tab.fileName === getPreset(tab.docKind).defaultFileName;
}

function createTab(index: number, docKind: DocKind): TabItem {
  const id = nanoid(6);
  const preset = getPreset(docKind);
  return {
    id,
    label: `${preset.label} ${index}`,
    containerId: `tab-editor-${id}`,
    fileName: preset.defaultFileName,
    readOnly: false,
    docKind,
  };
}

function createInitialTabState() {
  const initialTab = createTab(1, "word");
  return { tabs: [initialTab], activeId: initialTab.id };
}

export function TabsMultiPage({ embedded = false }: { embedded?: boolean }) {
  const [tabs, setTabs] = useState<TabItem[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<OfficeTheme>(DEFAULT_OFFICE_THEME);
  const initializedRef = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const { tabs: initialTabs, activeId: initialActiveId } = createInitialTabState();
    setTabs(initialTabs);
    setActiveId(initialActiveId);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activePreset = activeTab ? getPreset(activeTab.docKind) : null;

  const updateTab = (tabId: string, patch: Partial<TabItem>) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
    );
  };

  const runAction = async (action: () => Promise<void>, message: string) => {
    try {
      setError(null);
      await action();
    } catch (err) {
      setError(message);
      console.error(message, err);
    }
  };

  const openTabEditor = async (tab: TabItem) => {
    const preset = getPreset(tab.docKind);

    await onlyOfficeManagerFactory.open(
      {
        containerId: tab.containerId,
        fileType: preset.fileType,
        defaultFileName: preset.defaultFileName,
        readOnly: tab.readOnly,
        theme,
      },
      {
        fileName: tab.fileName,
        isNew: isNewDocument(tab),
        readOnly: tab.readOnly,
      },
    );

    initializedRef.current.add(tab.id);
  };

  useEffect(() => {
    if (!activeId) return;

    const tab = tabs.find((item) => item.id === activeId);
    if (!tab || initializedRef.current.has(tab.id)) return;

    let cancelled = false;

    openTabEditor(tab)
      .then(() => {
        if (cancelled) {
          onlyOfficeManagerFactory.destroy(tab.containerId);
          initializedRef.current.delete(tab.id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError("无法加载编辑器");
        console.error("Failed to open tab editor:", err);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, tabs]);

  useEffect(() => {
    const handleLoadingChange = (data: { loading: boolean }) => {
      setLoading(data.loading);
    };
    onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, handleLoadingChange);

    return () => {
      onlyofficeEventbus.off(
        ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE,
        handleLoadingChange,
      );
      onlyOfficeManagerFactory.destroyAll();
      initializedRef.current.clear();
    };
  }, []);

  const addTab = (docKind: DocKind) => {
    const nextTab = createTab(tabs.length + 1, docKind);
    setTabs((prev) => [...prev, nextTab]);
    setActiveId(nextTab.id);
  };

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) return;

    const tab = tabs.find((item) => item.id === tabId);
    if (tab) {
      onlyOfficeManagerFactory.destroy(tab.containerId);
      initializedRef.current.delete(tab.id);
    }

    setTabs((prev) => {
      const next = prev.filter((item) => item.id !== tabId);
      if (activeId === tabId) {
        setActiveId(next[0]?.id ?? "");
      }
      return next;
    });
  };

  const ensureActiveManager = async () => {
    if (!activeTab) throw new Error("No active tab");

    if (!initializedRef.current.has(activeTab.id)) {
      await openTabEditor(activeTab);
    }

    const manager = onlyOfficeManagerFactory.get(activeTab.containerId);
    if (!manager) throw new Error("Editor is not initialized");
    return manager;
  };

  const uploadFile = (file: File) =>
    runAction(async () => {
      if (!activeTab) return;

      const preset = getPreset(activeTab.docKind);

      await onlyOfficeManagerFactory.open(
        {
          containerId: activeTab.containerId,
          fileType: preset.fileType,
          defaultFileName: preset.defaultFileName,
          readOnly: activeTab.readOnly,
          theme,
        },
        {
          fileName: file.name,
          file,
          readOnly: activeTab.readOnly,
        },
      );

      initializedRef.current.add(activeTab.id);
      updateTab(activeTab.id, { fileName: file.name });
    }, "上传失败");

  const newDocument = () =>
    runAction(async () => {
      if (!activeTab) return;

      const preset = getPreset(activeTab.docKind);

      await onlyOfficeManagerFactory.open(
        {
          containerId: activeTab.containerId,
          fileType: preset.fileType,
          defaultFileName: preset.defaultFileName,
          readOnly: activeTab.readOnly,
          theme,
        },
        {
          fileName: preset.defaultFileName,
          isNew: true,
          readOnly: activeTab.readOnly,
        },
      );

      initializedRef.current.add(activeTab.id);
      updateTab(activeTab.id, { fileName: preset.defaultFileName });
    }, "新建失败");

  const exportDocument = () =>
    runAction(async () => {
      const manager = await ensureActiveManager();
      await manager.downloadExport();
    }, "导出失败");

  const toggleReadOnly = () =>
    runAction(async () => {
      if (!activeTab) return;

      const preset = getPreset(activeTab.docKind);
      const manager = await ensureActiveManager();
      const nextReadOnly = !activeTab.readOnly;

      if (manager.isReady()) {
        await manager.setReadOnly(nextReadOnly);
      } else {
        await onlyOfficeManagerFactory.open(
          {
            containerId: activeTab.containerId,
            fileType: preset.fileType,
            defaultFileName: preset.defaultFileName,
            readOnly: nextReadOnly,
            theme,
          },
          {
            fileName: activeTab.fileName,
            isNew: isNewDocument(activeTab),
            readOnly: nextReadOnly,
          },
        );
      }

      updateTab(activeTab.id, { readOnly: nextReadOnly });
    }, "切换模式失败");

  const applyTheme = (nextTheme: OfficeTheme) =>
    runAction(async () => {
      setTheme(nextTheme);

      await Promise.all(
        tabs.map(async (tab) => {
          if (!initializedRef.current.has(tab.id)) return;

          const manager = onlyOfficeManagerFactory.get(tab.containerId);
          if (manager?.isReady()) {
            await manager.setTheme(nextTheme);
          }
        }),
      );
    }, "切换主题失败");

  return (
    <div
      className={`flex flex-col bg-neutral-100 ${
        embedded ? "h-full min-h-0" : "h-screen"
      }`}
    >
      <header className={demoHeaderClass}>
        <div className={demoHeaderInnerClass}>
          <div className="mr-auto min-w-0">
            <h1 className={demoTitleClass}>{embedded ? "示例" : "多实例"}</h1>
            <p className={demoSubtitleClass}>
              {activeTab
                ? `${activePreset?.label} · ${activeTab.fileName}`
                : "切换标签页，实例状态会保留"}
            </p>
          </div>

          <div className={demoToolbarClass}>
            <DemoField label="主题">
              <DemoSelect
                value={theme}
                onChange={(event) =>
                  applyTheme(event.target.value as OfficeTheme)
                }
              >
                {OFFICE_THEME_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </DemoSelect>
            </DemoField>
            <DemoButton onClick={() => fileInputRef.current?.click()}>
              上传
            </DemoButton>
            <DemoButton onClick={newDocument}>
              新建{activePreset?.label ?? "文档"}
            </DemoButton>
            <DemoButton onClick={exportDocument}>导出</DemoButton>
            <DemoButton active={!!activeTab?.readOnly} onClick={toggleReadOnly}>
              {activeTab?.readOnly ? "只读" : "编辑"}
            </DemoButton>
          </div>
        </div>

        <div className="border-t border-neutral-200/80 bg-[#f5f4f3] px-2 py-1">
          <div className="flex items-end gap-0.5 overflow-x-auto">
            {tabs.map((tab) => {
              const preset = getPreset(tab.docKind);
              const isActive = activeId === tab.id;
              return (
                <div
                  key={tab.id}
                  className={`group relative flex max-w-[200px] min-w-[88px] shrink-0 items-stretch border border-b-0 ${
                    isActive
                      ? "z-10 -mb-px border-neutral-300 bg-white"
                      : "border-transparent hover:bg-white/50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(tab.id)}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-[12px] ${
                      isActive ? "text-neutral-900" : "text-neutral-500"
                    }`}
                    title={tab.fileName}
                  >
                    <span className="shrink-0 text-[11px] text-neutral-400">
                      {preset.badge}
                    </span>
                    <span className="truncate">{tab.label}</span>
                  </button>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => closeTab(tab.id)}
                      className={`mr-1 self-center rounded px-1 text-[10px] transition-colors ${
                        isActive
                          ? "text-gray-400 hover:text-gray-600"
                          : "text-gray-300 opacity-0 hover:text-gray-500 group-hover:opacity-100"
                      }`}
                      aria-label={`关闭 ${tab.label}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}

            <div className="mb-px flex shrink-0 items-center gap-1 pl-1.5">
              {(Object.keys(DOC_PRESETS) as DocKind[]).map((kind) => {
                const preset = getPreset(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => addTab(kind)}
                    className="inline-flex h-7 items-center border border-dashed border-neutral-300 bg-transparent px-2 text-[12px] text-neutral-600 hover:border-neutral-400 hover:bg-white"
                    title={`新建 ${preset.label} 标签页`}
                  >
                    + {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-4 rounded border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
            加载中...
          </div>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${
              activeId === tab.id ? "visible z-10" : "invisible z-0"
            }`}
          >
            <OnlyOfficeTabHost containerId={tab.containerId} />
          </div>
        ))}

        {loading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70 backdrop-blur-sm">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow">
              加载中...
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={activePreset?.accept ?? ".docx,.doc,.odt,.rtf,.txt"}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            uploadFile(file);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        }}
      />
    </div>
  );
}
```
