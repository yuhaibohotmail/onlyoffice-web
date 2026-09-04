# 上游那个包的几处问题，以及它们各自的证据

2026-08-30。这份文件记的是**建这个项目时查出来的东西**，每条都带「怎么核」，
不带证据的判断一条都不要往这里写。

---

## 一、那个格式转换引擎不是黑盒，源码一直是公开的

上游那个组件包里的 `x2t.wasm`（9.22 MB）此前被当成「直接提交进仓库、没有对应源码」的东西。
**这个说法不成立。** 它是 CryptPad 的 `onlyoffice-x2t-wasm` 那条公开配方的产物。

**两条证据**：

1. 上游 `x2t.js` 里那段启动脚本，与 CryptPad 仓库里的 `pre-js.js` **逐字一致**，
   连制表符缩进都一样。
2. 它导出了 `_main1`。这个符号只可能来自 CryptPad 的 `wrap-main.cpp`——
   那份代码被追加到 `X2tConverter/src/main.cpp` 末尾，把 `main` 包成一个可以反复调用的 `main1`。

**怎么核**：

```sh
# 那个 wasm 是 brotli 压过的，先解开才看得见里面
node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("x2t.raw.wasm",z.brotliDecompressSync(f.readFileSync("x2t.wasm")))'
grep -c '_main1' x2t.js                    # 有
sed -n '/include: \/pre-js.js/,/end include/p' x2t.js   # 与 CryptPad 的 pre-js.js 比
```

顺带从 wasm 的调试信息里读到了它的构建环境：编译器 `clang version 21.0.0git`（对应 emsdk 4.0.x），
源码树挂在 `/core`、emsdk 在 `/emsdk`——正是那个 Dockerfile 的布局。

## 二、上游那份 wasm 白大了三成

| | 上游那份 | CryptPad 发布的 |
|---|---|---|
| brotli 压缩后 | 9.22 MB | **6.49 MB** |
| 解开后 | 62.6 MB | 34.3 MB |
| 调试信息 | 26.5 MB | **0** |
| 函数个数 | 146 064 | 76 474 |

上游那趟编译**带着调试信息而且没开优化**。功能一样，浏览器要多下 2.7 MB。
我们用的是后者（`scripts/fetch-x2t.mjs`，官方 sha512 已核）。

## 三、上游那套 PDF 字体有两个问题，都不报错

### 3.1 里面是真的 Monotype Arial

`x2t-fonts/Arial-*.ttf` 四个文件的 name 表里写着
`Version 2.82`、`Typeface © The Monotype Corporation plc`、
`NOTIFICATION OF LICENSE AGREEMENT / This typeface is the property of Monotype...`。

**那不是能随分发包发出去的字体。** 已换成 Liberation Sans（照 Arial 字宽做的替代品，
SIL OFL 许可，就在我们自己那个社区版镜像里），排版宽度不变。

### 3.2 粗体和斜体的文件装反了

**名字叫 `*-Bold.ttf` 的文件里装的是斜体，叫 `*-Italic.ttf` 的装的是粗体**，
Arial 与 Carlito 两族都反。四个信号一致：

| 文件 | name 表子族 | OS/2 fsSelection | head macStyle | 字重 |
|---|---|---|---|---|
| `Arial-Bold.ttf` | Italic | `0x1` = ITALIC | `0x2` = ITALIC | 400 |
| `Arial-Italic.ttf` | Bold | `0x20` = BOLD | `0x1` = BOLD | 700 |
| `Carlito-Bold.ttf` | Italic | `0x1` | `0x2` | 400 |
| `Carlito-Italic.ttf` | Bold | `0x20` | `0x1` | 700 |

字节大小也对得上：上游 `Carlito-Bold.ttf` 是 609 KB，正是真正的 Carlito 斜体的大小。

组件是**按文件名**把字体喂给转换引擎的（`X2T_PDF_FONT_MANIFEST`），
所以后果是：**导出的 PDF 里粗体印成斜体、斜体印成粗体，全程没有任何一处报错。**

**已经立了判据**：`scripts/build-x2t-fonts.mjs` 配字体时逐个打开核对，
`scripts/check-x2t-fonts.mjs` 随时能再核一遍，两者共用 `scripts/lib/ttf-style.mjs` 一份逻辑。
**这条判据拿上游那个真实的坏文件注入验过，当场红**（还原后字节一致）。

## 四、PDF 与图片打不开的根因：缺的是加载入口，不是解析能力

上游那个包的 `web-apps/apps/` 下只有三个编辑器应用
（documenteditor / presentationeditor / spreadsheeteditor），
**缺 `pdfeditor` 与 `visioeditor`**。

但 `sdkjs/` 下 `pdf` 与 `visio` **都在**——也就是说解析那一半是全的，
**缺的只是 `web-apps` 那一半的加载入口**。所以症状才是「接口回报就绪、页面白着」。

有意思的是，**上游自己那个抽取脚本本来就会导出五个编辑器**
（`install_cross_origin_bridge` 里逐个点了 pdfeditor 与 visioeditor 的名），
所以仓库里那份产物是被删过或用旧版脚本抽的。

我们从社区版镜像重抽一遍，五个全在。

## 五、`sdkjs-plugins` 与那份空登记表

上游那个包**没有 `sdkjs-plugins/` 目录**，而它的 `plugins.json` 是
`{"pluginsData": []}`——一个为了消掉 404 而放的空壳。

**那个空壳是「插件用不了」的真正原因之一**：编辑器是拿这份登记表里的字符串直接去取插件配置的，
表是空的就一个插件都不会出现，包括镜像里自带的那 11 个官方插件
（AI / OCR / Photo Editor / Translator / Thesaurus / Highlight code / YouTube / Zotero /
Mendeley / Speech / Speech input）。

社区版镜像里 `sdkjs-plugins/` 有 19 项（11 个插件 + marketplace + 引导脚本 + v1）。
我们抽过来了，并且**把自带那些真的登记上**（`installRootConfigs`）。

另外还缺一份 `themes.json`——Document Server 是靠 nginx 现给这两个文件的，
镜像里没有；纯静态托管不补的话每次启动都 404，而**它不报错，只是少一块功能**。
这条是靠 `scripts/check-no-404.mjs` 抓到的：那 13 条实测只报「有 1 条控制台错误」，
不说是哪一条，而「有一条 404」与「有一条 404、是缺了主题表」是两个信息量完全不同的东西。

## 六、静态资源来源：社区版与 Developer Edition 的关系

上游那 1.06 GB 抽自 `onlyoffice/documentserver-de`（Developer Edition，商业授权）。
我们抽自社区版 `onlyoffice/documentserver:9.4.0.1`。

**两边的许可声明头逐字一致——代码是同一份，差别在分发条款不在代码**，所以换源不丢功能。
实测：换源之后那 13 条自动实测全过。

## 七、把伪造的那份授权降到最小，不损失功能

浏览器里那个模拟服务发给编辑器的 `type: "license"` 消息，上游把
`advancedApi` / `protectionSupport` / `isAnonymousSupport` / `liveViewerSupport` / `customization`
五个开关都设成开，那几个对应的是商业版才有的能力。

**五个全关，13 条实测照样全过。** 而**整段不发**则插件不起、导出挂满 30 秒再超时
——所以是「降到最小」，不是「删掉」。

## 八、一句注释是错的，而它让一条断言失去意义

`App.tsx` 里那条核实跨源判断的断言，原本照着组件内部的逻辑重算了一遍，
依据是一句注释：「组件内部那个判断函数没有导出」。
**那句话是错的**，`isOnlyOfficeCdnMode` 一直经 barrel 导出着。

害处不是多写几行，而是**这条断言验的是我们的复制品、不是产品本身**：
产品那边改了判断规则，这条断言照样绿。已改成直接调产品那个函数。

## 九、升级到 9.4 的难度，量出来的

如果要自己编转换引擎，就得把 CryptPad 那份 core 从 9.3.0.140 升到我们的 9.4.0.129。
这件事此前被列为「主要风险」，现在有数了（只用 git，不用 docker）：

- **CryptPad 对 core 改了 30 个文件，+1574 / −575**。大头是 qmake 构建文件、
  以及新写的 827 行 `doctrenderer_empty.cpp`（把要 V8 的那半换成空实现——V8 编不成 wasm）。
- **这 30 个文件在 9.3 到 9.4 之间只有 21 个变过，合计 +761 / −283**，
  而其中十来个的改动是**整齐的 +33 行、0 删除**——那是 Ascensio 在 9.4 给全树统一加的一段
  AGPL 许可头，插在第 1 行，与 CryptPad 改的位置不冲突，会自动合并。
- 真正要人看的只有三处：`HtmlFile2/htmlfile2.cpp`（+275）、`UnicodeConverter.pro`（113）、
  `Common/base.pri`。

**结论：可估的工作量，不是未知数。** 详见 `build/x2t/README.md`。

## 十、可编辑 PDF 被当成普通 PDF 打开——已修，而且它有两层

**状态：2026-08-30 修完并有实测守着（B15）。**

### 症状

OnlyOffice 自己生成的 PDF（**PDF 表单**，头部带 `/ONLYOFFICEFORM` 标记、流里嵌着一个
OOXML 包）会被当成普通 PDF 打开、丢掉可编辑性，**一句错都不报**。

### 第一层：那个判断根本没在跑

打开 PDF 时编辑器先加载一个**分派页**（`web-apps/apps/common/index.html`），
它读文件开头 300 字节判断这是不是可编辑 PDF，再决定往哪跳：

| 判断结果 | 跳到哪 | 用户看到的 |
|---|---|---|
| 是可编辑 PDF | `documenteditor` | 表单编辑界面，能填能改 |
| 普通 PDF | `pdfeditor` | 看和批注 |

它读文件的办法是：有 `document.directUrl` 就直接部分下载它，
**没有就退回文档服务器那套 `downloadfile/<key>` 端点**——我们这套没有那个端点，
请求 404，于是判断**永远回「不是」**。

⚠ **普通 PDF 恰好判对**（答案本来就是「不是」），所以在只有普通 PDF 的测试里，
一个永远回「不是」的判断与正确的判断**表现得一模一样**。
这是这一整条缺陷之所以没被发现的原因。

### 第二层：路由修好之后，文档仍然打不开

补上判断之后，可编辑 PDF 确实跳到了 documenteditor——**但文档没载进去**：
页面上工具栏齐全、表单那一排按钮（文本字段 / 复选框 / 签名…）都在，
画布上却什么都没有，还挂着一个报错框：

> 打开文件时出错。文件内容对应于以下格式之一：pdf/djvu/xps/oxfs，但文件的扩展名不一致：pdf。

原因在 `loadDocument()`：PDF 那条是 `output = 原始字节`，也就是**原样透传**。
那对 pdfeditor 是对的（它直接读 PDF），但 documenteditor 要的是**转换过的 Editor.bin**。

**这一层是第一层修好之后才露出来的**——只做一半会得到一个更糟的状态：
从「静悄悄地降级成只读」变成「进对了应用但打不开，还弹一个看不懂的框」。

### 怎么修的

一个判断，两处用：

1. `internal/editor/pdf-form.ts` 认一次（照抄编辑器自己那份 `isExtendedPDFFile`）
2. 可编辑 PDF → 按「PDF 表单」转成 word 的 Editor.bin；普通 PDF → 原样透传
3. 同一个结果经 `document.isForm` 告诉编辑器，让它跳过自己那次判断

**为什么给 `isForm` 而不是 `directUrl`**：两条路都能让判断跑起来，
但**同一个答案我们这边也要用**（决定怎么转换）。给 `directUrl` 等于让编辑器判一次、
我们判一次，**要求两个判断永远一致**——它们迟早不一致，而不一致的样子正是第二层那个症状。

### 判据

```
                        落在哪          纸张像素   内容像素   报错框
普通 PDF（手写）        pdfeditor       358963     1952      无
可编辑 PDF（表单模板）  documenteditor  341420        0      无
```

⚠ **别拿「内容像素」当通用判据**：那份表单模板本来就是空白的，
载进去之后也没有深色内容。区分「空白因为文档是空的」与「空白因为没载进去」，
要看**纸张**画出来没有——修之前那一栏是 0。

跑 `node scripts/probe-pdf-routing.mjs` 能把这张表现打一遍。

### 一条照抄来的规则，配了一条防漂的检查

`pdf-form.ts` 里那条判断是**照抄**静态资源里的 `isExtendedPDFFile`。
照抄有理由（同一个答案两处都要用），代价是**换一次静态资源，原文改了而我们这份不会跟着改**。
`node scripts/check-copied-rule.mjs` 把原文里那几个决定性的值取出来与我们这份逐个对。

⚠ 写那条检查时自己踩了两次，都是**误报**：第一次按 utf8 读原文，
那几个高位字节被换成替换字符、永远找不到；第二次没想到原文里是
**十六进制转义的源码文本**而我们这份是用字符码拼的，同一个值两种写法。
**一条会误报的判据比没有判据更糟**——它会先被加进豁免名单，然后连真的那次也不响了。

## 十一、各种格式逐个开一遍：16 份里 13 份画得出来，缺口全在那个 wasm 转换引擎里

跑法：`node scripts/make-format-fixtures.mjs` 现生成一套，
再 `node scripts/check-formats.mjs` 逐个打开。测试文档由**容器里那个原生 x2t**
从我们自己的三份源文件转出来（中文教案 docx / 中文表格 csv / 空白 pptx），
另有三份老式二进制取自 ONLYOFFICE core 并核过 sha256。

### 结果

| 格式 | 打开 | 落在哪个应用 | 纸张像素 | 内容像素 | 导出 |
|---|---|---|---|---|---|
| docx | ✅ | documenteditor | 331 371 | 6 646 | 25 518 B |
| doc | ✅ | documenteditor | 324 500 | 17 359 | 29 378 B |
| odt | ✅ | documenteditor | 333 827 | 6 214 | 4 879 B |
| rtf | ✅ | documenteditor | 334 945 | 5 221 | 861 955 B |
| txt | ✅ | documenteditor | 336 918 | 4 041 | 146 B |
| xlsx | ✅ | spreadsheeteditor | 477 437 | 3 296 | 9 471 B |
| xls | ✅ | spreadsheeteditor | 471 591 | 8 828 | ⚠ 导不出 |
| ods | ✅ | spreadsheeteditor | 477 947 | 2 503 | 4 958 B |
| csv | ✅ | spreadsheeteditor | 477 437 | 3 296 | 109 B |
| pptx | ✅ | presentationeditor | 384 315 | 3 229 | 33 285 B |
| ppt | ✅ | presentationeditor | 373 412 | 732 | ⚠ 导不出 |
| **odp** | **❌** | presentationeditor | **0** | **0** | 导不出 |
| pdf（普通） | ✅ | pdfeditor | 350 708 | 6 020 | ⚠ 导不出 |
| pdf（可编辑） | ✅ | documenteditor | 341 420 | 0（模板本来空白） | — |
| **epub** | **❌** | documenteditor | **0** | **0** | 导不出 |
| **html** | **❌** | documenteditor | **0** | **0** | 导不出 |
| fb2 | ○ | documenteditor | 341 420 | 0 | 导不出 |

**组件声明支持 12 个格式**（docx doc odt rtf txt / xlsx xls ods csv / pptx ppt odp），
**11 个真的画得出来，odp 不行**。

⚠ **上面那两列像素数是相对的，别当成钉死的值。** 它们随浏览器窗口与页面版面走：
2026-08-30 那次页面美化把顶栏加高之后，同一批文档重跑一遍，每个数都低了约四分之一
（docx 331 371 → 248 795），**而每一行的结论一个都没变**。
判据本来就是**「>0 说明画出来了、>10000 说明有纸张」**，不是某个具体数字——
看见这些数变了先别当成退化，先看结论那一列。

### 三处不出声的失败，各不相同

| 格式 | 症状 | 真正发生了什么 |
|---|---|---|
| **odp** | 弹「未知错误」，画布空白 | wasm 里抛 `function signature mismatch`，转换没产出 |
| **epub** | 弹「未知错误」，画布空白 | wasm 里抛 `memory access out of bounds` |
| **html** | **一直停在「文件加载中…」，不报错也不结束** | 转换既没成功也没失败，就是不回来 |

⚠ 第三种最坏：**它连报错框都没有**。页面上工具栏齐全、状态栏正常，只是文档永远不出现。

### 换一份 wasm 一试，epub 与 html 就好了

把上游那份基于更新的 core 编出来的 wasm 换上去（换完立刻还原、字节核对一致）：

| 格式 | 我们现在这份（core 9.3.0.140） | 上游那份（较新的 core） |
|---|---|---|
| epub | 崩溃，0 像素 | **340 692 纸张 / 6 745 内容，好了** |
| html | 挂住不返回 | **340 692 纸张 / 6 745 内容，好了** |
| odp | 崩溃，0 像素 | **仍然崩溃，0 像素** |

**这是「自己编一份对齐 9.4.0.129 的 x2t」到今天为止最硬的一条理由**
——它不只是版本整齐好看，是两个格式能不能用的差别。

odp 那条与 wasm 的版本无关：**同一份 odp，容器里那个原生 x2t 读得了**
（odp → pptx，转出 11 788 字节）。也就是说**文件没问题，是 wasm 版读不了 odp**。

### 老式二进制那三种：只读不写，两侧都印证了

`doc` / `xls` / `ppt` **打得开、画得出内容，但导不出去**
（导出时报「x2t 转换没有产出」）。这不是缺陷，是 OnlyOffice 本来的能力边界：
它读得了这三种，写不出它们。

同一件事在生成夹具时也撞见了：拿 x2t 往这三种格式转，**退出码 0、却不产出任何文件**
——所以这套夹具改成从 core 取真文件（见 `scripts/make-format-fixtures.mjs`）。

### 两个坑，都让「转换失败」看起来像「格式不支持」

1. **csv 转 xlsx 必须多给编码与分隔符两个参数**，不给的话 x2t 退出码 0、什么都不产出。
   少一份 xlsx 之后，由它转出的 ods 也跟着没有，看起来像「这几个格式转不了」。
2. **画布出现 ≠ 已经画完，更 ≠ 可以导出。** 等太短的话像素数是 0、导出挂满 30 秒再超时，
   两条都看着像「这个格式打不开」。实测要等十几秒才稳定。

## 十二、`npm run build` 一直是坏的，而 dev 一直好着

**状态：2026-08-30 修好。**

生产构建直接失败：

```
Invalid value "iife" for option "worker.format"
— UMD and IIFE output formats are not supported for code-splitting builds
file: src/onlyoffice-web-comp/internal/editor/x2t.ts
```

格式转换那半跑在一个 Web Worker 里，而它内部有懒加载（brotli 解码那份是用到才 import 的）。
vite 默认把 worker 打成 iife，那个格式**不支持代码分割**。

⚠ **开发服务器不打包，所以 dev 下永远不会报。**
也就是说这条只在 `npm run build` 时现形——**「跑得起来」与「构建得出来」是两件事**，
而我们此前一直只跑前者。

修法是 `vite.config.ts` 里 `worker: { format: "es" }`。修完产物 1.5 MB。

## 十三、还有三个我们没在用的界面：embed / mobile / forms

静态资源里每个编辑器应用都不止一个入口：

| 应用 | main（完整编辑器） | embed（查看器） | mobile | forms |
|---|---|---|---|---|
| documenteditor | 94.6 MB | **0.5 MB** | 5.5 MB | 1.5 MB |
| spreadsheeteditor | 441.3 MB | **0.5 MB** | 12.1 MB | — |
| presentationeditor | 68.7 MB | **0.4 MB** | 5.2 MB | — |
| visioeditor | 6.7 MB | **0.4 MB** | 3.8 MB | — |
| pdfeditor | 40.4 MB | — | — | — |

（盘上总量，含各语言包与资源，不等于一次加载要下多少；但应用外壳的差距是真的。）

**组件永远只加载 `main`**，因为它把 `type: "desktop"` **写死**在了给编辑器的配置里
（`core/editor-manager.ts`，两处），而挑哪个入口正是由这一格决定的：

```js
const path_type = corrected_type === "mobile" ? "mobile" :
                  corrected_type === "embedded" ? (fillForms && isForm ? "forms" : "embed") : "main";
```

**实测过**（临时把那一处改成 `"embedded"`，验完立刻还原、字节核对一致）：

```
地址   .../web-apps/apps/documenteditor/embed/index.html?...&type=embedded
画面   纸张 564184 / 内容 14725     ← 比编辑器还多，因为没有工具栏占位
界面   " lesson-plan-zh.docx 的 1 " ← 只剩文件名与页码
```

**也就是说「查看器」这条路是通的，差的只是把那一格开放成选项。**
这与第一轮报告里那句「它的预览是把编辑器的编辑功能关掉，不是查看器」不矛盾——
那句说的是 `main` 加只读；这里说的是**另有一个真正的查看器应用一直躺在资源里没被用**。

⚠ 一处要说准的：embed 那个入口**只有查看**，没有编辑、没有插件面板。
它替代不了现在这条路，是**另一档**——真要用得把它做成一个明确的选项，
并且各自补实测（今天一条都没有）。

## 十四、查看器做成选项了；而量完下载量才发现，省下来的只是外壳

**状态：2026-08-30 落地，实测 B16 守着。**

第十三节量的是**盘上**的体量（`embed` 0.5 MB 对 `main` 94.6 MB），并由此以为
「少下东西」是这一档的主要价值。**这一节把线上真正下了多少量了出来，那个推论不成立。**

### 改了什么

组件新增一格 `variant`（`"editor"` / `"viewer"`），一路开放到门面
（`OnlyOfficeManagerOptions` → `CreateEditorViewOptions` → 给编辑器那份配置里的 `type`），
写法照插件那一格。**两处 `type` 都改了**：挂载时那一处、以及切编辑权限时
`refreshFile` 用的那一处。

⚠ **第二处今天没有任何自动实测守着，而且是有原因的**：`syncEditingRights` 只在
拿不到 `asc_setRestriction` 时才走 `refreshFile`，而实测查了一眼——
**embed 那个应用的 SDK 里 `asc_setRestriction` 是有的**，所以那条退路今天走不到。
硬造一个走得到的场景要在运行期把 SDK 上的方法摘掉，而它挂在原型上、摘不干净，
造出来的也是一个产品里不会发生的状态。**所以这里如实记一笔：改是对的，但没人守着它。**

### 两档到底差在哪（同一份中文教案 docx，同一趟跑）

| | 编辑器（`variant: "editor"`） | 查看器（`variant: "viewer"`） |
|---|---|---|
| 落点 | `documenteditor/main/index.html` | `documenteditor/embed/index.html` |
| 纸张像素 / 内容像素 | 363 810 / 11 646 | **650 994 / 28 159** |
| 插件面板（`iframe_<guid>` 个数） | 2 | **0** |
| 功能区标签（`.ribtab` 个数） | 13 | **0** |
| 界面上的字 | 文件 开始 插入 绘图 布局 引用 协作 保护 视图 插件 AI 公式实验室… | `一次函数教学设计.docx 的 1` |
| 法律声明入口 | 在，可见 | **在，可见** |

查看器那边像素反而更多，因为没有工具栏占位，纸画得更大。

⚠ **`readOnly` 与它是两档，别混**：只读是 `main` 加 `asc_setRestriction`——
工具栏与插件面板都还在，只是不让改；查看器是**换了一个应用**，两样都没有。
demo 页面上因此是两个控件，按钮上的字也写明了「切成只读（仍是编辑器那一档）」。

### 下载量：量出来的结论与「0.5 MB 对 94.6 MB」对不上

`node scripts/measure-payload.mjs`（新写的，要真设施、刻意不挂进自动检查）。
同一份文档、同一趟跑、编辑器一遍查看器一遍，冷载与暖载各一次。

**docx（一次函数教学设计）冷载：**

| 组别 | 编辑器 | 查看器 | 查看器省下 |
|---|---|---|---|
| 字体 | 53 请求 · 85.4 MB | 51 请求 · 85.2 MB | 208 KB |
| sdkjs | 48 请求 · **121.4 MB** | 48 请求 · **121.4 MB** | **0** |
| 界面 | 220 请求 · 9.9 MB | 24 请求 · 2.8 MB | **7.1 MB** |
| 插件 | 67 请求 · 2.4 MB | 0 | **2.4 MB** |
| 其他 | 49 请求 · 2.6 MB | 47 请求 · 2.6 MB | 2 KB |
| **合计** | **437 请求 · 221.7 MB** | **170 请求 · 211.9 MB** | **9.7 MB（4.4%）** |

**xlsx（转出.xlsx）冷载**（换一个应用再量一遍，看这个差价是不是跟着应用大小走）：

| | 编辑器 | 查看器 | 省下 |
|---|---|---|---|
| 界面 | 10.7 MB | 2.85 MB | 7.85 MB |
| 插件 | 2.42 MB | 0 | 2.42 MB |
| 合计 | 413 请求 · 164.2 MB | 148 请求 · 153.8 MB | 10.5 MB（6.4%） |

**两次的差价几乎一样（9.7 MB 与 10.5 MB），而 `spreadsheeteditor` 的 `main` 在盘上是
441.3 MB、`documenteditor` 的是 94.6 MB。** 也就是说：

> **盘上那个体量差换算不成下载量。** `main` 那几百 MB 里绝大部分是各语言包与
> 用不到的资源，浏览器本来就不下。查看器省下的是**应用外壳与插件面板**，
> 大约 10 MB 与 265 个请求，**与是哪个编辑器无关**。

**暖载**（同一个浏览器档案里再开一份）：编辑器 91 KB、查看器 57 KB
——带版本号的长缓存是生效的，第二份文档几乎不再下东西。**日常体验看的是这一列。**

### 那 220 MB 到底是谁下的：按「谁在下」分的第二张表

只按东西的类型分组会把最要紧的一件事摊平。加一条轴之后：

| 谁在下 | 编辑器 | 查看器 |
|---|---|---|
| **组件那个预载 iframe** | 60 请求 · **133.5 MB** | 60 请求 · **128.5 MB** |
| 编辑器 iframe | 329 请求 · 85.5 MB | 62 请求 · 80.8 MB |
| 主页面 | 48 请求 · 2.6 MB | 48 请求 · 2.6 MB |

组件在挂编辑器之前先塞一个 `preload.html` 的 iframe（`util/initialize.ts`），
那个页面**把四个编辑器的 sdk 全拉下来**——`word` / `cell` / `slide` / `visio`
的 `sdk-all.js` 各 27.5 / 30.9 / 27.0 / 22.7 MB，**外加各自的 `sdk-all-min.js`**，
然后 `asc_loadFontsFromServer()` 再拉字体。**这一大块两档完全一样。**

所以真正的下载量问题排下来是这个顺序，**查看器排在最后**：

1. 预载 iframe 拉了四个编辑器的 sdk（**其中三个这次根本用不到**）≈ 110 MB
2. 中文字体 ≈ 85 MB（`fonts/070` 18.8 MB、`fonts/076` 17.5 MB、`fonts/071` 16.1 MB…）
3. 同一个 sdk 的**未压缩版与压缩版都下了**（`sdk-all.js` 27.5 MB + `sdk-all-min.js` 3.4 MB）
4. 应用外壳 + 插件面板 ≈ 10 MB ← **只有这一格是查看器能省的**

**这一档的价值因此要换个说法**：它省的不是字节（4.4%），是
**少 265 个请求、没有编辑入口、没有插件面板**——
给别人（门户）嵌一个只给看的文档时，少的是那一整片交互面，不是流量。

### 量下载量时踩的一个坑：无痕上下文没有磁盘缓存

第一版用的是 `browser.newContext()`。量出来**冷载与暖载分毫不差**
（两次都是 437 请求 221.7 MB），而且查看器比编辑器还多下 27.5 MB。

两个数都是假的，原因是同一个：**Playwright 的 `newContext()` 是无痕上下文，
只有内存缓存、没有磁盘缓存**，而那几个 20–30 MB 的 `sdk-all.js` 大过内存缓存肯放的尺寸，
于是一条都存不住——第二次开原样再下一遍。

⚠ **这个坑值钱的地方在于它长得像一个真缺陷**：「暖载与冷载一样」正是
「长缓存没配上」的症状，而那是量法的毛病不是产品的。
改成 `launchPersistentContext` + 一个空档案目录之后，暖载掉到 91 KB。

还有一处同型的：Playwright 的 `request.sizes().responseBodySize` **命中缓存时照样回
文件本身的大小**。字节要取 CDP 的 `Network.loadingFinished.encodedDataLength`
——那一格命中缓存时才是 0。两条都写在 `scripts/measure-payload.mjs` 的头注释里。

### 判据（B16）

`npm run e2e` 里新增一条，同一份 docx 两档各开一遍：

1. **落点不同**——`.../main/index.html` 对 `.../embed/index.html`。
   这是「切没切过去」唯一说得清的判据：两档的接口回报、事件、就绪状态全都一样。
2. 查看器那档**画得出纸张与内容**（取像素，不取「就绪」）。
3. **反向断言**：查看器那档插件面板 0 个、功能区标签 0 个；
   **同时断言编辑器那档两样都大于 0**——后半句是免费探针，
   选择器要是写错了恒回 0，编辑器那一半会当场红，不会两边一起静静地绿着。
4. 法律声明入口两档都在、都看得见。换应用不换容器，**但许可要求的东西要实测不能推理**。
5. 点一下「切成只读」那个按钮，**落点必须还在 `main`**——这条守的是
   「只读与查看器是两档」这件事本身：谁哪天把它们做成一件事，这里会红。

⚠ **切到查看器那一下走的是页面上那个下拉框，不是 `window.__poc`。**
脚本直接调接口的话，控件本身坏了（状态没接上、选了没生效）不会有任何东西红
——「手点着好使」与「脚本跑绿」就变成两件事了。同理，只读那条也走的是真按钮。

### 后来补的一条：判「那个入口还看得见吗」不能只量宽高

页面美化那一轮里发现，上面第 4 条原本只断言了 `getBoundingClientRect()` 的宽高大于零。
**一个被别的东西整个盖住的元素，那个宽高照样是正的**——于是许可要求的「显著可见」
会在一次纯样式改动里静静地失效，而实测全绿。

现在多问一句 `document.elementFromPoint`：那个入口中心那个点上，最上面的是不是它自己；
另加一条「还在视口里」。**拿一层透明盖板注进去验过**（给容器加一个铺满的 `::after`），
B16 当场红，并且报错里直接写出盖住它的是谁
（`它中心那个点上最上面的是 DIV.onlyoffice-container`）。验完还原，字节核对一致。

**这条断言拿缺陷注入验过**：把挂载那处改回写死的 `"desktop"`，
B16 当场红在第一条（`查看器那档没落在 documenteditor/embed：.../main/index.html?...&type=desktop`）；
另外单独量了一眼，那时查看器那档的插件面板是 2、功能区标签是 13
——**也就是说第 3 条自己也够把这次退化认出来**，不是靠第 1 条兜着。
验完还原，字节核对一致。
