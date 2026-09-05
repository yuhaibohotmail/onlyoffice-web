/**
 * 一条命令跑完这个 PoC 的全部实测。
 *
 * 它起两个服务器、按顺序跑七趟、然后收摊。七趟里有一趟是**对照组**
 * （故意用盘上原样那份登记表），它**期望红**——那一趟绿了才是出事了。
 *
 * 退出码：0 全过；1 有趟没过；2 = 一趟都没跑起来。
 *
 * 跑法：npm run poc:e2e
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POC = path.resolve(HERE, "..");
const 静态口 = Number(process.env.OOW_STATIC_PORT || 3042);
const mock口 = Number(process.env.OOW_MOCK_PORT || 3043);
/**
 * 整套东西挂在哪个路径前缀下。**默认空 = 挂在根上**，与从前逐字一样。
 *
 * 给了 `OOW_PREFIX=/oow` 就把同一套断言在**装机时那个形状**下再跑一遍
 * ——那才是真部署的样子（单域名那个站的根归门户）。
 * 挂在前缀下会碰坏一整类东西：编辑器推资源地址、插件登记表里的地址、
 * 那三条许可链接，**每一条错了都不出声**。
 */
// ⚠ 推荐 `OOW_PREFIX=oow`（**不带开头斜杠**）：Git Bash 会把看着像 Unix 路径的
//   环境值改写成 Windows 路径（`/oow` → `C:/Program Files/Git/oow`），
//   而那种情况下的症状是「服务器没起来」，一点都不指向前缀。带斜杠的也照收。
const 挂载前缀 = (() => {
  const s = String(process.env.OOW_PREFIX || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/^[A-Za-z]:/.test(s)) {
    console.error("OOW_PREFIX 被 Git Bash 改写成了 Windows 路径：" + s
      + "\n用不带开头斜杠的写法：OOW_PREFIX=oow");
    process.exit(2);
  }
  return s.startsWith("/") ? s : "/" + s;
})();
const 静态 = "http://127.0.0.1:" + 静态口 + 挂载前缀;
const 宿主 = "http://127.0.0.1:" + mock口;

const 进程们 = [];
function 起(名, 脚本, 参数, 环境) {
  const p = spawn(process.execPath, [path.join(POC, "server", 脚本), ...参数], {
    env: { ...process.env, ...环境 },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (b) => process.stdout.write("  [" + 名 + "] " + b));
  p.stderr.on("data", (b) => process.stderr.write("  [" + 名 + "!] " + b));
  进程们.push(p);
  return p;
}

function 停全部() {
  for (const p of 进程们) {
    try {
      p.kill();
    } catch {
      /* 已经没了就算了 */
    }
  }
  进程们.length = 0;
}

/** 等一个地址答话。**别用固定 sleep**——机器忙的时候它会不够，而不够的样子是「连不上」。 */
async function 等它起来(地址, 秒 = 20) {
  for (let i = 0; i < 秒 * 4; i++) {
    try {
      const r = await fetch(地址);
      if (r.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function 跑(脚本, 参数 = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, 脚本), ...参数], { stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

const 结果 = [];
async function 一趟(名, 脚本, 参数, 期望 = 0) {
  console.log("\n───── " + 名 + " ─────");
  const 码 = await 跑(脚本, 参数);
  const 过 = 码 === 期望;
  结果.push({ 名, 码, 期望, 过 });
  console.log(
    (过 ? "✔ " : "✘ ") + 名 + "：退出码 " + 码 +
      (期望 === 0 ? "" : "（这一趟**期望**是 " + 期望 + "，也就是期望它红）"),
  );
}

try {
  // ── 0 · 预生成登记表（装机时该做的那一步）──────────────────────────────
  console.log("───── 预生成插件登记表 ─────");
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(POC, "server", "pregenerate-plugins.mjs"),
      ...(挂载前缀 ? ["--prefix", 挂载前缀] : [])], {
      stdio: "inherit",
    });
    p.on("exit", resolve);
  });
  if (!fs.existsSync(path.join(POC, "assembled", "plugins.json"))) {
    console.error("预生成那一步没产出东西 —— 后面没得跑。");
    process.exitCode = 2;
  } else {
    // ── 1 · 正常那一档 ──────────────────────────────────────────────────
    起("静态", "static-server.mjs", [String(静态口)]);
    起("mock", "mock-host.mjs", [String(mock口)]);
    const 静态好了 = await 等它起来(静态 + "/embed.html");
    const mock好了 = await 等它起来(宿主 + "/_probe/state");
    if (!静态好了 || !mock好了) {
      console.error("服务器没起来（静态=" + 静态好了 + " mock=" + mock好了 + "）");
      process.exitCode = 2;
    } else {
      await 一趟("① 笨静态服务器后面正常吗（用预生成的登记表）", "static-check.mjs", [静态]);
      await 一趟("② 接入页那条链 + 凭据每次现要", "embed-flow.mjs", [宿主, 静态]);
      await 一趟("③ 导出回落时拒绝上传", "fallback-guard.mjs", [宿主, 静态]);
      await 一趟("④ 两道来源校验", "origin-guard.mjs", [静态]);
      await 一趟("⑤ 自定义插件那条通道（宿主下发配置，插件收得到）", "plugin-channel.mjs", [宿主, 静态]);
      await 一趟("⑥ 法律声明那四条链接真的能到东西", "legal-links.mjs", [静态, 宿主]);

      // ── 2 · 对照组：换成盘上原样那份登记表，**期望它红** ────────────────
      停全部();
      起("静态·原样", "static-server.mjs", [String(静态口)], { OOW_NO_PREGEN: "1" });
      if (await 等它起来(静态 + "/embed.html")) {
        await 一趟(
          "⑦ 对照组：不预生成登记表 → **期望红**（证明①那一趟的绿是有内容的）",
          "static-check.mjs",
          [静态],
          1,
        );
      } else {
        console.error("对照组那趟的服务器没起来");
        结果.push({ 名: "⑦ 对照组", 码: -1, 期望: 1, 过: false });
      }
    }
  }
} finally {
  停全部();
}

console.log("\n══════ 汇总 ══════");
for (const r of 结果) {
  console.log((r.过 ? "  ✔ " : "  ✘ ") + r.名 + "  （退出码 " + r.码 + "，期望 " + r.期望 + "）");
}
const 没过 = 结果.filter((r) => !r.过);
console.log(结果.length - 没过.length + "/" + 结果.length + " 趟如期");
if (!结果.length) process.exitCode = 2;
else if (没过.length) process.exitCode = 1;
