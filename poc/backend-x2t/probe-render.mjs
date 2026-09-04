/**
 * 第二问：**排版这一半能不能也搬到后端。**
 *
 * run.mjs 已经量出来 x2t.wasm 一个人出不了 PDF（rc=80）。原因不是「不会写 PDF」
 * ——wasm 里有 CPdfFile / PdfWriter——而是**排版引擎不在里面**：它是 sdkjs，
 * 一份 JavaScript。OnlyOffice 自己是拿一个叫 doctrenderer 的东西跑它（内嵌 V8）。
 * 而 Node 本来就是 V8，所以这条路值得当场试一次，不该靠推理下结论。
 *
 * 这个脚本就是那一次实测。它一步步走到底，每一步印出来：
 *   xregexp → native.js（无头 DOM 垫片）→ AllFonts.js
 *   → sdk-all-min.js（API 层）→ sdk-all.js（模型与排版层）
 *   → libfont（FreeType 的 wasm）
 *   → 建 api → 开 Editor.bin → 排版 → 取 PDF 命令流 → 交给 x2t.wasm 写成 PDF
 *
 * **今天走到「排版」那一步为止**：文档开得开，字体引擎起得来，卡在给字体建 face
 * （`m_pFaceInfo` 是 null，说明排版要的那几个字体没被装进引擎）。
 * 卡在哪、还差什么，见 README「第二段：排版」。
 *
 * ⚠ 这里面有三处不改就走不动、而报错都指向别处的地方，各自就地写了注释：
 * 两个 bundle 是**互补的两半**不是新旧两版、native.js 把 setTimeout 换成了空函数、
 * fonts.js 那个闭包收不到外面设的 Module。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { convert, AVS } from "./x2t-node.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VER = "9.4.0.129";
const BASE = path.join(ROOT, "vendor/onlyoffice", VER);
const SDK = path.join(BASE, "sdkjs");
const WEBAPPS = path.join(BASE, "web-apps");
const FONTS = path.join(BASE, "fonts");
const ENGINE = path.join(SDK, "common/libfont/engine");

const docx = fs.readFileSync(path.join(ROOT, "fixtures/lesson-plan-zh.docx"));
const binResult = await convert({
  data: docx,
  fileFrom: "in.docx",
  fileTo: "Editor.bin",
  formatFrom: AVS.DOCX,
  formatTo: AVS.CANVAS_WORD,
});
console.log(`x2t: docx → Editor.bin  ${binResult.ok ? "✓" : "✗"}  ${binResult.output?.length} 字节\n`);

const fontsRead = [];
const nativeStub = new Proxy(
  {
    GetEditorType: () => "document",
    GetDevicePixelRatio: () => 1,
    ConsoleLog: () => {},
    // 字体：doctrenderer 里这一格是 C++ 给的，我们从盘上读。
    // Id 就是 fonts/ 下那个文件名（"000"…"244"），AllFonts.js 里那张表给的。
    GetFontBinary: (id) => {
      fontsRead.push(String(id));
      return new Uint8Array(fs.readFileSync(path.join(FONTS, String(id))));
    },
  },
  {
    get: (t, k) => (k in t ? t[k] : typeof k === "string" ? () => undefined : undefined),
    has: () => true,
  },
);

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {}, time: () => {}, timeEnd: () => {} },
  TextDecoder,
  TextEncoder,
  Promise,
  URL,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  performance,
  native: nativeStub,
  XMLHttpRequest: function () {},
  navigator: { userAgent: "chrome", language: "en-US", platform: "Win32" },
  location: { protocol: "http:", host: "", href: "", pathname: "", search: "" },
  // ⚠ 藏掉 instantiateStreaming：fonts.js 见到它就走流式那条路，
  // 而我们那个假 fetch 回的不是真 Response。
  WebAssembly: {
    Module: WebAssembly.Module,
    Instance: WebAssembly.Instance,
    Memory: WebAssembly.Memory,
    Table: WebAssembly.Table,
    RuntimeError: WebAssembly.RuntimeError,
    compile: WebAssembly.compile,
    instantiate: WebAssembly.instantiate,
    validate: WebAssembly.validate,
  },
  /**
   * fonts.js 那份 Emscripten 胶水整个包在一个闭包里，里面那句
   * `var Module = typeof Module != "undefined" ? Module : {}` 读的是**函数内**那个
   * 还没赋值的 Module，所以在外面设 Module.wasmBinary 传不进去（试过，无效）。
   * 它又硬写着 ENVIRONMENT_IS_WEB = true，只会走 fetch，那就给它一个读盘的 fetch。
   */
  fetch: (url) => {
    const name = String(url).split("/").pop().split("?")[0];
    const bytes = fs.readFileSync(path.join(ENGINE, name));
    return Promise.resolve({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
    });
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const runFile = (file, label) => {
  const t0 = Date.now();
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: label }).runInContext(ctx);
    console.log(`✓ ${label.padEnd(34)} ${String(Date.now() - t0).padStart(5)}ms`);
  } catch (err) {
    console.log(`✗ ${label.padEnd(34)} ${String(Date.now() - t0).padStart(5)}ms  ${err.message}`);
  }
};

runFile(path.join(WEBAPPS, "vendor/xregexp/xregexp-all-min.js"), "xregexp");
runFile(path.join(SDK, "common/Native/native.js"), "native.js");
runFile(path.join(SDK, "common/Native/jquery_native.js"), "jquery_native.js");
runFile(path.join(SDK, "common/AllFonts.js"), "AllFonts.js");
// ⚠ **这两个文件是互补的两半，不是「压缩版」和「未压缩版」。** 名字骗人：
// sdk-all-min.js 里根本没压缩过，它装的是 API 层（asc_docs_api、AscBrowser、392 个
// LCID 常量）；sdk-all.js 装的是模型与排版层（CDocument、CMemory、CDocumentRenderer）。
// 只加载其中一个都能「成功」，然后在用到对方的东西时才报一句不相干的错
// （少了后者报 `AscCommon.History` 未定义，少了前者报 `lcid_enUS is not defined`）。
runFile(path.join(SDK, "word/sdk-all-min.js"), "sdk-all-min.js（API 层）");
runFile(path.join(SDK, "word/sdk-all.js"), "sdk-all.js（模型与排版层）");

// ⚠ native.js 把 setTimeout/setInterval 全换成了空函数（doctrenderer 里是同步跑的）。
// Emscripten 的启动收尾要过一次 setTimeout，被吃掉之后 wasm 永远初始化不完，
// 而报错是「_ASC_FT_Init is not a function」——那句话指着字体引擎，不指着这里。
Object.assign(sandbox, { setTimeout, clearTimeout, setInterval, clearInterval });
// native.js 里那个 console.error 引用了一个不存在的变量 param，一调用就 ReferenceError。
sandbox.console = { log: () => {}, warn: () => {}, error: () => {}, time: () => {}, timeEnd: () => {} };

runFile(path.join(ENGINE, "fonts.js"), "libfont/fonts.js");

// 判据取「真的调得动」，不取 typeof——Emscripten 那个惰性壳在 wasm 起来之前
// typeof 就已经是 function 了，调下去才报 `_ASC_FT_Init is not a function`。
const fontEngineReady = async () => {
  for (let i = 0; i < 200; i++) {
    try {
      const lib = sandbox.AscFonts.FT_CreateLibrary();
      sandbox.AscFonts.FT_Done_Library?.(lib);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return false;
};
console.log("字体引擎起来了吗:", (await fontEngineReady()) ? "是" : "否");
try {
  sandbox.immediateRun?.();
} catch {
  /* 队列已经清空过一次，再跑一次会撞空 */
}

sandbox.__bin = binResult.output;
const step = (label, code) => {
  const t0 = Date.now();
  try {
    const out = vm.runInContext(code, ctx, { filename: label });
    console.log(`✓ ${label.padEnd(30)} ${String(Date.now() - t0).padStart(6)}ms  →`, out);
    return out;
  } catch (err) {
    console.log(`✗ ${label.padEnd(30)} ${String(Date.now() - t0).padStart(6)}ms  ${err.message}`);
    return null;
  }
};

console.log("");
step("NativeCreateApi", `NativeCreateApi({}); __api = Api; NATIVE_DOCUMENT_TYPE`);
step("asc_nativeOpenFile", `__api["asc_nativeOpenFile"](__bin, "9.4.0"); "opened"`);
step("asc_nativeCalculateFile", `__api["asc_nativeCalculateFile"](); "calculated"`);
const pages = step("asc_nativePrintPagesCount", `__api["asc_nativePrintPagesCount"]()`);
step(
  "asc_nativeGetPDF",
  `__pdfbin = __api["asc_nativeGetPDF"]({}); __pdfbin ? __pdfbin.length : String(__pdfbin)`,
);

console.log("\n字体读到:", fontsRead.length, "个 →", fontsRead.slice(0, 10).join(","));

if (!(pages > 0)) {
  console.log(
    "\n结论：**排版没跑完，所以页数是 0**。asc_nativeGetPDF 仍然回了一段缓冲区，\n" +
      "但那是空的命令流——**「有返回值」在这儿不等于「画出来了」**，判据要取页数。\n" +
      "到这一步为止立得住的是：整套编辑器内核（两个 bundle 合计 32 MB JS）与那个\n" +
      "FreeType 的 wasm 都在 Node 里跑起来了，Editor.bin 也读进了文档模型。\n" +
      "还差的是把排版要用的字体真正装进引擎——见 README「第二段：排版」。",
  );
}

const pdfBin = sandbox.__pdfbin;
if (pdfBin && pages > 0) {
  const bytes = Buffer.from(pdfBin.buffer ?? pdfBin, pdfBin.byteOffset ?? 0, pdfBin.length);
  fs.writeFileSync(path.join(ROOT, "out/poc-pdf.bin"), bytes);
  const out = await convert({
    data: binResult.output,
    fileFrom: "output.bin",
    fileTo: "output.pdf",
    pdfFonts: true,
    pdfBinBytes: bytes,
  });
  console.log(
    "\nx2t: 命令流 → PDF：",
    out.ok ? `✓ ${out.output.length} 字节` : `✗ rc=${out.rc} ${out.error}`,
  );
  if (out.ok) fs.writeFileSync(path.join(ROOT, "out/poc-backend.pdf"), out.output);
}
