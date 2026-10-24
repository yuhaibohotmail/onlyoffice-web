# 嵌入协议第二版，以及它要的那个后端

> [English](INTEGRATION.md) | 中文（两边不一致时照英文）

这份是**接入页**（`embed-poc/embed.html`，在本仓库）与**接入后端**（不在本仓库）之间的约定。
接入后端谁来写、用什么语言写都行；接入页只依赖这里写下的东西。

第二版是给已经讲 **ONLYOFFICE Docs 接入协议（子集）** 的宿主用的：它签一份编辑器配置、
在 `document.url` 上给文件、在 `callbackUrl` 上收存件。在这样的宿主眼里，接入页加接入后端就是又一台文档服务器。
接入页只讲这一版：第一版（宿主把地址和请求头递给接入页，不要后端）已于 0.3.0 删除。

## 1. 谁做什么

| 角色 | 是什么 | 谁写 |
|---|---|---|
| **宿主** | 文档归它管的那个应用。签配置令牌、提供 `document.url`、答回调 | 使用方 |
| **接入页** | 在浏览器里跑编辑器（格式转换也在浏览器里，WebAssembly）。经 `postMessage` 与宿主页面说话，经 HTTP 与接入后端说话 | 本仓库 |
| **接入后端** | 一个小 HTTP 服务。验配置令牌、给接入页发会话凭据、带签名取件、暂存存件并回调宿主 | 使用方 |

接入后端**不做转换、不做协同**，也不含本仓库的任何代码，所以本仓库的许可管不到它。它只搬字节、核签名。

```
宿主页面             接入页（iframe）                接入后端                            宿主服务端
   │  open{token}  ──▶   │
   │                     │  POST /api/session {token} ──▶ 验令牌
   │                     │  ◀── session、mode、allowDownload、baseVersion …
   │                     │  GET /api/document ─────────▶  GET document.url（带签名）────────▶
   │                     │  ◀──────────── 字节 ─────────  ◀───────────────────────── 字节 ──
   │                     │  （在浏览器里转换、编辑）
   │  save  ─────────▶   │  POST /api/save（字节）─────▶  暂存
   │                     │                                POST callbackUrl {token} ────────▶
   │                     │                                ◀── GET <暂存地址>（带签名）────────
   │                     │                                ◀── 答复 {error:0, version} ────────
   │  ◀─ saved / failed  │  ◀── 新会话凭据 / 被拒 ──────
```

## 2. 配置令牌

宿主用一把与接入后端共用的密钥（相当于 ONLYOFFICE Docs 的 JWT 密钥）签的 HS256 JWT，
载荷**就是**编辑器配置本身，与 ONLYOFFICE Docs 一样。接入页不解析它，原样交给接入后端。

| 字段 | 必填 | 意思 |
|---|---|---|
| `document.url` | 是（`http`/`https`） | 接入后端唯一会去取文件的地址 |
| `document.key` | 是 | 文档标识；这个会话里每一次回调都带回去 |
| `document.fileType` | 是 | `docx`、`xlsx` 或 `pptx`（这个组件能开能存的三种；别的接入页会拒） |
| `document.title` | 否 | 编辑器里显示的文件名，用户存到本地时也用它 |
| `document.permissions.edit` | 否 | `false` → 只读会话 |
| `document.permissions.download` | 否 | `false` → 编辑器藏起下载与另存（`allowDownload: false`），见第 7 节 |
| `document.baseVersion` | 否 | **扩展字段**。宿主自己定义的防覆盖版本号（整数）。原样带进回调，宿主据此拒掉基于旧版本的存件 |
| `editorConfig.callbackUrl` | 编辑时必填 | 存件发到哪 |
| `editorConfig.mode` | 否 | `view` → 只读，缺省 `edit` |
| `editorConfig.user.id`、`.name` | 否 | 作者，写进回调 |
| `editorConfig.lang` | 否 | 界面语言（`zh`、`zh-CN`、`en`、`en-US`……，只分 `zh` 与 `en`） |
| `editorConfig.plugins` | 否 | 原样交给编辑器 |
| `exp` | 是 | 过期时刻（秒）。令牌只要活到接入页开完会话就行，几分钟到 20 分钟都常见 |

**只认令牌。** `open` 消息里可以带别的字段，接入页与接入后端一个都不看。

## 3. 嵌入协议第二版（宿主页面 ↔ 接入页）

走 `postMessage`。两边都要钉死对方的源：宿主发的时候 `targetOrigin` 写接入页那个源（永远不写 `"*"`），
接入页只收查询参数 `hostOrigin` 给的那个源发来的消息。

协议名 `onlyoffice-web-embed/2`，每条消息都是 `{ "protocol": "onlyoffice-web-embed/2", "type": …, … }`。

| 方向 | `type` | 字段 |
|---|---|---|
| 宿主 → 接入页 | `open` | `token`（配置令牌）；`backendUrl?`（见下）；`officeXmlLimitBytes?`；`lang?`（界面偏好，令牌里有 `editorConfig.lang` 时以令牌为准） |
| 宿主 → 接入页 | `save` | – |
| 宿主 → 接入页 | `download-unsaved` | –。把上次被拒的那一份存成本地文件（第 6 节） |
| 接入页 → 宿主 | `ready` | `protocols: ["onlyoffice-web-embed/2"]` |
| 接入页 → 宿主 | `opened` | `mode`（`"edit"`/`"view"`）、`allowDownload`、`baseVersion`（都取自验过的令牌） |
| 接入页 → 宿主 | `saved` | `version`（宿主回调答复里的，没有就是 `null`）、`size` |
| 接入页 → 宿主 | `failed` | `stage`（`open`/`session`/`download`/`export`/`save`/`download-unsaved`）、`message`、`status?`、`body?`、`from?`（`"host"`/`"backend"`）、`unsavedKept` |

**`backendUrl`**：`/api/…` 前面那一截，绝对地址或相对接入页的地址。不给时，接入后端被当成与接入页同源、
同一路径前缀：接入页在 `https://example.com/oow/embed.html`，就调 `https://example.com/oow/api/session`。
这是本来的部署方式（不跨源、不多一个源）。

**一条 `ready`，一条 `open`。** 接入页一加载就发一条 `ready`；宿主必须等到它再发 `open`（接入页挂上监听之前发过去的消息
会无声地丢掉）。接入页只收第一条 `open`，别的协议名的消息一律不理，第一版的（`onlyoffice-web-embed/1`）也一样。
用户的凭据不进 iframe：接入页手里只有接入后端发的会话凭据。

## 4. 接入后端的 HTTP 接口（接入页 → 接入后端）

路径都在 `<backendUrl>/api/` 下。没另说的，请求与答复都是 JSON。

### `POST /api/session`

请求：`{"token": "<配置令牌>"}`。

答复 `200`：

```json
{
  "session": "<会话凭据，接入页不解读>",
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

- `editorConfig.mode` 是 `view` **或者** `permissions.edit` 是 `false` 时 `mode` 为 `"view"`，否则 `"edit"`。
- `allowDownload` 就是 `permissions.download !== false`。
- `baseVersion` 取 `document.baseVersion`，没有就是 `null`。
- `document.fileType` 必须是 `docx`/`xlsx`/`pptx` 之一，否则接入页报 `failed{stage:"open"}`。
- 接入页把 `session` 当成不透明的一串，后面两个接口都带 `Authorization: Bearer <session>`。

### `GET /api/document`

带 `Authorization: Bearer <session>`。答复 `200`，内容是文件字节，带 `content-type`。
接入后端去取 `document.url`（5.1 节），把字节流式转过来。

### `POST /api/save`

带 `Authorization: Bearer <session>` 与 `content-type: application/octet-stream`，请求体就是文件。
接入后端暂存、回调宿主（5.2 节）、等宿主答复、把答复转回来。

宿主收下时答复 `200`：

```json
{ "session": "<新的会话凭据>", "version": 8, "baseVersion": 8 }
```

`version` 是宿主答复里的 `version`（没给就是 `null`）；`baseVersion` 是这个会话此后基于的版本。
**接入页换用新的 `session`**：旧的那张里还是旧的 `baseVersion`，拿它再存一次会被当成基于旧版本而拒掉。
新凭据不延长会话的有效期。

### `GET /api/health`（可选）

`200 {"ok": true}`。接入页不用，给健康检查与实测脚本用。

### 出错，以及是谁说的

每个非 2xx 答复都带 **`x-oow-from: backend`**（接入后端自己拒的）或 **`x-oow-from: host`**
（宿主拒的，这是它的答复原样转过来）。原样转交时还带 **`x-oow-host-status: <宿主的状态码>`**。

**宿主拒绝时原样转交**：HTTP 状态码就是宿主回的那个，报文就是宿主的报文（接入页把前 800 字节给用户看）。
唯一的例外：宿主回 3xx，或者回 2xx 但报文不是 `{"error": 0, …}`，这种状态码没法当「被拒」给人看，
接入后端回 `502`，宿主的原码放在 `x-oow-host-status` 里。接入页有 `x-oow-host-status` 就报它，没有就报 HTTP 状态码。

接入后端自己的错误是 `{"error": "<代码>", "message": "<说明>"}`：

| 状态码 | `error`（建议值） | 什么时候 |
|---|---|---|
| 400 | `bad-request` / `missing-field` / `empty` | 请求不成形；配置令牌缺 `document.url`、`document.key` 或（编辑时）`callbackUrl`；存件是空文件 |
| 401 | `bad-token` / `bad-session` | 配置令牌或会话凭据验不过、`alg` 不对、过期 |
| 403 | `read-only` | `view` 会话来存件 |
| 413 | `too-large` | 文件超过接入后端的上限。**不发回调** |
| 502 | `host-unreachable` | 宿主连不上、给了重定向，或者存件答复不是 `error: 0` |
| 504 | `host-timeout` | 宿主没在时限内答回调 |

接入页拿到失败之后：

| 接口 | 接入页发给宿主页面 |
|---|---|
| `/api/session` | `failed{stage:"session", status, body, from, unsavedKept:false}` |
| `/api/document` | `failed{stage:"download", status, body, from, unsavedKept:false}` |
| `/api/save` | `failed{stage:"save", status, body, from, unsavedKept:true}`：那一份字节留在接入页里 |

**跨源。** 接入后端与接入页同源时用不着。不同源时，它要为接入页那一个源答 `Authorization` 与
`content-type` 的预检，并暴露 `x-oow-from` 与 `x-oow-host-status` 两个头。

## 5. 接入后端 ↔ 宿主

### 5.1 取 `document.url`

`GET document.url`，带 `Authorization: Bearer <JWT>`，用共用密钥 HS256 签，载荷：

```json
{ "payload": { "url": "<逐字就是请求的地址>" }, "iat": 1760000000, "exp": 1760000300, "use": "fetch" }
```

`payload.url` 逐字等于发出去的那个地址（协议、主机与端口、路径、查询串）。这是 ONLYOFFICE Docs 自己取件时的形状，
另加 `use: "fetch"`，标明它是取件签名，免得被当成同一把密钥签的别的令牌。讲标准协议的宿主会忽略这一格。

宿主回非 2xx 时，照第 4 节转给接入页。

### 5.2 回调

`POST editorConfig.callbackUrl`，`content-type: application/json`，报文 `{"token": "<JWT>"}`
（令牌放在报文里，不放在请求头里），用共用密钥 HS256 签，载荷照 ONLYOFFICE Docs 回调的形状：

```json
{
  "key": "<document.key>",
  "status": 6,
  "forcesavetype": 1,
  "url": "<带签名、短时有效的地址，宿主从这里取暂存的那份>",
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

- 只发 status 6（「编辑中，当前状态已保存」）加 `forcesavetype` 1（「用户点了保存」）。
  1、2、4 不发：没有协同、没有「所有人都关了」、没有心跳。
- 配置令牌里有 `baseVersion` 才带。它是这个**会话**此刻基于的版本（同一会话里每存上一次就往前走）。
- `key` 在整个会话里都是配置令牌里那个 `document.key`。每存一次就换键的宿主（接 ONLYOFFICE Docs 时常这么做）
  也要认它，判是不是基于旧版本靠 `baseVersion`。
- 宿主在处理回调的过程中，对 `url` 发一个普通 `GET` 把文件取走。

**宿主的答复。** 成功是 HTTP 2xx、JSON 报文 `{"error": 0}`，可以另带 `"version": <整数>`，它就成了这个会话新的
`baseVersion`。**其余一律算被拒**，原样到接入页（第 4 节）。宿主发现 `baseVersion` 落后时，建议回 `409` 和一句
给人看的话，用户会看到它。

## 6. 存件被拒，用户的成果不丢

`/api/save` 失败时，接入页留住那一份字节，并在 `failed` 里写 `unsavedKept: true`。宿主页面此时应当给一个
「把我这一份存到本地」；点了就发 `download-unsaved`，接入页把留着的那一份存成本地文件，文件名取 `document.title`。
**`allowDownload` 为 `false` 时也照做**：那是用户自己刚改的内容，不给就等于丢掉。之后存成功一次，留着的那份就清掉。

## 7. 限度，直说

- **`allowDownload: false` 只是藏按钮。** 编辑器跑在浏览器里，文件必须到浏览器才打得开，铁了心的人照样拿得到。
  这一点上服务端的文档服务器更强。
- **撤掉权限不会结束已经开着的会话。** 会话凭据过期之前（下面建议的是 12 小时）接入页一直能存。
  宿主要更严，就在自己的回调处理里核。
- 没有协同、没有自动保存、没有会话状态回调。

## 8. 接入后端的建议做法

以下是这份约定背后的参考做法，接入页核不了它们。**实现由各接入后端自己负责。**

1. **只认令牌里的值。** 一切取自验过的配置令牌，地址、键、模式、版本都不从别处拿。只取 `document.url`，不跟重定向。
2. **HS256，从严。** 头里的 `alg` 不是 `HS256`（尤其是 `none`）就拒，签名按常数时间比较，`exp` 必须有。
   没有至少 32 个字符的共用密钥就不启动，也不要自己现生成一把（那把注定与宿主的对不上）。
3. **不给浏览器任何一张宿主会认的令牌。** 会话凭据在浏览器手里，所以不用共用密钥签，用从它派生的另一把，
   例如 `HMAC-SHA256(密钥, "<固定标签>")`。这样接入后端不用存状态（重启不丢会话，几个进程共用密钥时互认）。
4. **会话 12 小时，不续期。** 编辑本来没有时间上限，而这一版不做续期。存件后发的新凭据沿用原来的过期时刻。
5. **取件签名照 5.1 一字不差**：`{"payload":{"url"},"iat","exp","use":"fetch"}`，有效约 5 分钟。
6. **暂存。** 用随机名字（至少 128 位）、流式写盘不整份进内存，每次回调结束（不论成败）就删，启动时清空目录、
   定时扫掉过旧的文件。暂存取件地址用另一把派生密钥签（`HMAC(密钥, id|exp)`），短时有效（约 5 分钟）。
   只有宿主要用它：在对外网关上挡掉这个路径，地址建在宿主从内网够得着的那个地址上。
7. **回调之前先查。** `view` 会话 → 403；空文件 → 400；超上限（100 MB 是合理的缺省）→ 413。这三种都不发回调。
8. **超时。** 回调答复最多等 3 分钟上下（然后 504），前面若有代理，它的超时不能比这短。
9. **被拒原样转交。** 不解读宿主的报文，照抄状态码和最多 800 字节。

## 9. 怎么验一个实现

`npm run poc:e2e` 在真浏览器里把接入页走一遍。用的是 `embed-poc/server/fake-backend.mjs`，
一个刻意从简的**实测用假后端**（暂存放内存、不定时清理、不能拿去部署），宿主由 `embed-poc/server/mock-host.mjs` 扮演。
第 ②③ 两趟断言的包括：接入页按令牌里的模式与基准版打开；每一次取件签名都与宿主看到的地址一致；回调是 status 6、
带着对的 `baseVersion`；基于旧版本的存件被宿主以 409 拒掉、宿主那份没被覆盖；被拒的那一份能存到本地。
