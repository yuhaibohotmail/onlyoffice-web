/**
 * 认一份 PDF 是不是**带可编辑内容的 PDF**（OnlyOffice 自己导出的那种，
 * 头部带 `/ONLYOFFICEFORM` 标记、流里嵌着一个 OOXML 包）。
 *
 * 【本项目新增 2026-08-30】
 *
 * ── 为什么这份判断必须由我们自己做 ──────────────────────────────────────────
 *
 * 打开 PDF 时编辑器先加载一个分派页，它自己也会做同样的判断，用来决定往哪跳：
 *
 *   是可编辑 PDF → documenteditor（能填能改）    普通 PDF → pdfeditor（看和批注）
 *
 * 但**同一个答案我们这边也要用**：可编辑 PDF 要转成 Editor.bin 才能进 documenteditor，
 * 而普通 PDF 要原样透传给 pdfeditor。也就是说这个判断决定两件事，
 * 而**让两边各判一次就等于要求两个判断永远一致**——它们迟早会不一致，
 * 而不一致的样子是「进对了应用，却打不开文档」。
 *
 * 所以：我们判一次，把结果同时用于转换，并经 `document.isForm` 告诉编辑器，
 * 让它跳过自己那次判断。编辑器那边的开关是 `isForm===true || isForm===false` 时不再自己判。
 *
 * ── 规则从哪来 ──────────────────────────────────────────────────────────────
 *
 * 照抄编辑器自己那份 `isExtendedPDFFile`，出处：
 * `web-apps/apps/common/index.html`（`web-apps/apps/pdfeditor/main/index.html` 里有同样一份）。
 * **它只看文件开头 300 字节。**
 *
 * ⚠ 这是一处**照抄别人规则**的代码，升级静态资源时要回去对一眼原文。
 * `checkPdfFormRuleUnchanged()` 就是干这个的——它拿抽出来的那份 html 核对规则还在不在。
 */

/** 编辑器那份判断只看开头这么多字节。跟着它，不多读也不少读。 */
export const PDF_FORM_SNIFF_BYTES = 300;

/** PDF 头之后那行二进制注释：`%` 加四个高位字节再加 `\r`。 */
const BINARY_COMMENT = "%" + String.fromCharCode(0xcd, 0xca, 0xd2, 0xa9) + "\r";
const SIGNATURE = "ONLYOFFICEFORM";

/**
 * 把开头那段字节按 latin1 读成字符串再判——编辑器那边用的是
 * `xhr.overrideMimeType("text/plain; charset=iso-8859-1")`，等价于逐字节映射。
 * **别用 utf-8 解**：那几个高位字节会被替换成 U+FFFD，标记就找不到了。
 */
export function isExtendedPdfBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes.subarray(0, PDF_FORM_SNIFF_BYTES));
  if (!head) return false;

  const indexFirst = head.indexOf(BINARY_COMMENT);
  if (indexFirst === -1) return false;

  let pFirst = head.substring(indexFirst + 6);
  if (!(pFirst.lastIndexOf("1 0 obj\n<<\n", 0) === 0)) return false;
  pFirst = pFirst.substring(11);

  const indexStream = pFirst.indexOf("stream\r\n");
  const indexMeta = pFirst.indexOf(SIGNATURE);
  if (indexStream === -1 || indexMeta === -1 || indexStream < indexMeta) return false;

  // 标记后面要跟着两段用空格隔开的数字（起点与长度）
  let pMeta = pFirst.substring(indexMeta).substring(SIGNATURE.length + 3);
  let indexMetaLast = pMeta.indexOf(" ");
  if (indexMetaLast === -1) return false;
  pMeta = pMeta.substring(indexMetaLast + 1);
  indexMetaLast = pMeta.indexOf(" ");
  if (indexMetaLast === -1) return false;

  return true;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
