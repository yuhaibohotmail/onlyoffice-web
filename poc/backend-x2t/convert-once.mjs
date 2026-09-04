#!/usr/bin/env node
/**
 * 跑**一次**转换就退出。给 run.mjs 用的。
 *
 * ⚠ **为什么要单独一个进程。** x2t 的 `main1` 是一次同步的 wasm 调用，
 * 一旦它在里面转不出来（`html` 就是，见 FINDINGS 第十一节：不报错、不返回、
 * 就是不回来），**同一个进程里没有任何东西能把它打断**——事件循环根本轮不上，
 * 定时器不会触发，Promise 不会兑现。唯一能收场的办法是从外面把进程杀掉。
 *
 * 这不只是测试脚手架的事：**真做成一个后端服务，这一条同样成立**——
 * 每次转换得关在一个能被杀掉的进程（或能 terminate 的 worker）里，
 * 否则一份坏文档就能把整个服务挂死，而且看不出是哪一份。
 *
 * 用法：node convert-once.mjs '<job JSON>'
 * 结果打到 stdout 的最后一行，前缀 `RESULT `。产物落 --out 指定的文件。
 */

import fs from "node:fs";
import { convert } from "./x2t-node.mjs";

const job = JSON.parse(process.argv[2]);
const outFile = job.outFile;

const result = await convert({
  data: job.dataFile ? fs.readFileSync(job.dataFile) : undefined,
  fileFrom: job.fileFrom,
  fileTo: job.fileTo,
  formatFrom: job.formatFrom,
  formatTo: job.formatTo,
  csv: job.csv,
  pdfFonts: job.pdfFonts,
  pdfBinBytes: job.pdfBinFile ? fs.readFileSync(job.pdfBinFile) : undefined,
});

if (result.output && outFile) fs.writeFileSync(outFile, result.output);

console.log(
  "RESULT " +
    JSON.stringify({
      ok: result.ok,
      rc: result.rc,
      ms: result.ms,
      bytes: result.output?.length ?? 0,
      error: result.error,
      stderr: result.stderr.slice(0, 5),
    }),
);
