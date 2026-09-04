#!/usr/bin/env node
/**
 * 现生成一套**各种格式**的测试文档，供「哪些类型打得开」那条实测用。
 *
 *   node scripts/make-format-fixtures.mjs
 *   node scripts/make-format-fixtures.mjs --force
 *
 * ── 怎么来的 ────────────────────────────────────────────────────────────────
 *
 * 三份源文件，各带一族：
 *
 *   文字  我们自己现生成的那份中文教案 docx（有内容、有四个中文字体名）
 *   表格  我们自己现写的一份中文 csv，先转成 xlsx 再往下转
 *   演示  社区版镜像里的 `new.pptx`（空白，但是真文件）
 *
 * 然后**用容器里那个原生 x2t 转出其余格式**。这样每一份都是真文件、
 * 都出自我们自己的工具链，而且换台机器重跑能得到一样的东西。
 *
 * ⚠ **不从别处拷现成的测试文档。** 拷来的文件出处与许可都要单独交代，
 * 而且「它打不开」时分不清是我们的问题还是那份文件本身有问题。
 *
 * ── 两个会咬人的地方 ────────────────────────────────────────────────────────
 *
 * 1. **x2t 只给两个文件名是跑不起来的**——它要建临时目录，而默认那个位置建不了，
 *    报「Couldn't create temp folder」。必须走参数 XML，在里面写明 `m_sTempDir`。
 * 2. 转换在**容器里**做，产物再传回来。本机没有 docker。
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENT_SERVER as DS, SDK_ROOT, SDK_VERSION } from "../config.mjs";
import { buildLessonPlanDocx } from "../demo/fixtures/make-fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo/fixtures/formats");
const 远端 = "/tmp/oow-fixtures";
const FORCE = process.argv.includes("--force");

const log = (...a) => console.log("→", ...a);
const die = (m) => {
  console.error("✗ " + m);
  process.exit(1);
};

/** x2t 的格式编号，取自组件里的 AvsFileType。 */
const 格式 = {
  docx: 65, doc: 66, odt: 67, rtf: 68, txt: 69, html: 70, epub: 72, fb2: 73,
  xlsx: 257, xls: 258, ods: 259, csv: 260,
  pptx: 129, ppt: 130, odp: 131,
  pdf: 513,
};

/**
 * 三份源文件在容器里叫什么。
 *
 * ⚠ **容器里一律用 ASCII 文件名。** 中文文件名要穿过 ssh 与 docker exec 两层，
 * 每一层的字符集都不由我们定；名字错了之后 x2t 只会说「找不到文件」，
 * 而那句话不指向编码。本机这边照样用看得懂的名字，取回来时改回去。
 */
const 源 = {
  word: "src-word.docx",
  cell: "src-cell.csv",
  slide: "src-slide.pptx",
};

/**
 * 从哪一份转出哪一份。顺序有意义：xlsx 要先由 csv 转出来，后面几个才有源。
 *
 * ⚠ **doc / xls / ppt 三种老式二进制格式不在这张表里**：OnlyOffice **只读不写**，
 * x2t 转不出它们（实测：退出码 0、不产出任何文件）。
 * 要测「读得进来吗」得另外弄真文件，见下面 `老式二进制` 那一段。
 */
const 要转的 = [
  { 源: 源.word, 目标: "out.odt" },
  { 源: 源.word, 目标: "out.rtf" },
  { 源: 源.word, 目标: "out.txt" },
  { 源: 源.word, 目标: "out.html" },
  { 源: 源.word, 目标: "out.epub" },
  { 源: 源.word, 目标: "out.fb2" },
  { 源: 源.word, 目标: "out.pdf" },
  { 源: 源.cell, 目标: "out.xlsx" },
  { 源: "out.xlsx", 目标: "out.ods" },
  { 源: 源.slide, 目标: "out.odp" },
];

/**
 * 三种老式二进制格式的真文件。
 *
 * 它们是本项目**唯一一批不是自己现生成的测试文档**——因为生成不出来：
 * OnlyOffice 读得了 doc / xls / ppt，却写不出它们。要验「读得进来吗」，
 * 就得有真文件。
 *
 * 取自 ONLYOFFICE core 自己的测试素材，**按标签钉死并核对 sha256**。
 * 与本项目别处一样：来路写清楚、校验和对得上，才收。
 *
 * ⚠ `demo/fixtures/formats/` 整个目录 gitignore——这几份第三方文件不进我们仓库，
 * 要用现取。
 */
const CORE_TAG = "v9.4.0.129";
const 老式二进制 = [
  {
    存成: "老式.doc",
    路径: "DesktopEditor/raster/Jp2/openjpeg/openjpeg-2.4.0/src/bin/mj2/mj2_to_metadata_Notes.doc",
    sha256: "d1626c54abbfe264dc2f001ea516b2526c737d7bf3f64fc4776b1dd438af24a9",
  },
  {
    存成: "老式.xls",
    路径: "Test/Applications/AVSOfficeEWSEditorTest/AVSOfficeEWSEditorTest/TestFiles/Auto_color_as_index.xls",
    sha256: "2ab2143488b6e1ea7add11ae79e04083ad5d9c915dd09226d6f56360ba5d616c",
  },
  {
    存成: "老式.ppt",
    路径: "Common/cfcpp/test/data/src/ex.ppt",
    sha256: "f1b2132b44b7d52e5052b52ba9b812fcf89028af25c210e83c8439ab4e270cae",
  },
];

function sh(cmd, { input, binary = false } = {}) {
  const r = spawnSync("bash", ["-c", cmd], {
    input,
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) die(`命令失败（退出码 ${r.status}）：\n${cmd}\n${r.stderr ?? ""}`);
  return r.stdout;
}

const ssh = (cmd, opts) =>
  sh(`ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${DS.sshUser}@${DS.host} ${JSON.stringify(cmd)}`, opts);

/**
 * 把一段字节送进容器里的某个文件。`docker exec -i` 收标准输入。
 *
 * ⚠ **用标准输入送，别用 heredoc。** 内容要穿过本机 bash → ssh → 远端 sh → docker exec
 * 四层引号，heredoc 在中间某一层会被拆坏，而报错是远端 sh 的
 * 「Syntax error: redirection unexpected」——那句话不指向引号。
 */
function 送进容器(内容, 远端文件名) {
  const buf = Buffer.isBuffer(内容) ? 内容 : Buffer.from(内容, "utf8");
  sh(
    `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${DS.sshUser}@${DS.host} ` +
      JSON.stringify(`docker exec -i ${DS.container} sh -c 'cat > ${远端}/${远端文件名}'`),
    { input: buf },
  );
  return buf.length;
}

/** 从容器里取一个文件回来。 */
function 取回(远端文件名) {
  return ssh(`docker exec ${DS.container} sh -c 'cat ${远端}/${远端文件名} 2>/dev/null || true'`, { binary: true });
}

/**
 * ⚠ **源文件是 csv 时必须多给两个参数**（编码与分隔符）。
 * 不给的话 x2t **退出码 0、却什么都不产出**——一个不出声的失败，
 * 而少一份 xlsx 之后，后面由它转出的 xls / ods 也跟着没有，
 * 看起来像「这几个格式转不了」。
 */
const CSV_编码_UTF8 = 46;
const CSV_分隔符_逗号 = 4;

function 转一次(源, 目标) {
  const ext = 目标.split(".").pop().toLowerCase();
  const 编号 = 格式[ext];
  if (!编号) die(`不认识的目标格式：${ext}`);
  const csv额外 = 源.toLowerCase().endsWith(".csv")
    ? `<m_nCsvTxtEncoding>${CSV_编码_UTF8}</m_nCsvTxtEncoding>` +
      `<m_nCsvDelimiter>${CSV_分隔符_逗号}</m_nCsvDelimiter>`
    : "";
  // ⚠ 参数 XML 不能省：只给两个文件名时 x2t 建不了临时目录，报
  // 「Couldn't create temp folder」——那句话不指向缺少临时目录的配置。
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<m_sFileFrom>${远端}/${源}</m_sFileFrom>` +
    `<m_sFileTo>${远端}/${目标}</m_sFileTo>` +
    `<m_nFormatTo>${编号}</m_nFormatTo>` +
    `<m_sThemeDir>${DS.root}/sdkjs/slide/themes</m_sThemeDir>` +
    `<m_bFromChanges>false</m_bFromChanges>` +
    `<m_sAllFontsPath>${DS.root}/server/FileConverter/bin/AllFonts.js</m_sAllFontsPath>` +
    `<m_sFontDir>${DS.root}/fonts</m_sFontDir>` +
    `<m_sTempDir>${远端}/tmp</m_sTempDir>` +
    csv额外 +
    `</TaskQueueDataConvert>`;

  送进容器(xml, "p.xml");
  const 结果 = ssh(
    `docker exec ${DS.container} sh -c ` +
      JSON.stringify(
        `${DS.root}/server/FileConverter/bin/x2t ${远端}/p.xml >/dev/null 2>&1; echo rc=$?; ` +
          `[ -f ${远端}/${目标} ] && stat -c %s ${远端}/${目标} || echo 0`,
      ),
  );
  const rc = Number((结果.match(/rc=(\d+)/) || [])[1] ?? -1);
  const size = Number(结果.trim().split("\n").pop() || 0);
  return { rc, size };
}

function main() {
  if (fs.existsSync(OUT) && !FORCE) die(`${OUT} 已经有了。要重做加 --force。`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ── 三份源文件 ──────────────────────────────────────────────────────────
  const docx = buildLessonPlanDocx();
  fs.writeFileSync(path.join(OUT, "lesson-plan-zh.docx"), docx);

  // 中文表格：现写，不从别处拷。带一格公式，好看出转换有没有把它变成死值。
  const csv =
    "姓名,班级,平时分,期末分,总评\n" +
    "张三,高一(1)班,88,92,=C2*0.4+D2*0.6\n" +
    "李四,高一(1)班,76,81,=C3*0.4+D3*0.6\n" +
    "王五,高一(2)班,95,89,=C4*0.4+D4*0.6\n";
  fs.writeFileSync(path.join(OUT, "表格.csv"), Buffer.from("﻿" + csv, "utf8"));

  const pptx源 = path.join(SDK_ROOT, "onlyoffice", SDK_VERSION, "document-templates/new/default/new.pptx");
  if (!fs.existsSync(pptx源)) {
    die(`缺 ${pptx源}\n  它由 scripts/extract-assets.mjs 抽出来；先把那一步跑了。`);
  }
  fs.copyFileSync(pptx源, path.join(OUT, "new.pptx"));

  log("三份源文件就位：中文教案 docx / 中文表格 csv / 空白 pptx");

  // ── 送进容器 ────────────────────────────────────────────────────────────
  ssh(`docker exec ${DS.container} sh -c 'rm -rf ${远端} && mkdir -p ${远端}/tmp'`);
  const 送 = [
    ["lesson-plan-zh.docx", 源.word],
    ["表格.csv", 源.cell],
    ["new.pptx", 源.slide],
  ];
  for (const [本地名, 容器名] of 送) {
    const n = 送进容器(fs.readFileSync(path.join(OUT, 本地名)), 容器名);
    log(`送进容器 ${本地名} → ${容器名}（${n} 字节）`);
  }

  // ── 逐个转 ──────────────────────────────────────────────────────────────
  /** 容器里那个 ASCII 名字，在本机叫什么。 */
  const 本地名 = (容器名) => "转出." + 容器名.split(".").pop();

  const 记录 = [];
  for (const 条 of 要转的) {
    const 出 = 本地名(条.目标);
    const { rc, size } = 转一次(条.源, 条.目标);
    if (rc === 0 && size > 0) {
      const buf = 取回(条.目标);
      if (buf.length !== size) {
        // 传回来的字节数与容器里对不上，多半是二进制在某一层被当文本处理了。
        // **宁可丢掉也不留一份坏的**——一份悄悄坏掉的夹具会让实测报出假的失败。
        log(`⚠ ${出} 传回 ${buf.length} 字节，容器里是 ${size} 字节——对不上，丢弃`);
        记录.push({ 文件: 出, 结果: "传回时字节对不上", 容器里: size, 传回: buf.length });
        continue;
      }
      fs.writeFileSync(path.join(OUT, 出), buf);
      log(`${条.源.padEnd(16)} → ${出.padEnd(12)} ${String(size).padStart(8)} 字节`);
      记录.push({ 文件: 出, 结果: "成了", 字节: size, 由: 条.源 });
    } else {
      // **转不出来也要如实记下来。** 悄悄少一个格式，与「那个格式我们不支持」长得一样。
      log(`✗ ${条.源.padEnd(16)} → ${出.padEnd(12)} 转不出来（rc=${rc}）`);
      记录.push({ 文件: 出, 结果: "转不出来", 退出码: rc, 由: 条.源 });
    }
  }

  ssh(`docker exec ${DS.container} sh -c 'rm -rf ${远端}'`);

  // ── 三种老式二进制：只读不写，所以取真文件 ──────────────────────────────
  for (const 条 of 老式二进制) {
    const url = `https://raw.githubusercontent.com/ONLYOFFICE/core/${CORE_TAG}/${条.路径}`;
    const buf = sh(`curl -sSL ${JSON.stringify(url)}`, { binary: true });
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== 条.sha256) {
      // **拿到的不是那一份就不要。** 一份内容不对的夹具会让实测报出假的失败，
      // 而人会去查产品。
      log(`✗ ${条.存成} 校验和对不上，丢弃\n    该是 ${条.sha256}\n    实际 ${got}`);
      记录.push({ 文件: 条.存成, 结果: "校验和对不上" });
      continue;
    }
    fs.writeFileSync(path.join(OUT, 条.存成), buf);
    log(`取回 ${条.存成.padEnd(12)} ${String(buf.length).padStart(8)} 字节（core ${CORE_TAG}，校验和已核）`);
    记录.push({ 文件: 条.存成, 结果: "取回来了", 字节: buf.length, 由: `ONLYOFFICE/core ${CORE_TAG} 的 ${条.路径}` });
  }

  fs.writeFileSync(
    path.join(OUT, "SOURCE.json"),
    JSON.stringify(
      {
        说明: "这些测试文档是怎么来的。别手改——由 scripts/make-format-fixtures.mjs 生成。",
        源文件: {
          "lesson-plan-zh.docx": "本项目现生成（demo/fixtures/make-fixtures.mjs），中文内容 + 四个中文字体名",
          "表格.csv": "本项目现写，带三行中文与一列公式",
          "new.pptx": "社区版镜像 " + DS.image + " 里的新建演示模板（空白）",
        },
        转换用的: "容器里那个原生 x2t（" + DS.image + "），走参数 XML",
        老式二进制: "doc / xls / ppt 三种 OnlyOffice 只读不写，转不出来；取自 ONLYOFFICE/core ${CORE_TAG}，按 sha256 核过",
        生成时间: new Date().toISOString(),
        逐个: 记录,
      },
      null,
      2,
    ) + "\n",
  );

  const 成 = 记录.filter((x) => x.结果 === "成了").length;
  console.log(`\n✓ ${OUT}`);
  console.log(`  源文件 3 份 + 转出 ${成} 份（${记录.length} 个目标里有 ${记录.length - 成} 个没转出来）`);
  console.log(`  一共 ${fs.readdirSync(OUT).filter((f) => !f.endsWith(".json")).length} 份文档`);
}

main();
