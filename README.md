# onlyoffice-web

> English | [中文](README.zh.md)

**A browser-only ONLYOFFICE front-end component, built from the Community Edition and maintained by us.**

No Document Server is needed: the editors run in the browser, the collaboration protocol is answered
by a mock server running inside the same tab, and format conversion happens in the browser through
the ONLYOFFICE conversion engine compiled to WebAssembly.

The project is self-contained: it ships its own front end, back end, plugins and automated tests,
and does not connect to any external service.

This project is **released under AGPL-3.0** and complies with the five additional terms added by Ascensio System SIA.
It is a **modified version** of ONLYOFFICE, originally developed by Ascensio System SIA.
What was changed and when is recorded in [NOTICE.md](NOTICE.md). That file is part of the license obligations, not optional documentation.

Documentation in this repository is written in English. Some documents also have a Chinese copy next to them (`*.zh.md`); the copies are optional, and when the two differ, the English version is the one to follow.

## Two rules we do not break

1. **Having accepted the AGPL, we comply with it for real.** No white-labeling, no fabricated license to unlock
   commercial-edition features, no third-party trademarks. The legal notice entry in the UI is mandatory, not optional:
   additional term 3 states explicitly that a notice in the source code alone is not enough.
2. **Static assets come only from the Community Edition image.** The assets in the upstream component package
   were extracted from the Developer Edition image (commercial license); not a single byte of them is used.
   The license headers of the two are identical word for word: **the code is the same, only the distribution
   terms differ**, so switching the source loses no functionality.
   `scripts/extract-assets.mjs` stops immediately if the image name contains `-de` or `-ee`.

## Running it

Requires Node 22 or later. `npm install` and the three fetch steps are one-time setup; after that you only need `server` and `dev`.

```sh
npm install
npm run assets     # extract static assets from the Community Edition image (~1.5 GB; local docker, or ssh to a host running the image)
npm run x2t        # fetch the conversion engine (6.5 MB, verified against the official checksum)
npm run fonts      # set up the fonts used for PDF export (7 MB, bold/italic verified one by one)

npm run server     # 3041: document fetch / save, serves static assets, plugins and license texts
npm run dev        # 3040: the page
npm run e2e        # automated tests (17 cases; every assertion checks the artifact itself)
```

Some quick checks. **The first three need no infrastructure and finish in under a second**; the rest need both servers running plus a real browser:

```sh
npm run check:legal    # are the compliance requirements still in place in the code (with a built-in revert probe)
npm run check:fonts    # does each font file really contain the typeface its name says (with a built-in reverse probe)
npm run check:rule     # is the editor rule we copied still worded the same upstream

npm run check:404              # does anything fail to load when opening a document
npm run check:404 -- --pdf     # same, opening a PDF
npm run check:404 -- --viewer  # same, using the viewer
                               # ⚠ these three load three different apps; running only the first covers a third of it
npm run check:formats        # open every format in turn and print a table (16 files, ~5 minutes)
npm run measure:payload      # how much is downloaded to open a document: editor and viewer, cold and warm load each
node scripts/probe-pdf-routing.mjs   # does each of the two PDF kinds go to the right app
```

The test documents for the format checks have to be generated once (~1 minute, needs the host running the image):

```sh
npm run fixtures:formats
```

**Embedding this component in someone else's page** has its own example and tests. It is self-contained and independent of everything above:

```sh
npm run poc:build     # build its three pages
npm run poc:e2e       # start the servers, run all seven passes, stop them (one pass is **expected to fail**)
```

It answers questions such as "does it still work behind a server that only serves files, like nginx" and
"does the rule of requesting fresh credentials every time hold". Results are in [embed-poc/README.md](embed-poc/README.md).

## Build and release

```sh
npm run build      # front-end bundle → dist/ (~1.4 MB)
npm run release    # assemble the full package → release/onlyoffice-web-<version>/ (includes vendor, ~1.5 GB, takes a few minutes)
npm run release -- --no-vendor    # when the target machine already has vendor
```

⚠ **`dist/` cannot run on its own**; it is only the front-end half. The full package also needs two things: **the back-end process**,
and **`vendor/`** (the editors, the conversion engine and fonts, ~1.5 GB).
`vendor/` is **not in git**, and `npm run assets`, which fetches it, needs ssh access to a host running the Community Edition image.
That command cannot run on the target machine, so vendor has to travel with the release package. This is what `npm run release` does.

The package contains **the full source tree + `dist/` + `vendor/` + a deployment guide (`DEPLOY.md`)**,
with the same directory layout as the repository. **The back end has no third-party dependencies** (only `node:` built-ins),
so the package needs no `node_modules` and the target machine needs no `npm install`.

⚠ **Do not remove the source from the package**: the back end builds `/legal/source.tar.gz` on the fly from the project root at runtime
(the obligation in AGPL section 13). Without the source it serves an incomplete archive, **and still returns 200**.

Three built-in checks, each added after something actually went wrong:
assembly refuses to run if `dist/` is older than the source (otherwise the package ships the previous front end and nothing says a word);
it stops if anything in `vendor` is missing and tells you which command to run; and after assembling it verifies that all seven required pieces are present.

### Runtime configuration

| Environment variable | Purpose | If unset |
|---|---|---|
| `OOW_TOKEN_SECRET` | Secret used to sign tickets, at least 16 characters | **A random secret is generated at every start**, so all old tickets become invalid after a restart (fine for local development; set it for real deployments) |
| `OOW_SOURCE_URL` | URL of the source repository (for this project: <https://github.com/yuhaibohotmail/onlyoffice-web>) | The "Get source code" link in the UI serves an archive built on the fly by this server instead |

The front-end half needs a web server that serves `dist/` and forwards four paths, `/api`, `/packages`, `/plugins` and `/legal`,
to the back end. ⚠ **Everything must be same-origin**: the editor runs in an iframe and plugins open another iframe inside the editor;
if any layer is cross-origin, the parent page cannot read anything, **and the symptom is "the editor never shows up"**.
Under `dev` and `vite preview`, vite handles this (the four proxies in `demo/vite.config.ts`);
with nginx you have to configure it yourself.

⚠ **The reverse proxy must pass `Host` through unchanged** (or set `X-Forwarded-Host` / `X-Forwarded-Proto`).
The back end uses it to build the absolute URLs in the plugin registry. **Before 2026-08-30 this was hard-coded**,
and the consequence was measured: with the build served on port 3050, documents still opened, export still worked (48,607 bytes)
and the legal notice entry was still there, **but the plugin panel showed 0 plugins** (2 on port 3040), with 13 connection-refused errors in the console.
It is now built per request; the same test rerun shows 2 plugins again, and the console has only the one known upstream 404 left.

⚠ **Extracting the assets needs a container running the Community Edition image.** By default the **local docker** is used
(`DOCUMENT_SERVER.host` in `config.mjs` is empty).
If there is no local docker, fill that field with a host running the image and the script will do the work over ssh.
Alternatively, leave the file unchanged and point the `OOW_DS_HOST` environment variable at a host for the moment.

The row of buttons on the page goes through exactly the same code paths as the automated tests (all exposed on `window.__poc`).
**This is deliberate, not a separate implementation**; otherwise "works when clicked by hand" and "the script passes" would become two different things.

At the top of the page there is a **document drop-down** listing every document on the server (the three hand-written ones plus the format test set);
selecting one opens it. **The list comes from the server; the page does not keep its own copy.** Two copies would drift apart,
and drift would look like "one format is missing from the page, and nothing fails".

Next to it is a **UI drop-down** (editor / viewer), **independent of** the document drop-down: which document to open and
which UI to use are two separate choices, hence two controls. ⚠ There is also a "switch to read-only" button,
and **read-only and the viewer are not the same thing**: read-only is the same app with editing turned off (toolbar and plugin panel are still there),
while the viewer is a different app (neither is present). Having both controls makes this difference visible;
the hint in the middle of the page, shown when no document is open, says the same thing.

The dot on the left of the status line has four colors (idle / busy / done / error); the small tags on the right show
the current format, which UI is in use, whether it is read-only, and the version and digest after saving back.
⚠ **They are for display only and no test relies on them**: the automated tests look at bytes on disk, exported content and canvas pixels,
never at what the UI says.

## Layout

| | |
|---|---|
| `config.mjs` | **The single source of truth for versions and sources.** Do not copy a version number or URL anywhere else |
| `scripts/` | Fetching and verification: extract static assets / fetch the conversion engine / set up fonts / check fonts / measure payload / assemble the release package |
| `release/` | The full package built by `npm run release` (includes vendor, ~1.5 GB). **Not in git**, can be regenerated |
| `vendor/` | Extracted files, **not in git** (~1.5 GB, reproducible). Each set has a `SOURCE.json` next to it recording where it came from |
| `build/x2t/` | Recipe for building the conversion engine from source. **It cannot be built today**; see its README |
| `src/` | **The component itself (AGPL-3.0), the only part of this project meant for distribution.** Every place we changed carries a comment marker starting with `【本项目修改` (modified) or `【本项目新增` (added). The component documentation is in `src/docs/` |
| `src/legal/` | **The legal notice entry in the UI.** It lives in the component rather than the page; see below |
| `demo/` | **The example half, not distributed**: page + back end + plugin + fixtures + automated tests. Probes stay here |
| `demo/server/` | Back end: routing + ticket signing and verification + storage and versioning |
| `demo/plugin/` | Our own ONLYOFFICE plugin |
| `demo/e2e/run.mjs` | Automated tests |
| `embed-poc/` | **An example of embedding this component in someone else's page**: the host page holds the editor in an iframe, and the two sides talk only through `postMessage`. It is self-contained: it depends on no other code in this repository and ships its own servers. It is also a test suite (`npm run poc:e2e`, seven passes, one of them **expected to fail**). Results and pitfalls are in [embed-poc/README.md](embed-poc/README.md) |
| `NOTICE.md` | Modification notice (required by the license) |
| `LICENSE` | Full AGPL-3.0 text + Ascensio's five additional terms |
| `poc/backend-x2t/` | ⚠ **Abandoned, left in place for now.** An experiment with a middle path, running a wasm conversion engine on the back end as well; we decided against it (reasons in `BACKEND.md`). ⚠ The lines in its scripts that read `fixtures/lesson-plan-zh.docx` **no longer point to anything**: the fixtures moved into `demo/` on 2026-08-30 and the abandoned code was not updated. The code itself is fine; only the path is out of date |
| `BACKEND.md` | Which back-end features to implement and which not, measured against the Community Edition container, plus the decision above |

## Three deliberate design choices

**1. The legal notice entry is part of the component, not the page.**
The component is what other people reuse. If the notice lived in the example page, it would be lost as soon as someone reused the component,
and nothing would report it: the next person to reuse it would never know something mandatory was missing.

**2. The conversion engine and its fonts are not placed inside the versioned directory of the static assets.**
They follow two independent version lines: today the engine is based on core 9.3.0.140, while the static assets are 9.4.0.129.
In one directory that difference would be invisible; kept apart, each has its own `SOURCE.json`.
When serving, the back end maps them onto the two URLs the browser expects.

**3. `vendor/` is not in git.**
It is about 1.5 GB and can be reproduced from the image. What pins it is the **image ID** recorded in `SOURCE.json`,
not the image name, because a tag like `9.4.0.1` can be pushed again while an ID cannot.

## Current status

**All 17 automated tests pass** (`npm run e2e`): the fetch gate, fetching from the server and rendering the first screen, typing with a real keyboard,
saving back to the server with the bytes on disk actually changing, rejecting writes without a ticket, four plugin checks (plugin panel / inserting a formula / in-document button / delivering configuration),
the control case with registration turned off, official plugin registration, the two PDF kinds each going to their own app, and the editor and viewer being two different apps.

| Item | Status |
|---|---|
| Static assets extracted from the Community Edition image | ✅ All 5 editor apps present (including PDF and Visio); all 19 `sdkjs-plugins` entries present |
| Official plugins work | ✅ The 11 plugins bundled in the image are registered, and every registered entry can be fetched (the upstream registry is an empty shell, which is the first reason "plugins don't work") |
| PDFs open | ✅ **The two kinds of PDF go to different places**: ordinary PDFs open in `pdfeditor` (view and annotate), while **editable PDFs** generated by ONLYOFFICE itself open in `documenteditor` (fill in and edit). The latter used to be opened as ordinary PDFs, losing editability without any error; fixed on 2026-08-30, see section 10 of [FINDINGS.md](FINDINGS.md) |
| Which formats open | ⚠ **Of the 12 formats the component declares, 11 actually render; `odp` does not** (the wasm conversion engine crashes with `function signature mismatch`). In addition, `epub` crashes and `html` hangs silently. Legacy binary `doc/xls/ppt` open but cannot be exported (ONLYOFFICE only reads them, by design). Full table in section 11 of FINDINGS |
| Conversion engine | ⚠ Uses the prebuilt binary published by CryptPad (checksum verified, 30% smaller than the upstream one), **based on core 9.3.0.140, one release behind our 9.4.0.129**. ⚠ **That gap has a real cost**: a wasm based on a newer core fixes both `epub` and `html`. Building it ourselves needs Linux plus docker; see `build/x2t/README.md` |
| Fonts for PDF export | ✅ All replaced with freely redistributable fonts, and upstream's swapped bold/italic fixed |
| Visio | ⚠ The `visioeditor` app is in the tree, but **no test has touched it yet**. "The files are there" and "it opens" are two different things |
| Production build | ✅ Fixed on 2026-08-30. Before that, `npm run build` always failed (the worker bundle format did not support code splitting), **while dev kept working** (see section 12 of FINDINGS) |
| Viewer | ✅ Added on 2026-08-30 as a `variant` option on the component (editor / viewer), covered by test B16. ⚠ **But it does not reduce download size**: measured cold load for the same document goes from 221.7 MB to 211.9 MB, only 4.4% less, all of it the app shell and plugin panel; the "0.5 MB vs 94.6 MB" on disk does not translate into download size. What it really saves is 265 requests and most of the interactive UI. See section 14 of FINDINGS |
| How much one document open downloads | ⚠ **Cold load 221.7 MB / 437 requests** (warm load 91 KB, so long-term caching is working). Most of it is not the editor UI: the component's preload iframe downloads **the SDKs of all four editors** (only one is used), about 110 MB; Chinese fonts are about 85 MB; and both the unminified and minified builds of the same SDK are downloaded. `npm run measure:payload` measures it again; full table in section 14 of FINDINGS |
| `mobile` / `forms` entry points | ⚠ Still unused, and no test has touched them. The `variant` option only exposes `embed` |
| Release | ⚠ **A complete package that runs can now be assembled** (`npm run release`, tested by running it as if on a target machine: document opens, 2 plugins in the panel, export of 25,518 bytes, all four license links present). The code is published at <https://github.com/yuhaibohotmail/onlyoffice-web>. **It has not been deployed to any machine yet**, and there is no CI |
| The five compliance terms | See below |

### The five compliance terms

| # | Requirement | Status |
|---|---|---|
| 1 | Retain notices and attributions | ✅ Both license texts ship with the assets and can be opened directly from the UI entry |
| 2 | Mark modifications (with dates, stating that it is based on ONLYOFFICE) | ✅ [NOTICE.md](NOTICE.md), also listed in the UI entry |
| 3 | A clearly reachable, prominently visible legal notice entry in the UI | ✅ A permanent button at the bottom right of the editor, which opens original developer / modification notice / license |
| 4 | No trademark rights are granted | ✅ Removed the Microsoft Office icons that had been swapped in and restored the editor's own branding; no white-labeling |
| 5 | Non-code content is under CC BY-SA 4.0 | ✅ Stated in both the UI entry and NOTICE |

**Also AGPL section 13** (not one of the five additional terms, and easy to miss): every user interacting with the program over a network
must be able to **obtain the complete corresponding source of this version free of charge**. ✅ Added on 2026-08-30: the
"Get source code" link in the UI entry points to `/legal/source`, where the back end **builds a tar.gz on the fly** from the project root at runtime
(alternatively, set `OOW_SOURCE_URL` to point at the code repository). That page also states where the other two parts come from:
ONLYOFFICE itself and x2t were not written by us, and without their origins, someone who received the package could not match those bytes to their source.
⚠ Before this was added, the panel only said "under which terms" without providing "the thing itself", **so that half was not met**.

In addition: the fabricated license has been reduced to the minimum (all five switches for commercial-edition capabilities are off, and tests show no loss of functionality).

## Pitfalls

Every item below actually happened. What they have in common is that **the symptom does not point to the real cause**,
so running into one again costs far more time than reading this list once.

**Editor and component**

1. **`#iframe-office-id` does not exist at runtime**: the component replaces that div, and the editor iframe is
   a direct child of `.onlyoffice-container`; there is also a preload iframe on body that has to be excluded.
   Looking it up by id never finds anything, while the Promise for opening the document has long resolved and the page shows ready. **It waits forever without an error.**
2. **First screen rendered ≠ ready to export.** Calling export as soon as the canvas appears blocks for 30 seconds and then throws a timeout; waiting 1.5 seconds first returns in 200 ms.
3. **Export returns `{blob, fileName}`, not a Blob**, and it has an `isOriginalFileFallback` field:
   when a limit is exceeded it returns **the original file as it was opened**. Check this field before saving, otherwise a "saved successfully" silently reverts the user's changes.
4. **None of the three proxies (`/api`, `/packages`, `/plugins`) can be left out.** The editor runs in an iframe,
   and plugins open another iframe inside the editor; if any layer is cross-origin the parent page cannot read anything.
   **The symptom is "the editor never shows up", which looks like the editor is broken.**

**Plugins**

5. **The in-document button is drawn on the canvas**, so searching the DOM for its text always finds nothing. Automation locates it by scanning canvas pixels for the icon color,
   which is why the plugin icon is a solid block of magenta.
6. **Do not issue editor calls inside the button's check function.** The editor accepts only one call at a time, and the bootstrap script
   sends the registration request right after the check function returns; a collision is silently dropped. The control gets created, the event fires,
   the check returns true, **and the button simply never appears**.
7. **Only one handler per event name**: a later one replaces the earlier one, without an error.
8. **Entering a content control selects all of it**, so with the cursor inside, the next insert **replaces** the previous content. Press `Ctrl+End` before inserting.
9. **A plugin's ready signal must be sent to the top window, not the parent window**: the plugin's parent is the editor iframe,
   so a message sent to the parent never reaches the page, while the plugin itself works perfectly.
10. **An icon is required for content control buttons**; without one the editor throws internally and shows "An error has occurred while working with the document", which looks like a corrupt document.
11. **Pasting HTML twice in a row makes the editor stop responding**; queue the pastes and send them one at a time.

**On Windows**

12. Calling `tar` / `unzip` directly from Node picks up the ones bundled with Windows, which report "gzip: stdin: unexpected end of file",
    as if the archive were corrupt. Go through `bash -c` and write paths as `/e/...`.
13. **Backslashes get interpreted along the way when writing files**: inside heredocs and `node -e` strings, `\t` turns into a tab.
    Write large files with an editor; when patching files, **count how many times the anchor matches for every replacement, and stop unless it is exactly 1**.
14. **The component's files use CRLF line endings**, while files newly written for this project use LF. Anchors must use CRLF when patching component files,
    otherwise nothing matches, and the script silently does nothing.
15. Files extracted with tar from a container are read-only, so overwriting them later on Windows fails with a permission error,
    **and the error names the file being overwritten, which makes that file look like the problem**. The extraction script already has a step that clears the read-only flag.

**Testing**

16. **Check the artifact itself, not what the UI says.** To tell whether the server copy changed, **check the bytes on disk**;
    to tell whether the plugin did its work, **check whether the text can be found in the exported docx**.
17. **Reset to the same starting point before every run**, otherwise documents pile up content inserted by previous runs,
    and the free probe "the old version does not contain this text" starts failing at random. **When it fails, everything looks green.**
18. **Negative assertions are free probes**: whenever you assert "the new version contains X", also assert "the old version does not contain X".
19. Exit codes: 0 all passed; 1 some cases failed; **2 = not a single assertion ran**.
20. **After a change, inject a defect once to confirm the assertions still catch it.**

**Measuring payload** (neither reports an error, and the numbers look perfectly reasonable)

21. **Playwright's `newContext()` is an incognito context with only a memory cache and no disk cache.**
    The 20–30 MB `sdk-all.js` files are larger than the memory cache is willing to keep, so none of them get cached,
    and **warm and cold load measure exactly the same**, which looks exactly like the real bug "long-term caching is not configured".
    To measure warm load, use `launchPersistentContext` with an empty profile directory.
22. **`request.sizes().responseBodySize` returns the size of the file itself even on a cache hit.**
    For the bytes on the wire, use CDP's `Network.loadingFinished.encodedDataLength`.

**Changing page styles** (none of these report an error)

23. **Three things about `.onlyoffice-container` must not change**: the class name (the component and every automated test find the editor by it);
    the editor iframe must be its **direct child** (no wrapper elements inside it);
    and it must be positioned (the legal notice entry is absolutely positioned against it; if the container is `static`,
    the entry ends up somewhere else on the page and is no longer "prominently visible").
24. **To place something over the editor area (an empty state, an overlay), mount it as a sibling of `.onlyoffice-container`,
    not as a child.** The component replaces the div inside the container and inserts the iframe directly into the container;
    when React conditionally mounts or unmounts a sibling within the same parent, the `insertBefore` call during commit
    crashes the whole tree. **It does not go through onError, and types and unit tests are all green**; it only shows up when the editor is recreated.
25. **Do not use `height: calc(100% - header height)`; lay out the whole page with flex.** A hard-coded value stops matching as soon as
    the header height changes, and **the mismatch reports nothing**: the editor is either pushed below the viewport or leaves an empty strip underneath,
    which looks as if the editor failed to fill its space. `min-height: 0` on `.onlyoffice-container` is required too:
    flex items by default refuse to shrink below their content.
26. **Checking "is the legal notice entry still visible" cannot rely on width and height alone.** An element completely covered by something else
    still gets a positive width and height from `getBoundingClientRect()`, so the license requirement "prominently visible"
    can silently stop being met after a purely cosmetic change. The check must also ask `document.elementFromPoint`
    whether the topmost element at its center point is the entry itself. The two checks in B16 are written this way,
    and they were confirmed to fail by injecting a transparent overlay.

**Packaging and release** (none of these report an error)

27. **The assembly script can recurse into its own output directory.** `make-release.mjs` writes the package into
    `release/` under the project root, while it copies the source using an exclusion list. If `release` is missing from that list, it copies
    itself one layer inside another until the disk is full, **so deeply nested that neither `du` nor `Remove-Item` can finish** (mirror an empty directory over it with robocopy).
    The same list also governs `/legal/source.tar.gz`; if it is missing there, that "source archive" gets 1.5 GB stuffed into it.
    ⚠ There is **only one** exclusion list (`demo/server/source-archive.mjs`), shared by assembly and source archiving.
    With two copies, the two packages could differ without anyone noticing.
28. **Nothing says a word when `dist/` is older than the source.** The assembled package runs; it just runs the previous front end.
    `make-release.mjs` has a guard for this: if the source is newer than `dist/index.html`, it refuses to assemble.
29. **Do not use a pipeline's exit code as the check.** The exit code of `grep ... | head` is that of `head`,
    so it is 0 even when grep finds nothing. This happened once while checking "did vendor end up in the archive",
    and nearly counted "not verified" as "verified". Extract the count and compare it yourself.

## Known limitations

- **No collaboration, and overwrites happen without an error.** The mock server lives in a single tab, and there is no way in for a second person.
  If two people open the same document and each saves, the later save completely overwrites the earlier one, and both see success.
- **No autosave.** Saving is triggered by clicking a button. If the browser crashes or the tab is closed, all changes are lost.
- **`Ctrl+S` is intercepted** (the component deliberately disables the editor's built-in save); pressing it does nothing and reports nothing.
