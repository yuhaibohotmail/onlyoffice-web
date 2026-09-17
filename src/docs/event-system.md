# Event System

> English | [中文](event-system.zh.md)

[← Core API](./core-api.md) | [Full Examples →](./full-examples.md)

OnlyOffice Web Comp uses an EventBus for cross-module event communication.

## Event Types

```typescript
import { ONLYOFFICE_EVENT_KEYS } from "@/components/onlyoffice-web-comp";

ONLYOFFICE_EVENT_KEYS.SAVE_DOCUMENT   // 'saveDocument' - document save/export completed
ONLYOFFICE_EVENT_KEYS.DOCUMENT_READY  // 'documentReady' - document is ready
ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE  // 'loadingChange' - loading state changed
ONLYOFFICE_EVENT_KEYS.ONSAVE          // 'onSave' - editor onSave flow completed (lightweight notification)
ONLYOFFICE_EVENT_KEYS.OFFICE_XML_SIZE_LIMIT_EXCEEDED // 'officeXmlSizeLimitExceeded' - decompressed Office XML size exceeds the limit
```

### Event Descriptions

| Event | When it fires | Typical use |
|------|----------|----------|
| `SAVE_DOCUMENT` | Export/save completed; `export()` waits for this event | Get `binData`, upload to the server |
| `DOCUMENT_READY` | The document inside the editor iframe has finished loading | Initialize comments/revisions, hide the skeleton screen |
| `LOADING_CHANGE` | Long operations such as `setReadOnly` and `export` | Global loading UI |
| `ONSAVE` | The save callback has notified the editor (after `asc_onSaveCallback`) | Show a "saved" message when `binData` is not needed |
| `OFFICE_XML_SIZE_LIMIT_EXCEEDED` | With `officeXmlEvent` enabled, the XML package content inside an Office ZIP exceeds the threshold after decompression; intercepted before x2t conversion | Report risky files, show a custom error message |

Both `SAVE_DOCUMENT` and `ONSAVE` fire during a single save flow: the former carries the full binary data, the latter carries only `fileName` and `instanceId`.

## Listening for Events

```typescript
import {
  onlyofficeEventbus,
  ONLYOFFICE_EVENT_KEYS,
} from "@/components/onlyoffice-web-comp";

onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.DOCUMENT_READY, (data) => {
  console.log("文档已准备就绪:", data.fileName);
  // data: { fileName, fileType, instanceId? }
});

onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.SAVE_DOCUMENT, (data) => {
  console.log("文档已保存:", data.fileName);
  // data: { fileName, fileType, binData, instanceId, media? }

  if (data.instanceId === manager.getEditor().getInstanceId()) {
    // Multiple instances: handle only the current instance
  }
});

onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.ONSAVE, (data) => {
  console.log("保存流程完成:", data.fileName);
  // data: { fileName, instanceId }
});

onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, (data) => {
  setLoading(data.loading);
});

onlyofficeEventbus.on(
  ONLYOFFICE_EVENT_KEYS.OFFICE_XML_SIZE_LIMIT_EXCEEDED,
  (data) => {
    console.warn(data.errorDescription, data.fileName);
    // data: { fileName, fileType, errorDescription, xmlBytes, limitBytes, entryCount, instanceId, containerId }
  },
);
```

### Listening for Loading via `OnlyOfficeManager`

```typescript
const unsubscribe = manager.onLoadingChange(({ loading }) => {
  setLoading(loading);
});

// When the component unmounts
unsubscribe();
```

## Waiting for Events

`waitFor` returns a Promise; the second argument is the timeout in milliseconds, **default 30000**:

```typescript
const readyData = await onlyofficeEventbus.waitFor(
  ONLYOFFICE_EVENT_KEYS.DOCUMENT_READY,
  10000,
);

const saveData = await onlyofficeEventbus.waitFor(
  ONLYOFFICE_EVENT_KEYS.SAVE_DOCUMENT,
  10000,
);
```

Related constants:

| Constant | Value | Description |
|------|-----|------|
| `waitFor` default timeout | 30000 ms | When the second argument is not passed |
| `READONLY_SWITCH_MIN_DELAY_MS` | 200 ms | Minimum time loading is shown when switching read-only mode, to prevent flicker |

## Loading State Management

`LOADING_CHANGE` fires automatically during operations such as export and read-only switching:

```typescript
import { useEffect, useState } from "react";
import {
  onlyofficeEventbus,
  ONLYOFFICE_EVENT_KEYS,
} from "@/components/onlyoffice-web-comp";

function EditorPage() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleLoadingChange = (data: { loading: boolean }) => {
      setLoading(data.loading);
    };

    onlyofficeEventbus.on(
      ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE,
      handleLoadingChange,
    );

    return () => {
      onlyofficeEventbus.off(
        ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE,
        handleLoadingChange,
      );
    };
  }, []);

  return <div>{loading && <Loading />}</div>;
}
```

**Note:** `editorManager.setReadOnly()` and `export()` trigger `LOADING_CHANGE`; in read-only mode `export()` does not go through the editor's save, so it usually does not prolong loading.

## SDK-Level Callbacks (Complementary to the EventBus)

The Word API inside the editor iframe supports `asc_registerCallback`, wrapped by `EditorManager.subscribe()`. For common callback names see `AscWordApiMethod`, for example:

- `asc_onAddComment` / `asc_onChangeCommentData` / `asc_onRemoveComment` — comment changes
- `asc_onShowRevisionsChange` — revision list changes
- `asc_onDocumentModifiedChanged` — document modified state

See [Comments, Revisions, and Word API](./comments-revisions-word-api.md) for details.

## Removing Listeners

```typescript
const handler = (data: unknown) => {
  console.log("事件触发:", data);
};

onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.DOCUMENT_READY, handler);
onlyofficeEventbus.off(ONLYOFFICE_EVENT_KEYS.DOCUMENT_READY, handler);
```

The unsubscribe function returned by `EditorManager.subscribe()` is used to cancel SDK callbacks and is independent of the EventBus `off`.
