# Problems in the upstream package, and the evidence for each

> English | [中文](FINDINGS.zh.md)

2026-08-30. This file records **what we found while building this project**. Every entry comes with "how to verify";
do not add any claim here that has no evidence behind it.

---

## 1. The format conversion engine is not a black box; its source code has always been public

The `x2t.wasm` (9.22 MB) in the upstream component package was previously treated as something "committed directly into the repository with no corresponding source code".
**That claim does not hold.** It is the output of CryptPad's public `onlyoffice-x2t-wasm` recipe.

**Two pieces of evidence**:

1. The startup script in the upstream `x2t.js` is **identical, character for character,** to `pre-js.js` in the CryptPad repository,
   down to the tab indentation.
2. It exports `_main1`. This symbol can only come from CryptPad's `wrap-main.cpp` —
   that code is appended to the end of `X2tConverter/src/main.cpp` and wraps `main` into a `main1` that can be called repeatedly.

**How to verify**:

```sh
# The wasm is brotli-compressed; decompress it first to see what is inside
node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("x2t.raw.wasm",z.brotliDecompressSync(f.readFileSync("x2t.wasm")))'
grep -c '_main1' x2t.js                    # present
sed -n '/include: \/pre-js.js/,/end include/p' x2t.js   # compare with CryptPad's pre-js.js
```

Along the way, the wasm's debug info also revealed its build environment: compiler `clang version 21.0.0git` (corresponding to emsdk 4.0.x),
source tree mounted at `/core`, emsdk at `/emsdk` — exactly the layout of that Dockerfile.

## 2. The upstream wasm is about 30% larger than it needs to be

| | Upstream | Released by CryptPad |
|---|---|---|
| After brotli compression | 9.22 MB | **6.49 MB** |
| Decompressed | 62.6 MB | 34.3 MB |
| Debug info | 26.5 MB | **0** |
| Number of functions | 146 064 | 76 474 |

The upstream build **kept debug info and had optimization turned off**. Same functionality, but the browser has to download 2.7 MB more.
We use the latter (`scripts/fetch-x2t.mjs`, official sha512 verified).

## 3. The upstream PDF fonts have two problems, and neither raises an error

### 3.1 It contains genuine Monotype Arial

The name tables of the four `x2t-fonts/Arial-*.ttf` files contain
`Version 2.82`, `Typeface © The Monotype Corporation plc`, and
`NOTIFICATION OF LICENSE AGREEMENT / This typeface is the property of Monotype...`.

**That is not a font that can be shipped in a distribution package.** It has been replaced with Liberation Sans (a substitute built to match Arial's character widths,
SIL OFL licensed, and included in the Community Edition image we use), so layout widths do not change.

### 3.2 The bold and italic files are swapped

**The files named `*-Bold.ttf` contain italic, and the files named `*-Italic.ttf` contain bold**,
in both the Arial and Carlito families. Four signals agree:

| File | name table subfamily | OS/2 fsSelection | head macStyle | Weight |
|---|---|---|---|---|
| `Arial-Bold.ttf` | Italic | `0x1` = ITALIC | `0x2` = ITALIC | 400 |
| `Arial-Italic.ttf` | Bold | `0x20` = BOLD | `0x1` = BOLD | 700 |
| `Carlito-Bold.ttf` | Italic | `0x1` | `0x2` | 400 |
| `Carlito-Italic.ttf` | Bold | `0x20` | `0x1` | 700 |

The byte sizes match too: the upstream `Carlito-Bold.ttf` is 609 KB, exactly the size of the real Carlito italic.

The component feeds fonts to the conversion engine **by file name** (`X2T_PDF_FONT_MANIFEST`),
so the consequence is: **in exported PDFs, bold prints as italic and italic prints as bold, and nothing reports an error at any point.**

**A check is now in place**: `scripts/build-x2t-fonts.mjs` opens and verifies each file while assembling the fonts,
and `scripts/check-x2t-fonts.mjs` can re-verify at any time; both share one piece of logic in `scripts/lib/ttf-style.mjs`.
**This check was verified by injecting the real broken upstream file, and it failed immediately** (bytes identical after restoring).

## 4. Root cause of PDFs and images not opening: what is missing is the loading entry point, not the parsing ability

Under `web-apps/apps/`, the upstream package has only three editor applications
(documenteditor / presentationeditor / spreadsheeteditor);
**`pdfeditor` and `visioeditor` are missing**.

But under `sdkjs/`, `pdf` and `visio` **are both present** — that is, the parsing half is complete,
and **only the loading entry points in the `web-apps` half are missing**. That is why the symptom is "the API reports ready, the page stays blank".

Interestingly, **upstream's own extraction script already exports all five editors**
(`install_cross_origin_bridge` names pdfeditor and visioeditor one by one),
so the output committed in that repository was either pruned or extracted with an older version of the script.

We re-extracted from the Community Edition image, and all five are present.

## 5. `sdkjs-plugins` and the empty registry

The upstream package **has no `sdkjs-plugins/` directory**, and its `plugins.json` is
`{"pluginsData": []}` — an empty placeholder put there to silence a 404.

**That empty placeholder is one of the real reasons "plugins don't work"**: the editor uses the strings in this registry directly to fetch plugin configs;
if the list is empty, not a single plugin appears, including the 11 official plugins bundled in the image
(AI / OCR / Photo Editor / Translator / Thesaurus / Highlight code / YouTube / Zotero /
Mendeley / Speech / Speech input).

In the Community Edition image, `sdkjs-plugins/` has 19 entries (11 plugins + marketplace + bootstrap scripts + v1).
We extracted it, and **actually registered the bundled plugins** (`installRootConfigs`).

A `themes.json` was also missing — Document Server has nginx generate these two files on the fly,
and they are not in the image; with plain static hosting, unless you add them, every startup gets a 404, and **it does not raise an error, it just loses a piece of functionality**.
This was caught by `scripts/check-no-404.mjs`: the 13 live tests only reported "there is 1 console error",
without saying which one, and "there is one 404" and "there is one 404, caused by the missing theme list" carry completely different amounts of information.

## 6. Source of the static assets: how Community Edition relates to Developer Edition

Upstream's 1.06 GB was extracted from `onlyoffice/documentserver-de` (Developer Edition, commercially licensed).
We extract from the Community Edition `onlyoffice/documentserver:9.4.0.1`.

**The license header comments on both sides are identical, character for character — the code is the same; the difference is in the distribution terms, not the code**, so switching the source loses no functionality.
Measured: after switching, all 13 automated live tests passed.

## 7. Reducing the faked license to the minimum without losing functionality

In the `type: "license"` message that the mock service in the browser sends to the editor, upstream set all five switches
`advancedApi` / `protectionSupport` / `isAnonymousSupport` / `liveViewerSupport` / `customization`
to on; these correspond to capabilities that only the commercial edition has.

**With all five turned off, the 13 live tests still all pass.** But **not sending the message at all** means plugins do not start and exports hang for the full 30 seconds before timing out
— so this is "reduce to the minimum", not "remove".

## 8. A comment was wrong, and it made an assertion meaningless

The assertion in `App.tsx` that verifies the cross-origin check originally re-implemented the component's internal logic,
based on a comment: "the check function inside the component is not exported".
**That comment is wrong**: `isOnlyOfficeCdnMode` has been exported through the barrel all along.

The harm is not a few extra lines of code; it is that **this assertion tested our copy, not the product itself**:
if the product changed its rule, this assertion would still pass. It now calls the product's function directly.

## 9. How hard it is to upgrade to 9.4, measured

To build the conversion engine ourselves, CryptPad's core would have to be upgraded from 9.3.0.140 to our 9.4.0.129.
This was previously listed as a "major risk"; now there are numbers (using only git, no docker):

- **CryptPad changed 30 files in core, +1574 / −575**. Most of that is qmake build files,
  plus a newly written 827-line `doctrenderer_empty.cpp` (it replaces the half that needs V8 with empty implementations — V8 cannot be compiled to wasm).
- **Only 21 of these 30 files changed between 9.3 and 9.4, totaling +761 / −283**,
  and about ten of those changes are **a uniform +33 lines, 0 deletions** — that is an AGPL license header
  that Ascensio added across the whole tree in 9.4, inserted at line 1; it does not conflict with the places CryptPad changed, and will merge automatically.
- Only three places really need a human to look at them: `HtmlFile2/htmlfile2.cpp` (+275), `UnicodeConverter.pro` (113),
  `Common/base.pri`.

**Conclusion: the amount of work can be estimated; it is not an unknown.** See `build/x2t/README.md` for details.

## 10. Editable PDFs were opened as ordinary PDFs — fixed, and it had two layers

**Status: fixed on 2026-08-30 and covered by a live test (B15).**

### Symptom

PDFs generated by OnlyOffice itself (**PDF forms**, with an `/ONLYOFFICEFORM` marker in the header and an
OOXML package embedded in a stream) were opened as ordinary PDFs and lost their editability, **without a single error**.

### Layer 1: the check was not running at all

When opening a PDF, the editor first loads a **dispatch page** (`web-apps/apps/common/index.html`),
which reads the first 300 bytes of the file to decide whether it is an editable PDF, and then decides where to redirect:

| Result of the check | Redirects to | What the user sees |
|---|---|---|
| Editable PDF | `documenteditor` | Form editing UI; can fill in and edit |
| Ordinary PDF | `pdfeditor` | View and annotate |

The way it reads the file: if `document.directUrl` is set, it does a partial download of that URL;
**if not, it falls back to Document Server's `downloadfile/<key>` endpoint** — our setup has no such endpoint,
the request returns 404, and so the check **always answers "no"**.

⚠ **Ordinary PDFs happen to be judged correctly** (the answer is "no" anyway), so in tests that contain only ordinary PDFs,
a check that always answers "no" and a correct check **behave exactly the same**.
This is why the whole defect went unnoticed.

### Layer 2: after the routing was fixed, the document still would not open

After adding the check, editable PDFs did redirect to documenteditor — **but the document was not loaded**:
the page had the full toolbar, and the row of form buttons (text field / checkbox / signature…) was all there,
yet the canvas was empty, with an error dialog on top:

> An error occurred while opening the file. The file content corresponds to one of the following formats: pdf/djvu/xps/oxfs, but the file extension does not match: pdf.

The cause is in `loadDocument()`: the PDF branch is `output = raw bytes`, i.e. **passed through unchanged**.
That is correct for pdfeditor (it reads PDF directly), but documenteditor needs a **converted Editor.bin**.

**This layer only showed up after layer 1 was fixed** — doing only half of the fix leads to a worse state:
from "silently downgraded to read-only" to "lands in the right application but cannot open the document, and pops up a dialog nobody can make sense of".

### How it was fixed

One check, used in two places:

1. `internal/editor/pdf-form.ts` decides once (copied from the editor's own `isExtendedPDFFile`)
2. Editable PDF → converted as a "PDF form" into a word Editor.bin; ordinary PDF → passed through unchanged
3. The same result is passed to the editor through `document.isForm`, so that it skips its own check

**Why pass `isForm` rather than `directUrl`**: either route makes the check run,
but **we need the same answer on our side too** (to decide how to convert). Passing `directUrl` means the editor decides once
and we decide once, **which requires the two checks to always agree** — sooner or later they will disagree, and disagreement looks exactly like the layer-2 symptom.

### Check

```
                                Lands in        Paper px   Content px   Error dialog
Ordinary PDF (hand-written)     pdfeditor       358963     1952         none
Editable PDF (form template)    documenteditor  341420        0         none
```

⚠ **Do not use "content pixels" as a general check**: that form template is blank to begin with,
and has no dark content even once it is loaded. To tell "blank because the document is empty" from "blank because it was not loaded",
look at whether **the paper** was drawn — before the fix, that column was 0.

Run `node scripts/probe-pdf-routing.mjs` to print this table again.

### A copied rule, paired with a check that catches drift

The check in `pdf-form.ts` is **copied** from `isExtendedPDFFile` in the static assets.
There is a reason to copy it (the same answer is needed in two places); the cost is that **when the static assets are replaced, the original may change while our copy does not**.
`node scripts/check-copied-rule.mjs` extracts the few decisive values from the original and compares them one by one with ours.

⚠ While writing that check I tripped twice, both times on **false positives**: the first time I read the original as utf8,
so the high bytes were replaced with replacement characters and could never be found; the second time I did not expect that the original is
**hex-escaped source text** while our copy builds the value from character codes — the same value written two different ways.
**A check that gives false positives is worse than no check** — it gets added to the exemption list first, and after that it stays silent even when the real failure comes.

## 11. Opening every format one by one: 13 of 16 render, and all the gaps are in the wasm conversion engine

How to run: `node scripts/make-format-fixtures.mjs` generates a fresh set,
then `node scripts/check-formats.mjs` opens each one. The test documents are converted by **the native x2t inside the container**
from three source files of our own (Chinese lesson plan docx / Chinese spreadsheet csv / blank pptx);
three more legacy binary files are taken from ONLYOFFICE core, with sha256 verified.

### Results

| Format | Opens | Application it lands in | Paper pixels | Content pixels | Export |
|---|---|---|---|---|---|
| docx | ✅ | documenteditor | 331 371 | 6 646 | 25 518 B |
| doc | ✅ | documenteditor | 324 500 | 17 359 | 29 378 B |
| odt | ✅ | documenteditor | 333 827 | 6 214 | 4 879 B |
| rtf | ✅ | documenteditor | 334 945 | 5 221 | 861 955 B |
| txt | ✅ | documenteditor | 336 918 | 4 041 | 146 B |
| xlsx | ✅ | spreadsheeteditor | 477 437 | 3 296 | 9 471 B |
| xls | ✅ | spreadsheeteditor | 471 591 | 8 828 | ⚠ cannot export |
| ods | ✅ | spreadsheeteditor | 477 947 | 2 503 | 4 958 B |
| csv | ✅ | spreadsheeteditor | 477 437 | 3 296 | 109 B |
| pptx | ✅ | presentationeditor | 384 315 | 3 229 | 33 285 B |
| ppt | ✅ | presentationeditor | 373 412 | 732 | ⚠ cannot export |
| **odp** | **❌** | presentationeditor | **0** | **0** | cannot export |
| pdf (ordinary) | ✅ | pdfeditor | 350 708 | 6 020 | ⚠ cannot export |
| pdf (editable) | ✅ | documenteditor | 341 420 | 0 (the template is blank to begin with) | — |
| **epub** | **❌** | documenteditor | **0** | **0** | cannot export |
| **html** | **❌** | documenteditor | **0** | **0** | cannot export |
| fb2 | ○ | documenteditor | 341 420 | 0 | cannot export |

**The component declares support for 12 formats** (docx doc odt rtf txt / xlsx xls ods csv / pptx ppt odp);
**11 of them actually render, odp does not**.

⚠ **The two pixel columns above are relative; do not treat them as fixed values.** They depend on the browser window and the page layout:
after the 2026-08-30 page restyling made the top bar taller, rerunning the same set of documents gave numbers about a quarter lower across the board
(docx 331 371 → 248 795), **while not a single row's conclusion changed**.
The check has always been **">0 means it rendered, >10000 means there is paper"**, not any specific number —
if you see these numbers change, do not treat it as a regression yet; look at the conclusion column first.

### Three silent failures, each one different

| Format | Symptom | What actually happened |
|---|---|---|
| **odp** | "Unknown error" dialog, blank canvas | wasm throws `function signature mismatch`; the conversion produces nothing |
| **epub** | "Unknown error" dialog, blank canvas | wasm throws `memory access out of bounds` |
| **html** | **stays at "Loading file…" forever, with no error and no end** | the conversion neither succeeds nor fails; it just never returns |

⚠ The third is the worst: **it does not even show an error dialog**. The page has the full toolbar and a normal status bar; the document just never appears.

### Swapping in another wasm fixes epub and html

Swapping in the upstream wasm, which was built from a newer core (restored immediately afterwards, bytes verified identical):

| Format | Ours today (core 9.3.0.140) | Upstream's (newer core) |
|---|---|---|
| epub | crashes, 0 pixels | **340 692 paper / 6 745 content, works** |
| html | hangs, never returns | **340 692 paper / 6 745 content, works** |
| odp | crashes, 0 pixels | **still crashes, 0 pixels** |

**This is, to date, the strongest reason to "build our own x2t aligned with 9.4.0.129"**
— it is not just about tidy version numbers; it is the difference between two formats working and not working.

The odp case has nothing to do with the wasm version: **the native x2t in the container can read the same odp file**
(odp → pptx, 11 788 bytes of output). That is, **the file is fine; it is the wasm build that cannot read odp**.

### The three legacy binary formats: read but not write, confirmed from both sides

`doc` / `xls` / `ppt` **open and render content, but cannot be exported**
(export reports "x2t conversion produced no output"). This is not a defect; it is OnlyOffice's own capability boundary:
it can read these three formats, but cannot write them.

The same thing came up while generating the fixtures: converting to these three formats with x2t **exits with code 0 but produces no file**
— which is why the fixtures were changed to take real files from core (see `scripts/make-format-fixtures.mjs`).

### Two pitfalls, both of which make "conversion failed" look like "format not supported"

1. **Converting csv to xlsx requires two extra parameters, encoding and delimiter**; without them x2t exits with code 0 and produces nothing.
   With that xlsx missing, the ods converted from it is missing too, and it looks as if "these formats cannot be converted".
2. **The canvas appearing ≠ rendering has finished, and even less ≠ ready to export.** If you do not wait long enough, the pixel count is 0 and export hangs for the full 30 seconds before timing out,
   and both look like "this format cannot be opened". In practice it takes more than ten seconds to stabilize.

## 12. `npm run build` was broken all along, while dev always worked

**Status: fixed on 2026-08-30.**

The production build failed outright:

```
Invalid value "iife" for option "worker.format"
— UMD and IIFE output formats are not supported for code-splitting builds
file: src/onlyoffice-web-comp/internal/editor/x2t.ts
```

The format conversion half runs in a Web Worker, and it contains lazy loading (the brotli decoder is only imported when it is needed).
Vite bundles workers as iife by default, and that format **does not support code splitting**.

⚠ **The dev server does not bundle, so this never errors under dev.**
That means it only shows up during `npm run build` — **"it runs" and "it builds" are two different things**,
and until then we had only ever checked the former.

The fix is `worker: { format: "es" }` in `vite.config.ts`. After the fix, the build output is 1.5 MB.

## 13. Three more UIs we are not using: embed / mobile / forms

In the static assets, each editor application has more than one entry point:

| Application | main (full editor) | embed (viewer) | mobile | forms |
|---|---|---|---|---|
| documenteditor | 94.6 MB | **0.5 MB** | 5.5 MB | 1.5 MB |
| spreadsheeteditor | 441.3 MB | **0.5 MB** | 12.1 MB | — |
| presentationeditor | 68.7 MB | **0.4 MB** | 5.2 MB | — |
| visioeditor | 6.7 MB | **0.4 MB** | 3.8 MB | — |
| pdfeditor | 40.4 MB | — | — | — |

(Total size on disk, including all language packs and resources; this is not how much a single load downloads. But the gap in the application shell is real.)

**The component only ever loads `main`**, because it **hard-codes** `type: "desktop"` in the config it passes to the editor
(`core/editor-manager.ts`, two places), and this field is exactly what decides which entry point is picked:

```js
const path_type = corrected_type === "mobile" ? "mobile" :
                  corrected_type === "embedded" ? (fillForms && isForm ? "forms" : "embed") : "main";
```

**Tested** (temporarily changed that one place to `"embedded"`, restored right after, bytes verified identical):

```
URL      .../web-apps/apps/documenteditor/embed/index.html?...&type=embedded
Canvas   paper 564184 / content 14725     ← more than the editor, because no space is taken by a toolbar
UI       " lesson-plan-zh.docx 的 1 " ← only the file name and the page number are left
```

**In other words, the "viewer" path works; the only thing missing is exposing that field as an option.**
This does not contradict the sentence in the first-round report, "its preview is the editor with editing turned off, not a viewer" —
that sentence is about `main` plus read-only; this is about **a real viewer application that has been sitting in the assets, unused, all along**.

⚠ One thing to state precisely: the embed entry point **can only view** — no editing, no plugin panel.
It cannot replace the current path; it is **a separate mode** — to really use it, it has to be made an explicit option,
and each mode needs its own live tests (today there are none).

## 14. The viewer is now an option; and measuring the downloads showed that what it saves is only the shell

**Status: landed on 2026-08-30, covered by live test B16.**

Section 13 measured size **on disk** (`embed` 0.5 MB vs `main` 94.6 MB), and from that assumed
that "downloading less" was the main value of this mode. **This section measures how much is actually downloaded over the network, and that inference does not hold.**

### What changed

The component has a new field `variant` (`"editor"` / `"viewer"`), exposed all the way up to the facade
(`OnlyOfficeManagerOptions` → `CreateEditorViewOptions` → `type` in the config passed to the editor),
following the same pattern as the plugin field. **Both `type` sites were changed**: the one used at mount time, and the one
`refreshFile` uses when switching editing rights.

⚠ **Today no automated live test covers the second site, and there is a reason for that**: `syncEditingRights` only goes through
`refreshFile` when `asc_setRestriction` is not available, and a quick live check showed that
**the SDK of the embed application does have `asc_setRestriction`**, so that fallback path cannot be reached today.
Forcing a scenario that reaches it would mean removing the method from the SDK at runtime, but it sits on the prototype and cannot be removed cleanly,
and the result would be a state that never happens in the product. **So this is recorded plainly: the change is correct, but nothing covers it.**

### What exactly differs between the two modes (same Chinese lesson plan docx, same run)

| | Editor (`variant: "editor"`) | Viewer (`variant: "viewer"`) |
|---|---|---|
| Landing page | `documenteditor/main/index.html` | `documenteditor/embed/index.html` |
| Paper pixels / content pixels | 363 810 / 11 646 | **650 994 / 28 159** |
| Plugin panels (number of `iframe_<guid>`) | 2 | **0** |
| Ribbon tabs (number of `.ribtab`) | 13 | **0** |
| Text shown in the UI | File, Home, Insert, Draw, Layout, References, Collaboration, Protection, View, Plugins, AI, Formula Lab… (Chinese UI) | `一次函数教学设计.docx 的 1` |
| Legal notice entry point | present, visible | **present, visible** |

The viewer actually has more pixels, because there is no toolbar taking up space, so the paper is drawn larger.

⚠ **`readOnly` and the viewer are two different modes; do not mix them up**: read-only is `main` plus `asc_setRestriction` —
the toolbar and plugin panel are still there, editing is just not allowed; the viewer is **a different application**, with neither of the two.
That is why the demo page has two separate controls, and the button label spells it out: `切成只读（仍是编辑器那一档）` ("switch to read-only (still the editor mode)").

### Download size: the measured conclusion does not match "0.5 MB vs 94.6 MB"

`node scripts/measure-payload.mjs` (newly written; needs real infrastructure and is deliberately not wired into the automated checks).
Same document, same run, once as the editor and once as the viewer, with one cold load and one warm load each.

**docx (a lesson plan on linear functions) cold load:**

| Group | Editor | Viewer | Saved by the viewer |
|---|---|---|---|
| Fonts | 53 requests · 85.4 MB | 51 requests · 85.2 MB | 208 KB |
| sdkjs | 48 requests · **121.4 MB** | 48 requests · **121.4 MB** | **0** |
| UI | 220 requests · 9.9 MB | 24 requests · 2.8 MB | **7.1 MB** |
| Plugins | 67 requests · 2.4 MB | 0 | **2.4 MB** |
| Other | 49 requests · 2.6 MB | 47 requests · 2.6 MB | 2 KB |
| **Total** | **437 requests · 221.7 MB** | **170 requests · 211.9 MB** | **9.7 MB (4.4%)** |

**xlsx (转出.xlsx) cold load** (measured again with a different application, to see whether this difference follows the size of the application):

| | Editor | Viewer | Saved |
|---|---|---|---|
| UI | 10.7 MB | 2.85 MB | 7.85 MB |
| Plugins | 2.42 MB | 0 | 2.42 MB |
| Total | 413 requests · 164.2 MB | 148 requests · 153.8 MB | 10.5 MB (6.4%) |

**The difference is almost the same both times (9.7 MB and 10.5 MB), while `main` of `spreadsheeteditor` is
441.3 MB on disk and `main` of `documenteditor` is 94.6 MB.** That is:

> **The size difference on disk does not translate into download size.** Most of those hundreds of MB in `main` are language packs and
> resources that are never used, which the browser does not download anyway. What the viewer saves is **the application shell and the plugin panel**,
> about 10 MB and 265 requests, **regardless of which editor it is**.

**Warm load** (opening another document in the same browser profile): editor 91 KB, viewer 57 KB
— the long-lived caching of versioned files works, and the second document downloads almost nothing. **Day-to-day experience depends on this column.**

### Who downloads those 220 MB: a second table, grouped by "who is downloading"

Grouping only by the type of resource flattens out the most important fact. After adding a second axis:

| Who is downloading | Editor | Viewer |
|---|---|---|
| **The component's preload iframe** | 60 requests · **133.5 MB** | 60 requests · **128.5 MB** |
| Editor iframe | 329 requests · 85.5 MB | 62 requests · 80.8 MB |
| Main page | 48 requests · 2.6 MB | 48 requests · 2.6 MB |

Before mounting the editor, the component first inserts a `preload.html` iframe (`util/initialize.ts`),
and that page **pulls down the sdk of all four editors** — `sdk-all.js` for `word` / `cell` / `slide` / `visio`
at 27.5 / 30.9 / 27.0 / 22.7 MB respectively, **plus each one's `sdk-all-min.js`** —
and then `asc_loadFontsFromServer()` pulls the fonts. **This large chunk is exactly the same in both modes.**

So when the real download-size problems are ranked, they come in this order, **with the viewer last**:

1. The preload iframe pulls the sdk of four editors (**three of which are not used at all this time**) ≈ 110 MB
2. Chinese fonts ≈ 85 MB (`fonts/070` 18.8 MB, `fonts/076` 17.5 MB, `fonts/071` 16.1 MB…)
3. **Both the unminified and the minified versions** of the same sdk are downloaded (`sdk-all.js` 27.5 MB + `sdk-all-min.js` 3.4 MB)
4. Application shell + plugin panel ≈ 10 MB ← **this is the only item the viewer can save**

> Items 1 and 3 have since been fixed, and the whole tree is now served compressed: a cold load is **58.5 MB**,
> not 221.7 MB. The numbers in this section are the "before" measurement — see §15 for what changed and what is left.

**So the value of this mode has to be described differently**: what it saves is not bytes (4.4%), but
**265 fewer requests, no editing entry points, and no plugin panel** —
for a host application that embeds a read-only document, what goes away is that whole interactive surface, not traffic.

### A pitfall when measuring download size: incognito contexts have no disk cache

The first version used `browser.newContext()`. The measurement showed **cold load and warm load exactly identical**
(both 437 requests, 221.7 MB), and the viewer downloading 27.5 MB more than the editor.

Both numbers were false, for the same reason: **Playwright's `newContext()` is an incognito context,
with only a memory cache and no disk cache**, and those 20–30 MB `sdk-all.js` files are larger than the memory cache is willing to hold,
so not one of them gets cached — the second open downloads everything again.

⚠ **What makes this pitfall worth recording is that it looks like a real defect**: "warm load is the same as cold load" is exactly
the symptom of "long-lived caching is not configured", but here it was a flaw in the measurement, not in the product.
After switching to `launchPersistentContext` + an empty profile directory, the warm load dropped to 91 KB.

There is one more of the same kind: Playwright's `request.sizes().responseBodySize` **still returns
the file's own size on a cache hit**. The byte count has to be taken from CDP's `Network.loadingFinished.encodedDataLength`
— that field is 0 on a cache hit. Both are written up in the header comment of `scripts/measure-payload.mjs`.

### Check (B16)

One new test in `npm run e2e`, which opens the same docx once in each mode:

1. **The landing pages differ** — `.../main/index.html` vs `.../embed/index.html`.
   This is the only check that can clearly tell "whether it actually switched": the API reports, events and ready states are all identical in both modes.
2. The viewer mode **renders paper and content** (measured by pixels, not by "ready").
3. **Negative assertions**: in viewer mode, 0 plugin panels and 0 ribbon tabs;
   **and at the same time assert that both are greater than 0 in editor mode** — the second half is a free probe:
   if a selector were wrong and always returned 0, the editor half would fail immediately, instead of both sides silently passing together.
4. The legal notice entry point is present and visible in both modes. The application changes but the container does not; **still, what the license requires has to be tested, not reasoned about**.
5. Click the `切成只读` ("switch to read-only") button once, and **the landing page must still be `main`** — this guards
   the very fact that "read-only and the viewer are two modes": if someone someday merges them into one thing, this test fails.

⚠ **Switching to the viewer goes through the dropdown on the page, not through `window.__poc`.**
If the script called the API directly, a broken control (state not wired up, a selection that does not take effect) would not make anything fail
— "works when clicked by hand" and "the script passes" would become two different things. Likewise, the read-only test uses the real button.

### Added later: checking "is that entry point still visible" cannot rely on width and height alone

During the page restyling round, it turned out that item 4 above originally only asserted that the width and height from `getBoundingClientRect()` were greater than zero.
**An element that is completely covered by something else still has a positive width and height** — so the license requirement of being "prominently visible"
could silently stop being met after a purely stylistic change, while the live tests all stayed green.

Now it also asks `document.elementFromPoint`: at the center point of that entry point, is the topmost element the entry point itself;
plus one more check that it is "still inside the viewport". **Verified by injecting a transparent overlay** (adding a full-cover `::after` to the container):
B16 failed immediately, and the error message names what is covering it
(`它中心那个点上最上面的是 DIV.onlyoffice-container`). Restored after verification, bytes verified identical.

**This assertion was verified by injecting a defect**: changing the mount site back to the hard-coded `"desktop"`,
B16 failed immediately at item 1 (`查看器那档没落在 documenteditor/embed：.../main/index.html?...&type=desktop`);
a separate measurement showed that at that point the viewer mode had 2 plugin panels and 13 ribbon tabs
— **which means item 3 on its own is also enough to catch this regression**, rather than depending on item 1 to cover it.
Restored after verification, bytes verified identical.

## 15. Cold load cut from 221.7 MB to 58.5 MB, in two changes

Section 14 measured where the bytes go but stopped at ranking them. This section is the fix, and both halves are
measured the same way (`node scripts/measure-payload.mjs`, document 1, the Chinese lesson-plan docx, editor mode,
cold load, same machine, same run).

| | Requests | Bytes | First paint |
|---|---|---|---|
| Before | 437 | **221.7 MB** | 2159 ms |
| After warming up one editor instead of four | 387 | **131.1 MB** | 906 ms |
| After also serving the compressed copies | 387 | **58.5 MB** | 840 ms |

Warm load is unchanged at 91 KB — the long-lived cache was already working, and none of this is about that column.

### Where the bytes actually were

| Rank | File | Cold-load bytes | What it is | Needed for a docx? |
|---|---|---|---|---|
| 1 | `sdkjs/cell/sdk-all.js` | 30.9 MB | spreadsheet engine | **no** |
| 2 | `sdkjs/word/sdk-all.js` | 27.5 MB | word engine | yes |
| 3 | `sdkjs/slide/sdk-all.js` | 27.0 MB | presentation engine | **no** |
| 4 | `sdkjs/visio/sdk-all.js` | 22.7 MB | visio engine | **no** |
| 5 | `fonts/070` | 18.8 MB | Microsoft YaHei Regular | declared by the document |
| 6 | `fonts/076` | 17.5 MB | SimSun / NSimSun | declared by the document |
| 7 | `fonts/071` | 16.1 MB | Microsoft YaHei Bold | declared by the document |
| 8 | `fonts/073` | 10.1 MB | FangSong | declared by the document |
| 9 | `fonts/074` | 9.3 MB | SimHei | declared by the document |
| 10 | `sdkjs/common/libfont/engine/fonts.wasm` | 3.4 MB | font rasteriser | yes |
| 11 | `sdkjs/word/sdk-all-min.js` | 3.4 MB | bootstrap bundle | yes |
| 12–14 | `cell` / `slide` / `visio` `sdk-all-min.js` | 8.3 MB | their bootstraps | **no** |
| 15 | `documenteditor/main/code.js` | 2.2 MB | application shell | yes |
| 16–19 | four `main/resources/css/app.css` | 2.3 MB | shells' styles | one of them |

Two families are 81% of the total: four editor engines at 108.1 MB and five Chinese fonts at 71.8 MB.

The fonts are **driven by the document, and downloaded whole**. `demo/fixtures/lesson-plan-zh.docx` declares
微软雅黑 / 宋体 / 黑体 / 仿宋 / Calibri, and exactly those five files come down: a 3 KB document pulls 71.8 MB of fonts.
There is no glyph subsetting anywhere in this pipeline — the whole TTF goes into the rasteriser.

### Change 1 — warm up one editor, not four (−90.6 MB)

⚠ **`sdk-all-min.js` is not a minified `sdk-all.js`; it is a bootstrap.** In `sdkjs/word/sdk-all-min.js` (line 34497)
`loadSdk()` loads the full `sdk-all.js` on top of the bootstrap **unless `window['AscNotLoadAllScript']` is set**.
Only `preload.html` and `cache-scripts.html` set that flag, so every editor load pulls its engine.

**Verified by injecting the flag** into `documenteditor/main/index.html`: the editor never became ready
(`page.waitForFunction: Timeout 120000ms exceeded`). So the 27.5 MB engine is mandatory, and the waste is not
"the unminified copy" — it is **the three editors this document does not use**.

Before mounting the editor, the component inserts a hidden warm-up iframe pointing at upstream's `preload.html`,
which pulls all four engines, all four bootstraps and all four application shells, regardless of what is being opened.

What now happens instead:

- `scripts/build-preload-pages.mjs` generates one page per editor application
  (`preload-documenteditor.html`, `preload-spreadsheeteditor.html`, `preload-presentationeditor.html`,
  `preload-visioeditor.html`, `preload-pdfeditor.html`). Upstream's `preload.html` is left untouched on disk.
  The generator reads each application's `app.js` and refuses to run if the `sdk:` line disagrees with its table
  — ⚠ `pdfeditor` uses the **word** sdk, which is not derivable from the application name.
- `initializeOnlyOffice(documentType?)` takes the document type and points the warm-up iframe at the matching page.
  All three call sites in `OnlyOfficeManager` pass it, so warming starts before the document is even fetched.
  With no argument it warms word, matching what `getDocumentType()` already returns for an unrecognised extension
  — ⚠ two different defaults here would warm A while opening B, download a second sdk, and raise no error.
- ⚠ In the generated pages `sdk-all.js` is a `<link rel="preload">`, not a `<script>`. Warming needs the bytes in the
  cache, not the code running; upstream's page really does parse and execute 27.5 MB in a hidden iframe.
  **This had to be measured, not assumed**: if those preloaded bytes were not reused by the editor iframe, the same
  file would be fetched twice and **the total would go up silently**. In the trace `word/sdk-all.js` appears exactly
  once, fetched by the warm-up iframe (10 requests · 31.8 MB) and served from cache to the editor iframe.

Result: 437 requests · 221.7 MB → 387 requests · 131.1 MB, first paint 2159 ms → 906 ms.

⚠ **The measuring tool lied first.** `measure-payload.mjs` classified the warm-up iframe by matching `preload.html`,
so after the rename its requests were **silently folded into the editor-iframe row** and the "who is downloading"
table lost the one line that answers "is warming up doing anything at all". The total was right; the structure was not.
Fixed to match `preload(-<app>)?.html`.

### Change 2 — serve the compressed copies (−72.6 MB)

Nothing in this tree was compressed on the wire, because **both halves of the mechanism were off**, each for its
own reason, and neither is visible from the other:

- The image ships a `.gz` next to every file — 9759 of them, **including all 245 font files**, verified in the
  source container. `scripts/extract-assets.mjs` deleted all of them, and the stated reason was
  "no static server reads these". That is wrong: nginx's `gzip_static on` reads exactly those.
- The web server in front of the deployed tree had no compression configured, and nginx's default `gzip_types`
  is `text/html` only — so even an inherited `gzip on` would not have covered the JavaScript or the fonts.

⚠ **With both halves off, everything looks fine**: pages open, caching works, request counts are normal.
The only symptom is that the cold-load byte count is twice what it should be, and nobody watches that number.

What now happens:

- `scripts/precompress.mjs` writes a `.gz` next to every file over 1 KB in `vendor/` (skipping formats that are
  already compressed; ⚠ **the font files have no extension at all and are the single biggest group**, so the rule is
  an extension deny-list, not an allow-list). It is incremental, and it deletes any copy that did not come out
  smaller — keeping one would mean sending *more* bytes while both responses still return 200.
  `scripts/make-release.mjs` runs it before copying `vendor/`, so a release package always ships them.
- `demo/server/index.mjs` and `embed-poc/server/static-server.mjs` serve that copy when the client accepts gzip —
  the same rule nginx applies, including refusing a `.gz` older than its source.
  ⚠ `content-type` comes from the **original** file's extension; taking it from the `.gz` turns every file into
  `application/gzip`, and scripts then do not execute and wasm is rejected **while the status code stays 200**.
- For a server in front of the tree: `gzip_static on; gzip_vary on;`.
  ⚠ `gzip_static` is not governed by `gzip_types`, which is what makes it cover the extension-less font files.

Measured ratios (the image's own copies and ours agree to within a percent):

| File | Original | gzip |
|---|---|---|
| `sdkjs/word/sdk-all.js` | 27.53 MB | 4.49 MB (16%) |
| `sdkjs/word/sdk-all-min.js` | 3.36 MB | 0.61 MB (18%) |
| `documenteditor/main/code.js` | 2.20 MB | 0.32 MB (14%) |
| `sdkjs/common/libfont/engine/fonts.wasm` | 3.45 MB | 1.36 MB (40%) |
| `fonts/070` (Microsoft YaHei Regular) | 18.79 MB | 11.86 MB (63%) |
| whole tree, files over 1 KB | 985.9 MB | 440.9 MB (45%) |

Result: 131.1 MB → 58.5 MB. Compressing the tree takes 33 seconds and doubles it on disk.

### What is left

| Group | Cold-load bytes | Share |
|---|---|---|
| Fonts | 48.2 MB | **82%** |
| sdkjs | 5.2 MB | 9% |
| Application shell | 1.7 MB | 3% |
| Plugins | 0.9 MB | 1% |
| Other (mostly the dev server's own modules, absent in a build) | 2.6 MB | 4% |

Chinese fonts only compress by about 40%, so they are now four fifths of a cold load. Subsetting them, or replacing
them with an OFL family and subsetting that, is the only remaining large win — and it is also a licensing question,
since Microsoft YaHei / SimSun / SimHei / FangSong are in the same category as the Monotype Arial found in §3.1.
**Not done here**: it needs a decision about which characters may be dropped, and a test that makes a missing glyph
visible. Note that fonts are cached for a year, so this is about the first visit only.

### Checks (B17, B18), and the proof that they bite

`npm run e2e` grew two entries. Both guard savings that **nothing else would notice disappearing**: if someone points
the warm-up iframe back at `preload.html`, or a deployment stops serving the `.gz` copies, every page still works and
every other assertion stays green.

- **B17** asserts the warm-up iframe is `preload-documenteditor.html` when opening a docx, and that `cell`, `slide`
  and `visio` sdk files were never requested. ⚠ Those are negative assertions, so it also asserts that
  **`word/sdk-all.js` was requested** — a free probe: if the URL matching were wrong, all three negatives would be
  vacuously true, and this one would fail instead.
- **B18** requests the same URL twice, changing only `Accept-Encoding`, and asserts the gzip response is smaller,
  carries `content-encoding: gzip` and `vary: accept-encoding`, and that `content-type` is unchanged. It checks a
  script and a font file, because the font files are the ones with no extension.

**Both were verified by injecting the defect**: the preload page names were reverted to `preload.html` and the server
was started with `OOW_NO_PRECOMPRESSED=1`. B17 and B18 failed and the other 17 entries stayed green. Restored
afterwards, bytes verified identical.
