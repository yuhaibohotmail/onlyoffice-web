import { STATIC_RESOURCE, getOnlyOfficePreloadPage, getOnlyOfficePreloadUrl } from "../const";
import { DocumentType } from "../internal/editor/types";

let initializePromise: Promise<void> | null = null;
let initializeApiUrl = "";

type DocsApiWindow = Window & {
  DocsAPI?: unknown;
};

function resetLoadedDocsApi(apiUrl: string) {
  if (!initializeApiUrl || initializeApiUrl === apiUrl) {
    return;
  }

  document
    .querySelectorAll<HTMLScriptElement>(
      'script[src*="/web-apps/apps/api/documents/api.js"]',
    )
    .forEach((script) => script.remove());
  document
    .querySelectorAll<HTMLIFrameElement>("iframe[data-onlyoffice-preload]")
    .forEach((iframe) => iframe.remove());

  try {
    delete (window as DocsApiWindow).DocsAPI;
  } catch {
    (window as DocsApiWindow).DocsAPI = undefined;
  }
}

/**
 * 挂编辑器之前先塞一个隐藏 iframe 把 SDK 拉进缓存。
 *
 * ⚠ **只预热这一种文档要用的那个编辑器。** 上游那份 `preload.html` 是四个一起拉的
 * （word / cell / slide / visio 的 `sdk-all.js` 各 22–31 MB，外加各自的引导包与样式），
 * 与这次打开的是什么文档无关；一份 docx 冷载因此多下约 90 MB。
 * 那几份按类型分开的页面由 `scripts/build-preload-pages.mjs` 生成。
 *
 * 一个页面只塞一次，判据是 `data-onlyoffice-preload` 上那个值——所以先开 docx
 * 再开 xlsx 时会**再塞一个**，那是对的：第二种文档的 SDK 也该提前拉。
 */
function preloadEditorFrame(documentType?: DocumentType) {
  const page = getOnlyOfficePreloadPage(documentType);
  if (document.querySelector(`iframe[data-onlyoffice-preload="${page}"]`)) {
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.src = getOnlyOfficePreloadUrl(documentType);
  iframe.dataset.onlyofficePreload = page;
  iframe.className = "w-0 h-0 hidden absolute -z-10";
  document.body.appendChild(iframe);
}

/**
 * 加载 DocsAPI，并把这次要开的那一种文档的 SDK 提前拉进缓存。
 *
 * `documentType` 可以不传（公开 API 的老用法），那时按 Word 预热
 * ——与 `getDocumentType()` 认不出扩展名时的默认值一致。
 */
export async function initializeOnlyOffice(documentType?: DocumentType) {
  if (typeof window === "undefined") return;

  const apiUrl = STATIC_RESOURCE.onlyoffice.apiUrl;

  if (initializePromise && initializeApiUrl === apiUrl) {
    // DocsAPI 已经在了，但这次可能是另一种文档，那一档的 SDK 还没预热过。
    preloadEditorFrame(documentType);
    return initializePromise;
  }

  if (initializePromise && initializeApiUrl !== apiUrl) {
    initializePromise = null;
  }
  resetLoadedDocsApi(apiUrl);
  initializeApiUrl = apiUrl;

  initializePromise = new Promise<void>((resolve, reject) => {
    preloadEditorFrame(documentType);

    if (window.DocsAPI?.DocEditor) {
      resolve();
      return;
    }

    let script = document.querySelector<HTMLScriptElement>(
      `script[src="${apiUrl}"]`,
    );

    if (!script) {
      script = document.createElement("script");
      script.src = apiUrl;
      document.head.appendChild(script);
    }

    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        initializePromise = null;
        reject(new Error("Failed to load OnlyOffice DocsAPI script"));
      },
      { once: true },
    );
  });

  return initializePromise;
}
