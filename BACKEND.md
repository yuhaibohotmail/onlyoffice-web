# 后端该做什么

对照 OnlyOffice 自己的后端在做什么，定这个项目的后端该接哪些、不接哪些。

下面凡是说 OnlyOffice 怎么做的，都是从**跑着的那个社区版容器里量出来的**
（`onlyoffice/documentserver:9.4.0.1`），不是照文档抄的。
每条后面括号里是怎么量的。

> ## 结论（2026-08-30 用户裁定）
>
> **后端 wasm 那条中间路不做。** 要服务端能力就用标准 DocumentServer，
> 要零依赖就用现有的浏览器端实现——**中间那条两边都不需要**。
>
> 三条依据，都不是推理：
>
> 1. **安全动机已经证伪**（第七节）：搬到后端换掉的是容器不是「拿不拿得到」。
> 2. **C 的剩余收益 DS 全都有，而且没有缺口**：我们这份 wasm 有 epub / fb2 / odp
>    三个格式读不了、html 会挂死；容器里那个原生 x2t 这四样都正常
>    （`fixtures/formats/` 那批 epub / html / odp 就是它转出来的）。
> 3. **DS 不是备选方案，是已经在跑的东西**：`ops/units/onlyoffice`（9.4.0.1）已落地，
>    dev 三台（`.40` / `.42` / `.43`）都装着 `doc-node`，`doc-server` 的默认文档引擎就是它。
>    而且开销量过：**50 个并发编辑连接只让容器多吃 30 MiB**（每连接 0.29–0.32 MiB），
>    25 人持续打字占那台 2 核机器 3.4% CPU——单元注释里的原话是
>    「先撑不住的是测试台，不是 DS」。
>
> 所以**第五节那张顺序表整张作废**，第 1 / 2 / 4 / 5 步都别做；
> 第 3 步（协作会话）走 DS 的话它自己就做了，也不用做。
> 下面第一到第四节的分块与判据仍然成立，**留着是因为它们是「为什么该这么选」的依据**。
>
> ⚠ **真正该重新问的不是这条，是「那 onlyoffice-web 还为什么存在」**——见第八节。

---

## 一、OnlyOffice 的后端实际在做什么

它只有**两个进程**，前面一层 nginx：

```
ds:converter     RUNNING          ← C++，格式转换与渲染
ds:docservice    RUNNING          ← Node.js，协作会话与宿主集成，听 8000
ds:example       STOPPED          ← 示例宿主，不是产品的一部分
ds:metrics       STOPPED
```
（`supervisorctl status`；`ss -ltn` 显示容器里只有 80 和 8000 在听）

这两个进程的活，按**谁需要它**分成三块。这个分法是下面所有结论的依据：

| 块 | 谁在做 | 具体是什么 |
|---|---|---|
| **A · 宿主集成** | docservice | 从宿主取原文件、存回宿主（`callbackUrl` 回调）、JWT 签发校验、`/command`（forcesave / drop / info）、`/ConvertService.ashx`、权限与版本编排 |
| **B · 协作会话** | docservice | WebSocket 那套协议：`auth` / `openDocument` / `saveChanges` / `getLock` / `releaseLock` / `isSaveLock` / `unSaveLock` / `rpc`，变更广播、锁归属、存盘时机 |
| **C · 转换与渲染** | converter | x2t + doctrenderer + 各格式的解析库 |

C 那块的东西在盘上摊开是这样（`ls FileConverter/bin/`）：

```
x2t                    libdoctrenderer.so     DoctRenderer.config
AllFonts.js            font_selection.bin     fonts.log        ← 字体索引
libPdfFile.so          libDocxRenderer.so     libEpubFile.so
libFb2File.so          libHtmlFile2.so        libHWPFile.so
libDjVuFile.so         libXpsFile.so          libIWorkFile.so
libOFDFile.so          libStarMathConverter.so                 docbuilder
```

**`DoctRenderer.config` 值得单独看一眼**，因为它逐字列出了「让 sdkjs 在没有浏览器的地方跑起来」需要哪几个文件：

```xml
<file>../../../sdkjs/common/Native/native.js</file>
<file>../../../sdkjs/common/Native/jquery_native.js</file>
<allfonts>./AllFonts.js</allfonts>
<file>../../../web-apps/vendor/xregexp/xregexp-all-min.js</file>
<sdkjs>../../../sdkjs</sdkjs>
<dictionaries>../../../dictionaries</dictionaries>
```

**这正是 `poc/backend-x2t/probe-render.mjs` 已经在加载的那几个**——所以那条路不是猜的，
是照着 OnlyOffice 自己的清单走的。⚠ 但有一处我们走岔了：这里的 `<allfonts>` 指的是
**`FileConverter/bin/AllFonts.js`**，不是 `sdkjs/common/AllFonts.js`，且它旁边配着一份
`font_selection.bin`。那是给转换器单独生成的一份字体索引——**PoC 卡住的那一步，答案八成就在这儿**。

### 关于「DocumentServer 很重」这个说法

默认配置里它确实要三样外部依赖：PostgreSQL（`localhost:5432`）、RabbitMQ（`amqp://localhost:5672`）、
Redis（`default.json` 第 150 / 371 / 417 行）。

**但这个容器里这三个进程一个都没有**（`ps -eo comm` 只有 nginx / docservice / converter / cron /
supervisord），`healthcheck` 回 200，日志写着 `embedded converter started`。

⚠ **别据此断定生产也不需要它们**——我只验证了健康检查和取资源，**没有验过多人协作**，
而那三样正是为多实例共享会话与任务队列存在的。这里记下来只是为了别把「必须先搭三个中间件」
当成既定前提。

---

## 二、我们今天的分工

同样三块，看看各自落在哪儿：

| 块 | OnlyOffice 放哪 | 我们今天放哪 | 多少代码 |
|---|---|---|---|
| A · 宿主集成 | docservice | **`server/` (3041)** | 750 行，零依赖 |
| B · 协作会话 | docservice | **浏览器标签页里** | `internal/editor/server.ts`，2413 行 |
| C · 转换渲染 | converter | **浏览器里** | `x2t.wasm`，每个访问者下 6.8 MB、解压成 36 MB |

`server/` 今天提供的是**两样能力，其余端点都为这两样服务**（它自己的头注释）：

- 取件 `GET /api/internal/download/{docId}/{cacheKey}/{name}?token=`
- 存件 `POST /api/documents/{docId}/content`
- 外加：会话令牌签发与校验（`jwt.mjs`，会话 900 秒 / 取件 300 秒）、落盘与版本
  （`storage.mjs`，**每存一次新写一个版本文件，旧版永不覆盖**）、只读伺服
  `/packages/**` `/legal/**` `/plugins/**`

**它的路径名是照 doc-server 的形状取的**（`server/index.mjs` 头注释明说），
也就是说：**A 那一块在平台里早就有人做了**——`backends/services/doc-server`（6012）
的 auth / tenant / document / storage / version / editor / audit / webhook 那一整套，
干的就是 OnlyOffice 眼里「宿主」的活。这里这 750 行是它的一个小仿制品，
存在的理由是让这个仓库能自己跑起来、自己验证，**不是要变成产品后端**。

项目自己也是这么规划的：`NEXT-SESSION-PROMPT.md` 里第三件事就是把 `server/` 挪进
`demo/`，理由是「组件是唯一要发布的那一份，demo 那些探针不该跟着发出去」。

---

## 三、这个分工今天的代价

不是抽象缺点，是已经写在 README「已知的限制」里的三条，加上 PoC 新量出来的两条：

| 现象 | 根在哪 |
|---|---|
| **不支持协作，而且互相覆盖时不报错**。两个人各自保存，后存的把先存的整个盖掉，两边都显示成功 | B 在标签页里。一个标签页看不见另一个标签页 |
| **不自动保存**，浏览器崩了改动全丢 | 同上：没有一个活在服务端的会话 |
| **`Ctrl+S` 被拦掉了**，按下去没反应也不报错 | 同上 |
| 每个访问者都要下 6.8 MB wasm 并解压成 36 MB | C 在浏览器里 |
| **服务端完全不认识文档内容**——收下的是一堆字节。出不了预览图、做不了全文检索、不能批量转换、不能在上传时校验 | C 在浏览器里 |

---

## 四、判据：什么该搬到后端

**别照着 OnlyOffice 的模块表抄。** 用一条能自己判的判据：

> **这件事需要一个「所有客户端都同意」的答案吗？**

需要的，必须在服务端；不需要的，在哪儿都行，看代价。
按这条切，上面 A / B / C 三块的结论完全不同。

### 档一 · 必须搬（不搬就是错的，不是慢）

**只有 B 这一块。** 而且 B 的全部内容就是三个问题的答案要唯一：

1. `saveChanges` 的**顺序**——谁的改动排在谁前面
2. `getLock` 的**归属**——这一段现在归谁改
3. **基于哪个版本改的**——`storage.mjs` 已经有版本号了，缺的是「这次提交是从哪一版长出来的」

这三件今天在标签页里，所以「两个人打开同一份文档」这件事**在架构上就不成立**，
不是没做完，是做不了。

### 档二 · ~~该搬~~ **不搬，走 DS**（2026-08-30 改）

**这一档原本写的是「C 该搬」，已作废，理由见开头那个结论框。** 原文保留在下面，
因为「搬过去能换来什么」那几条仍然是真的——只是**那几条 DS 也都给，而且没有格式缺口**。

**C 这一块。PoC 已经证明可行**（`poc/backend-x2t/`）：12 种格式互转，单次几十毫秒，
纯 Node、零 npm 依赖。搬过去换来四样今天没有的东西：

- **上传即转换**，不必等到有人打开它
- **批量与离线转换**，不占用户的浏览器
- **客户端不必再下那 36 MB**（首屏、弱网、低配终端）
- **PDF 转回可编辑 Word**（PoC 实测，中文原样活下来）

⚠ **它不是一条安全收益，别当成一条。** 搬完之后浏览器收到的从 docx 变成 `Editor.bin`，
**换掉的是容器，不是「拿不拿得到」**——实测见 `poc/backend-x2t/probe-what-browser-gets.mjs`：
bin 里正文是明文 UTF-16LE（30 行 JS 就读出来了）；原文件里的作者元数据与 `w:vanish`
隐藏文字**照样跟着过去**；还原成 docx 也不需要另外准备工具，**浏览器自己就带着那份 x2t.wasm**，
那正是导出按钮在做的事。真 DocumentServer 也是这么发的
（`urls['Editor.bin'] || urls['origin.' + documentFormat]`，见 `sdk-all-min.js`），
而且它还留了一条直接发原文件的退路。详见下面第七节。

⚠ **搬的时候必须带一条纪律**：每次转换关在一个能被杀掉的进程或 worker 里。
`html` 那一格实测**不是失败，是不返回**——`main1` 是同步 wasm 调用，
进去之后同进程里没有任何东西打断得了它。一份坏文档就能挂死整个转换服务，
而且看不出是哪一份。

**服务端出 PDF / 预览图**属于同一块的后半段，路已经验通（编辑器内核在 Node 里起来了、
文档模型读进去了），卡在字体装载——而上面第一节已经指出 OnlyOffice 把答案摆在哪儿了。

### 档三 · 不该搬（OnlyOffice 有，我们不需要）

- **PG + RabbitMQ + Redis 那一套**：DS 用它们是为了多实例共享会话与任务队列。
  我们是单实例、教育场景的并发，先用进程内队列加一张表就够。这一层可以后加，
  一上来照抄只会得到三个要运维的中间件。
- **回调式集成**（`callbackUrl` + `/command` + `ConvertService.ashx`）：那套协议是
  为「我不认识宿主系统」设计的。**我们的宿主就是自己**，直接调用比隔着 HTTP 回调简单一个数量级。
- **A 那一整块**：doc-server 已经在做，别做第二份。

---

## 五、~~建议的顺序~~ **整张作废**（2026-08-30）

原来这里是一张五步表：搬转换 → 上传即转 → 搬协作会话 → 接字体出 PDF → 预览图。
**五步全部不做**，理由见开头结论框。留个残骸在这儿是为了让下一个人知道
**这条路被走到过、被否掉了**，而不是没人想过。

| # | 原计划 | 现在 |
|---|---|---|
| 1 | 把转换搬进 `server/` | 不做。DS 的 `/ConvertService.ashx` 已经是这个，且没有格式缺口 |
| 2 | 上传即转 `Editor.bin` 落盘 | 不做。DS 自己就这么干（`urls['Editor.bin']`） |
| 3 | 把协作会话搬出标签页 | 不做。**走 DS 的话这一块就是 DS 本身** |
| 4 | 接字体，服务端出 PDF | 不做。等于在 Node 里重写 doctrenderer，去复刻一个**已经装在 `doc-node` 上的**二进制 |
| 5 | 预览图 / 缩略图 | 不做。同上；且那几台上还装着 kkFileView，预览本来就有人做 |

**`poc/backend-x2t/` 留着**：它是这个否定结论的证据，三个脚本都能复跑，
下次有人再问「wasm 能不能搬后端」时，答案带着数据而不是印象。

---

## 六、这条路上量出来的三条事实（计划作废了，这三条别跟着丢）

**一、`server.ts` 搬不动，不是「改改就行」。** 里面有 16 处 DOM 引用。大多数好换
（`window.setTimeout`、`Blob`、`URL.createObjectURL`），但有一处是**真的在用 canvas 光栅化 SVG**
（第 287 行，`document.createElement("canvas")` → `drawImage` → `toBlob`），
那是给 x2t 吃不下的图片格式做的兜底。**这条现在成了一条支持「别搬」的理由**
——将来若有人再提「把协作会话搬到 Node」，这 16 处是要先算进去的成本。

**二、`server/` 的定位别让它漂。** 项目自己规划的是把它挪进 `demo/`
（`NEXT-SESSION-PROMPT.md` 第三件事）。既然后端那条路不做了，这个定位就更清楚了：
**它是 demo 的自证设施，不是产品后端，也不该再长新能力。**
产品那一侧的宿主集成是 `doc-server` 的活。

**三、许可这条与做不做后端无关，仍然成立。** `src/` 整棵树是 AGPL-3.0。
只要这个组件被拿去给别人用（第八节那几种情况全是），
README 那两条不许越过的线就一直有效——尤其第一条「接受了 AGPL 就要真的做到」，
界面上那个法律声明入口是硬要求。

---

## 七、「搬到后端就能不让浏览器拿到原文」——不成立

这条单独写一节，因为它看起来很像 C 的附带收益，而**它不是**。
实测脚本：`node poc/backend-x2t/probe-what-browser-gets.mjs`（自带一份带元数据与隐藏文字的夹具）。

搬完之后浏览器收到的确实不再是那份 docx，而是 `Editor.bin`。但手里有 `Editor.bin` 的人：

| 问 | 实测 |
|---|---|
| 正文读得出来吗 | **读得出来。**明文 UTF-16LE，不加密不混淆。30 行 JS 直接拉出「八年级数学 · 一次函数 教学设计」 |
| 原文件里不显示的东西还在吗 | **还在。**作者元数据与 `w:vanish` 隐藏文字**逐字跟着过去**——服务端转换不是一次净化 |
| 还原得回 docx 吗 | **还原得回。**8912 字节、147 个正文字符。而且**不需要另外准备工具：浏览器自己就带着那份 x2t.wasm**，这正是导出按钮在做的事 |

**真 DocumentServer 也是这么发的**，而且它没打算挡住这件事：

```js
var documentUrl = urls['Editor.bin'] || urls['origin.' + t.documentFormat];
```
（`sdkjs/word/sdk-all-min.js`）——**首选发 bin，取不到就直接发原文件**。

### 根因

**编辑器在浏览器里排版和渲染，所以文档内容必须到浏览器。** 这不是实现选择，是架构定的。
只要页面上能看见字，客户端就已经有了这些字。任何「禁止下载/禁止复制」都是劝阻，不是边界。

### 那什么才挡得住

先分清要的是「能编辑」还是「只要能看」：

| 要什么 | 能做到吗 | 代价 |
|---|---|---|
| 能编辑，且浏览器拿不到内容 | **做不到。**别在这上面花时间 | — |
| 只要能看 | **服务端渲染成像素，浏览器只收图**——走 DS 或 kkFileView，别自己写 | 不能选中复制、不能搜索、体积大；⚠ 截图与 OCR 仍能取回 |
| 只要能看，但想省事发 PDF | ⚠ **PDF 不算。**里面的文字是可提取的，发 PDF 等于发文本 | — |
| 降低泄漏后果 | 水印 + 审计留痕，把「防泄漏」换成「可追溯」 | 挡不住有心人，但改变了成本 |
| 真正敏感的内容 | **不进这份文档**。分级，敏感段落走另一条不落到富文本编辑器的路 | 要改业务，不是改架构 |

---

## 八、那 onlyoffice-web 还为什么存在

否掉后端 wasm 之后，真正该问的是这一条。**它的答案不在「轻 / 重」那条轴上**——
按轻重排的话，DS 在这个平台上根本不重（50 并发多吃 30 MiB），这条轴分不出东西来。

判据是另一条：

> **这个页面能不能容忍「打开一份文档，要先跟一个服务建一次会话」？**

| 能容忍 | 不能容忍 |
|---|---|
| 用 **DS**。已经装了、量过、`doc-server` 已经接了，一分新工作都没有 | 用**浏览器端那份**。代价是没有协作、四个格式有缺口、每人下 36 MB |

「不能容忍」具体是哪几种情况，值得写死，否则这个项目会因为没有边界而慢慢什么都想做：

1. **要把编辑器发给别人**——第三方或别的团队引用这个组件，不能要求对方先部署一个 1.3 GB 的容器。
   这是 `frontends/packages/*` 与 `vue-sdk` 那条线的形状，也是本项目 README 第一句写的定位。
2. **纯静态托管**：产物拷到任意静态服务器就能跑，没有后端进程。
   （与 `frontends/example/playback-lab` 同一档。）
3. **离线或断网演示**。
4. 门户里嵌一个**只读预览**，不想为一次预览走「建会话 → 发令牌 → 挂回调」那一整套。

⚠ **第 4 条今天最需要重新掂量。** `NEXT-SESSION-PROMPT.md` 里排在第一件的「加查看器选项」
就是冲它去的，而它的前提是「门户拿不到 DS」——**这个前提今天在 dev 上已经不成立了**
（`doc-node` 在 `.40` / `.42` / `.43` 上跑着，`doc-server` 默认就用它）。
prod 上还没装，但按 ops 的设计那是**清单里加一行**的事，角色目录早就在了，不是一项新工程。

所以做那一档之前先答一句：**省掉的那次会话，值不值得维护第二套文档打开路径。**
答「值」也完全站得住（前三条理由是实的），但要写下来——
否则半年后没人说得清这个项目和 DS 是什么关系。
