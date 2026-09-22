'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, PDFName, rgb, degrees, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const {
  buildImpositionPlan,
  buildSignaturePlan,
  normalizeSheetsPerSignature,
  blanksForCount,
  normalizeRotation,
  effectivePageSize,
  computePanelSize,
  slotPlacement,
  imposePdf,
} = require('../lib/impose');

// ---------- 1. 页序算法单测 ----------
function planToArray(plan) {
  return plan.sheets.flatMap((s) => [
    ['F', s.front.left.page, s.front.right.page],
    ['B', s.back.left.page, s.back.right.page],
  ]);
}

assert.strictEqual(blanksForCount(1), 3);
assert.strictEqual(blanksForCount(4), 0);
assert.strictEqual(blanksForCount(5), 3);
assert.strictEqual(blanksForCount(10), 2);
assert.strictEqual(blanksForCount(12), 0);

// 8 页：F[8|1] B[2|7], F[6|3] B[4|5]
const p8 = buildImpositionPlan(8);
assert.deepStrictEqual(p8.sheets[0].front.left, { page: 8, blank: false });
assert.deepStrictEqual(p8.sheets[0].front.right, { page: 1, blank: false });
assert.deepStrictEqual(p8.sheets[0].back.left, { page: 2, blank: false });
assert.deepStrictEqual(p8.sheets[0].back.right, { page: 7, blank: false });
assert.deepStrictEqual(p8.sheets[1].front.left, { page: 6, blank: false });
assert.deepStrictEqual(p8.sheets[1].front.right, { page: 3, blank: false });
assert.deepStrictEqual(p8.sheets[1].back.left, { page: 4, blank: false });
assert.deepStrictEqual(p8.sheets[1].back.right, { page: 5, blank: false });
assert.strictEqual(p8.paddedCount, 0);

// 5 页 -> 补 3 空白（位置 6,7,8 为空白）
const p5 = buildImpositionPlan(5);
assert.strictEqual(p5.paddedCount, 3);
assert.strictEqual(p5.sheets[0].front.left.blank, true);   // 8 = blank
assert.strictEqual(p5.sheets[0].front.right.page, 1);
assert.strictEqual(p5.sheets[0].back.left.page, 2);
assert.strictEqual(p5.sheets[0].back.right.blank, true);   // 7 = blank
assert.strictEqual(p5.sheets[1].front.left.blank, true);   // 6 = blank
assert.strictEqual(p5.sheets[1].back.left.page, 4);
assert.strictEqual(p5.sheets[1].back.right.page, 5);

// 所有槽位覆盖：每张纸 4 页，非空白页恰好 1..N
function coverage(n) {
  const plan = buildImpositionPlan(n);
  assert.strictEqual(plan.totalCount % 4, 0);
  const pages = [];
  for (const s of plan.sheets) {
    for (const side of ['front', 'back']) {
      for (const pos of ['left', 'right']) {
        const slot = s[side][pos];
        if (!slot.blank) pages.push(slot.page);
      }
    }
  }
  assert.strictEqual(pages.length, n, `n=${n} coverage count`);
  assert.deepStrictEqual([...pages].sort((a, b) => a - b), [...Array(n).keys()].map((i) => i + 1));
}
for (let n = 1; n <= 40; n++) coverage(n);

console.log('✅ 页序算法测试通过 (1..40 页全覆盖)');

// ---------- 1b. 分册签帖页序算法单测 ----------
// 1b.1 参数规范化：缺省/空 => null（整册），1～20 整数通过，其余拒绝
assert.strictEqual(normalizeSheetsPerSignature(undefined), null);
assert.strictEqual(normalizeSheetsPerSignature(null), null);
assert.strictEqual(normalizeSheetsPerSignature(''), null);
assert.strictEqual(normalizeSheetsPerSignature('   '), null);
assert.strictEqual(normalizeSheetsPerSignature(1), 1);
assert.strictEqual(normalizeSheetsPerSignature(20), 20);
assert.strictEqual(normalizeSheetsPerSignature('4'), 4);
assert.strictEqual(normalizeSheetsPerSignature('12'), 12);
assert.strictEqual(normalizeSheetsPerSignature(' 4 '), 4); // 允许首尾空白
for (const bad of [0, 21, -1, 1.5, '3.5', '1.0', '4.0', '1e0', '+4', '0x4', 'abc', NaN, Infinity, true, false, {}, []]) {
  assert.throws(() => normalizeSheetsPerSignature(bad), /每帖最多纸张数/, `bad=${String(bad)}`);
}

// 1b.2 整册模式（不传 / null / 空串）保持原有结构
for (const opt of [undefined, {}, { sheetsPerSignature: null }, { sheetsPerSignature: '' }]) {
  const w = buildImpositionPlan(10, opt);
  assert.strictEqual(w.mode, 'whole');
  assert.strictEqual(w.sheetsPerSignature, null);
  assert.strictEqual(w.signatureCount, 1);
  assert.strictEqual(w.signatures.length, 1);
  assert.strictEqual(w.sheets.length, 3);
  assert.strictEqual(w.paddedCount, 2);
  assert.strictEqual(w.signatures[0].sheets, w.sheets);
  assert.strictEqual(w.signatures[0].sourceStart, 1);
  assert.strictEqual(w.signatures[0].sourceEnd, 10);
}

// 非法上限应直接抛出
assert.throws(() => buildImpositionPlan(10, { sheetsPerSignature: 0 }), /每帖最多纸张数/);
assert.throws(() => buildImpositionPlan(10, { sheetsPerSignature: 21 }), /每帖最多纸张数/);
assert.throws(() => buildImpositionPlan(10, { sheetsPerSignature: 'x' }), /每帖最多纸张数/);

// 1b.3 16 页，每帖最多 4 张（容量 16）→ 恰好 1 帖、16 页、0 补白、4 张纸
{
  const plan = buildImpositionPlan(16, { sheetsPerSignature: 4 });
  assert.strictEqual(plan.mode, 'signature');
  assert.strictEqual(plan.sheetsPerSignature, 4);
  assert.strictEqual(plan.signatureCount, 1);
  assert.strictEqual(plan.paddedCount, 0);
  assert.strictEqual(plan.sheets.length, 4);
  const sig = plan.signatures[0];
  assert.deepStrictEqual(
    [sig.signature, sig.sourceStart, sig.sourceEnd, sig.sourceCount, sig.paddedCount, sig.sheets.length],
    [1, 1, 16, 16, 0, 4],
  );
  // 骑马钉顺序不变：第 1 张 正面 [16|1] 背面 [2|15]
  assert.strictEqual(sig.sheets[0].front.left.page, 16);
  assert.strictEqual(sig.sheets[0].front.right.page, 1);
  assert.strictEqual(sig.sheets[0].back.left.page, 2);
  assert.strictEqual(sig.sheets[0].back.right.page, 15);
}

// 1b.4 17 页，每帖最多 4 张（容量 16）→ 第 1 帖 1..16（0 补白，4 张）；
// 第 2 帖 17（补 3 白，1 张纸收尾）
{
  const plan = buildImpositionPlan(17, { sheetsPerSignature: 4 });
  assert.strictEqual(plan.signatureCount, 2);
  assert.strictEqual(plan.paddedCount, 3);
  assert.strictEqual(plan.sheets.length, 5);
  assert.strictEqual(plan.totalCount, 20);

  const s1 = plan.signatures[0];
  assert.deepStrictEqual(
    [s1.sourceStart, s1.sourceEnd, s1.sourceCount, s1.paddedCount, s1.sheets.length],
    [1, 16, 16, 0, 4],
  );

  const s2 = plan.signatures[1];
  assert.deepStrictEqual(
    [s2.sourceStart, s2.sourceEnd, s2.sourceCount, s2.paddedCount, s2.sheets.length],
    [17, 17, 1, 3, 1],
  );
  // 末帖仅 1 页：正面 [空白|第17页]，背面 [空白|空白]
  assert.strictEqual(s2.sheets[0].front.left.blank, true);
  assert.strictEqual(s2.sheets[0].front.right.page, 17);
  assert.strictEqual(s2.sheets[0].back.left.blank, true);
  assert.strictEqual(s2.sheets[0].back.right.blank, true);
  // 帖内纸张编号从 1 重新计数
  assert.strictEqual(s2.sheets[0].sheet, 1);
  // 顶层展平视图带帖号，且纸张保持帖序连续
  assert.deepStrictEqual(plan.sheets.map((s) => s.signature), [1, 1, 1, 1, 2]);
  assert.strictEqual(plan.sheets[4].front.right.page, 17);
}

// 1b.5 20 页，每帖 2 张（容量 8）→ 3 帖：1..8(2张)、9..16(2张)、17..20(1张)
{
  const plan = buildImpositionPlan(20, { sheetsPerSignature: 2 });
  assert.strictEqual(plan.signatureCount, 3);
  assert.strictEqual(plan.paddedCount, 0);
  assert.strictEqual(plan.sheets.length, 5);
  assert.deepStrictEqual(
    plan.signatures.map((s) => [s.sourceStart, s.sourceEnd, s.sourceCount, s.sheets.length]),
    [[1, 8, 8, 2], [9, 16, 8, 2], [17, 20, 4, 1]],
  );
  // 第 2 帖页码使用全局原始页码：首张贴面 [16|9]，背面 [10|15]
  const mid = plan.signatures[1];
  assert.strictEqual(mid.sheets[0].front.left.page, 16);
  assert.strictEqual(mid.sheets[0].front.right.page, 9);
  assert.strictEqual(mid.sheets[0].back.left.page, 10);
  assert.strictEqual(mid.sheets[0].back.right.page, 15);
  // 第 3 帖：[20|17] 背面 [18|19]
  const last = plan.signatures[2];
  assert.strictEqual(last.sheets[0].front.left.page, 20);
  assert.strictEqual(last.sheets[0].front.right.page, 17);
  assert.strictEqual(last.sheets[0].back.left.page, 18);
  assert.strictEqual(last.sheets[0].back.right.page, 19);
}

// 1b.6 各帖覆盖与补白位置：非空白页恰好覆盖 1..N 且无重复；
// 任一非满帖的补白只允许出现在帖尾（骑马钉外层正面左 / 背面两侧等末尾槽位）
function signatureCoverage(n, maxSheets) {
  const plan = buildImpositionPlan(n, { sheetsPerSignature: maxSheets });
  const capacity = maxSheets * 4;
  const pages = [];
  let covered = 0;
  for (const sig of plan.signatures) {
    assert.ok(sig.sourceCount <= capacity, `n=${n} max=${maxSheets} 帖容量`);
    assert.ok(sig.sheets.length <= maxSheets, '帖内纸张数不超过上限');
    assert.strictEqual(sig.sheets.length, Math.ceil(sig.sourceCount / 4));
    for (const s of sig.sheets) {
      for (const side of ['front', 'back']) {
        for (const pos of ['left', 'right']) {
          const slotItem = s[side][pos];
          if (!slotItem.blank) {
            pages.push(slotItem.page);
            assert.ok(
              slotItem.page >= sig.sourceStart && slotItem.page <= sig.sourceEnd,
              '槽位页码必须落在本帖原始页范围内',
            );
          }
        }
      }
    }
    covered += sig.sourceCount;
  }
  assert.strictEqual(covered, n);
  assert.strictEqual(pages.length, n, `n=${n} max=${maxSheets} 覆盖页数`);
  assert.deepStrictEqual(
    [...pages].sort((a, b) => a - b),
    [...Array(n).keys()].map((i) => i + 1),
  );
  // 除末帖外，各帖必须装满到容量（仅末帖允许不足）
  for (let i = 0; i < plan.signatures.length - 1; i++) {
    assert.strictEqual(plan.signatures[i].sourceCount, capacity);
  }
}
for (const maxSheets of [1, 2, 3, 4, 5, 20]) {
  for (let n = 1; n <= 90; n++) signatureCoverage(n, maxSheets);
}

// 1b.7 单帖方案 buildSignaturePlan 的全局页码偏移
{
  const sig = buildSignaturePlan(2, 9, 8); // 第 3 帖，页 9..16
  assert.strictEqual(sig.signature, 3);
  assert.strictEqual(sig.sourceStart, 9);
  assert.strictEqual(sig.sourceEnd, 16);
  assert.strictEqual(sig.sheets[0].front.left.page, 16);
  assert.strictEqual(sig.sheets[0].front.right.page, 9);
}

console.log('✅ 分册签帖页序算法测试通过（参数校验 / 切帖 / 全局页码 / 1..90 全覆盖）');

// ---------- 2. 混合尺寸适配单测 ----------
// 2.1 旋转角规范化：负角、超圈角、非 90 倍数
assert.strictEqual(normalizeRotation(0), 0);
assert.strictEqual(normalizeRotation(90), 90);
assert.strictEqual(normalizeRotation(180), 180);
assert.strictEqual(normalizeRotation(270), 270);
assert.strictEqual(normalizeRotation(-90), 270);
assert.strictEqual(normalizeRotation(450), 90);
assert.strictEqual(normalizeRotation(89.6), 90);

// 2.2 统一面板尺寸：取全部页面有效宽高的最大值，并给出方向
const mixedPanel = computePanelSize([
  { width: 595.28, height: 841.89 }, // A4 竖版
  { width: 841.89, height: 595.28 }, // A4 横版（旋转后的有效宽高）
  { width: 300, height: 400 },       // 小尺寸页
]);
assert.ok(Math.abs(mixedPanel.width - 841.89) < 1e-6);
assert.ok(Math.abs(mixedPanel.height - 841.89) < 1e-6);
assert.strictEqual(mixedPanel.orientation, 'square');
assert.strictEqual(computePanelSize([{ width: 595.28, height: 841.89 }]).orientation, 'portrait');
assert.strictEqual(computePanelSize([{ width: 841.89, height: 595.28 }]).orientation, 'landscape');

// 2.3 槽位放置：任意旋转下，旋转后的内容包围盒恰好居中于半区
function placedBBox(srcW, srcH, rotation, originX, panelW, panelH) {
  const p = slotPlacement(srcW, srcH, rotation, originX, panelW, panelH);
  const rad = (p.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [[0, 0], [srcW, 0], [0, srcH], [srcW, srcH]].map(([cx, cy]) => [
    p.x + cx * cos - cy * sin,
    p.y + cx * sin + cy * cos,
  ]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

for (const rotation of [0, 90, 180, 270]) {
  const srcW = 595.28;
  const srcH = 841.89;
  const panelW = 900;
  const panelH = 900;
  const originX = 900; // 右半区
  const bbox = placedBBox(srcW, srcH, rotation, originX, panelW, panelH);
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? srcH : srcW;
  const dispH = swapped ? srcW : srcH;
  const eps = 1e-6;
  assert.ok(Math.abs(bbox.minX - (originX + (panelW - dispW) / 2)) < eps, `rot=${rotation} minX`);
  assert.ok(Math.abs(bbox.maxX - (originX + (panelW + dispW) / 2)) < eps, `rot=${rotation} maxX`);
  assert.ok(Math.abs(bbox.minY - (panelH - dispH) / 2) < eps, `rot=${rotation} minY`);
  assert.ok(Math.abs(bbox.maxY - (panelH + dispH) / 2) < eps, `rot=${rotation} maxY`);
}

console.log('✅ 混合尺寸适配单测通过（旋转规范化 / 统一面板 / 各角度槽位居中）');

// 读取输出页的内容流文本（Contents 可能是单条流或流数组，均为 flate 编码）
function decodePageContent(doc, pageIndex) {
  const node = doc.getPage(pageIndex).node;
  const contents = node.get(PDFName.of('Contents'));
  const refs = typeof contents.asArray === 'function' ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    return zlib.inflateSync(Buffer.from(stream.getContents())).toString('latin1');
  }).join('\n');
}

// 解析内容流中的全部 cm 矩阵 [a b c d e f]
function parseCmOperators(content) {
  const ops = [];
  const re = /(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+cm/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ops.push(m.slice(1, 7).map(Number));
  }
  return ops;
}

// ---------- 3. 端到端：生成 10 页 PDF，拼版后校验 ----------
(async () => {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28; // A4 竖版 (pt)
  const PAGE_H = 841.89;
  for (let i = 1; i <= 10; i++) {
    const page = src.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0) });
  }
  const srcBytes = await src.save();

  const { pdfBytes, plan } = await imposePdf(srcBytes);
  const out = await PDFDocument.load(pdfBytes);

  // 10 页 -> 12 面板 -> 3 张纸 -> 6 个输出页面
  assert.strictEqual(out.getPageCount(), 6, '输出页数应为 2 × 张数');
  assert.strictEqual(plan.sheets.length, 3);
  assert.strictEqual(plan.paddedCount, 2);

  // 统一面板 = A4 竖版；输出页面为横向 A3：宽 = 2×A4宽，高 = A4高
  assert.ok(Math.abs(plan.panel.width - PAGE_W) < 0.01, `面板宽 ${plan.panel.width}`);
  assert.ok(Math.abs(plan.panel.height - PAGE_H) < 0.01, `面板高 ${plan.panel.height}`);
  assert.strictEqual(plan.panel.orientation, 'portrait');
  const outPage = out.getPage(0);
  assert.ok(Math.abs(outPage.getWidth() - PAGE_W * 2) < 0.5, `宽度 ${outPage.getWidth()}`);
  assert.ok(Math.abs(outPage.getHeight() - PAGE_H) < 0.5, `高度 ${outPage.getHeight()}`);

  fs.writeFileSync('/tmp/out-10pages.pdf', pdfBytes);
  console.log('✅ 端到端拼版通过：10 页 -> 3 张纸(6 面)，输出横向尺寸正确');
  console.log('   页序预览：');
  for (const s of plan.sheets) {
    const f = (p) => (p.blank ? '空白' : `${p.page}`);
    console.log(`   第${s.sheet}张 正面 [${f(s.front.left)} | ${f(s.front.right)}]  背面 [${f(s.back.left)} | ${f(s.back.right)}]`);
  }

  // ---------- 4. 端到端：混合尺寸 + 旋转页面 ----------
  const A4W = 595.28;
  const A4H = 841.89;

  // 4.1 effectivePageSize：旋转 270° 的页面有效宽高互换
  const rotDoc = await PDFDocument.create();
  const rp = rotDoc.addPage([200, 100]);
  rp.setRotation(degrees(270));
  const eff = effectivePageSize(rp);
  assert.strictEqual(eff.rotation, 270);
  assert.strictEqual(eff.width, 100);
  assert.strictEqual(eff.height, 200);

  // 4.2 构造 5 页混合 PDF：竖版 A4 ×2、小页、/Rotate 90 的 A4、横版介质 900×500
  const mixed = await PDFDocument.create();
  const mfont = await mixed.embedFont(StandardFonts.Helvetica);
  for (const label of ['M1', 'M2']) {
    const p = mixed.addPage([A4W, A4H]);
    p.drawText(label, { x: 200, y: 400, size: 40, font: mfont });
  }
  const p3 = mixed.addPage([300, 400]);
  p3.drawText('M3', { x: 100, y: 200, size: 30, font: mfont });
  const p4 = mixed.addPage([A4W, A4H]);
  p4.setRotation(degrees(90)); // 显示为横版 841.89 × 595.28
  p4.drawText('M4', { x: 200, y: 400, size: 40, font: mfont });
  const p5 = mixed.addPage([900, 500]);
  p5.drawText('M5', { x: 400, y: 250, size: 40, font: mfont });
  const mixedBytes = await mixed.save();

  const { pdfBytes: mixedOut, plan: mixedPlan } = await imposePdf(mixedBytes);

  // 统一面板：宽 = max(595.28, 595.28, 300, 841.89, 900) = 900
  //          高 = max(841.89, 841.89, 400, 595.28, 500) = 841.89
  assert.ok(Math.abs(mixedPlan.panel.width - 900) < 0.01, `面板宽 ${mixedPlan.panel.width}`);
  assert.ok(Math.abs(mixedPlan.panel.height - A4H) < 0.01, `面板高 ${mixedPlan.panel.height}`);
  assert.strictEqual(mixedPlan.panel.orientation, 'landscape');

  // 5 页 -> 补 3 白 -> 8 面板 -> 2 张纸 -> 4 个输出页面，纸张 = 1800 × 841.89
  const mixedDoc = await PDFDocument.load(mixedOut);
  assert.strictEqual(mixedDoc.getPageCount(), 4, '输出页数应为 2 × 张数');
  assert.strictEqual(mixedPlan.paddedCount, 3);
  const sheet0 = mixedDoc.getPage(0);
  assert.ok(Math.abs(sheet0.getWidth() - 1800) < 0.01, `纸宽 ${sheet0.getWidth()}`);
  assert.ok(Math.abs(sheet0.getHeight() - A4H) < 0.01, `纸高 ${sheet0.getHeight()}`);

  // 页序与补白规则不变：第 2 张纸背面 = [第 4 页 | 第 5 页]
  assert.strictEqual(mixedPlan.sheets[1].back.left.page, 4);
  assert.strictEqual(mixedPlan.sheets[1].back.right.page, 5);

  // 4.3 旋转页（源第 4 页，位于第 2 张纸背面左半区 = 输出第 4 页）：
  // 内容流应包含 -90° 旋转矩阵，且平移锚点使旋转后的内容居中于左半区
  const backContent = decodePageContent(mixedDoc, 3);
  const ops = parseCmOperators(backContent);
  const expectX = (900 - A4H) / 2;                 // 左半区水平居中：29.055
  const expectY = (A4H - A4W) / 2 + A4W;           // 锚点上移一个显示高度：718.585
  const rotOp = ops.find((m) => Math.abs(m[0]) < 1e-6 && Math.abs(m[1] + 1) < 1e-6
    && Math.abs(m[2] - 1) < 1e-6 && Math.abs(m[3]) < 1e-6);
  assert.ok(rotOp, '旋转页应带有 -90° 旋转矩阵');
  const moveOp = ops.find((m) => Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6
    && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6
    && Math.abs(m[4] - expectX) < 0.01 && Math.abs(m[5] - expectY) < 0.01);
  assert.ok(moveOp, `旋转页应平移到 (${expectX.toFixed(3)}, ${expectY.toFixed(3)})`);

  // 4.4 小页（源第 3 页，第 2 张纸正面右半区 = 输出第 3 页）1:1 居中，无缩放无旋转
  const frontContent = decodePageContent(mixedDoc, 2);
  const frontOps = parseCmOperators(frontContent);
  const smallX = 900 + (900 - 300) / 2;            // 右半区水平居中：1200
  const smallY = (A4H - 400) / 2;                  // 垂直居中：220.945
  const smallOp = frontOps.find((m) => Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6
    && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6
    && Math.abs(m[4] - smallX) < 0.01 && Math.abs(m[5] - smallY) < 0.01);
  assert.ok(smallOp, `小页应 1:1 居中于 (${smallX}, ${smallY.toFixed(3)})`);

  fs.writeFileSync('/tmp/out-mixed.pdf', mixedOut);
  console.log('✅ 端到端混合尺寸拼版通过：5 页(含旋转/小页/横版) -> 2 张纸(4 面)');
  console.log(`   统一面板：${mixedPlan.panel.width} × ${mixedPlan.panel.height} pt（${mixedPlan.panel.orientation}）`);

  // ---------- 5. 端到端：分册签帖 ----------
  // 5.1 10 页、每帖 1 张（容量 4）→ 帖：1..4(1张) / 5..8(1张) / 9..10(补2白,1张)
  //      共 3 帖 3 张纸 -> 6 个输出页面，仍为单个 PDF
  {
    const { pdfBytes: sigBytes, plan: sigPlan } = await imposePdf(srcBytes, { sheetsPerSignature: 1 });
    const sigDoc = await PDFDocument.load(sigBytes);
    assert.strictEqual(sigPlan.mode, 'signature');
    assert.strictEqual(sigPlan.sheetsPerSignature, 1);
    assert.strictEqual(sigPlan.signatureCount, 3);
    assert.strictEqual(sigPlan.paddedCount, 2);
    assert.strictEqual(sigPlan.sheets.length, 3);
    assert.strictEqual(sigDoc.getPageCount(), 6, '输出页数应为 2 × 总张数');

    assert.deepStrictEqual(
      sigPlan.signatures.map((s) => [s.sourceStart, s.sourceEnd, s.sourceCount, s.paddedCount, s.sheets.length]),
      [[1, 4, 4, 0, 1], [5, 8, 4, 0, 1], [9, 10, 2, 2, 1]],
    );
    // 第 1 帖：[4|1] 背面 [2|3]；第 2 帖：[8|5] 背面 [6|7]；第 3 帖：[空白|9] 背面 [10|空白]
    assert.strictEqual(sigPlan.signatures[0].sheets[0].front.left.page, 4);
    assert.strictEqual(sigPlan.signatures[1].sheets[0].back.right.page, 7);
    assert.strictEqual(sigPlan.signatures[2].sheets[0].front.left.blank, true);
    assert.strictEqual(sigPlan.signatures[2].sheets[0].front.right.page, 9);
    assert.strictEqual(sigPlan.signatures[2].sheets[0].back.left.page, 10);
    assert.strictEqual(sigPlan.signatures[2].sheets[0].back.right.blank, true);

    // 全局统一面板（A4 竖版），各帖输出纸张同为 2×A4 宽 × A4 高
    assert.ok(Math.abs(sigPlan.panel.width - PAGE_W) < 0.01);
    assert.ok(Math.abs(sigPlan.panel.height - PAGE_H) < 0.01);
    for (let i = 0; i < sigDoc.getPageCount(); i++) {
      const p = sigDoc.getPage(i);
      assert.ok(Math.abs(p.getWidth() - PAGE_W * 2) < 0.5, `第 ${i} 面宽度`);
      assert.ok(Math.abs(p.getHeight() - PAGE_H) < 0.5, `第 ${i} 面高度`);
    }

    fs.writeFileSync('/tmp/out-signatures.pdf', sigBytes);
    console.log('✅ 端到端分册签帖通过：10 页 / 每帖 1 张 -> 3 帖 3 张纸(6 面)，单个 PDF 连续输出');
  }

  // 5.2 未启用（不传 options）与整册模式输出完全一致
  {
    const { pdfBytes: a } = await imposePdf(srcBytes);
    const { pdfBytes: b } = await imposePdf(srcBytes, {});
    assert.deepStrictEqual(a, b, '整册默认行为应保持不变');
    console.log('✅ 未启用分册时与原整册行为一致');
  }
})();
