# What the back end should do

> English | [中文](BACKEND.zh.md)

This document compares what ONLYOFFICE's own back end does and decides which of those jobs this project's back end should take on and which it should not.

Every statement below about how ONLYOFFICE does something was **measured in a running Community Edition container**
(`onlyoffice/documentserver:9.4.0.1`), not copied from the documentation.
The parentheses after each statement say how it was measured.

> ## Conclusion (decided by the project owner, 2026-08-30)
>
> **The middle path, running wasm on the back end, will not be built.** If you need server-side capabilities, use the standard DocumentServer;
> if you need zero dependencies, use the existing in-browser implementation. **Neither side needs the middle path.**
>
> Three grounds, none of them based on reasoning alone:
>
> 1. **The security motive has been disproved** (section 7): moving to the back end changes the container, not whether the content can be obtained.
> 2. **DS provides every remaining benefit of C, with no gaps**: our wasm build cannot read three formats (epub / fb2 / odp)
>    and hangs on html; the native x2t in the container handles all four correctly
>    (the epub / html / odp files in `fixtures/formats/` were converted by it).
> 3. **DS is not a fallback option; it is something that already exists**: wherever an ONLYOFFICE Document Server (9.4.0.1)
>    is already deployed and available, it is a ready-made document engine.
>    Its overhead has also been measured: **50 concurrent editing connections add only 30 MiB to the container** (0.29–0.32 MiB per connection),
>    and 25 people typing continuously use 3.4% CPU on a 2-core test machine. In the words of the measurement notes:
>    "the test rig gives out first, not DS".
>
> Therefore **the whole ordered table in section 5 is void**: do not do steps 1 / 2 / 4 / 5;
> step 3 (the collaboration session) is done by DS itself if you use DS, so it is not needed either.
> The split into blocks and the criterion in sections 1 to 4 still hold. **They are kept because they are the grounds for why this is the right choice.**
>
> ⚠ **The question that really needs asking again is not this one, but "then why does onlyoffice-web still exist"**. See section 8.

---

## 1. What ONLYOFFICE's back end actually does

It has only **two processes**, with a layer of nginx in front:

```
ds:converter     RUNNING          ← C++, format conversion and rendering
ds:docservice    RUNNING          ← Node.js, collaboration sessions and host integration, listens on 8000
ds:example       STOPPED          ← example host, not part of the product
ds:metrics       STOPPED
```
(`supervisorctl status`; `ss -ltn` shows that only 80 and 8000 are listening in the container)

The work of these two processes splits into three blocks by **who needs it**. This split is the basis of every conclusion below:

| Block | Who does it | What it is concretely |
|---|---|---|
| **A · Host integration** | docservice | Fetching the original file from the host and saving it back to the host (the `callbackUrl` callback), JWT signing and verification, `/command` (forcesave / drop / info), `/ConvertService.ashx`, orchestration of permissions and versions |
| **B · Collaboration session** | docservice | The WebSocket protocol: `auth` / `openDocument` / `saveChanges` / `getLock` / `releaseLock` / `isSaveLock` / `unSaveLock` / `rpc`, broadcasting changes, lock ownership, when to save |
| **C · Conversion and rendering** | converter | x2t + doctrenderer + the parsing libraries for each format |

Laid out on disk, block C looks like this (`ls FileConverter/bin/`):

```
x2t                    libdoctrenderer.so     DoctRenderer.config
AllFonts.js            font_selection.bin     fonts.log        ← font index
libPdfFile.so          libDocxRenderer.so     libEpubFile.so
libFb2File.so          libHtmlFile2.so        libHWPFile.so
libDjVuFile.so         libXpsFile.so          libIWorkFile.so
libOFDFile.so          libStarMathConverter.so                 docbuilder
```

**`DoctRenderer.config` deserves a separate look**, because it lists word for word which files are needed to "run sdkjs where there is no browser":

```xml
<file>../../../sdkjs/common/Native/native.js</file>
<file>../../../sdkjs/common/Native/jquery_native.js</file>
<allfonts>./AllFonts.js</allfonts>
<file>../../../web-apps/vendor/xregexp/xregexp-all-min.js</file>
<sdkjs>../../../sdkjs</sdkjs>
<dictionaries>../../../dictionaries</dictionaries>
```

**These are exactly the files that `poc/backend-x2t/probe-render.mjs` already loads**, so that approach was not a guess;
it follows ONLYOFFICE's own list. ⚠ But we took a wrong turn in one place: the `<allfonts>` here refers to
**`FileConverter/bin/AllFonts.js`**, not `sdkjs/common/AllFonts.js`, and it comes with a
`font_selection.bin` next to it. That is a font index generated separately for the converter. **The answer to the step where the PoC got stuck is very likely here.**

### About the claim that "DocumentServer is heavy"

In the default configuration it does require three external dependencies: PostgreSQL (`localhost:5432`), RabbitMQ (`amqp://localhost:5672`),
and Redis (lines 150 / 371 / 417 of `default.json`).

**But none of these three processes exists in this container** (`ps -eo comm` shows only nginx / docservice / converter / cron /
supervisord), `healthcheck` returns 200, and the log says `embedded converter started`.

⚠ **Do not conclude from this that production does not need them either.** I only verified the health check and fetching resources; **multi-user collaboration was not verified**,
and those three exist precisely for sharing sessions and task queues across multiple instances. This is recorded here only so that "three middleware services must be set up first"
is not taken as a given.

---

## 2. How we divide the work today

The same three blocks, and where each one sits:

| Block | Where ONLYOFFICE puts it | Where we put it today | How much code |
|---|---|---|---|
| A · Host integration | docservice | **`server/` (3041)** | 750 lines, zero dependencies |
| B · Collaboration session | docservice | **In the browser tab** | `internal/editor/server.ts`, 2413 lines |
| C · Conversion and rendering | converter | **In the browser** | `x2t.wasm`, each visitor downloads 6.8 MB, which decompresses to 36 MB |

What `server/` provides today is **two capabilities, and every other endpoint serves these two** (its own header comment):

- Fetch: `GET /api/internal/download/{docId}/{cacheKey}/{name}?token=`
- Save: `POST /api/documents/{docId}/content`
- Plus: session token signing and verification (`jwt.mjs`, 900 seconds for sessions / 300 seconds for fetches), writing to disk and versioning
  (`storage.mjs`, **every save writes a new version file; old versions are never overwritten**), and read-only serving of
  `/packages/**` `/legal/**` `/plugins/**`

**Its path names were modeled on the API shape of a real document-management back end** (the header comment of `server/index.mjs` says so explicitly).
In other words, **block A belongs to the document-management back end of whatever application hosts this component, not to this project**.
The auth / tenant / document / storage / version / editor / audit / webhook set of such a back end
does exactly the job that ONLYOFFICE calls "the host". These 750 lines are a small imitation of it;
they exist so that this repository can run and verify itself on its own, **not to become a product back end**.

The project plans it this way too: the third item in `NEXT-SESSION-PROMPT.md` is moving `server/` into
`demo/`, on the grounds that "the component is the only thing to be published; the demo's probes should not be shipped with it".

---

## 3. What this division costs today

These are not abstract drawbacks. They are the three already listed under "Known limitations" in README.md, plus two newly measured by the PoC:

| Symptom | Where the cause is |
|---|---|
| **No collaboration, and overwrites happen without an error.** Two people each save, the later save completely overwrites the earlier one, and both see success | B is in the tab. One tab cannot see another tab |
| **No autosave**; if the browser crashes, all changes are lost | Same as above: there is no session living on the server |
| **`Ctrl+S` is intercepted**; pressing it does nothing and reports nothing | Same as above |
| Every visitor has to download 6.8 MB of wasm and decompress it to 36 MB | C is in the browser |
| **The server knows nothing about document content**: what it receives is a pile of bytes. It cannot produce preview images, cannot do full-text search, cannot convert in batches, cannot validate on upload | C is in the browser |

---

## 4. The criterion: what should move to the back end

**Do not copy ONLYOFFICE's module table.** Use a criterion you can apply yourself:

> **Does this thing need an answer that "all clients agree on"?**

If it does, it must be on the server; if it does not, it can be anywhere, depending on cost.
Cut along this line, and the three blocks A / B / C come out completely differently.

### Tier 1 · Must move (not moving it is wrong, not just slow)

**Only block B.** And the whole of B is that the answers to three questions must be unique:

1. The **order** of `saveChanges`: whose change comes before whose
2. The **ownership** of `getLock`: who is allowed to edit this section right now
3. **Which version the edit is based on**: `storage.mjs` already has version numbers; what is missing is "which version this submission grew from"

These three live in the tab today, so "two people open the same document" **cannot work at the architecture level**.
It is not unfinished; it cannot be done.

### Tier 2 · ~~Should move~~ **Do not move; use DS** (changed 2026-08-30)

**This tier originally said "C should move". That is void; the reasons are in the conclusion box at the top.** The original text is kept below,
because the points about "what moving it would gain" are still true. It is just that **DS provides all of them too, and has no format gaps**.

**Block C. The PoC has already shown it is feasible** (`poc/backend-x2t/`): conversion between 12 formats, tens of milliseconds per conversion,
pure Node, zero npm dependencies. Moving it would gain four things we do not have today:

- **Convert on upload**, without waiting for someone to open the file
- **Batch and offline conversion**, without using the user's browser
- **Clients no longer download those 36 MB** (first screen, weak networks, low-end devices)
- **PDF converted back to editable Word** (measured in the PoC; Chinese text survives intact)

⚠ **It is not a security benefit; do not count it as one.** After the move, what the browser receives changes from docx to `Editor.bin`;
**what changes is the container, not whether the content can be obtained**. See the measurement in `poc/backend-x2t/probe-what-browser-gets.mjs`:
the body text in the bin is plain UTF-16LE (30 lines of JS read it out); the author metadata and `w:vanish`
hidden text from the original file **go along with it unchanged**; converting back to docx needs no extra tool either, **because the browser already carries that x2t.wasm**,
which is exactly what the export button does. The real DocumentServer sends content the same way
(`urls['Editor.bin'] || urls['origin.' + documentFormat]`, see `sdk-all-min.js`),
and it even keeps a fallback that sends the original file directly. Details in section 7 below.

⚠ **Moving it must come with one rule**: run each conversion in a process or worker that can be killed.
The `html` cell was measured **not to fail but to never return**: `main1` is a synchronous wasm call,
and once inside it, nothing in the same process can interrupt it. A single bad document can hang the entire conversion service,
and there is no way to tell which document it was.

**Server-side PDF / preview images** are the second half of the same block. The approach has been verified to work (the editor core starts in Node,
and the document model loads), but it is stuck on loading fonts, and section 1 above already pointed out where ONLYOFFICE keeps the answer.

### Tier 3 · Should not move (ONLYOFFICE has it, we do not need it)

- **The PG + RabbitMQ + Redis set**: DS uses them to share sessions and task queues across multiple instances.
  We are single-instance with low concurrency; an in-process queue plus one table is enough to start with. This layer can be added later;
  copying it from the start only gets you three middleware services to operate.
- **Callback-based integration** (`callbackUrl` + `/command` + `ConvertService.ashx`): that protocol was
  designed for "I do not know the host system". **Our host is ourselves**, so calling directly is an order of magnitude simpler than going through HTTP callbacks.
- **The whole of block A**: that is the job of the host application's own document-management back end; do not build a second copy here.

---

## 5. ~~Suggested order~~ **The whole table is void** (2026-08-30)

This used to be a five-step table: move conversion → convert on upload → move the collaboration session → hook up fonts and produce PDF → preview images.
**None of the five steps will be done**; the reasons are in the conclusion box at the top. The remains are left here so that the next person knows
**this path was followed and rejected**, not that nobody thought of it.

| # | Original plan | Now |
|---|---|---|
| 1 | Move conversion into `server/` | Not done. DS's `/ConvertService.ashx` already is this, and has no format gaps |
| 2 | Convert on upload and write `Editor.bin` to disk | Not done. DS does this itself (`urls['Editor.bin']`) |
| 3 | Move the collaboration session out of the tab | Not done. **If you use DS, this block is DS itself** |
| 4 | Hook up fonts, produce PDF on the server | Not done. It amounts to rewriting doctrenderer in Node to replicate a binary **that Document Server already ships** |
| 5 | Preview images / thumbnails | Not done. Same as above; and a separate preview service (e.g. kkFileView) can already do previews |

**`poc/backend-x2t/` stays**: it is the evidence for this negative conclusion, and all three scripts can be rerun.
The next time someone asks "can the wasm move to the back end", the answer comes with data rather than impressions.

---

## 6. Three facts measured along this path (the plan is void, but do not lose these three)

**1. `server.ts` cannot be moved; it is not a matter of "a few tweaks".** It contains 16 DOM references. Most are easy to replace
(`window.setTimeout`, `Blob`, `URL.createObjectURL`), but one of them **really uses canvas to rasterize SVG**
(line 287, `document.createElement("canvas")` → `drawImage` → `toBlob`),
which is the fallback for image formats x2t cannot handle. **This has now become a reason in favor of "do not move it"**:
if anyone proposes "move the collaboration session to Node" again, these 16 places are a cost to count first.

**2. Do not let the role of `server/` drift.** The project plans to move it into `demo/`
(the third item in `NEXT-SESSION-PROMPT.md`). Now that the back-end path is not being pursued, its role is even clearer:
**it is the demo's self-verification tool, not a product back end, and it should not grow new capabilities.**
Host integration on the product side is the job of the host application's own document-management back end.

**3. The licensing point is independent of whether a back end is built, and still holds.** The whole `src/` tree is AGPL-3.0.
As long as this component is handed to others to use (every case in section 8 is like that),
the two rules in README.md that we do not break stay in force. In particular the first one, "Having accepted the AGPL, we comply with it for real":
the legal notice entry in the UI is a hard requirement.

---

## 7. "Moving to the back end keeps the original content away from the browser": does not hold

This gets its own section because it looks very much like a side benefit of C, and **it is not**.
Measurement script: `node poc/backend-x2t/probe-what-browser-gets.mjs` (it brings its own fixture with metadata and hidden text).

After the move, what the browser receives is indeed no longer that docx but `Editor.bin`. But for someone holding `Editor.bin`:

| Question | Measured |
|---|---|
| Can the body text be read? | **Yes.** Plain UTF-16LE, not encrypted or obfuscated. 30 lines of JS pull out "八年级数学 · 一次函数 教学设计" ("Grade 8 Mathematics · Linear Functions · Lesson Plan") directly |
| Is what the original file does not display still there? | **Yes.** Author metadata and `w:vanish` hidden text **go along word for word**. Server-side conversion is not a sanitization step |
| Can it be restored to docx? | **Yes.** 8912 bytes, 147 body characters. And **no extra tool is needed: the browser already carries that x2t.wasm**, which is exactly what the export button does |

**The real DocumentServer sends content the same way**, and it does not try to prevent this:

```js
var documentUrl = urls['Editor.bin'] || urls['origin.' + t.documentFormat];
```
(`sdkjs/word/sdk-all-min.js`): **it prefers sending the bin, and if that is not available it sends the original file directly**.

### Root cause

**The editor lays out and renders in the browser, so the document content must reach the browser.** This is not an implementation choice; the architecture dictates it.
As long as text is visible on the page, the client already has that text. Any "no download / no copy" is a deterrent, not a boundary.

### Then what can actually stop it

First decide whether you need "can edit" or "only needs to view":

| What you need | Can it be done? | Cost |
|---|---|---|
| Can edit, and the browser cannot get the content | **No.** Do not spend time on it | — |
| Only needs to view | **Render to pixels on the server; the browser receives only images.** Use DS or kkFileView; do not write your own | Cannot select and copy, cannot search, large size; ⚠ screenshots and OCR can still recover the content |
| Only needs to view, but sending PDF would be easier | ⚠ **PDF does not count.** The text inside is extractable; sending PDF is sending text | — |
| Reduce the consequences of a leak | Watermarks + audit trail, turning "prevent leaks" into "traceable" | Does not stop a determined person, but changes the cost |
| Truly sensitive content | **Keep it out of this document.** Classify it; sensitive passages take another route that never reaches a rich-text editor | Requires changing the business process, not the architecture |

---

## 8. Then why does onlyoffice-web still exist

After rejecting back-end wasm, this is the question that really needs asking. **Its answer is not on the "light / heavy" axis**:
ranked by weight, DS measures as not heavy at all (50 concurrent connections add 30 MiB), so this axis does not separate anything.

The criterion is a different one:

> **Can this page tolerate "opening a document requires first establishing a session with a service"?**

| Can tolerate | Cannot tolerate |
|---|---|
| Use **DS**. Its overhead has been measured; wherever DS is already deployed and the host's document back end is already connected to it, there is zero new work | Use **the in-browser version**. The cost is no collaboration, gaps in four formats, and 36 MB per person |

Which cases count as "cannot tolerate" is worth pinning down; otherwise this project will slowly try to do everything for lack of a boundary:

1. **The editor has to be handed to others**: third parties or other teams use this component, and you cannot require them to deploy a 1.3 GB container first.
   This is the shape of a reusable front-end component package, and it is also the positioning stated in the first sentence of this project's README.md.
2. **Pure static hosting**: copy the build output to any static server and it runs, with no back-end process.
3. **Offline or disconnected demos**.
4. Embedding a **read-only preview** in a host application, without going through the whole "create session → issue token → register callback" sequence for a single preview.

⚠ **Case 4 is the one that most needs re-weighing today.** "Add a viewer option", the first item in `NEXT-SESSION-PROMPT.md`,
is aimed at it, and its premise is "the host application cannot get DS". **That premise does not hold wherever DS is already available.**
For an environment where DS is not yet deployed, installing one is a matter of deployment configuration, not a new engineering project.

So before building that tier, answer one question first: **is saving that one session worth maintaining a second path for opening documents?**
Answering "yes" is entirely defensible (the first three reasons are real), but write it down;
otherwise, six months from now nobody will be able to say how this project relates to DS.
