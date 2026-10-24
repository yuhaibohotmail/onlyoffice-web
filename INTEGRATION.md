# Embed protocol v2 and the backend it needs

> English | [中文](INTEGRATION.zh.md)

This is the contract between the **embed page** (`embed-poc/embed.html`, in this repository) and an
**integration backend** (not in this repository). Anyone may implement the backend, in any language;
the embed page relies on nothing but what is written here.

Version 2 is for hosts that already speak a **subset of the ONLYOFFICE Docs integration protocol**: they sign an
editor configuration, serve the file at `document.url`, and take saves on `callbackUrl`. To such a host, embed
page + backend look like one more document server. It is the only version the embed page speaks: version 1 (the
host handed the page URLs and request headers, no backend) was removed in 0.3.0.

## 1. Who does what

| Party | What it is | Written by |
|---|---|---|
| **Host** | The application that owns the documents. Signs the config token, serves `document.url`, answers the callback | the integrator |
| **Embed page** | Runs the editor in the browser (conversion is in WebAssembly, in the browser). Talks to the host page by `postMessage` and to the backend over HTTP | this repository |
| **Integration backend** | A small HTTP service. Verifies the config token, hands the page a session credential, fetches the file with a request signature, stages saved files and calls the host back | the integrator |

The backend does **no conversion and no collaboration**. It contains no code from this repository, so the
licence of this repository does not extend to it. It only moves bytes and checks signatures.

```
host page            embed page (iframe)            integration backend                 host server
   │  open{token}  ──▶   │
   │                     │  POST /api/session {token} ──▶ verify token
   │                     │  ◀── session, mode, allowDownload, baseVersion …
   │                     │  GET /api/document ─────────▶  GET document.url (signed) ───────▶
   │                     │  ◀──────────── bytes ────────  ◀──────────────────────── bytes ──
   │                     │  (convert + edit in the browser)
   │  save  ─────────▶   │  POST /api/save (bytes) ────▶  stage the bytes
   │                     │                                POST callbackUrl {token} ────────▶
   │                     │                                ◀── GET <staged url> (signed) ─────
   │                     │                                ◀── answer {error:0, version} ─────
   │  ◀─ saved / failed  │  ◀── new session / refusal ──
```

## 2. The config token

An HS256 JWT signed by the host with a secret it shares with the backend (the counterpart of ONLYOFFICE Docs'
JWT secret). Its payload **is** the editor configuration, as in ONLYOFFICE Docs. The embed page never parses
it; it passes it to the backend unchanged.

| Field | Required | Meaning |
|---|---|---|
| `document.url` | yes (`http`/`https`) | The only URL the backend ever fetches the file from |
| `document.key` | yes | Document identifier; sent back in every callback of this session |
| `document.fileType` | yes | `docx`, `xlsx` or `pptx` (the formats this component opens and saves; the page refuses anything else) |
| `document.title` | no | File name shown in the editor and used when the user saves a local copy |
| `document.permissions.edit` | no | `false` → read-only session |
| `document.permissions.download` | no | `false` → the editor hides download and Save As (`allowDownload: false`). See section 7 |
| `document.baseVersion` | no | **Extension field.** The host's own optimistic-concurrency version number (an integer it defines). Copied unchanged into the callback so the host can refuse a save based on a stale version |
| `editorConfig.callbackUrl` | yes when editing | Where saves are sent |
| `editorConfig.mode` | no | `view` → read-only. Default `edit` |
| `editorConfig.user.id`, `.name` | no | The author, reported in the callback |
| `editorConfig.lang` | no | UI language (`zh`, `zh-CN`, `en`, `en-US`, …; only `zh` and `en` are distinguished) |
| `editorConfig.plugins` | no | Passed to the editor untouched |
| `exp` | yes | Expiry (seconds since the epoch). The token only has to live until the page has opened the session; a few minutes to 20 minutes is usual |

**Only the token counts.** The `open` message may carry other fields; none of them is read, by the page or by
the backend.

## 3. Embed protocol v2 (host page ↔ embed page)

Messages go through `postMessage`. Both sides must pin the other's origin: the host posts with the embed
page's origin as `targetOrigin` (never `"*"`), and the embed page only accepts messages from the origin given
in its `hostOrigin` query parameter.

Protocol name: `onlyoffice-web-embed/2`. Every message is `{ "protocol": "onlyoffice-web-embed/2", "type": …, … }`.

| Direction | `type` | Fields |
|---|---|---|
| host → page | `open` | `token` (the config token); `backendUrl?` (see below); `officeXmlLimitBytes?`; `lang?` (a UI preference; the token's `editorConfig.lang` wins) |
| host → page | `save` | – |
| host → page | `download-unsaved` | – . Save the copy that was refused last time to a local file (section 6) |
| page → host | `ready` | `protocols: ["onlyoffice-web-embed/2"]` |
| page → host | `opened` | `mode` (`"edit"`/`"view"`), `allowDownload`, `baseVersion` (all from the verified token) |
| page → host | `saved` | `version` (from the host's callback answer, or `null`), `size` |
| page → host | `failed` | `stage` (`open`/`session`/`download`/`export`/`save`/`download-unsaved`), `message`, `status?`, `body?`, `from?` (`"host"`/`"backend"`), `unsavedKept` |

**`backendUrl`**: the part in front of `/api/…`. Absolute, or relative to the embed page. When omitted, the
backend is assumed on the embed page's own origin and path prefix: a page served at `https://example.com/oow/embed.html`
calls `https://example.com/oow/api/session`. That is the intended deployment (no CORS, no extra origin).

**One `ready`, one `open`.** On load the page posts one `ready`; the host must wait for it before sending
`open` (a message posted before the page's listener is attached is silently lost). The page accepts only the first
`open` and ignores messages with any other protocol name, including version 1's (`onlyoffice-web-embed/1`). The
user's credentials never enter the iframe: the page holds only the backend's session credential.

## 4. The backend's HTTP API (embed page → backend)

All paths are under `<backendUrl>/api/`. Requests and answers are JSON unless stated otherwise.

### `POST /api/session`

Request: `{"token": "<config token>"}`.

Answer `200`:

```json
{
  "session": "<opaque session credential>",
  "expiresIn": 43200,
  "document": { "title": "report.docx", "fileType": "docx" },
  "mode": "edit",
  "allowDownload": true,
  "baseVersion": 7,
  "user": { "id": "u1", "name": "Ann" },
  "lang": "en",
  "plugins": null
}
```

- `mode` is `"view"` if `editorConfig.mode` is `view` **or** `permissions.edit` is `false`, else `"edit"`.
- `allowDownload` is `permissions.download !== false`.
- `baseVersion` is `document.baseVersion`, or `null` when absent.
- `document.fileType` must be one of `docx`/`xlsx`/`pptx`, otherwise the page reports `failed{stage:"open"}`.
- The page treats `session` as opaque and sends it as `Authorization: Bearer <session>` on the next two calls.

### `GET /api/document`

Header `Authorization: Bearer <session>`. Answer `200` with the file's bytes and a `content-type`.
The backend fetches `document.url` (section 5.1) and streams the bytes through.

### `POST /api/save`

Headers `Authorization: Bearer <session>`, `content-type: application/octet-stream`; body = the file.
The backend stages the bytes, calls the host back (section 5.2), waits for its answer, and passes it on.

Answer `200` when the host accepted the save:

```json
{ "session": "<new session credential>", "version": 8, "baseVersion": 8 }
```

`version` is the host's `version` (or `null` if it gave none); `baseVersion` is the version the session now
builds on. **The page switches to the new `session`**: the old one still carries the old `baseVersion`, and a
second save with it would be refused as stale. The new credential does not extend the session's expiry.

### `GET /api/health` (optional)

`200 {"ok": true}`. Not used by the embed page; handy for health checks and test harnesses.

### Errors, and who said them

Every non-2xx answer carries **`x-oow-from: backend`** (the backend refused on its own) or **`x-oow-from: host`**
(the host refused, and this is its answer passed on). A passed-on answer also carries
**`x-oow-host-status: <the host's status code>`**.

**A host refusal is passed on unchanged**: the HTTP status is the host's own, and the body is the host's body
(the page shows up to 800 bytes of it to the user). The one exception: a host 3xx, or a host 2xx whose body is
not `{"error": 0, …}`, is not a status the page can show as a refusal, so the backend answers `502` and keeps
the host's code in `x-oow-host-status`. The page reports `x-oow-host-status` when present, else the HTTP status.

The backend's own errors are `{"error": "<code>", "message": "<text>"}`:

| Status | `error` (suggested) | When |
|---|---|---|
| 400 | `bad-request` / `missing-field` / `empty` | malformed request; config token without `document.url`, `document.key`, or (when editing) `callbackUrl`; empty file on save |
| 401 | `bad-token` / `bad-session` | config token or session credential does not verify, has the wrong `alg`, or has expired |
| 403 | `read-only` | save in a `view` session |
| 413 | `too-large` | file over the backend's upload limit. **No callback is sent** |
| 502 | `host-unreachable` | the host could not be reached, redirected, or answered a save with something other than `error: 0` |
| 504 | `host-timeout` | the host did not answer the callback in time |

What the page does with a failure:

| Call | Page sends to the host page |
|---|---|
| `/api/session` | `failed{stage:"session", status, body, from, unsavedKept:false}` |
| `/api/document` | `failed{stage:"download", status, body, from, unsavedKept:false}` |
| `/api/save` | `failed{stage:"save", status, body, from, unsavedKept:true}`: the bytes stay in the page |

**CORS.** Not needed when the backend shares the embed page's origin. If it does not, it must answer the
preflight for `Authorization` and `content-type` and expose `x-oow-from` and `x-oow-host-status`, for the
embed page's origin only.

## 5. Backend ↔ host

### 5.1 Fetching `document.url`

`GET document.url` with `Authorization: Bearer <JWT>`, HS256 with the shared secret, payload:

```json
{ "payload": { "url": "<the exact URL requested>" }, "iat": 1760000000, "exp": 1760000300, "use": "fetch" }
```

`payload.url` is exactly the URL that goes over the wire (scheme, host and port, path, query). This is the
shape ONLYOFFICE Docs uses for its own fetches, plus `use: "fetch"`, which marks the token as a fetch
signature so it cannot be mistaken for any other token signed with the same secret. Hosts that speak the
standard protocol ignore the extra field.

A non-2xx answer from the host is passed to the page as described in section 4.

### 5.2 The callback

`POST editorConfig.callbackUrl`, `content-type: application/json`, body `{"token": "<JWT>"}` (the token in the
body, not in a header), HS256 with the shared secret, payload shaped like an ONLYOFFICE Docs callback:

```json
{
  "key": "<document.key>",
  "status": 6,
  "forcesavetype": 1,
  "url": "<a signed, short-lived URL where the host collects the staged file>",
  "filetype": "docx",
  "users": ["<user.id>"],
  "actions": [{ "type": 2, "userid": "<user.id>" }],
  "history": { "changes": [{ "user": { "id": "<user.id>", "name": "<user.name>" }, "created": "2026-10-07 09:15:00" }] },
  "lastsave": "2026-10-07T09:15:00.000Z",
  "baseVersion": 7,
  "iat": 1760000000,
  "exp": 1760000300
}
```

- Only status 6 ("being edited, current state saved") with `forcesavetype` 1 ("the user pressed save") is sent.
  Statuses 1, 2 and 4 are not: there is no collaboration, no "everyone closed it" and no heartbeat.
- `baseVersion` is present only if the config token had it. It is the version the **session** currently builds on
  (it moves forward after each accepted save in the same session).
- `key` is the config token's `document.key` for every save of the session. A host that changes the key after each
  save (as ONLYOFFICE Docs integrations often do) must still accept it, and should rely on `baseVersion` to detect
  a stale save.
- The host collects the file with a plain `GET` on `url` while handling the callback.

**The host's answer.** Success is HTTP 2xx with a JSON body `{"error": 0}`, optionally `"version": <integer>`,
which becomes the session's new `baseVersion`. **Anything else is a refusal** and reaches the page unchanged
(section 4). A host that detects a stale `baseVersion` should answer `409` with a short human-readable body;
the user sees it.

## 6. A refused save does not lose the user's work

When `/api/save` fails, the page keeps the bytes and says so with `unsavedKept: true`. The host page should then
offer "save my copy locally"; on click it sends `download-unsaved`, and the page saves the kept bytes as a local
file named after `document.title`. **This also applies when `allowDownload` is `false`**: it is the user's own
edit, and refusing it would lose it. A later successful save discards the kept copy.

## 7. Limits, stated plainly

- **`allowDownload: false` only hides buttons.** The editor runs in the browser, so the file has to reach the
  browser to be opened. A determined user can still extract it. A server-side document server is stronger here.
- **Revoking a right does not end an open session.** Until the session credential expires (12 hours in the
  recommendation below), the page can keep saving. A host that needs more checks it in its callback handler.
- No collaboration, no autosave, no session-state callbacks.

## 8. Recommended practice for the backend

What follows is the reference practice behind this contract, not something the embed page can check.
**Each backend is responsible for its own implementation.**

1. **Only the token's values.** Read everything from the verified config token; never take a URL, key, mode or
   version from anywhere else. Fetch only `document.url`, and do not follow redirects.
2. **HS256, strictly.** Reject tokens whose header `alg` is anything but `HS256` (in particular `none`), compare
   signatures in constant time, require `exp`. Refuse to start without a shared secret of at least 32 characters;
   do not generate one (it could never match the host's).
3. **Never give the browser a token the host would accept.** The session credential lives in the browser, so do not
   sign it with the shared secret. Sign it with a key derived from it, e.g. `HMAC-SHA256(secret, "<fixed label>")`.
   This keeps the backend stateless (restarts do not end sessions; several processes sharing the secret accept each
   other's sessions).
4. **Session lifetime 12 hours, never renewed.** Editing has no natural time limit, and this version has no renewal.
   The credential issued after a save keeps the original expiry.
5. **Fetch signature exactly as in 5.1**, `{"payload":{"url"},"iat","exp","use":"fetch"}`, valid about 5 minutes.
6. **Staged files.** Store them under random names (at least 128 bits), stream to disk rather than memory, delete
   each one after the callback ends (success or not), clear the directory on start and sweep old files periodically.
   The staged-file URL is signed with another derived key (`HMAC(key, id|exp)`) and short-lived (about 5 minutes).
   Only the host needs it: block that path at the public gateway and build the URL on an address the host can
   reach internally.
7. **Checks before the callback.** `view` session → 403; empty body → 400; over the upload limit (100 MB is a
   reasonable default) → 413. None of them sends a callback.
8. **Timeouts.** Wait up to about 3 minutes for the callback answer (then 504), and make sure a proxy in front of the
   backend allows at least as long.
9. **Pass refusals on unchanged.** Do not interpret the host's body; copy the status and up to 800 bytes.

## 9. Testing an implementation

`npm run poc:e2e` drives the embed page in a real browser. It runs
`embed-poc/server/fake-backend.mjs`, a deliberately minimal **test fake** of this contract (in-memory staging,
no sweeps, not for deployment), against `embed-poc/server/mock-host.mjs` acting as the host. Passes ② and ③
assert, among other things, that the page opens with the mode and base version from the token, that every fetch signature
matches the URL the host saw, that the callback is status 6 with the right `baseVersion`, that a stale save is
refused with the host's 409 without overwriting the stored file, and that the refused copy can be saved locally.
