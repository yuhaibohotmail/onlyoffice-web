# PoC：把 OnlyOffice 那个 wasm 搬到后端跑

> **⚠ 这条路已经作废，这份目录留着只是记录。**
>
> 结论（见下面「答案」那一段）是**渲染那一半挪不过去**，所以这个方向没有继续做。
> 完整的取舍写在仓库根的 `BACKEND.md` 里。
>
> **⚠ 下面那些命令今天跑不通**：几个脚本读的是 `fixtures/lesson-plan-zh.docx`，
> 而那批夹具 2026-08-30 搬进了 `demo/` —— 作废的东西没跟着改。
> **那不是它坏了，是路径过期了。** 想重跑的话先把那几行的路径改对。

**问的是：** 前端那个 wasm 能不能挪到后端去，挪过去之后我们是不是就有了一个简化版的
OnlyOffice。

**答案：** 能挪，而且**格式转换那一半今天就能用**——那个 wasm 在 Node 里约 190 毫秒起来（含解压到 36 MB），
一份 3 KB 的 docx 转成编辑器内部格式 23 毫秒。**但「渲染」那一半挪不过去**，
因为那一半根本不在这个 wasm 里。

下面每一条都有一条命令能自己跑一遍。

```sh
node poc/backend-x2t/run.mjs            # 第一问：转换。16 种格式逐个走一遍
node poc/backend-x2t/probe-render.mjs   # 第二问：排版。走到卡住那一步为止
```

前提与整个项目一样：`npm run assets`（抽静态资源）、`npm run x2t`（取引擎）、
`npm run fonts`，以及 `npm run fixtures:formats`（生成 16 份测试文档）。

---

## 一、先纠一个前提：那个 wasm 不负责渲染

提问里说的是「用 wasm 在前端实现渲染」。**实际不是这么分工的**，而这个分工恰好就是
整件事的答案，所以先说清楚：

| 谁 | 干什么 | 是什么 |
|---|---|---|
| `x2t.wasm` | **格式转换**：docx ↔ 内部格式 ↔ odt/rtf/txt…，以及**把已经排好版的画图指令写成 PDF** | 6.8 MB（brotli 压过，解开 36 MB）的 C++ 编译产物 |
| `sdkjs` | **排版与渲染**：算出每个字在第几页第几毫米，画到画布上 | 32 MB JavaScript（两个 bundle） |

浏览器里导出 PDF 的真实过程是**两段**：sdkjs 先在 JS 里把文档排好版、产出一段二进制的
画图指令流（代码里叫 `pdf.bin`），再交给 x2t.wasm 写成 PDF 文件。
组件里那个 `convertEditorBinToPdf` 收 `pdfRendererStream` 参数，就是这一段。

所以「把 wasm 搬到后端」搬过去的是**第一段的转换 + 第二段的写文件**，
**中间那段排版没搬过去**——它在 JS 里。

---

## 二、第一问：转换。**能，而且很快**

`node poc/backend-x2t/run.mjs`。全程没有浏览器，没有 Document Server，没有 docker。

```
  引擎     vendor\x2t （core 9.3.0.140）
  解开后   36.0 MB
  Node     v24.11.0
```

| 源格式 | 源字节 | 读进来 | 内部格式 | 用时 | 写回 | 写回字节 | 用时 | 正文字符 | 备注 |
|---|---:|:--:|---:|---:|:--:|---:|---:|---:|---|
| doc | 35328 | ✅ | 25576 | 64ms | ✅ docx | 13931 | 35ms | 3353 | |
| docx | 3071 | ✅ | 1626 | 23ms | ✅ docx | 8858 | 30ms | 135 | |
| epub | 2153 | ❌ | — | 24ms | ❌ | — | — | 0 | wasm 读不了 |
| fb2 | 616 | ❌ | 11 | 16ms | ❌ | — | — | 0 | 转出 11 字节的空壳 |
| html | 1868 | ⏳挂住 | — | — | ❌ | — | — | 0 | wasm 不返回 |
| odt | 3290 | ✅ | 1688 | 44ms | ✅ docx | 8767 | 30ms | 135 | |
| **pdf** | 143094 | ✅ | 8940 | 86ms | ✅ docx | 9636 | 38ms | **127** | **PDF 转回可编辑 Word** |
| rtf | 1884 | ✅ | 7896 | 44ms | ✅ docx | 10897 | 36ms | 119 | |
| txt | 321 | ✅ | 2185 | 26ms | ✅ docx | 8728 | 31ms | 135 | |
| csv | 167 | ✅ | 2379 | 32ms | ✅ xlsx | 7026 | 41ms | 60 | |
| ods | 3964 | ✅ | 2048 | 71ms | ✅ xlsx | 7062 | 39ms | 24 | |
| xls | 14336 | ✅ | 5674 | 66ms | ✅ xlsx | 9416 | 43ms | 472 | |
| xlsx | 4953 | ✅ | 2129 | 40ms | ✅ xlsx | 6638 | 38ms | 48 | |
| odp | 6409 | ❌ | — | 25ms | ❌ | — | — | 0 | wasm 读不了 |
| ppt | 8192 | ✅ | 21487 | 67ms | ✅ pptx | 16411 | 40ms | 0 | 夹具里没有文字 |
| pptx | 34699 | ✅ | 60663 | 56ms | ✅ pptx | 36997 | 46ms | 0 | 夹具本来就是空白页 |

**16 种里 12 种读得进来、写得回去。** 另外四种（epub / fb2 / html / odp）与
浏览器那边**完全一致**——是这份 wasm 基于的 core 版本旧了一档，不是后端的问题，
FINDINGS 第十一节量过同一组数（且已知换一份基于更新 core 的 wasm，epub 与 html 就都好了）。

另外两条顺带核过的：

- **老式二进制只读不写**：docx → doc / xlsx → xls / pptx → ppt 三条都没有产出（rc=80 / 88）。
  这是 OnlyOffice 本来的能力边界。
- **PDF 能转回可编辑的 Word**，中文原样活下来（127 个字符）。这一格是意外收获。

### 判据取产物，不取退出码

x2t 有一类失败是**退出码 0、什么都不产出**，所以每一格都去认字节：
Editor.bin 认 DOCY/XLSY/PPTY 魔数**外加 64 字节下限**，OOXML 认 zip 里有没有该有的那一项，
**并且把正文抠出来数字数**。

那个下限与那个字数不是凑数的：**fb2 那一格转出来的是 11 字节，魔数完全正确、正文一个字都没有**。
只认魔数的判据会给它开绿灯，报告上就会写着「16 种里 13 种可用」。

判据自己也被验过两次（注入缺陷，看它会不会红）：

| 注入什么 | 结果 |
|---|---|
| 去掉 Editor.bin 那 64 字节下限 | fb2 转绿 → 与预期表不符，红。**说明那个下限是真在挡事的** |
| 把所有产物截断到 40 字节 | 16 行里 12 行红。**说明判据读的是字节不是退出码** |

两次都按快照—注入—跑—还原—`cmp` 走，还原后逐字节一致。

### 一件做后端服务必须知道的事：坏文档能挂死整个进程

`html` 那一格**不是失败，是不返回**。`main1` 是一次同步的 wasm 调用，进到里面之后
**同一个进程里没有任何东西能把它打断**——事件循环轮不上，定时器不触发，Promise 不兑现。

所以 `run.mjs` 是**每一格开一个子进程**跑的，超时就杀。这不是测试脚手架的将就：
**真做成服务也得这样**，否则一份坏文档就能把整个转换服务挂死，而且看不出是哪一份。
代价是每次转换要多花约 190 毫秒去解压并加载那 36 MB wasm（一个常驻进程池能把这笔省掉）。

---

## 三、第二问：排版。**路是通的，今天差最后一步**

既然排版引擎是 JavaScript，而 Node 本身就是 V8——OnlyOffice 自己的 doctrenderer
无非也是「V8 + 这几个 js 文件」——那就当场试一次，别靠推理。

`node poc/backend-x2t/probe-render.mjs`：

```
✓ xregexp                                4ms
✓ native.js                              0ms      ← OnlyOffice 自带的无头 DOM 垫片
✓ jquery_native.js                       5ms
✓ AllFonts.js                            1ms
✓ sdk-all-min.js（API 层）                69ms
✓ sdk-all.js（模型与排版层）                355ms   ← 28.9 MB
✓ libfont/fonts.js                       4ms      ← FreeType 的 wasm
字体引擎起来了吗: 是

✓ NativeCreateApi                    17ms  → document
✓ asc_nativeOpenFile                 55ms  → opened      ← Editor.bin 读进了文档模型
✗ asc_nativeCalculateFile            59ms  Cannot read properties of null (reading 'm_pFaceInfo')
```

**立得住的：** 整套编辑器内核在 Node 里加载起来了（约 0.5 秒），OnlyOffice 官方那套无头入口
（`asc_nativeOpenFile` / `asc_nativeCalculateFile` / `asc_nativeGetPDF`）都在，
FreeType 的 wasm 也起来了，Editor.bin 读进了文档模型。

**差的：** 排版时给字体建 face 失败——字体文件读得到（`native.GetFontBinary` 已经接上盘），
但只被要走了一个，说明**把字体装进引擎那一步没接对**。这一段在 doctrenderer 里是 C++ 做的，
换到 Node 得照浏览器那条路重接一遍。

**并且，`asc_nativeGetPDF` 照样回了 5 MB 的缓冲区。** 那是空的命令流。
**在这里「有返回值」不等于「画出来了」**——判据要取页数（`asc_nativePrintPagesCount` 回 0）。
拿字节长度当成功，就会得到一份 5 MB 的假成功。

### 一条关键证据：wasm 里有「写 PDF」，没有「排版」

把那 36 MB 解开后直接找字符串：

| 找什么 | 在不在 |
|---|---|
| `CPdfFile` / `PdfWriter`（写 PDF 的那一半） | **在** |
| `doctrenderer` / `sdk-all` / `AllFonts`（排版那一半） | **都不在** |

所以 rc=80 失败的**不是「写 PDF」，是「排版」**。这也说明 CryptPad 那份 wasm
是**刻意只编了转换那一半**——不是缺陷，是他们不需要排版。

---

## 四、所以「简化版的 OnlyOffice」是什么

分两步看，别当成一件事：

**今天就能拿到的（第一段）：一个纯 Node 的格式转换服务。**
没有 Document Server、没有 docker、没有浏览器，一个 `node_modules` 都不用装。
12 种格式互转、PDF 转可编辑 Word、每次几十毫秒。
DocumentServer 那一摊里的 FileConverter，这就是它的对应物。

**还要一段工作才能拿到的（第二段）：后端出 PDF / 出预览图。**
路径已经验证是通的，卡在字体装载。做完之后就是完整的
「docx → 排版 → PDF」，也就是 OnlyOffice 的 doctrenderer 的对应物，
但跑在 Node 里、不需要那个 C++ 二进制。

**如果只是想要「后端出 PDF」而不在乎怎么来的**，还有第三条路没在这里试：
用无头浏览器驱动现成的组件。这个仓库已经有 Playwright 和整套 e2e，
浏览器里的导出 PDF 是**今天就通的**。代价是每次渲染要开一个 Chromium。
它与第二段是「买还是造」的关系，不是技术可行性问题。

---

## 五、这里面几个不改就走不动、而报错都指向别处的地方

留在这儿是因为每一条都花了时间，且**报错都不指向真正的原因**。

1. **`x2t.wasm` 是 brotli 压过的**（盘上 6.8 MB，解开 36 MB）。不解就喂给
   `WebAssembly.instantiate`，报的是「expected magic word 00 61 73 6d」——
   **那句话指着 wasm 文件，看着像文件坏了**。

2. **Emscripten 胶水里那句 `var Module;`**。在 Node 的模块作用域里它是个局部变量，
   外面设的 `Module` 传不进去。得把整份胶水包进一个参数名叫 `Module` 的函数里
   （就是 Emscripten 自己 MODULARIZE 的做法），那句声明才变成无操作。

3. **`sdk-all.js` 与 `sdk-all-min.js` 是互补的两半，不是新旧两版。** 名字骗人：
   min 那份根本没压缩过。前者装模型与排版层，后者装 API 层。
   只加载一个都会「成功」，然后在用到对方的东西时报一句不相干的错：
   少了模型层报 `AscCommon.History` 未定义，少了 API 层报 `lcid_enUS is not defined`。
   **两句都不会让人想到「另一个文件没加载」。**

4. **`native.js` 把 `setTimeout` / `setInterval` 全换成了空函数**（doctrenderer 里是同步跑的）。
   Emscripten 的启动收尾要过一次 `setTimeout`，被吃掉之后 wasm 永远初始化不完，
   而报错是 **`_ASC_FT_Init is not a function`——指着字体引擎**。

5. **`fonts.js` 那份胶水整个包在闭包里**，里面那句
   `var Module = typeof Module != "undefined" ? Module : {}` 读的是函数内那个还没赋值的
   `Module`，所以在外面设 `Module.wasmBinary` 无效（试过）。它又硬写着
   `ENVIRONMENT_IS_WEB = true`、只走 `fetch`，只能给它一个读盘的假 `fetch`。

6. **`native.js` 里那个 `console.error` 引用了一个不存在的变量 `param`**，一调用就
   `ReferenceError`。是上游的 bug，得把 console 换掉。

7. **`NativeOpenFileData` 最后一句是 `Api = Api.getJsApi()`**，把 `Api` 换成了一个
   不带 `asc_native*` 的外壳。要留住真 api，得自己分两步调
   `NativeCreateApi()` + `asc_nativeOpenFile()`。

8. **Emscripten 的 FS 抛的不是 `Error`，是个带 `errno` 的普通对象**，
   `String()` 出来是 `[object Object]`，**一个字的线索都没有**。

---

## 六、目录里有什么

| 文件 | 干什么 |
|---|---|
| `x2t-node.mjs` | 在 Node 里驱动 x2t.wasm。照浏览器那份 `x2t.worker.ts` 改的，刻意保持同一套步骤 |
| `convert-once.mjs` | 跑一次转换就退出。**单独一个进程是必需的**，理由见头注释 |
| `run.mjs` | 第一问：16 种格式的矩阵，判据取产物 |
| `probe-render.mjs` | 第二问：排版那一段走到哪儿了 |
| `zip.mjs` | 从产物里把正文抠出来数字数。够用就行，不是通用 zip 库 |

**已知的欠账**（PoC 阶段可以，真落地要还）：

- `x2t-node.mjs` 里那份 PDF 字体清单是**从 `src/onlyoffice-web-comp/const/index.ts` 抄来的第二份**。
  应当从那一处 import，别留两份——两份会漂，而漂了不报错。
- `convert()` 里走命令流那条路（`pdfBinBytes`）是照浏览器那份 worker 的
  `writePdfBin` 写的，**但一次都没有真跑过**——因为产不出命令流。
  第二段做通之后，它是第一个要验的东西。
