# Building the format conversion engine (x2t) ourselves

> English | [中文](README.zh.md)

This directory answers one question: **how to build the wasm that does format conversion in the browser from source, instead of taking a ready-made copy from somewhere else.**

Right now `vendor/x2t/` holds the ready-made build published by CryptPad (fetched by `scripts/fetch-x2t.mjs`, checksum verified).
**This directory exists to replace it with a copy we build ourselves**, for two reasons: first, the license requires us to be able to provide the corresponding source
and the build method; second, the ready-made copy is based on core 9.3.0.140, while the version we use is 9.4.0.129: one release apart.

⚠ **It cannot be built on this machine today**: it needs Linux plus Docker, this machine has neither, and installing them requires administrator rights.
The test machines available to us have 2 cores, 1750 MB RAM and a 17 GB disk; openssl plus boost alone exceed the disk.
Once those are installed, run `./build.sh`; nothing else needs to be prepared.

## One thing already established: the upstream copy is not a black box

The `x2t.wasm` in the upstream component package has always been treated as something "committed straight into the repository, with no corresponding source". **It is not.**
It is the output of CryptPad's public recipe. Two pieces of evidence:

1. The startup script in its `x2t.js` is **identical character for character** to `pre-js.js` in the CryptPad repository, down to the tab indentation.
2. It exports `_main1`. That symbol can only come from CryptPad's `wrap-main.cpp`: that code is appended to the end of
   `X2tConverter/src/main.cpp` and wraps `main` into a `main1` that can be called repeatedly.

Measured along the way: the upstream copy is 9.22 MB, the one CryptPad publishes is 6.49 MB, **the same functionality at 30% less size**.
The difference is that the upstream build carried 26.5 MB of debug information and had optimization turned off (146064 functions vs. 76474).

The debug information in this wasm also reveals its build environment: the compiler is
`clang version 21.0.0git` (corresponding to emsdk 4.0.x), the source tree is mounted at `/core`, and emsdk at `/emsdk`,
which is exactly the layout of CryptPad's Dockerfile.

## What the recipe looks like

CryptPad's `Dockerfile` has about thirty stages; each stage builds one static library, and at the end they are linked into the wasm:

- Base: `ubuntu:22.04` + `emsdk 4.0.11` + qt6 (for qmake)
- Third-party libraries, each built separately: openssl 1.1.1f, boost 1.84, harfbuzz, hyphen, brotli, heif, gumbo, katana
- core's own libraries: kernel, graphics, UnicodeConverter, the FormatLib for each format (docx/pptx/xlsx/doc/ppt/xls/odf/rtf/txt),
  PdfFile, HtmlFile2, EpubFile, XpsFile, DjVuFile, HwpFile, IWorkFile, DocxRenderer, doctrenderer
- Finally `wrap-main.cpp` is appended to `X2tConverter/src/main.cpp`, and the link step adds
  `--pre-js pre-js.js`, `-sEXPORTED_RUNTIME_METHODS=ccall,FS`, `-sEXPORTED_FUNCTIONS=_main1`,
  `-sALLOW_MEMORY_GROWTH`
- The output is then compressed with `brotli`, giving `x2t.wasm.br` and `x2t.js.br`

It comes with its own comparison tests: the native x2t inside a real Document Server serves as the baseline, the same batch of files is converted on both sides, and the results are compared.

## How to build

```sh
./build.sh              # build the currently pinned version; output goes to out/
./build.sh --bump       # first upgrade core to the coreVersion in config.mjs, then build
```

What `build.sh` does: clones the CryptPad repository (if it is not cloned yet), optionally upgrades core to the version we want,
runs their `build.sh`, and copies the output into `vendor/x2t/`, rewriting the `SOURCE.json` there.

## Upgrading to 9.4.0.129

The `core/` in the CryptPad repository is a **modified copy** of ONLYOFFICE core, stored as a git subtree.
Upgrading means:

```sh
git subtree pull --prefix core https://github.com/ONLYOFFICE/core.git v9.4.0.129 --squash
```

There will be conflicts, because they have made surgical changes to core. **How hard this is has already been measured** (2026-08-30, using only git, no docker):

**CryptPad changed 30 files in core, +1574 / −575.** Most of it falls into three parts:
`Common/base.pri` alone accounts for 473 changed lines (qmake compiler flags);
the newly written `doctrenderer_empty.cpp`, 827 lines (it replaces the half that needs V8 with an empty implementation; **V8 cannot be compiled to wasm**,
and this is the key surgery of the whole recipe); and a dozen or so `.pri` / `.pro` build files.
Only five places actually change C++ logic: `HtmlFile2/htmlfile2.cpp`, `PPTShape/BinaryReader.{h,cpp}`,
`X2tConverter/src/lib/html.h`, `pdf_image.h`, `main.cpp`.

**Next, how much these 30 files changed between 9.3.0.140 and 9.4.0.129**: only 21 of them changed,
+761 / −283 in total. And about ten of those changes are **a uniform +33 lines, 0 deletions**:
that is the AGPL license header Ascensio added to every file in the tree in 9.4, inserted at line 1.
CryptPad's changes are all inside the file bodies, so this kind merges automatically without conflicts.

**Only three places really need a human to look at them**: `HtmlFile2/htmlfile2.cpp` (+275, the only substantial rewrite),
`UnicodeConverter.pro` (113), and `Common/base.pri` (besides the license header, it also gains a block under `core_release` with
`-g0` and `-Wl,-s`, **which is exactly the removal of debug information, the same direction we want to go**).

Conclusion: **the upgrade is a workload that can be estimated, not an unknown.** But the order is still: first build once at their pinned 9.3.0.140,
confirm the whole chain works on our build machine, **and only then** change the version. If you upgrade straight away and the build fails, you cannot tell whether
"the recipe does not work on our build machine" or "something changed in 9.4".

The commands used to measure these two numbers (first shallow-clone the CryptPad repository to any location):

```sh
git fetch --depth=1 https://github.com/ONLYOFFICE/core.git v9.3.0.140 && git tag -f v930 FETCH_HEAD
git fetch --depth=1 https://github.com/ONLYOFFICE/core.git v9.4.0.129 && git tag -f v940 FETCH_HEAD
git diff --stat v930 HEAD:core      # what CryptPad changed
git diff --stat v930 v940 -- <the 30 paths above>   # what changed in these files between the two versions
```

## What counts as "it worked" after a build

**Judge by the output itself, not by whether the build script reported an error.** Three checks:

1. After decompressing `x2t.wasm`, the magic number is `\0asm`, the section structure contains code / data / export, and there are **no** `.debug_*` sections
   (debug information means the optimization flags did not take effect, and the output will be about 30% larger)
2. The export table contains `main1`: without it the component cannot drive the engine at all
3. Run the automated real-world test in `demo/e2e/` once: fetch a document, edit it, insert a formula with the plugin, save it back to the server,
   judged by the bytes of the exported docx. **When the engine is swapped, format conversion is what breaks most easily, and it breaks silently.**

After the build, also note the output size and the number of functions, and compare them with the two sets of numbers in this document.
