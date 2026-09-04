# 第三方件：OnlyOffice 插件引导脚本

`plugins.js` —— **不是本项目写的**。

- 来源：Ascensio System SIA 官方的插件引导脚本（`pluginBase.js` + `plugins.js` 合并的那一份）
- 许可：Apache License 2.0（文件头部保留着原始声明）

## 为什么必须有它，而它又不在那 1.06 GB 的 SDK 包里

每个 OnlyOffice 插件启动时都要它：它负责跟编辑器握手（`postMessage` 一条 `initialize`），
再接住编辑器发回来的 `plugin_init` 消息、把消息里那段代码 `eval` 掉——
**`Asc.plugin.executeMethod` 这些 API 是那一步注入的**，不是这个脚本自带的、也不在 SDK 里。

真实的 Document Server 把它放在 `sdkjs-plugins/` 目录下随插件一起发。
而本项目伺服的那份静态 SDK **整个 `sdkjs-plugins/` 目录都不在**
（打包脚本本来会取它，只是没进提交），所以只能另外拿一份。

## 为什么不自己重写

这段握手协议自己写得出来，但**写错了会让失败变得说不清**：面板不出来的时候，
分不清是「这个纯前端编辑器带不动插件」还是「我们的握手写错了」——
而前者正是本项目要回答的那个问题。用官方那份，失败就只有一种解释。
