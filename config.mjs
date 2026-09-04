/**
 * 全项目唯一的一处「版本与来源」事实来源。
 *
 * 别在别的文件里再抄一份版本号或地址——抄下来的那份会漂，而漂了不报错。
 * 脚本要用哪个值就从这里 import。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根。**算出来的，不写死**——写死的路径换台机器就错，而报错不指向它。 */
export const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 从哪个镜像抽静态资源。⚠ 只认社区版，见 README「两条不要越过的线」。 */
export const DOCUMENT_SERVER = {
  /** 镜像名。带 `-de` / `-ee` 的一律不许填这里。 */
  image: "onlyoffice/documentserver:9.4.0.1",

  /**
   * 镜像 ID。抽取时会核对，对不上就停——**这是产物可复现的判据**。
   * 换镜像时把这里改掉，别去改脚本。
   */
  imageId: "sha256:9f1f9ada40561752ba2597da8fe6e51fe7e09ba2b76cebdb4377ce004d88e5a3",

  /**
   * 格式转换引擎自报的版本（容器里 x2t 打印的那一行）。
   * 自己编 x2t 时要对齐的就是这个号。
   */
  coreVersion: "9.4.0.129",

  /** 容器里静态资源的根。 */
  root: "/var/www/onlyoffice/documentserver",

  /**
   * 镜像跑在哪儿。
   *
   * **空字符串 = 用本机的 docker**（有 docker 的机器就该是空的）。
   * 本机没有 docker 时，填一台跑着那个镜像的机器，抽取脚本会 ssh 过去做。
   * 也可以不动这里，用环境变量 `OOW_DS_HOST` 临时指一台。
   */
  host: process.env.OOW_DS_HOST ?? "",
  sshUser: process.env.OOW_DS_SSH_USER ?? "root",
  container: process.env.OOW_DS_CONTAINER ?? "onlyoffice",
};

/** 抽出来的静态资源放哪（相对项目根）。整棵树 gitignore。 */
export const VENDOR_DIR = "vendor/onlyoffice";

/**
 * 格式转换引擎（x2t）。
 *
 * 上游那个组件包里的 x2t 是 CryptPad 那条公开配方的产物——证据是它的启动脚本
 * 与 CryptPad 仓库里的 `pre-js.js` 逐字一致，且导出了只有 CryptPad 的包装代码
 * 才会产生的入口符号 `_main1`。所以「没有对应源码」这个说法不成立。
 *
 * 眼下先用 CryptPad 发布的现成产物（校验和已核）。等本机有了 docker，
 * `build/x2t/` 那份配方会编出对齐 coreVersion 的自建产物顶掉它。
 */
export const X2T = {
  source: "cryptpad-release",
  version: "v9.3.0+0",
  url: "https://github.com/cryptpad/onlyoffice-x2t-wasm/releases/download/v9.3.0%2B0/x2t.zip",
  /** 官方随发布件一起给的 sha512，取回来必须对上。 */
  sha512:
    "e82fbf21fcdcff2cbaca5b9a49c3a3d6bc5f5f02ba9b704a7384ceb91e17e979bf7659aaf59f677edf319fde91dd847b419e018f58f38eb1df6ab433a6cd207c",
  /** 这份产物基于的 core 版本。⚠ 与 coreVersion 差一档，自建之后这里要跟着改。 */
  builtFromCore: "9.3.0.140",
  repo: "https://github.com/cryptpad/onlyoffice-x2t-wasm",
};

// ── 跑起来要用的那几个值 ────────────────────────────────────────────────────

/**
 * 静态资源在盘上的根。**算出来的**——上一轮那个 PoC 这里是一行写死的 Windows 路径，
 * 而写成别的形式时 Node 会解成一个不存在的路径，于是每个请求 404，
 * 浏览器里报的却是「DocsAPI 脚本加载失败」，指向 SDK 不指向那一行。算出来就没这个坑。
 */
export const SDK_ROOT = path.join(PROJECT_ROOT, "vendor");

/** 静态资源那棵树的版本目录名，等于抽取时容器自报的引擎版本。 */
export const SDK_VERSION = DOCUMENT_SERVER.coreVersion;

/**
 * 转换引擎与它的字体在盘上的位置。
 *
 * ⚠ **刻意不放进版本目录里面。** 它们与静态资源是两条各自独立的版本线：
 * 今天引擎是 9.3.0.140 而静态资源是 9.4.0.129。混在一个目录里，
 * 这个差别就看不见了；分开放，`SOURCE.json` 各记各的，差在哪一眼能看出来。
 * 后端伺服时把它们贴到 `/packages/onlyoffice/<版本>/x2t{,-fonts}/` 这两个位置上，
 * 因为组件是按那个地址找的。
 */
export const X2T_DIR = path.join(PROJECT_ROOT, "vendor/x2t");
export const X2T_FONTS_DIR = path.join(PROJECT_ROOT, "vendor/x2t-fonts");

/** 端口。挑一块没人用的：平台各服务在 6000 段，前两轮 PoC 占 3020-3031。 */
export const WEB_PORT = 3040;
export const API_PORT = 3041;

/** 页面地址。插件的登记要用**绝对地址**，所以这里要能拼出来。 */
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/**
 * 签令牌的密钥**不在这里**。
 *
 * 从前这儿有一行写死的字符串，而后端是监听在 `0.0.0.0` 上的——
 * 等于把一把能用的钥匙提交进了仓库。2026-08-30 挪进 `demo/server/index.mjs`：
 * 环境变量 `OOW_TOKEN_SECRET` 优先，没设就每次启动现生成一把随机的。
 *
 * 放在这儿留一句，是因为**这个文件是「有哪些可配的东西」的入口**，
 * 而一个被挪走的配置项如果什么痕迹都不留，下一个人只会以为它从来不存在。
 */
