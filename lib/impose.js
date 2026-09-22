'use strict';

const { PDFDocument, degrees } = require('pdf-lib');

/**
 * 骑马钉（saddle-stitch）拼版核心逻辑。
 *
 * 每张纸正反两页（两个 output PDF page），每排放两个原始页，即每张纸容纳 4 页：
 *   - 正面（front）：末页(左) | 首页(右)
 *   - 背面（back） ：第 2 页(左) | 倒数第 2 页(右)
 *   其余纸张按同样方式逐层向内递进。
 * 页数不是 4 的倍数时，在文档末尾补空白页。
 *
 * 分册签帖（signatures）模式：给定每帖最多纸张数（1～20，每帖容量 = 4 × 纸张数），
 * 按原始页序把文档切成连续的若干签帖，仅在每帖末尾补白，各帖分别按骑马钉规则
 * 排版；最后一帖不足上限时按实际页数收尾（纸张数 = ceil(实际页数 / 4)）。
 * 未启用时整本作为一个签帖，保持原有整册行为。
 *
 * 混合尺寸适配：各页尺寸或旋转方向不一致时，按每页旋转后的有效宽高取
 * 全部页面宽高的最大值作为统一面板尺寸；每页按其显示方向 1:1 居中放入
 * 对应半区，空余区域保持透明留白。分册模式下统一面板仍取全部页面的全局
 * 最大值，以保证各帖输出纸张物理尺寸一致。
 */

const MIN_SHEETS_PER_SIGNATURE = 1;
const MAX_SHEETS_PER_SIGNATURE = 20;

/**
 * 规范化「每帖最多纸张数」参数。
 *
 * undefined / null / 空白字符串视为未启用（返回 null，即整册模式）；
 * 数字必须是 1～20 的整数；字符串仅接受纯整数写法（与前端 /^\d+$/ 一致，
 * 允许首尾空白，拒绝 "1.0"、"1e0" 等非整数写法），否则抛出异常。
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null} 1～20 的整数，或 null（未启用分册）
 */
function normalizeSheetsPerSignature(value) {
  const message = `每帖最多纸张数必须是 ${MIN_SHEETS_PER_SIGNATURE}～${MAX_SHEETS_PER_SIGNATURE} 之间的整数`;
  if (value === undefined || value === null) return null;

  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(message);
    }
    n = Number(trimmed);
  } else {
    // 布尔、对象等非数值类型一律拒绝
    throw new Error(message);
  }

  if (!Number.isInteger(n) || n < MIN_SHEETS_PER_SIGNATURE || n > MAX_SHEETS_PER_SIGNATURE) {
    throw new Error(message);
  }
  return n;
}

/**
 * 根据原始页数返回需要补的空白页数（0~3）。
 * @param {number} sourceCount
 * @returns {number}
 */
function blanksForCount(sourceCount) {
  return (4 - (sourceCount % 4)) % 4;
}

/**
 * 为单个签帖生成骑马钉页序方案。
 *
 * 槽位页码使用**全局原始页码**（帖内相对位置 + sourceStart - 1）；
 * 超出本帖实际页数的本地位置为补白槽位（blank: true），即补白只落在帖尾。
 *
 * @param {number} signatureIndex 帖序号（从 0 开始）
 * @param {number} sourceStart 本帖首页的全局页码（从 1 开始）
 * @param {number} sourceCount 本帖实际包含的原始页数
 * @returns {object} 签帖方案
 */
function buildSignaturePlan(signatureIndex, sourceStart, sourceCount) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }
  const blanks = blanksForCount(sourceCount);
  const totalCount = sourceCount + blanks;
  const sheetCount = totalCount / 4;
  const offset = sourceStart - 1;

  const slot = (position) => {
    if (position <= sourceCount) {
      return { page: offset + position, blank: false };
    }
    return { page: null, blank: true };
  };

  const sheets = [];
  for (let i = 0; i < sheetCount; i += 1) {
    // 正面：从尾部取左页、从头部取右页
    const frontLeft = totalCount - 2 * i;       // 末页、倒数第 4、倒数第 8 ...
    const frontRight = 2 * i + 1;               // 首页、第 3 页、第 5 页 ...
    // 背面：从头部取左页、从尾部取右页
    const backLeft = 2 * i + 2;                 // 第 2 页、第 6 页、第 10 页 ...
    const backRight = totalCount - 2 * i - 1;   // 倒数第 2、倒数第 6 ...

    sheets.push({
      sheet: i + 1, // 帖内纸张编号
      front: {
        left: slot(frontLeft),
        right: slot(frontRight),
      },
      back: {
        left: slot(backLeft),
        right: slot(backRight),
      },
    });
  }

  return {
    signature: signatureIndex + 1,
    sourceStart,
    sourceEnd: sourceStart + sourceCount - 1,
    sourceCount,
    paddedCount: blanks,
    blanks,
    totalCount,
    sheetCount,
    sheets,
  };
}

/**
 * 生成拼版页序方案（整册或分册签帖）。
 *
 * 未指定 options.sheetsPerSignature（或为空）时为整册模式：整本作为唯一一个签帖，
 * 顶层 sheets/paddedCount/totalCount/blanks 与旧版完全一致。
 *
 * 启用分册时按容量 4 × sheetsPerSignature 沿原始页序连续切帖：
 *   {
 *     mode: 'signature',
 *     sheetsPerSignature: number,
 *     signatures: [{
 *       signature, sourceStart, sourceEnd, sourceCount,
 *       paddedCount, blanks, totalCount, sheetCount, sheets
 *     }, ...],
 *     ...
 *   }
 *
 * @param {number} sourceCount 原始 PDF 页数
 * @param {{ sheetsPerSignature?: number|string|null }} [options]
 * @returns {object}
 */
function buildImpositionPlan(sourceCount, options = {}) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }
  const maxSheets = normalizeSheetsPerSignature(options.sheetsPerSignature);

  const signatures = [];
  if (maxSheets === null) {
    // 整册模式：整本即一帖
    signatures.push(buildSignaturePlan(0, 1, sourceCount));
  } else {
    // 按原页序切分为容量 4 × 上限 的连续签帖，末帖按实际页数收尾
    const capacity = maxSheets * 4;
    let start = 1;
    let remaining = sourceCount;
    while (remaining > 0) {
      const chunk = Math.min(remaining, capacity);
      signatures.push(buildSignaturePlan(signatures.length, start, chunk));
      start += chunk;
      remaining -= chunk;
    }
  }

  const totalBlanks = signatures.reduce((sum, sig) => sum + sig.blanks, 0);
  const totalSheets = signatures.reduce((sum, sig) => sum + sig.sheets.length, 0);
  const signatureMode = maxSheets !== null;

  const plan = {
    mode: signatureMode ? 'signature' : 'whole',
    sheetsPerSignature: maxSheets,
    signatures,
    // 整册模式保留与旧版完全一致的顶层 sheets（即唯一签帖的同一组对象）；
    // 分册模式展平为各帖纸张，并附 signature 帖号，便于不感知签帖的调用方顺序遍历。
    sheets: signatureMode
      ? signatures.flatMap((sig) => sig.sheets.map((sh) => ({ ...sh, signature: sig.signature })))
      : signatures[0].sheets,
    sourceCount,
    paddedCount: totalBlanks,
    totalCount: sourceCount + totalBlanks,
    blanks: totalBlanks,
    sheetCount: totalSheets,
    signatureCount: signatures.length,
  };
  return plan;
}

/**
 * 把 PDF 的 /Rotate 角度规范化为 0 / 90 / 180 / 270。
 * 负角、超圈角（如 -90、450）都会折算到标准直角；非 90 倍数按最近直角取整。
 * @param {number} angle
 * @returns {number}
 */
function normalizeRotation(angle) {
  const quarterTurns = Math.round((Number(angle) || 0) / 90);
  return (((quarterTurns % 4) + 4) % 4) * 90;
}

/**
 * 页面旋转后的有效宽高（即阅读器实际展示的宽高）。
 * 旋转 90°/270° 时宽高互换。
 *
 * @param {PDFPage} page pdf-lib 页面对象
 * @returns {{ rotation: number, width: number, height: number }}
 */
function effectivePageSize(page) {
  const rotation = normalizeRotation(page.getRotation().angle);
  const width = page.getWidth();
  const height = page.getHeight();
  const swapped = rotation === 90 || rotation === 270;
  return {
    rotation,
    width: swapped ? height : width,
    height: swapped ? width : height,
  };
}

/**
 * 混合尺寸适配：以全部页面有效宽、有效高的最大值作为统一面板尺寸，
 * 并据此给出面板方向（portrait 竖版 / landscape 横版 / square 方形）。
 *
 * @param {Array<{ width: number, height: number }>} pageSizes 各页有效宽高
 * @returns {{ width: number, height: number, orientation: string }}
 */
function computePanelSize(pageSizes) {
  if (!pageSizes.length) {
    throw new Error('PDF 不包含任何页面');
  }
  let width = 0;
  let height = 0;
  for (const size of pageSizes) {
    if (size.width > width) width = size.width;
    if (size.height > height) height = size.height;
  }
  let orientation = 'square';
  if (width > height) orientation = 'landscape';
  else if (height > width) orientation = 'portrait';
  return { width, height, orientation };
}

/**
 * 计算源页在半区内的绘制参数：页面按旋转后的显示方向 1:1 居中，不缩放。
 *
 * drawPage 的 rotate 以锚点 (x, y) 为原点**逆时针**旋转，而 PDF /Rotate 为
 * **顺时针**显示旋转，故取相反角度，并把锚点平移到旋转后内容包围盒对应的
 * 角上，使旋转后的内容恰好落在半区居中位置。
 *
 * @param {number} srcWidth 源页介质宽（未旋转）
 * @param {number} srcHeight 源页介质高（未旋转）
 * @param {number} rotation 规范化后的旋转角（0/90/180/270）
 * @param {number} originX 半区左边缘在纸面上的 x 坐标
 * @param {number} panelWidth 统一面板宽
 * @param {number} panelHeight 统一面板高
 * @returns {{ x: number, y: number, rotate: number }}
 */
function slotPlacement(srcWidth, srcHeight, rotation, originX, panelWidth, panelHeight) {
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? srcHeight : srcWidth;
  const dispH = swapped ? srcWidth : srcHeight;
  const x = originX + (panelWidth - dispW) / 2;
  const y = (panelHeight - dispH) / 2;
  switch (rotation) {
    case 90:
      return { x, y: y + dispH, rotate: -90 };
    case 180:
      return { x: x + dispW, y: y + dispH, rotate: 180 };
    case 270:
      return { x: x + dispW, y, rotate: -270 };
    default:
      return { x, y, rotate: 0 };
  }
}

/**
 * 执行拼版并返回新 PDF 的字节数据。
 *
 * 输出每张纸为横向（landscape）尺寸：宽 = 2 × 面板宽，高 = 面板高。
 * 统一面板尺寸取全部页面旋转后有效宽高的最大值（分册时也按整本计算，使各帖
 * 纸张尺寸一致）；每个原始页按其显示方向 1:1（不缩放）居中绘制到对应半区，
 * 空余区域透明留白。补的空白页不绘制任何内容。
 *
 * 分册签帖模式下各帖纸张按帖序连续输出（一个帖内先正面后背面），结果仍为
 * 单个 PDF 文件。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @param {{ sheetsPerSignature?: number|string|null }} [options] 每帖最多纸张数（1～20）；
 *        未指定或为空时为整册模式
 * @returns {Promise<{ pdfBytes: Uint8Array, plan: object }>}
 *          plan 中附带 panel：{ width, height, orientation } 统一面板信息
 */
async function imposePdf(sourceBytes, options = {}) {
  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    // 触发一次页树读取，损坏/被截断的文件会在此处暴露异常
    srcDoc.getPageCount();
  } catch (err) {
    throw new Error('文件不是有效的 PDF（可能已损坏或被加密）');
  }
  const sourceCount = srcDoc.getPageCount();
  if (sourceCount === 0) {
    throw new Error('PDF 不包含任何页面');
  }

  const plan = buildImpositionPlan(sourceCount, options);

  // 混合尺寸适配：逐页按旋转后的有效宽高计算，统一面板取全部页面宽高的最大值
  const pageInfos = srcDoc.getPages().map((page) => effectivePageSize(page));
  const panel = computePanelSize(pageInfos);
  plan.panel = panel;

  const outDoc = await PDFDocument.create();
  // 将全部源页作为 XObject 嵌入（保留其字体/图片/批注等资源），再逐页绘制到拼版纸上。
  // drawPage 需要 embedPdf 返回的 PDFEmbeddedPage（copyPages 的页面对象不能直接绘制）。
  const indices = Array.from({ length: sourceCount }, (_, i) => i);
  const embeddedPages = await outDoc.embedPdf(srcDoc, indices);

  const sheetWidth = panel.width * 2;
  const sheetHeight = panel.height;
  // 按签帖顺序连续输出：每个签帖内部纸张 1..N，每张纸先正面后背面
  for (const signature of plan.signatures) {
    for (const sheet of signature.sheets) {
      // 正面：左 | 右
      const front = outDoc.addPage([sheetWidth, sheetHeight]);
      drawSlot(front, sheet.front.left, embeddedPages, pageInfos, 0, panel);
      drawSlot(front, sheet.front.right, embeddedPages, pageInfos, panel.width, panel);

      // 背面：左 | 右
      const back = outDoc.addPage([sheetWidth, sheetHeight]);
      drawSlot(back, sheet.back.left, embeddedPages, pageInfos, 0, panel);
      drawSlot(back, sheet.back.right, embeddedPages, pageInfos, panel.width, panel);
    }
  }

  if (plan.mode === 'signature') {
    outDoc.setTitle(`拼版小册子（${sourceCount} 页 / ${plan.signatureCount} 帖 / ${plan.sheetCount} 张纸）`);
  } else {
    outDoc.setTitle(`拼版小册子（${sourceCount} 页 / ${plan.sheets.length} 张纸）`);
  }
  outDoc.setProducer('booklet-imposer (pdf-lib)');

  const pdfBytes = await outDoc.save();
  return { pdfBytes, plan };
}

/**
 * 把一个槽位（原始页或空白页）绘制到目标纸面上。
 * 原始页面按其旋转后的显示方向 1:1 居中绘制到自己的半区，不缩放；
 * 半区内未被覆盖的区域保持透明留白。
 */
function drawSlot(targetSheet, slot, embeddedPages, pageInfos, originX, panel) {
  if (slot.blank) {
    return; // 补的空白页：保持完全空白
  }
  const embedded = embeddedPages[slot.page - 1];
  const info = pageInfos[slot.page - 1];
  const { x, y, rotate } = slotPlacement(
    embedded.width,
    embedded.height,
    info.rotation,
    originX,
    panel.width,
    panel.height,
  );
  targetSheet.drawPage(embedded, { x, y, rotate: degrees(rotate) });
}

module.exports = {
  MIN_SHEETS_PER_SIGNATURE,
  MAX_SHEETS_PER_SIGNATURE,
  normalizeSheetsPerSignature,
  blanksForCount,
  buildSignaturePlan,
  buildImpositionPlan,
  normalizeRotation,
  effectivePageSize,
  computePanelSize,
  slotPlacement,
  imposePdf,
};
