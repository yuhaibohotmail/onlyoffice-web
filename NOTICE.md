# 修改说明

本文件是许可要求的一部分，不是可选的文档。

ONLYOFFICE 按 GNU Affero 通用公共许可证第 3 版发布，并附有 Ascensio System SIA 补充的五条附加条款
（原文见 `LICENSE`，从第 662 行起）。**第二条**要求：修改过的版本必须带一份显著的声明，
写明它已被修改、修改的日期，并清楚指出它基于 Ascensio System SIA 开发的原始 ONLYOFFICE 软件。
这就是那份声明。

---

## 一、这是什么

**本项目是一个修改过的版本，不是 Ascensio System SIA 发布的原版。**

原始软件：**ONLYOFFICE**，由 **Ascensio System SIA** 开发
（版权所有 © 2009-2026 Ascensio System SIA，网址 <https://www.onlyoffice.com>）。

本项目名为 `onlyoffice-web`，同样按 **AGPL-3.0** 发布，连同上述五条附加条款一起遵守。
非代码内容（插图、图标集、文档）按**知识共享 署名-相同方式共享 4.0 国际**许可。

**ONLYOFFICE 是 Ascensio System SIA 的商标。本项目未获得任何商标授权**
（附加条款第四条）。项目里出现这个名字，只是为了说明本软件基于什么、以及谁是原始开发者。

## 二、改了什么，什么时候改的

### 2026-08-30

| 改了什么 | 为什么 |
|---|---|
| **去掉了编辑器左上角的自定义标识** | 上游把它换成了微软 Office 的图标（从一个外部地址取 simple-icons 的 `microsoftoffice.svg`）。那是别家的商标，我们没有任何权利用它；而换掉 ONLYOFFICE 自己的标识属于白标，白标是商业版才有的功能。现在显示的是编辑器自带的 ONLYOFFICE 标识——这也正好满足附加条款第三条里「能认出原始开发者」那一项。顺带去掉一个外部地址依赖。 |
| **把浏览器内那个假服务发出的授权消息降到最小** | 这套方案没有文档服务器，编辑器启动时等的那条授权消息由浏览器里的一个模拟服务发出。上游把 `advancedApi`、`protectionSupport`、`isAnonymousSupport`、`liveViewerSupport`、`customization` 五个开关都设成开，那几个开关对应的是商业版才有的能力。我们按 AGPL 发布，不该拿一条自己编的消息去解锁付费功能，五个全部关闭。实测不损失任何功能。 |
| **换掉导出 PDF 用的字体，并修正粗斜装反** | 上游那套字体里装的是真的 Monotype Arial，那不是能随分发包发出去的字体，已换成字宽一致、可自由分发的 Liberation Sans。同时上游那套的粗体与斜体文件是**装反的**（名字叫 `*-Bold.ttf` 的里面是斜体），导致导出的 PDF 粗斜互换而不报错，已修正并加了一条自动核对。 |
| **静态资源改为从社区版镜像抽取** | 上游那份静态资源抽自 Developer Edition 镜像（商业授权）。我们按 AGPL 发布，只能用社区版。两边的许可声明头逐字一致，代码是同一份，差别在分发条款不在代码。 |
| **新增界面上的法律声明入口** | 附加条款第三条要求界面里有一个清晰可达、显著可见的入口。**它写在组件里而不是页面里**——组件是给别人引用的，放在页面里的话别人引用时就丢了，而丢了不会有任何东西报错。 |
| **组件新增一格插件配置并下发给编辑器** | 上游的组件从不往编辑器传插件配置，于是插件拿不到配置。这一格是编辑器给插件下发配置的唯一通道。 |
| **修正「带可编辑内容的 PDF 被当成普通 PDF 打开」** | OnlyOffice 自己生成的 PDF 表单，原本会丢掉可编辑性且不报错。原因有两层：一是判断这件事的那个请求打到一个不存在的端点上、于是永远回「不是」；二是判断修好之后，文档仍然以原始字节交给编辑器，而那一半要的是转换过的格式。现在由组件自己认一次，结果既用于转换、也告诉编辑器该用哪个编辑界面。 |
| **组件新增一格 `variant`，可以用查看器打开** | 上游把给编辑器那份配置里的 `type` 一格**写死成 `"desktop"`**（两处），而挑加载哪个应用入口正是由这一格决定的，于是永远只加载完整编辑器 `main`。静态资源里一直躺着一个 `embed`——真正的查看器应用，盘上 0.5 MB 对 94.6 MB。现在开放成一格选项。它与既有的 `readOnly` 正交：只读是编辑器关掉编辑（仍有工具栏与插件面板），查看器是换成另一个应用（没有工具栏也没有插件面板）。 |

## 三、对应源码在哪

**本项目的完整源码在 <https://github.com/yuhaibohotmail/onlyoffice-web>**，
连同重新构建它所需要的全部脚本。

⚠ 许可证第 13 条要的是「**本版本**的完整对应源码」——所以部署一个版本时，
要让界面上那个「获取源代码」指到**与它对得上的那个标签**，而不是仓库的当前状态。
指法见 `LegalNoticeOptions.sourceUrl`（纯静态部署）或环境变量 `OOW_SOURCE_URL`（带后端时）。

其中**格式转换引擎**（浏览器里那个 WebAssembly 模块）来自
CryptPad 的 `onlyoffice-x2t-wasm`（<https://github.com/cryptpad/onlyoffice-x2t-wasm>）——
一份公开的、把 ONLYOFFICE core 用 emscripten 编成 WebAssembly 的配方，同样按 AGPL 发布。
我们取的是它发布的产物并核对了官方校验和（见 `scripts/fetch-x2t.mjs`），
自己从源码构建的做法写在 `build/x2t/README.md` 里。

**上游那个组件包里的同一个模块曾被当成「没有对应源码」的东西，那是不成立的**：
它的启动脚本与 CryptPad 仓库里的对应文件逐字一致，并且导出了只有 CryptPad 的包装代码
才会产生的入口符号。

## 四、第三方组件

编辑器静态资源自带的第三方声明见 `/legal/3rd-Party.txt`（原样来自社区版镜像）。

本项目另外用到：

| 东西 | 许可 | 哪来的 |
|---|---|---|
| Liberation Sans（四款） | SIL OFL 1.1 | 社区版镜像的 `core-fonts/liberation/` |
| Carlito（四款） | SIL OFL 1.1 | 社区版镜像的 `core-fonts/crosextra/` |
| Droid Sans Fallback | Apache 2.0 | 社区版镜像的 `core-fonts/droid/` |
| 插件引导脚本 | Apache 2.0 | Ascensio System SIA 官方，见 `plugin/third-party/README.md` |
