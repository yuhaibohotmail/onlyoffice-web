#!/usr/bin/env node
/**
 * PoC：把 OnlyOffice 那个 wasm 引擎搬到后端跑，看能得到什么、得不到什么。
 *
 * 跑法：`node poc/backend-x2t/run.mjs`（要先 `npm run assets` 与 `npm run x2t`）。
 * 加 `--keep` 把产物留在 `out/poc-backend/` 里。
 *
 * **判据取产物本身。** 而且要取到底：只认「是不是合法 docx」是不够的，
 * fb2 那一格实测就是**转换报成功、文件结构完好、正文一个字都没有**——
 * 只认魔数会给它开绿灯。所以每一格都把正文抠出来数字数。
 *
 * **每一格开一个进程跑**，理由见 convert-once.mjs 的头注释：有的输入会让 wasm
 * 不返回，而同一个进程里没有任何东西打断得了它。
 *
 * 退出码：0 = 与 EXPECT 完全一致；1 = 有格子不一致；2 = 一格都没跑成。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AVS, X2T_DIR, X2T_FONTS_DIR } from "./x2t-node.mjs";
import { extractText, readZipEntries } from "./zip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "out/poc-backend");
const KEEP = process.argv.includes("--keep");
/** 超过这个时间还没回来就当它挂住了。好的那些实测都在 150ms 以内。 */
const TIMEOUT_MS = 25_000;

// ── 判据 ───────────────────────────────────────────────────────────────────

const startsWith = (buf, ascii) =>
  buf.length >= ascii.length && buf.subarray(0, ascii.length).toString("latin1") === ascii;

/**
 * 是不是一份**有内容的** Editor.bin。
 * 魔数取自组件里的 isValidEditorBin；那 64 字节的下限是这里加的——
 * fb2 转出来的是 11 字节，魔数对、内容空。
 */
const isEditorBin = (b) =>
  b.length > 64 && ["DOCY", "XLSY", "PPTY"].some((m) => startsWith(b, m));

const isPdf = (b) =>
  startsWith(b, "%PDF-") && b.subarray(-2048).toString("latin1").includes("%%EOF");

const ZIP_ENTRY = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
};

const isOoxml = (b, kind) => {
  const entries = readZipEntries(b);
  return Boolean(entries && entries[ZIP_ENTRY[kind]]);
};

// ── 格式号与分族 ───────────────────────────────────────────────────────────

const FMT = {
  docx: AVS.DOCX, doc: AVS.DOC, odt: AVS.ODT, rtf: AVS.RTF, txt: AVS.TXT,
  html: AVS.HTML, epub: AVS.EPUB, fb2: AVS.FB2,
  xlsx: AVS.XLSX, xls: 0x0100 + 0x0002, ods: AVS.ODS, csv: AVS.CSV,
  pptx: AVS.PPTX, ppt: 0x0080 + 0x0002, odp: AVS.ODP,
  pdf: AVS.PDF,
};

const FAMILY = {
  word: { bin: AVS.CANVAS_WORD, export: "docx", legacy: "doc" },
  cell: { bin: AVS.CANVAS_SPREADSHEET, export: "xlsx", legacy: "xls" },
  slide: { bin: AVS.CANVAS_PRESENTATION, export: "pptx", legacy: "ppt" },
};

const famOf = (ext) =>
  ["xlsx", "xls", "ods", "csv"].includes(ext) ? "cell"
  : ["pptx", "ppt", "odp"].includes(ext) ? "slide"
  : "word";

/**
 * 每一格的预期。**写的是「今天实测就是这样」，不是「应该这样」**——
 * 对不上就红，两个方向都红：好了而没改这里，同样是红。
 *
 * `text` 是产物里至少要有多少个正文字符。写 0 的那三格各有各的原因，
 * 在 note 里说清楚，别让「0」看起来都一样。
 */
const EXPECT = {
  docx: { bin: true, exp: true, text: 100 },
  doc: { bin: true, exp: true, text: 1000 },
  odt: { bin: true, exp: true, text: 100 },
  rtf: { bin: true, exp: true, text: 100 },
  txt: { bin: true, exp: true, text: 100 },
  html: { bin: false, exp: false, text: 0, note: "wasm 挂住不返回" },
  epub: { bin: false, exp: false, text: 0, note: "wasm 读不了" },
  fb2: { bin: false, exp: false, text: 0, note: "转出 11 字节的空壳" },
  pdf: { bin: true, exp: true, text: 100, note: "PDF 转回可编辑 Word" },
  xlsx: { bin: true, exp: true, text: 20 },
  xls: { bin: true, exp: true, text: 100 },
  ods: { bin: true, exp: true, text: 20 },
  csv: { bin: true, exp: true, text: 20 },
  pptx: { bin: true, exp: true, text: 0, note: "夹具本来就是空白页" },
  ppt: { bin: true, exp: true, text: 0, note: "夹具里没有文字" },
  odp: { bin: false, exp: false, text: 0, note: "wasm 读不了" },
};

function collectInputs() {
  const files = [];
  const add = (file) => {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (FMT[ext] === undefined || files.some((f) => f.ext === ext)) return;
    files.push({ ext, file });
  };
  const formatsDir = path.join(ROOT, "fixtures/formats");
  if (fs.existsSync(formatsDir)) {
    for (const name of fs.readdirSync(formatsDir).sort()) add(path.join(formatsDir, name));
  }
  add(path.join(ROOT, "fixtures/lesson-plan-zh.docx"));
  const order = { word: 0, cell: 1, slide: 2 };
  return files.sort(
    (a, b) => order[famOf(a.ext)] - order[famOf(b.ext)] || a.ext.localeCompare(b.ext),
  );
}

// ── 跑一格：单开一个进程，超时就杀 ─────────────────────────────────────────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "poc-x2t-"));
let ran = 0;

function runCell(job) {
  ran++;
  const proc = spawnSync(
    process.execPath,
    [path.join(HERE, "convert-once.mjs"), JSON.stringify(job)],
    { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 1 << 24 },
  );
  if (proc.signal || proc.error?.code === "ETIMEDOUT") return { ok: false, hung: true, bytes: 0 };
  const line = (proc.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) {
    return {
      ok: false,
      bytes: 0,
      error: (proc.stderr ?? "").trim().split("\n").pop() ?? "没有结果行",
    };
  }
  return JSON.parse(line.slice(7));
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const inputs = collectInputs();
if (!inputs.length) {
  console.error("✗ 一份测试文档都没有。先跑 npm run fixtures:formats");
  process.exit(2);
}

const source = JSON.parse(fs.readFileSync(path.join(X2T_DIR, "SOURCE.json"), "utf8"));
console.log("后端跑 x2t.wasm —— 全程没有浏览器参与\n");
console.log("  引擎    ", path.relative(ROOT, X2T_DIR), `（core ${source["基于的core版本"]}）`);
console.log(
  "  解开后  ",
  (zlib.brotliDecompressSync(fs.readFileSync(path.join(X2T_DIR, "x2t.wasm"))).length / 1e6).toFixed(1),
  "MB",
);
console.log("  字体    ", path.relative(ROOT, X2T_FONTS_DIR));
console.log("  Node    ", process.version);
console.log("  每格超时", TIMEOUT_MS / 1000, "秒\n");

fs.mkdirSync(OUT, { recursive: true });

const rows = [];
let mismatched = 0;
const t0 = Date.now();

for (const input of inputs) {
  const fam = FAMILY[famOf(input.ext)];
  const binFile = path.join(scratch, `${input.ext}.bin`);
  process.stdout.write(`  ${input.ext.padEnd(5)} …`);

  const toBin = runCell({
    dataFile: input.file,
    fileFrom: `in.${input.ext}`,
    fileTo: "Editor.bin",
    formatFrom: FMT[input.ext],
    formatTo: fam.bin,
    csv: input.ext === "csv",
    outFile: binFile,
  });
  const binOk = toBin.ok && isEditorBin(fs.readFileSync(binFile));

  let back = { ok: false, bytes: 0 };
  let text = "";
  if (binOk) {
    const expFile = path.join(scratch, `${input.ext}.${fam.export}`);
    back = runCell({
      dataFile: binFile,
      fileFrom: "Editor.bin",
      fileTo: `out.${fam.export}`,
      formatFrom: fam.bin,
      formatTo: FMT[fam.export],
      outFile: expFile,
    });
    if (back.ok) {
      const bytes = fs.readFileSync(expFile);
      back.verified = isOoxml(bytes, fam.export);
      text = extractText(bytes, fam.export);
      if (KEEP) fs.copyFileSync(expFile, path.join(OUT, `${input.ext}.${fam.export}`));
    }
    if (KEEP) fs.copyFileSync(binFile, path.join(OUT, `${input.ext}.bin`));
  }

  const want = EXPECT[input.ext];
  const surprise =
    want &&
    (want.bin !== binOk || want.exp !== Boolean(back.verified) || text.length < want.text);
  if (surprise) mismatched++;

  rows.push({
    ext: input.ext,
    srcBytes: fs.statSync(input.file).size,
    binOk, binBytes: toBin.bytes, binMs: toBin.ms, binHung: toBin.hung,
    expOk: Boolean(back.verified), expBytes: back.bytes, expMs: back.ms, expTo: fam.export,
    chars: text.length,
    note: want?.note,
    surprise,
  });
  process.stdout.write(`\r  ${input.ext.padEnd(5)} ${binOk ? "✅" : toBin.hung ? "⏳" : "❌"}\n`);
}

const totalMs = Date.now() - t0;

// ── 表 ─────────────────────────────────────────────────────────────────────

const mark = (ok, hung) => (hung ? "⏳挂住" : ok ? "✅" : "❌");
console.log("\n### 读得进来、写得回去吗\n");
console.log("| 源格式 | 源字节 | 读进来 | 内部格式 | 用时 | 写回 | 写回字节 | 用时 | 正文字符 | 与预期 | 备注 |");
console.log("|---|---:|:--:|---:|---:|:--:|---:|---:|---:|:--:|---|");
for (const r of rows) {
  console.log(
    `| ${r.ext} | ${r.srcBytes} | ${mark(r.binOk, r.binHung)} | ${r.binBytes || "—"} |` +
      ` ${r.binMs !== undefined ? Math.round(r.binMs) + "ms" : "—"} |` +
      ` ${mark(r.expOk)} ${r.expTo} | ${r.expBytes || "—"} |` +
      ` ${r.expMs !== undefined ? Math.round(r.expMs) + "ms" : "—"} |` +
      ` ${r.chars} | ${r.surprise ? "⚠ 不符" : "一致"} | ${r.note ?? ""} |`,
  );
}

// ── 老式二进制：读得了，写不出 ─────────────────────────────────────────────

console.log("\n### 老式二进制写得出去吗（OnlyOffice 本来就只读不写，这里核一遍）\n");
for (const famName of ["word", "cell", "slide"]) {
  const fam = FAMILY[famName];
  const src = inputs.find((i) => i.ext === fam.export);
  if (!src) continue;
  const binFile = path.join(scratch, `legacy-${famName}.bin`);
  runCell({
    dataFile: src.file,
    fileFrom: `in.${fam.export}`,
    fileTo: "Editor.bin",
    formatFrom: FMT[fam.export],
    formatTo: fam.bin,
    outFile: binFile,
  });
  const file = path.join(scratch, `legacy-${famName}.${fam.legacy}`);
  const r = runCell({
    dataFile: binFile,
    fileFrom: "Editor.bin",
    fileTo: `out.${fam.legacy}`,
    formatFrom: fam.bin,
    formatTo: FMT[fam.legacy],
    outFile: file,
  });
  console.log(
    `  ${r.ok ? "⚠ 居然有产出" : "✅ 如预期没有产出"}  ${fam.export} → ${fam.legacy}` +
      `   rc=${r.rc}  ${r.bytes} 字节`,
  );
}

// ── 渲染那一格：这个 PoC 真正要问的那一问 ─────────────────────────────────

console.log("\n### 渲染（出 PDF）——两种问法各问一次\n");
const docxInput = inputs.find((i) => i.ext === "docx");
const docxBin = path.join(scratch, "render.bin");
runCell({
  dataFile: docxInput.file,
  fileFrom: "in.docx",
  fileTo: "Editor.bin",
  formatFrom: AVS.DOCX,
  formatTo: AVS.CANVAS_WORD,
  outFile: docxBin,
});

for (const ask of [
  {
    label: "docx 直接 → pdf",
    job: { dataFile: docxInput.file, fileFrom: "in.docx", fileTo: "out.pdf", formatFrom: AVS.DOCX, formatTo: AVS.PDF, pdfFonts: true },
  },
  {
    label: "Editor.bin → pdf",
    job: { dataFile: docxBin, fileFrom: "Editor.bin", fileTo: "out.pdf", formatFrom: AVS.CANVAS_WORD, formatTo: AVS.PDF, pdfFonts: true },
  },
]) {
  const file = path.join(scratch, "render.pdf");
  const r = runCell({ ...ask.job, outFile: file });
  const ok = r.ok && isPdf(fs.readFileSync(file));
  console.log(
    `  ${ok ? "✅" : "❌"} ${ask.label.padEnd(18)} rc=${String(r.rc).padEnd(4)}` +
      ` ${String(Math.round(r.ms ?? 0)).padStart(4)}ms  ` +
      (ok ? `${r.bytes} 字节` : "没有产出"),
  );
  if (ok && KEEP) fs.copyFileSync(file, path.join(OUT, "render.pdf"));
}
console.log(
  "\n  rc=80 是 x2t 的通用转换失败码。**这里失败的不是「写 PDF」，是「排版」**——\n" +
    "  排版引擎是 sdkjs（JavaScript），不在这份 wasm 里；wasm 里只有写 PDF 的那一半。\n" +
    "  证据与另一条路见 poc/backend-x2t/README.md，实测见 probe-render.mjs。",
);

console.log(`\n共跑 ${ran} 次转换，${(totalMs / 1000).toFixed(1)} 秒（每次都是一个新进程，含加载 36 MB wasm）。`);
if (KEEP) console.log(`产物留在 ${path.relative(ROOT, OUT)}/`);
fs.rmSync(scratch, { recursive: true, force: true });

if (!ran) {
  console.error("\n✗ 一格都没跑成");
  process.exit(2);
}
if (mismatched) {
  console.error(`\n✗ ${mismatched} 行与 EXPECT 不符——要么是坏了，要么是好了而那张表没跟着改`);
  process.exit(1);
}
console.log("\n✓ 每一格都与 EXPECT 那张表一致");
