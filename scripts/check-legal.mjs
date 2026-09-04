#!/usr/bin/env node
/**
 * 核一遍合规那几条**在代码里还立着**。
 *
 *   node scripts/check-legal.mjs
 *
 * 零设施、亚秒级。
 *
 * ── 它在防什么 ──────────────────────────────────────────────────────────────
 *
 * 合规那五条是一次性做完的，而**做完之后没有任何东西拦着它被改回去**。
 * 把微软那个图标加回来、把授权里五个开关翻回 true、把界面上那个入口摘掉，
 * 这三件事都不会让任何测试变红——它们只会让我们悄悄地违约。
 *
 * 所以这里立几条回归探针。它查的不是「有没有做过」，而是「现在还在不在」。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *
 *   0  都在
 *   1  有一条不在了
 *   2  一条都没查（文件路径变了，这与「都在」不是一回事）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let 查过 = 0;
let 不对 = 0;

const 读 = (rel) => {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8");
};

const 查 = (说的是什么, 判) => {
  查过++;
  let 结果;
  try {
    结果 = 判();
  } catch (e) {
    结果 = "查的时候出错：" + e.message;
  }
  if (结果 === true) {
    console.log("✓ " + 说的是什么);
  } else {
    console.error("✗ " + 说的是什么 + "\n    " + 结果);
    不对++;
  }
};

// ── 一、许可原文与修改说明都在 ──────────────────────────────────────────────

查("许可原文里有那五条附加条款", () => {
  const s = 读("LICENSE");
  if (!s) return "LICENSE 不在";
  const 条 = [
    "Retention of Notices and Attribution",
    "Modification Notice Requirement",
    "Appropriate Legal Notices in User Interfaces",
    "No Trademark License",
    "Non-Code Content Licensing",
  ];
  const 缺 = 条.filter((t) => !s.includes(t));
  return 缺.length ? "少了：" + 缺.join("、") : true;
});

查("修改说明在，且写明了基于 ONLYOFFICE、由 Ascensio 开发", () => {
  const s = 读("NOTICE.md");
  if (!s) return "NOTICE.md 不在";
  if (!s.includes("Ascensio System SIA")) return "没写原始开发者是谁";
  if (!s.includes("修改过的版本")) return "没写这是一个修改版";
  if (!/20\d\d-\d\d-\d\d/.test(s)) return "没写修改日期";
  return true;
});

// ── 二、界面上那个入口还在 ──────────────────────────────────────────────────

查("界面上那个法律声明入口还在组件里（不是在页面里）", () => {
  const s = 读("src/legal/notice.ts");
  if (!s) return "legal/notice.ts 不在";
  const m = 读("src/core/editor-manager.ts");
  if (!m) return "editor-manager.ts 不在";
  if (!m.includes("mountLegalNotice")) return "编辑器挂载时没有挂上它——挂在页面里的话，别人引用组件时就丢了";
  return true;
});

查("那个入口里三样都有：原始开发者 / 是修改版 / 许可信息", () => {
  const s = 读("src/legal/notice.ts");
  if (!s) return "legal/notice.ts 不在";
  if (!s.includes("Ascensio System SIA")) return "没提原始开发者";
  if (!s.includes("修改过的版本")) return "没说这是修改版";
  if (!s.includes("LICENSE.txt")) return "没有指向许可原文的链接";
  return true;
});

查("修改清单不是空的（附加条款第二条要求写明改了什么）", () => {
  const s = 读("src/legal/notice.ts");
  if (!s) return "legal/notice.ts 不在";
  const n = (s.match(/日期:/g) || []).length;
  return n >= 1 ? true : "MODIFICATIONS 是空的";
});

// ── 三、回退探针：这几样不许再出现 ──────────────────────────────────────────

/**
 * 把注释剥掉再判。
 *
 * ⚠ 这一步不是可有可无的：**我们正是在注释里解释「为什么去掉那个图标」**，
 * 所以带注释一起判必然误报。第一版就是这么误报的——它跨行匹配到了
 * 一段解释文字的两端引号之间。**一条会误报的判据比没有判据更糟**，
 * 因为它会先被人加进豁免名单，然后连真的那次也不响了。
 */
function 去掉注释(s) {
  // ⚠ 先把行尾归一。组件那些文件是 CRLF，而正则里的 `$` 卡在行尾那个 `\r` 前面
  // 匹配不上——于是注释一行都没被剥掉，判据照样误报。**第二版就栽在这里。**
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");
}

查("没有把别家的商标图标加回来", () => {
  const 命中 = [];
  const 走 = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        走(p);
      } else if (/[.](ts|tsx|js|jsx)$/.test(e.name)) {
        const 代码 = 去掉注释(fs.readFileSync(p, "utf8"));
        if (/microsoftoffice/i.test(代码)) {
          命中.push(path.relative(ROOT, p).split(path.sep).join("/"));
        }
      }
    }
  };
  // ⚠ **两棵树都要扫。** 组件在 src/、页面在 demo/；
  // 只扫一棵不会红，只会**静静地少看一半**。
  走(path.join(ROOT, "src"));
  走(path.join(ROOT, "demo"));
  return 命中.length ? "这些文件里又出现了：" + 命中.join("、") : true;
});

查("伪造的那份授权还是最小的（五个商业版开关都关着）", () => {
  const s = 读("src/internal/editor/server.ts");
  if (!s) return "server.ts 不在";
  const 段 = s.slice(s.indexOf('type: "license"'), s.indexOf('type: "license"') + 900);
  if (!段) return "找不到那段授权消息";
  const 开着的 = ["protectionSupport", "isAnonymousSupport", "liveViewerSupport", "customization", "advancedApi", "branding"]
    .filter((k) => new RegExp(k + ":\\s*true").test(段));
  return 开着的.length ? "这几个又被打开了：" + 开着的.join("、") : true;
});

查("静态资源来源仍然钉在社区版镜像上", () => {
  const s = 读("config.mjs");
  if (!s) return "config.mjs 不在";
  const m = s.match(/image:\s*"([^"]+)"/);
  if (!m) return "config.mjs 里找不到镜像那一行";
  if (/-de|-ee/.test(m[1])) return "镜像变成了商业授权版：" + m[1];
  const g = 读("scripts/extract-assets.mjs");
  if (!g || !g.includes("refuseNonCommunityImage")) return "抽取脚本里那道拦截没了";
  return true;
});

// ── 四、把带修改标记的文件列出来，供人与修改说明对照 ────────────────────────

const 带标记的 = [];
const 扫 = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      扫(p);
    } else if (/[.](ts|tsx|mjs|js)$/.test(e.name)) {
      const s = fs.readFileSync(p, "utf8");
      const n = (s.match(/【本项目(修改|新增)/g) || []).length;
      if (n) 带标记的.push({ 文件: path.relative(ROOT, p).split(path.sep).join("/"), 处数: n });
    }
  }
};
// ⚠ **两棵树都要扫**，理由同上：这份清单是拿来与 NOTICE.md 对账的，
// 漏掉 demo/ 那棵的话，页面里那处修改标记就再也不出现在对照清单里了。
扫(path.join(ROOT, "src"));
扫(path.join(ROOT, "demo"));

console.log("\n带「本项目修改/新增」标记的文件（拿它与 NOTICE.md 对照，别让两边分叉）：");
for (const x of 带标记的) console.log("  " + String(x.处数).padStart(2) + " 处  " + x.文件);
if (带标记的.length === 0) {
  console.error("\n✗ 一处修改标记都没有——改了上游的代码却没留标记，是查不出来的那种违约");
  不对++;
}

if (查过 === 0) {
  console.error("✗ 一条都没查到");
  process.exit(2);
}
if (不对) {
  console.error(`\n✗ ${查过} 条里有 ${不对} 条不对`);
  process.exit(1);
}
console.log(`\n✓ ${查过} 条全在`);
