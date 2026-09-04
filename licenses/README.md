# 许可原件（2026-08-30 从我们自己的社区版容器里取的）

这几份不是我们写的，是**依据**。取自镜像
**`onlyoffice/documentserver:9.4.0.1`**（社区版，AGPL）里的容器，
路径 `/var/www/onlyoffice/documentserver/`。

| 文件 | 是什么 |
|---|---|
| `onlyoffice-LICENSE.txt` | AGPL-3.0 全文 **＋ Ascensio 的五条附加条款**。各处源码头部写的「together with the additional terms provided in the LICENSE file」指的就是这一份 |
| `api-js-header-community.txt` | 社区版 `api.js` 头部的许可声明 |
| `api-js-header-de-derived.txt` | 上游那个包里同一个文件的声明，**与上面那份逐字一致** |

## 为什么要专门取这一份

上游那个纯前端项目带的 1.06 GB 静态包里**一份 OnlyOffice 的许可文件都没有**
（整棵树里只有 Monaco 的两份）。而源码头部明写它的条款「连同 LICENSE 文件里提供的附加条款」
——**不知道那五条写了什么，就没法声明遵守它**。这个空白现在填上了。

## 那五条附加条款（按第 7 条补充，违反即构成违约）

1. **保留声明与署名** —— 版权声明、许可声明、免责声明、来源署名都必须保留
2. **修改要声明** —— 修改版必须带显著声明，写明**已修改**、**修改日期**，
   并**明确指出它基于 Ascensio System SIA 开发的 ONLYOFFICE**
3. **界面里的法律声明** —— 有交互界面的，必须通过**清晰可达、显著可见**的界面入口
   让用户能够：(i) 认出 ONLYOFFICE 是原始开发者；(ii) 知道当前这一版可能是修改版；
   (iii) 拿到适用的许可信息
4. **不授予商标权** —— 不授予使用其商标、服务标记、商号、**logo 或品牌标识**的任何权利，
   商标另按 <https://www.onlyoffice.com/trademark-policy>
5. **非代码内容另有许可** —— 插图、图标集、文档内容等按 **CC BY-SA 4.0**

## 两条顺带查到的事实

- **社区版容器里有 `sdkjs-plugins/`**：11 个插件 + `marketplace` + **`pluginBase.js`** + `v1`。
  上一轮说「`pluginBase.js` 不在包里」讲的是**上游那个包**；真要那个目录，
  从**我们自己这个社区版容器**取就行，不必碰商业版。
- **社区版与上游那个 DE 派生包的许可声明头逐字一致** —— 说明代码是同一份，
  差别在**分发条款**而不在代码。
