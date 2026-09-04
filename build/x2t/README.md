# 自己编格式转换引擎（x2t）

这个目录答一个问题：**怎么从源码编出浏览器里那个做格式转换的 wasm，而不是从别处拿一份现成的。**

眼下 `vendor/x2t/` 里放的是 CryptPad 发布的现成产物（`scripts/fetch-x2t.mjs` 取的，校验和已核）。
**这个目录是用来把它换成我们自己编的那一份的**，理由有两条：一是许可要求我们能给出对应源码
与构建方式，二是现成那份基于的 core 是 9.3.0.140，而我们自己的文档服务是 9.4.0.129，差一档。

⚠ **本机今天编不了**：要一台 Linux 加 Docker，而本机两样都没有，装它要管理员权限。
dev 那八台机器是 2 核、1750 MB 内存、17 G 盘，光 openssl 加 boost 就超盘。
装好之后跑 `./build.sh`，别的什么都不用准备。

## 一件已经查清的事：上游那份不是黑盒

上游那个组件包里的 `x2t.wasm` 一直被当成「直接提交进仓库、没有对应源码」的东西。**不是。**
它是 CryptPad 那条公开配方的产物，两条证据：

1. 它的 `x2t.js` 里那段启动脚本，与 CryptPad 仓库里的 `pre-js.js` **逐字一致**，连制表符缩进都一样。
2. 它导出了 `_main1`。这个符号只可能来自 CryptPad 的 `wrap-main.cpp`——那份代码被追加到
   `X2tConverter/src/main.cpp` 末尾，把 `main` 包成一个可以反复调用的 `main1`。

顺带量出来的：上游那份 9.22 MB，CryptPad 发布的那份 6.49 MB，**同样的功能小 30%**。
差在上游那趟编译带着 26.5 MB 调试信息而且没开优化（函数个数 146064 对 76474）。

从这份 wasm 的调试信息里还能读出它的构建环境：编译器是
`clang version 21.0.0git`（对应 emsdk 4.0.x），源码树挂在 `/core`，emsdk 在 `/emsdk`
——正是 CryptPad 那个 Dockerfile 的布局。

## 配方长什么样

CryptPad 的 `Dockerfile` 有三十来个阶段，一个阶段编一个静态库，最后链成 wasm：

- 底座 `ubuntu:22.04` + `emsdk 4.0.11` + qt6（要 qmake）
- 第三方各自单编：openssl 1.1.1f、boost 1.84、harfbuzz、hyphen、brotli、heif、gumbo、katana
- core 自己的库：kernel、graphics、UnicodeConverter、各格式的 FormatLib（docx/pptx/xlsx/doc/ppt/xls/odf/rtf/txt）、
  PdfFile、HtmlFile2、EpubFile、XpsFile、DjVuFile、HwpFile、IWorkFile、DocxRenderer、doctrenderer
- 最后把 `wrap-main.cpp` 追加进 `X2tConverter/src/main.cpp`，链接时带上
  `--pre-js pre-js.js`、`-sEXPORTED_RUNTIME_METHODS=ccall,FS`、`-sEXPORTED_FUNCTIONS=_main1`、
  `-sALLOW_MEMORY_GROWTH`
- 产物再用 `brotli` 压一遍，得到 `x2t.wasm.br` 与 `x2t.js.br`

它自带一套对照测试：拿真 Document Server 里那个原生 x2t 当基准，同一批文件两边各转一遍比结果。

## 怎么编

```sh
./build.sh              # 编当前钉住的版本，产物落 out/
./build.sh --bump       # 先把 core 升到 config.mjs 里那个 coreVersion 再编
```

`build.sh` 干的事：克隆 CryptPad 那个仓库（如果还没克隆）、可选地把 core 升到我们要的版本、
跑他们的 `build.sh`、把产物拷进 `vendor/x2t/` 并重写那份 `SOURCE.json`。

## 升到 9.4.0.129

CryptPad 那个仓库里的 `core/` 是 ONLYOFFICE core 的一份**改过的副本**，以 git subtree 的形式存着。
升级就是：

```sh
git subtree pull --prefix core https://github.com/ONLYOFFICE/core.git v9.4.0.129 --squash
```

会有冲突，因为他们对 core 动过刀。**这件事的难度已经量过了**（2026-08-30，只用 git，不用 docker）：

**CryptPad 对 core 改了 30 个文件，+1574 / −575。** 大头是三块：
`Common/base.pri` 一个占 473 行改动（qmake 的编译参数）、
新写的 `doctrenderer_empty.cpp` 827 行（把要 V8 的那半换成空实现——**V8 编不成 wasm**，
这是整条配方的核心手术）、以及十来个 `.pri` / `.pro` 构建文件。
真正改到 C++ 逻辑的只有五处：`HtmlFile2/htmlfile2.cpp`、`PPTShape/BinaryReader.{h,cpp}`、
`X2tConverter/src/lib/html.h`、`pdf_image.h`、`main.cpp`。

**再看这 30 个文件从 9.3.0.140 到 9.4.0.129 变了多少**：只有 21 个变过，
合计 +761 / −283。而且其中十来个的改动是**整齐的 +33 行、0 删除**——
那是 Ascensio 在 9.4 给全树每个文件统一加的一段 AGPL 许可头，插在第 1 行。
CryptPad 改的都在文件体内，所以这一类会自动合并，不产生冲突。

**真正要人看的只有三处**：`HtmlFile2/htmlfile2.cpp`（+275，唯一一处实质重写）、
`UnicodeConverter.pro`（113）、`Common/base.pri`（除许可头外还多了一段 `core_release` 下的
`-g0` 与 `-Wl,-s`——**正好是把调试信息去掉那件事，与我们想要的方向一致**）。

结论：**升级是可估的工作量，不是未知数。** 但顺序仍然是先照他们钉住的 9.3.0.140 编一遍、
确认整条链在我们机器上通，**再**动版本。一上来就升，编不过时分不清是
「配方在我们机器上不通」还是「9.4 变了什么」。

量这两个数用的命令（先把 CryptPad 那个仓库浅克隆到任意位置）：

```sh
git fetch --depth=1 https://github.com/ONLYOFFICE/core.git v9.3.0.140 && git tag -f v930 FETCH_HEAD
git fetch --depth=1 https://github.com/ONLYOFFICE/core.git v9.4.0.129 && git tag -f v940 FETCH_HEAD
git diff --stat v930 HEAD:core      # CryptPad 改了什么
git diff --stat v930 v940 -- <上面那 30 个路径>   # 这些文件在两版之间变了什么
```

## 编完拿什么判「成了」

**判据取产物本身，不取构建脚本有没有报错。** 三条：

1. `x2t.wasm` 解开之后魔数是 `\0asm`，段结构里有 code / data / export，**没有** `.debug_*`
   （带调试信息说明优化参数没生效，产物会大三成）
2. 导出表里有 `main1`——没有它组件根本调不动
3. 拿 `demo/e2e/` 那套自动实测跑一遍：取件、编辑、插件插公式、存回服务端，
   判据取导出的 docx 字节。**换引擎最容易坏的就是格式转换，而它坏起来不出声。**

编完顺手记一下产物的大小与函数个数，与这份文档里那两组数对一下。
