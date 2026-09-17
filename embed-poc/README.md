# embed-poc — embedding this component in someone else's page

> English | [中文](README.zh.md)

A **self-contained** example: a host page holds this editor in an iframe, and the two sides talk only through `postMessage`.
The document is fetched from an address the host provides and, after editing, saved back to an address the host provides.

It is also six live tests, each answering a question you cannot answer without running it (readings are below under "What was measured").

```sh
npm run poc:build     # build the three pages → embed-poc/dist/
npm run poc:e2e       # start the servers, run all seven passes, stop (one of the passes is **expected to fail**)
```

Running the parts individually:

```sh
npm run poc:plugins                     # pregenerate the plugin registry (the step that belongs at deployment time)
npm run poc:static -- 3042              # dumb static server (stands in for nginx)
npm run poc:mock   -- 3043              # mock backend (stands in for the document service; also serves the host page)
node embed-poc/probe/static-check.mjs   # then open http://127.0.0.1:3043/ in a browser
```

---

## Two hard constraints

These two are not a matter of style; they are the preconditions for this PoC proving anything, and for other people being able to use it.

**① Self-contained: depends on no existing code in this repository, and brings its own backend services.**
It does not reuse `demo/server/`, does not modify `demo/App.tsx`, is not a second entry point of `demo/`, and does not use `scripts/`.
It consumes only two things: **the component itself** (`src/`) and **the static assets** (`vendor/`).

⚠ This directly determines whether the conclusions hold. `demo/server/` **generates the plugin registry on the fly for each request**
(replacing the relative addresses in the on-disk copy with absolute addresses). Using a server that rewrites the registry to check
"can plain static hosting serve the plugin panel?" only tests that server itself.

**② Knows no specific backend.** The contract (`src/protocol.ts`) states only four neutral things:
where to fetch the file, where to save it, which version this is, and which headers to send with requests.
Write one vendor's backend endpoints or data shapes into it, and this component goes from "anyone can embed it" to "works only with that one vendor".

---

## What it consists of

| | |
|---|---|
| `src/protocol.ts` | **The entire agreement between host ↔ embed page**. The two sides talk only through this one file |
| `embed.html` + `src/embed.ts` | **Embed page** — the one that lives inside the iframe; the actual deliverable of this PoC |
| `index.html` + `src/host.ts` | Host page, standing in for a future business application. It has a switch that is **deliberately wrong**, see below |
| `static-check.html` + `src/static-check.ts` | Opens only a blank document, **zero fixtures, zero mocks**; answers question 1 on its own |
| `server/static-server.mjs` | **The dumb half**, stands in for nginx. It only serves files; **there is not a single line of code that rewrites content** |
| `server/mock-host.mjs` | The mock half, stands in for the document backend. It also builds a minimal docx on the fly (with its own zip writer) |
| `server/pregenerate-plugins.mjs` | **The step that belongs at deployment time**: replaces the relative addresses in the plugin registry with absolute paths |
| `plugin/` | This PoC's own minimal plugin — **it only displays the `options` it receives**, which is the only channel for the host to pass credentials to a plugin. The icon is drawn on the fly by `make-icon.mjs`; no binary is committed |
| `probe/*.mjs` | Six live tests + a `run.mjs` that chains them together |

**The two backends are two separate processes, not merged.** They stand in for two different things (nginx / document backend)
and answer two different questions. Once merged, "the plugin panel appeared" can no longer tell you whether the static half was enough
or the mock half added something extra. **And only separate processes give you cross-origin** — which is exactly what a real deployment looks like.

---

## What was measured (2026-09-04)

### 1. Can this be served as plain static files? — **Yes, but the plugin registry must be pregenerated**

The on-disk `plugins.json` contains relative addresses (`sdkjs-plugins/{GUID}/config.json`).
**The editor resolves them under its own application directory**:

```
/packages/onlyoffice/<version>/web-apps/apps/documenteditor/main/sdkjs-plugins/{GUID}/config.json  → 404
```

while the files actually live at `<root>/sdkjs-plugins/{GUID}/config.json`. The same set of files, two cases compared:

| Registry | Files present on disk | **Entries the editor fetched** |
|---|---|---|
| As on disk (relative addresses) | 11/11 present | **0 / 11** |
| Pregenerated at deployment time (absolute paths) | 11/11 present | **11 / 11** |

⚠ **This failure is completely silent**: the document opens as usual, exports as usual, the legal notice entry point is still there;
only the plugin panel is empty. The 11 404s in the console are the only trace.

**So `pregenerate-plugins.mjs` must be run once at deployment time.** It is somewhat better than the `demo/server/` approach:
`demo/server/` builds a **full address** from the Host of each request (it faces arbitrary Hosts, so that is its only option),
whereas at deployment time we know which path the build output is mounted under, so it writes only **paths starting with a slash** —
no scheme, domain or port, so **changing the domain, changing the port, or switching http to https does not break it**.
⚠ It still contains the **mount prefix**, so the script takes a `--prefix`.

> This case is covered by pass ⑦ of `run.mjs`, and that pass is **expected to fail**. If it passes, something has gone wrong.

### 2. The embed page chain — works, all 11 assertions pass

Real keyboard typing → export → save back, with the check based on **the bytes on the server side**:
`1401 → 25172 bytes`, version `1 → 2`, after unpacking the new version **it really contains the marker typed this time**,
**the old version does not** (negative assertion), and the seed sentence is still there.

### 3. Credentials are requested fresh each time — yes, and the control group really fails

3 requests in one session, 3 mutually distinct credentials.
After switching to the "get one at the start and use it throughout" variant, **the save is rejected with 401**.

⚠ The real-world counterpart of this failure is **token expiry**: editing a document has no time limit, but tokens do.
The mock replaces "expired" with "invalidated after one use"; the failure is exactly the same, but visible within one second.
So the embed page **requests a fresh one from the host right before every request it sends**,
and the contract **has no place at all to put a token** — you cannot write the "receive one at the start and keep it" mistake.

### 4. Upload is refused when export falls back to the original file — yes, and not a single byte changed on the server

With the size limit pushed down to 1 byte, `exportAsBlob()` returns **the original file as it was opened**
(the only difference is one extra field, `isOriginalFileFallback`, in the return value). The embed page recognizes it and refuses to upload;
the mock still shows "version 1, 1401 bytes".

⚠ The consequence of not checking that field is of the worst kind: the server stores the unchanged bytes, the version number moves forward as usual,
the page shows "saved successfully", **and all of the user's changes from this session are lost**.

⚠ That gate sets its flag at **open** time (the limit is exceeded when x2t converts the input), not only at export time.
So a document over the limit could not be opened, or not fully opened, in the first place — this test **does not require the editor to appear**.

### 5. The custom plugin channel — works, and can carry configuration

Plugins have **two channels that are unrelated to each other**; do not mix them up:

| | Channel 1: static registry | Channel 2: editor configuration |
|---|---|---|
| What it installs | The 11 official plugins bundled with the image | **Our own plugins** |
| Can it deliver configuration | **No** (there is no `options` field) | **Yes** — `options` is the **only** channel for the host to pass configuration to a plugin |
| Affected by "plain static" | **Yes** (see section 1 above) | **No** — it does not go through that static host at all |

In a real deployment, the credentials a plugin needs to access its own backend go in `options`,
so **channel 2 is the one that matters when connecting to a real backend**. This PoC includes a minimal plugin
(`plugin/`) that does only one thing: display the `options` it receives and report them to the outermost page.
Measured: the `{来自:"宿主页", 记号:…}` that the host put in arrived unchanged.

⚠ **The `Asc.plugin.info.options` that the editor hands to the plugin already has the guid level stripped off.**
The host puts `options: { "<guid>": {…} }`, and what the plugin reads is `{…}` directly.
The first version of the check read it as nested and got `undefined` — **at that point the first two assertions were green,
which looked like "received, but with the wrong content", when in fact the check itself was written wrong**.

⚠ The plugin's **guid is read from its own `config.json`; the host side does not write a second copy**.
If each side wrote its own copy and the guid were changed without the host following — the plugin would still register,
but `options` is keyed by guid, so a mismatch means **the configuration is not received and no error is reported**.

⚠ The icon is **required**. If it is missing, the editor throws internally, and the outside shows "error while using the document", which looks as if the document is broken.
The icon here is drawn on the fly by `plugin/make-icon.mjs` (32×32 magenta); no binary is committed.

⚠ **`isInsideMode` decides only the appearance, not the channel**: `true` docks the plugin in the panel on the left side of the editor
(same as `demo/plugin`), `false` opens it as a centered modal dialog. In both forms `options` is delivered all the same.
**But choosing `false` breaks other tests**: the dialog covers the document body, and the save test clicks the mouse at coordinates and then types on the keyboard,
so the click lands on the dialog and the text does not go into the document body — **and of all the assertions in that run, only "the new version contains the marker typed this time" failed**:
the save succeeded, the version moved forward, and the bytes really changed. If the check had been "saved successfully", that pass would have been all green while verifying nothing.

### 6. Both origin checks — both are blocking

Declare trust only in another origin, then send a message from this page → ignored;
control group (declare trust in this page's own origin) → accepted. Only the control group shows that the first result is not vacuously true.

### 7. The four legal notice links really lead somewhere — they do now, and **the need for this was only discovered while building this PoC**

⚠ **In the plain static setup, the dumb server originally did not serve a single `/legal/*` path** — meaning
all four links were 404, **while the page still opened without reporting a single error**.
Additional term 3 of the license requires that "users can obtain the license information",
and **an entry point that leads to a 404 when clicked is the same as having no entry point**.

Two things were added:

- The static server got three more mounts. The two original license files **are already in the static asset tree**
  (`<root>/LICENSE.txt` and `3rd-Party.txt`; one nginx alias is enough),
  while the third, `NOTICE.md`, is at the repository root and **must be copied separately into the deployment directory at deployment time**.
- The fourth, "Get source code", cannot rely on a static file: by default it points to `<legalRoot>/source`,
  which requires a backend to **build a source archive on the fly**, and in plain static hosting there is no such process.
  So the component gained a new field, `registerLegalNotice({ sourceUrl })`; the embed page registers it before creating the editor,
  pointing to the public repository. ⚠ In a real deployment it must point to **the tag that matches the deployed version** —
  "the repository contains a newer version" does not satisfy "this version" as stated in section 13 of the license.

⚠ **The existing tests cannot catch this**: B16 in `demo/e2e/run.mjs` only asserts that the button
**exists and is not covered**, and never opens the links. This repository really did break once because of this
(the dev Vite config was missing the `/legal` proxy, all four links were 404, and every test was green).

### 8. Disabling download and Save As (added 2026-09-17) — can be disabled, saving is unaffected

The open command gained a new field, `allowDownload` (not given = allowed, the same as before it was added). When set to `false`,
the component sets `download` to false in the permissions it gives the editor, and the File menu has no "Download as" and no Save As panel.

⚠ **The difficulty is that the component's own export also goes through `downloadAs`**, and when any of the four editors receives this command, the first thing it does is check the download permission,
refusing if it is absent. Turning off only the permission would also turn off saving. So during export the component temporarily sets
`appOptions.canDownload` on the editor's `Main` controller to true and restores it after the export (`grantDownloadForExport` in `editor-manager.ts`).

Readings were measured with a separate host page used for manual testing (not part of this repository); **the automated passes here do not cover this option**:

| What was checked | Result |
|---|---|
| Read-only and edit mode for docx / xlsx / pptx, read-only for OnlyOffice form PDFs and plain PDFs, with the File menu opened | None of the 8 cases show "Download as" or the Save As panel; 0 browser downloads throughout |
| Control group: the same 8 cases switched back to allowed | All 8 show "Download as" — the previous row is not vacuously true |
| Editing and saving back with download disabled (docx / xlsx / pptx) | The saved bytes contain the text typed this time; the version number moves forward |
| Probe: remove only the "temporarily allow" line, in the test browser only | 30 seconds after saving, the export fails with a timeout and the version number does not change — that line is required |

⚠ **It only removes the entry points in the interface; it does not stop a determined person**: the embed page has to fetch the whole original file into the browser to open it, and it can still be seen in the developer tools.

Two other changes were made along the way, both found during this work:

- **The embed page must tell the host when export fails.** Previously, when `exportAsBlob()` threw, the error was swallowed by the `.catch(() => {})` in the message handler;
  the host received nothing at all and stayed at "saving" forever. Now it sends a `failed` message (`stage: "export"`). The probe above reported the failure on the spot because of this.
- **The dumb static server gained a type for `.htm`.** Without it, opening the editor's "File" menu makes the browser download a `ProgramInterface.htm`
  (a help page the editor loads in the background; served as `application/octet-stream`, it was treated as a file). In nginx's default type table, htm is already text/html.
  The type table in `demo/server/` was missing the same line, and it was added there too.
  ⚠ **After the fix, browsers that opened the page before will keep downloading**: that tree is served with a one-year immutable cache, so the wrong response, together with its type, is already stored in the browser cache,
  and the browser no longer asks the server (measured: after the fix, the same browser profile still downloaded, and the request never reached the server; a fresh profile did not download). Clear the cache once in that browser.

---

## Three things discovered while building this PoC

**1. The host cannot reach anything inside the iframe, so the protocol must have a "save now" command.**
The first version of the host was written like this: `iframe.contentWindow.__embed.save()`.
The embed page and the host are **almost certainly on different origins** (the embed page has to be same-origin with that large set of static assets, while the host is the business application);
reading a property across origins gives `undefined`, and `undefined?.save?.()` is valid
— so **clicking save does nothing and reports no error at all**.

**2. Checks that count "number of times" produce numbers that cannot be explained.**
"The editor fetched every entry in the registry" was first compared by number of requests, and the result was `12/11`
— the editor fetches the same config entry more than once. Counting by **set** is what actually asks that question.

**3. If the static server does not send the cross-origin header, plugins are silently not delivered.**
The host is on one origin and the plugin config on another; the host has to `fetch` that config.json to read the guid.
Without `access-control-allow-origin`, that fetch fails straight away with `TypeError: Failed to fetch`,
and the host writes it to the log and skips the plugin — **nothing is missing on the page, there are just no plugins**.
So this one response header was added to the dumb server (**it is a header, not a content rewrite**; nginx is commonly configured this way too).
⚠ In production, a same-origin deployment (where another application owns the site root and this project is mounted under a path prefix such as `/oow`) does not need it, because the two sides are then same-origin.

---

## Known limitations

- **Simultaneous editing by several people is not supported.** If two people each save, the later save completely overwrites the earlier one.
  The `baseVersion` field in the contract gives the backend a chance to say something before overwriting;
  **it is a mitigation, not a fix**: the second person still loses their own work unless they export first.
- **No autosave.** Saving is triggered by a person clicking a button.
- The mock backend here is **only a stand-in**; its credential logic (invalidated after one use) exists so that the tests have something to check,
  and is not behavior that any real backend should have.
