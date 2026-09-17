# PoC: running the OnlyOffice wasm on the back end

> English | [中文](README.zh.md)

> **⚠ This path has been abandoned; this directory is kept only as a record.**
>
> The conclusion (see the "Answer" paragraph below) is that **the rendering half cannot be moved over**, so this direction was not pursued further.
> The full trade-off is written in `BACKEND.md` at the repository root.
>
> **⚠ The commands below do not work today**: several scripts read `fixtures/lesson-plan-zh.docx`,
> but those fixtures moved into `demo/` on 2026-08-30, and the abandoned code was not updated to match.
> **That does not mean it is broken; the path is just out of date.** If you want to rerun it, fix the path on those lines first.

**The question:** can the front-end wasm be moved to the back end, and once it is moved, do we then have a simplified
OnlyOffice?

**Answer:** it can be moved, and **the format-conversion half is usable today**: in Node the wasm starts in about 190 ms (including decompressing it to 36 MB),
and converting a 3 KB docx into the editor's internal format takes 23 ms. **But the "rendering" half cannot be moved**,
because that half is not in this wasm at all.

Every point below comes with a command you can run yourself.

```sh
node poc/backend-x2t/run.mjs            # Question 1: conversion. Goes through 16 formats one by one
node poc/backend-x2t/probe-render.mjs   # Question 2: layout. Goes as far as the step where it gets stuck
```

The prerequisites are the same as for the whole project: `npm run assets` (extract the static assets), `npm run x2t` (fetch the engine),
`npm run fonts`, and `npm run fixtures:formats` (generate the 16 test documents).

---

## 1. First, correcting a premise: the wasm does not do the rendering

The question talked about "implementing rendering in the front end with wasm". **That is not how the work is actually divided**, and this division happens to be
the answer to the whole question, so it comes first:

| Who | Does what | What it is |
|---|---|---|
| `x2t.wasm` | **Format conversion**: docx ↔ internal format ↔ odt/rtf/txt…, plus **writing already laid-out drawing commands out as a PDF** | 6.8 MB (brotli-compressed; 36 MB decompressed) C++ build output |
| `sdkjs` | **Layout and rendering**: works out on which page and at which millimetre each character sits, and draws it onto the canvas | 32 MB of JavaScript (two bundles) |

Exporting a PDF in the browser really happens in **two stages**: sdkjs first lays out the document in JS and produces a binary
stream of drawing commands (called `pdf.bin` in the code), then hands it to x2t.wasm to be written out as a PDF file.
The `convertEditorBinToPdf` in the component takes a `pdfRendererStream` parameter; that is this stage.

So "moving the wasm to the back end" moves **the conversion of the first stage + the file writing of the second stage**;
**the layout in between is not moved**: it lives in JS.

---

## 2. Question 1: conversion. **Yes, and it is fast**

`node poc/backend-x2t/run.mjs`. At no point is there a browser, a Document Server, or docker.

```
  引擎     vendor\x2t （core 9.3.0.140）
  解开后   36.0 MB
  Node     v24.11.0
```

(The script prints its labels in Chinese: `引擎` = "engine", `解开后` = "decompressed".)

| Source format | Source bytes | Read in | Internal format | Time | Written back | Written-back bytes | Time | Body characters | Notes |
|---|---:|:--:|---:|---:|:--:|---:|---:|---:|---|
| doc | 35328 | ✅ | 25576 | 64ms | ✅ docx | 13931 | 35ms | 3353 | |
| docx | 3071 | ✅ | 1626 | 23ms | ✅ docx | 8858 | 30ms | 135 | |
| epub | 2153 | ❌ | — | 24ms | ❌ | — | — | 0 | the wasm cannot read it |
| fb2 | 616 | ❌ | 11 | 16ms | ❌ | — | — | 0 | produces an 11-byte empty shell |
| html | 1868 | ⏳hangs | — | — | ❌ | — | — | 0 | the wasm does not return |
| odt | 3290 | ✅ | 1688 | 44ms | ✅ docx | 8767 | 30ms | 135 | |
| **pdf** | 143094 | ✅ | 8940 | 86ms | ✅ docx | 9636 | 38ms | **127** | **PDF converted back to editable Word** |
| rtf | 1884 | ✅ | 7896 | 44ms | ✅ docx | 10897 | 36ms | 119 | |
| txt | 321 | ✅ | 2185 | 26ms | ✅ docx | 8728 | 31ms | 135 | |
| csv | 167 | ✅ | 2379 | 32ms | ✅ xlsx | 7026 | 41ms | 60 | |
| ods | 3964 | ✅ | 2048 | 71ms | ✅ xlsx | 7062 | 39ms | 24 | |
| xls | 14336 | ✅ | 5674 | 66ms | ✅ xlsx | 9416 | 43ms | 472 | |
| xlsx | 4953 | ✅ | 2129 | 40ms | ✅ xlsx | 6638 | 38ms | 48 | |
| odp | 6409 | ❌ | — | 25ms | ❌ | — | — | 0 | the wasm cannot read it |
| ppt | 8192 | ✅ | 21487 | 67ms | ✅ pptx | 16411 | 40ms | 0 | the fixture contains no text |
| pptx | 34699 | ✅ | 60663 | 56ms | ✅ pptx | 36997 | 46ms | 0 | the fixture is a blank slide to begin with |

**12 of the 16 can be read in and written back.** The other four (epub / fb2 / html / odp) behave
**exactly the same** as on the browser side: the core version this wasm is based on is one release old; it is not a back-end problem.
FINDINGS section 11 measured the same set of numbers (and it is known that switching to a wasm based on a newer core fixes both epub and html).

Two more things checked along the way:

- **Legacy binary formats are read-only**: none of docx → doc / xlsx → xls / pptx → ppt produced any output (rc=80 / 88).
  This is a limit of OnlyOffice itself.
- **PDF can be converted back to editable Word**, with the Chinese text coming through intact (127 characters). This cell was an unexpected bonus.

### Judge by the output, not the exit code

x2t has a class of failure where **the exit code is 0 and nothing is produced**, so every cell checks the actual bytes:
Editor.bin is checked for the DOCY/XLSY/PPTY magic number **plus a 64-byte minimum**, OOXML is checked for whether the zip contains the entry it should,
**and the body text is extracted and its characters counted**.

That minimum and that character count are not there for show: **the fb2 cell produces 11 bytes with a perfectly correct magic number and not a single character of body text**.
A check that looked only at the magic number would let it pass, and the report would then say "13 of 16 usable".

The check itself was verified twice (inject a defect and see whether it turns red):

| What was injected | Result |
|---|---|
| Remove the 64-byte minimum for Editor.bin | fb2 turns green → no longer matches the expected table, red. **This shows the minimum really is catching something** |
| Truncate every output to 40 bytes | 12 of the 16 rows red. **This shows the check reads bytes, not the exit code** |

Both times followed snapshot → inject → run → restore → `cmp`, and after restoring the files were identical byte for byte.

### One thing you must know when building a back-end service: a bad document can hang the whole process

The `html` cell **is not a failure; it never returns**. `main1` is a synchronous wasm call, and once execution is inside it,
**nothing in the same process can interrupt it**: the event loop never gets a turn, timers do not fire, Promises do not resolve.

So `run.mjs` runs **each cell in its own child process** and kills it on timeout. This is not a shortcut in the test scaffolding:
**a real service has to do the same**, otherwise a single bad document can hang the entire conversion service, and there is no way to tell which document it was.
The cost is about 190 ms extra per conversion to decompress and load that 36 MB wasm (a persistent process pool could save this).

---

## 3. Question 2: layout. **The path works; today it is one step short**

Since the layout engine is JavaScript, and Node is itself V8 (OnlyOffice's own doctrenderer
is essentially just "V8 + these few js files"), we tried it on the spot instead of relying on reasoning.

`node poc/backend-x2t/probe-render.mjs`:

```
✓ xregexp                                4ms
✓ native.js                              0ms      ← headless DOM shim that ships with OnlyOffice
✓ jquery_native.js                       5ms
✓ AllFonts.js                            1ms
✓ sdk-all-min.js（API 层）                69ms
✓ sdk-all.js（模型与排版层）                355ms   ← 28.9 MB
✓ libfont/fonts.js                       4ms      ← FreeType wasm
字体引擎起来了吗: 是

✓ NativeCreateApi                    17ms  → document
✓ asc_nativeOpenFile                 55ms  → opened      ← Editor.bin loaded into the document model
✗ asc_nativeCalculateFile            59ms  Cannot read properties of null (reading 'm_pFaceInfo')
```

(The script prints its labels in Chinese: `（API 层）` = "(API layer)", `（模型与排版层）` = "(model and layout layer)", `字体引擎起来了吗: 是` = "font engine up: yes".)

**What holds up:** the entire editor core loads in Node (about 0.5 s), OnlyOffice's official headless entry points
(`asc_nativeOpenFile` / `asc_nativeCalculateFile` / `asc_nativeGetPDF`) are all present,
the FreeType wasm starts as well, and Editor.bin is loaded into the document model.

**What is missing:** creating a font face during layout fails. The font files can be read (`native.GetFontBinary` is already wired to the disk),
but only one of them was requested, which shows that **the step that loads fonts into the engine is not wired up correctly**. In doctrenderer this part is done in C++;
in Node it has to be rewired following the path the browser takes.

**Also, `asc_nativeGetPDF` still returned a 5 MB buffer.** That is an empty command stream.
**Here "it returned something" does not mean "it drew something"**: the check has to use the page count (`asc_nativePrintPagesCount` returns 0).
Taking the byte length as success gives you a 5 MB false success.

### A key piece of evidence: the wasm contains "write PDF" but not "layout"

Decompress those 36 MB and search the strings directly:

| Searched for | Present? |
|---|---|
| `CPdfFile` / `PdfWriter` (the PDF-writing half) | **Present** |
| `doctrenderer` / `sdk-all` / `AllFonts` (the layout half) | **None present** |

So what fails with rc=80 **is not "writing the PDF" but "layout"**. It also shows that CryptPad's wasm
**deliberately compiles only the conversion half**: this is not a defect; they simply do not need layout.

---

## 4. So what is "a simplified OnlyOffice"

Look at it as two steps, not as one thing:

**What is available today (the first stage): a pure-Node format conversion service.**
No Document Server, no docker, no browser, not a single `node_modules` package to install.
Conversion among 12 formats, PDF to editable Word, a few tens of milliseconds each time.
It is the counterpart of the FileConverter in DocumentServer.

**What takes more work to get (the second stage): PDFs / preview images produced on the back end.**
The path has been verified to work; it is stuck on font loading. Once that is done, you have the complete
"docx → layout → PDF", that is, the counterpart of OnlyOffice's doctrenderer,
but running in Node and without that C++ binary.

**If all you want is "PDFs from the back end" and you do not care how they are made**, there is a third path not tried here:
drive the existing component with a headless browser. This repository already has Playwright and a full e2e suite,
and PDF export in the browser **works today**. The cost is starting a Chromium for every render.
Its relationship to the second stage is "buy or build", not a question of technical feasibility.

---

## 5. Places where nothing works until they are fixed, and the error points somewhere else

They are kept here because each one took time, and **none of the errors point to the real cause**.

1. **`x2t.wasm` is brotli-compressed** (6.8 MB on disk, 36 MB decompressed). Feed it to
   `WebAssembly.instantiate` without decompressing and the error is "expected magic word 00 61 73 6d":
   **that message points at the wasm file and makes it look corrupt**.

2. **The `var Module;` statement in the Emscripten glue.** In Node's module scope it is a local variable,
   so a `Module` set from outside does not get in. You have to wrap the whole glue in a function whose parameter is named `Module`
   (which is exactly what Emscripten's own MODULARIZE does); then that declaration becomes a no-op.

3. **`sdk-all.js` and `sdk-all-min.js` are two complementary halves, not an old and a new version.** The names are misleading:
   the min one is not minified at all. The former holds the model and layout layer, the latter the API layer.
   Loading only one of them "succeeds", and then an unrelated error appears as soon as something from the other one is used:
   without the model layer you get `AscCommon.History` is undefined, without the API layer you get `lcid_enUS is not defined`.
   **Neither message makes you think "the other file was not loaded".**

4. **`native.js` replaces `setTimeout` / `setInterval` with empty functions** (in doctrenderer everything runs synchronously).
   Emscripten's startup finishes by going through one `setTimeout`; once that is swallowed, the wasm never finishes initializing,
   and the error is **`_ASC_FT_Init is not a function`, which points at the font engine**.

5. **The whole `fonts.js` glue is wrapped in a closure**, and the statement inside it,
   `var Module = typeof Module != "undefined" ? Module : {}`, reads the function's own `Module`, which has not been assigned yet,
   so setting `Module.wasmBinary` from outside has no effect (tried). It also hard-codes
   `ENVIRONMENT_IS_WEB = true` and only uses `fetch`, so the only option is to give it a fake `fetch` that reads from disk.

6. **The `console.error` in `native.js` references a variable `param` that does not exist**, so calling it throws
   `ReferenceError`. This is an upstream bug; the console has to be replaced.

7. **The last statement of `NativeOpenFileData` is `Api = Api.getJsApi()`**, which replaces `Api` with a
   wrapper that has none of the `asc_native*` methods. To keep the real api, you have to make the two calls yourself:
   `NativeCreateApi()` + `asc_nativeOpenFile()`.

8. **Emscripten's FS does not throw an `Error`; it throws a plain object with an `errno`**,
   which `String()` turns into `[object Object]`, **without a single clue**.

---

## 6. What is in this directory

| File | What it does |
|---|---|
| `x2t-node.mjs` | Drives x2t.wasm in Node. Adapted from the browser's `x2t.worker.ts`, deliberately keeping the same sequence of steps |
| `convert-once.mjs` | Runs one conversion and exits. **A separate process is required**; the reason is in the header comment |
| `run.mjs` | Question 1: the 16-format matrix, judged by the output |
| `probe-render.mjs` | Question 2: how far the layout stage gets |
| `zip.mjs` | Extracts the body text from outputs to count characters. Just enough for this; not a general-purpose zip library |

**Known debts** (acceptable for a PoC, to be paid off before real use):

- The PDF font list in `x2t-node.mjs` is **a second copy taken from `src/onlyoffice-web-comp/const/index.ts`**.
  It should be imported from that one place instead of keeping two copies: two copies drift apart, and the drift raises no error.
- The command-stream path in `convert()` (`pdfBinBytes`) was written after `writePdfBin` in the browser worker,
  **but it has never actually been run**, because no command stream can be produced.
  Once the second stage works, it is the first thing to verify.
