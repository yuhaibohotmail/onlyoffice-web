/**
 * 在 Node 里把 x2t.wasm 跑起来的驱动。
 *
 * 浏览器那一侧的同一件事写在 `src/onlyoffice-web-comp/internal/editor/x2t.worker.ts`，
 * 这里是**照着它改的 Node 版**，刻意保持同一套步骤（写 params.xml → ccall main1 → 读产物），
 * 好让「浏览器能转的它也能转吗」这个问题的答案不掺进别的变量。
 *
 * 与浏览器那份的三处差别，都是环境逼出来的，不是我们想改：
 *  1. 胶水脚本用 CommonJS 包一层再 require 进来（浏览器那边是 eval 进 worker 全局）。
 *     包起来的原因是脚本里那句 `var Module;`——它在模块作用域里是局部变量，
 *     我们在外面设的 Module 根本传不进去。包成函数参数，那句声明就变成无操作。
 *  2. wasm 是 brotli 压过的（盘上 6.8 MB，解开 36 MB），用 node:zlib 解。
 *     浏览器那边走的是 DecompressionStream。**这一步不做的话报错指向 wasm 本身**
 *     （「expected magic word 00 61 73 6d」），看着像文件坏了。
 *  3. 字体直接从盘上读，不走 HTTP。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

export const X2T_DIR = path.join(PROJECT_ROOT, "vendor/x2t");
export const X2T_FONTS_DIR = path.join(PROJECT_ROOT, "vendor/x2t-fonts");

/** AvsFileType 里这次用得到的那些。取自 types.ts，值不许在这儿另编一套。 */
export const AVS = {
  UNKNOWN: 0x0000,
  DOCX: 0x0040 + 0x0001,
  DOC: 0x0040 + 0x0002,
  ODT: 0x0040 + 0x0003,
  RTF: 0x0040 + 0x0004,
  TXT: 0x0040 + 0x0005,
  HTML: 0x0040 + 0x0006,
  EPUB: 0x0040 + 0x0008,
  FB2: 0x0040 + 0x0009,
  PPTX: 0x0080 + 0x0001,
  ODP: 0x0080 + 0x0003,
  XLSX: 0x0100 + 0x0001,
  ODS: 0x0100 + 0x0003,
  CSV: 0x0100 + 0x0004,
  PDF: 0x0200 + 0x0001,
  PDFA: 0x0200 + 0x0009,
  IMAGE_PNG: 0x0400 + 0x0005,
  IMAGE_JPG: 0x0400 + 0x0001,
  CANVAS_WORD: 0x2000 + 0x0001,
  CANVAS_SPREADSHEET: 0x2000 + 0x0002,
  CANVAS_PRESENTATION: 0x2000 + 0x0003,
  CANVAS_PDF: 0x2000 + 0x0004,
};

/**
 * 导出 PDF 时 x2t 会按哪些名字来要字体。
 * **这份表是从 `src/onlyoffice-web-comp/const/index.ts` 的 X2T_PDF_FONT_MANIFEST 抄的**——
 * PoC 阶段先抄，真要落地时应当从那一处 import，别留两份。
 */
const PDF_FONT_MANIFEST = [
  { file: "Carlito-Regular.ttf", aliases: ["Carlito.ttf", "Calibri.ttf"] },
  { file: "Carlito-Bold.ttf", aliases: ["Carlito_Bold.ttf", "Calibri_Bold.ttf"] },
  { file: "Carlito-Italic.ttf", aliases: ["Carlito_Italic.ttf", "Calibri_Italic.ttf"] },
  {
    file: "Carlito-BoldItalic.ttf",
    aliases: ["Carlito_Bold_Italic.ttf", "Calibri_Bold_Italic.ttf"],
  },
  { file: "LiberationSans-Regular.ttf", aliases: ["Arial.ttf", "Liberation Sans.ttf"] },
  { file: "LiberationSans-Bold.ttf", aliases: ["Arial_Bold.ttf", "Liberation Sans_Bold.ttf"] },
  {
    file: "LiberationSans-Italic.ttf",
    aliases: ["Arial_Italic.ttf", "Liberation Sans_Italic.ttf"],
  },
  {
    file: "LiberationSans-BoldItalic.ttf",
    aliases: ["Arial_Bold_Italic.ttf", "Liberation Sans_Bold_Italic.ttf"],
  },
  {
    file: "DroidSansFallback.ttf",
    aliases: [
      "Droid Sans Fallback.ttf",
      "SimSun.ttf",
      "NSimSun.ttf",
      "宋体.ttf",
      "Microsoft YaHei.ttf",
      "微软雅黑.ttf",
      "PingFang SC.ttf",
    ],
  },
];

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function decompressIfNeeded(buffer) {
  const isRawWasm = WASM_MAGIC.every((byte, index) => buffer[index] === byte);
  return isRawWasm ? buffer : zlib.brotliDecompressSync(buffer);
}

let modulePromise = null;

/**
 * x2t 自己 printf 出来的东西落这儿。
 *
 * ⚠ **刻意做成模块级的一个筐，不做成 loadX2t 的参数。** 参数版写过一版：
 * 运行时只加载一次，于是 print 回调闭包捕获的永远是第一次那个数组，
 * 后面每次转换传进来的新数组一个字都收不到——**而它的样子是「x2t 一声不吭就失败了」**，
 * 人会去查 x2t，该查的是这几行。
 */
const stdioSink = [];

/**
 * 加载并初始化 x2t 运行时。重复调用复用同一个实例——
 * 与浏览器那边的 worker 一样，一个进程里只养一份。
 */
export function loadX2t() {
  if (modulePromise) return modulePromise;

  const glueSource = fs.readFileSync(path.join(X2T_DIR, "x2t.js"), "utf8");
  const wasmBinary = decompressIfNeeded(fs.readFileSync(path.join(X2T_DIR, "x2t.wasm")));

  const wrapperPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "x2t-node-")),
    "x2t-wrapper.cjs",
  );
  fs.writeFileSync(
    wrapperPath,
    `module.exports = function (Module) {\n${glueSource}\n;return Module;\n};\n`,
  );

  modulePromise = new Promise((resolve, reject) => {
    const Module = {
      wasmBinary,
      noInitialRun: true,
      noExitRuntime: true,
      print: (line) => stdioSink.push(`[out] ${line}`),
      printErr: (line) => stdioSink.push(`[err] ${line}`),
      onAbort: (reason) => reject(new Error(`x2t aborted: ${reason}`)),
      onRuntimeInitialized: () => {
        for (const dir of ["/working", "/working/media", "/working/fonts", "/working/themes"]) {
          try {
            Module.FS.mkdir(dir);
          } catch {
            /* 已存在 */
          }
        }
        resolve(Module);
      },
    };
    try {
      require(wrapperPath)(Module);
    } catch (err) {
      reject(err);
    }
  });

  return modulePromise;
}

/**
 * 把抛出来的东西说清楚。
 *
 * Emscripten 的 FS 抛的不是 Error，是个带 errno/code 的普通对象——
 * 直接 String() 得到的是 `[object Object]`，**一个字的线索都没有**。
 */
function describeError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (err && typeof err === "object") {
    const parts = [err.name ?? err.constructor?.name ?? "Object"];
    if (err.message) parts.push(err.message);
    for (const key of ["errno", "code", "path"]) {
      if (err[key] != null) parts.push(`${key}=${err[key]}`);
    }
    return parts.join(" ");
  }
  return String(err);
}

function rmTree(Module, dir) {
  let entries;
  try {
    entries = Module.FS.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "." || entry === "..") continue;
    const child = `${dir}/${entry}`;
    const stat = Module.FS.stat(child);
    if (Module.FS.isDir(stat.mode)) {
      rmTree(Module, child);
      Module.FS.rmdir(child);
    } else {
      Module.FS.unlink(child);
    }
  }
}

let fontsWritten = false;

/** 把 PDF 导出要用的字体铺进 /working/fonts/，包括 x2t 会按别名去找的那些副本。 */
function ensurePdfFonts(Module) {
  if (fontsWritten) return;
  for (const { file, aliases } of PDF_FONT_MANIFEST) {
    const bytes = fs.readFileSync(path.join(X2T_FONTS_DIR, file));
    for (const name of [file, ...aliases]) {
      Module.FS.writeFile(`/working/fonts/${name}`, bytes);
    }
  }
  fontsWritten = true;
}

/**
 * 跑一次转换。
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array} [opts.data] 源文件字节；不给则要求 fileFrom 已在 FS 里
 * @param {string} opts.fileFrom  工作目录内的源文件名（含扩展名，x2t 认它）
 * @param {string} opts.fileTo    工作目录内的目标文件名
 * @param {number} [opts.formatFrom]
 * @param {number} [opts.formatTo]
 * @param {boolean} [opts.pdfFonts] 目标是 PDF 时要铺字体
 * @returns {{ok:boolean, output?:Buffer, media:Record<string,Buffer>, ms:number, stderr:string[], error?:string}}
 */
export async function convert({
  data,
  fileFrom,
  fileTo,
  formatFrom,
  formatTo,
  pdfBinBytes,
  csv = false,
  pdfFonts = false,
  keepWorking = false,
}) {
  const Module = await loadX2t();
  stdioSink.length = 0;

  const fromPath = `/working/${fileFrom}`;
  const toPath = `/working/${fileTo}`;

  if (pdfFonts) ensurePdfFonts(Module);

  /**
   * 走不走「命令流」那条路。
   *
   * ⚠ **这两种是两件不同的事，别混。** 不给命令流时是「你自己把它排版成 PDF」，
   * 而这份 wasm 里根本没有排版引擎，所以那条路必然失败（rc=80，见 README）。
   * 给了命令流则是「排版已经做完了，你只管把这些画图指令写成 PDF」，
   * 那一半 wasm 里是有的（CPdfFile / PdfWriter）。
   * 照浏览器那份 worker 的写法：走命令流时**不传格式号**，且 m_bIsNoBase64 反过来。
   */
  const usePdfBin = Boolean(pdfBinBytes?.length);
  if (usePdfBin) {
    Module.FS.writeFile("/working/pdf.bin", new Uint8Array(pdfBinBytes));
  } else {
    try {
      if (Module.FS.analyzePath("/working/pdf.bin").exists) Module.FS.unlink("/working/pdf.bin");
    } catch {
      /* 没有就算了 */
    }
  }

  const params = {
    m_sFileFrom: fromPath,
    m_sFileTo: toPath,
    m_sThemeDir: "/working/themes",
    m_sFontDir: "/working/fonts/",
    m_bIsNoBase64: !usePdfBin,
  };
  if (!usePdfBin) {
    if (formatFrom !== undefined) params.m_nFormatFrom = formatFrom;
    if (formatTo !== undefined) params.m_nFormatTo = formatTo;
  }
  if (formatTo === AVS.PDFA) params.m_bIsPDFA = true;
  /**
   * ⚠ csv 源必须补编码与分隔符两个参数。不给的话 x2t **退出码 0、什么都不产出**
   * ——FINDINGS 第十一节记的两个坑之一，它的样子是「这个格式转不了」。
   * 46 = UTF-8，4 = 逗号，与浏览器那份 worker 的默认值一致。
   */
  if (csv) {
    params.m_nCsvTxtEncoding = 46;
    params.m_nCsvDelimiter = 4;
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
>
${Object.entries(params)
  .map(([k, v]) => `<${k}>${v}</${k}>`)
  .join("\n")}
</TaskQueueDataConvert>`;

  Module.FS.writeFile("/working/params.xml", xml);
  if (data) Module.FS.writeFile(fromPath, new Uint8Array(data));

  try {
    if (Module.FS.analyzePath(toPath).exists) Module.FS.unlink(toPath);
  } catch {
    /* 没有就算了 */
  }

  const started = process.hrtime.bigint();
  let rc = null;
  let thrown = null;
  try {
    rc = Module.ccall("main1", "number", ["string"], ["/working/params.xml"]);
  } catch (err) {
    thrown = describeError(err);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  let output = null;
  let readError = null;
  try {
    const stat = Module.FS.stat(toPath);
    if (Module.FS.isDir(stat.mode)) {
      // 有些目标格式产出的是一整个目录（例如带媒体的 html）
      output = null;
      readError = "产物是目录不是文件";
    } else {
      output = Buffer.from(Module.FS.readFile(toPath));
    }
  } catch (err) {
    readError = describeError(err);
  }

  const media = {};
  try {
    for (const name of Module.FS.readdir("/working/media/")) {
      if (name === "." || name === "..") continue;
      media[name] = Buffer.from(Module.FS.readFile(`/working/media/${name}`));
    }
  } catch {
    /* 没有媒体 */
  }

  if (!keepWorking) {
    for (const p of [fromPath, toPath, "/working/params.xml", "/working/pdf.bin"]) {
      try {
        const stat = Module.FS.stat(p);
        if (Module.FS.isDir(stat.mode)) {
          rmTree(Module, p);
          Module.FS.rmdir(p);
        } else {
          Module.FS.unlink(p);
        }
      } catch {
        /* 没有就算了 */
      }
    }
    rmTree(Module, "/working/media");
    rmTree(Module, "/working/themes");
  }

  return {
    ok: Boolean(output && output.length),
    rc,
    output,
    media,
    ms,
    stderr: stdioSink.slice(),
    error: thrown ?? readError ?? null,
  };
}
