'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const imposeBtn = document.getElementById('impose-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const previewEl = document.getElementById('preview');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');
const signatureToggle = document.getElementById('signature-toggle');
const signatureOptions = document.getElementById('signature-options');
const sheetsInput = document.getElementById('sheets-per-signature');

const MIN_SHEETS_PER_SIGNATURE = 1;
const MAX_SHEETS_PER_SIGNATURE = 20;

let selectedFile = null;
let resultBlobUrl = null;
let resultBaseName = 'booklet';

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

// 读取并校验「每帖最多纸张数」：启用分册时必须是 1～20 的整数
// 返回 { ok, value, message }；未启用时 value 为 null（整册模式）
function readSheetsPerSignature() {
  if (!signatureToggle.checked) return { ok: true, value: null };
  const raw = (sheetsInput.value || '').trim();
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: `每帖最多纸张数必须是 ${MIN_SHEETS_PER_SIGNATURE}～${MAX_SHEETS_PER_SIGNATURE} 之间的整数` };
  }
  const n = Number(raw);
  if (n < MIN_SHEETS_PER_SIGNATURE || n > MAX_SHEETS_PER_SIGNATURE) {
    return { ok: false, message: `每帖最多纸张数必须是 ${MIN_SHEETS_PER_SIGNATURE}～${MAX_SHEETS_PER_SIGNATURE} 之间的整数` };
  }
  return { ok: true, value: n };
}

function syncSignatureUi() {
  signatureOptions.hidden = !signatureToggle.checked;
}

function clearResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  summaryEl.hidden = true;
  previewEl.hidden = true;
  sheetsEl.innerHTML = '';
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectFile(file);
});

signatureToggle.addEventListener('change', () => {
  syncSignatureUi();
});
syncSignatureUi();

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  selectFile(file);
});

function selectFile(file) {
  clearResult();
  if (!file) {
    selectedFile = null;
    fileName.textContent = '';
    imposeBtn.disabled = true;
    return;
  }
  if (file.type && file.type !== 'application/pdf') {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  resultBaseName = (file.name || 'booklet').replace(/\.pdf$/i, '');
  imposeBtn.disabled = false;
  setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`, 'info');
}

imposeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const limit = readSheetsPerSignature();
  if (!limit.ok) {
    setStatus(limit.message, 'error');
    sheetsInput.focus();
    return;
  }

  imposeBtn.disabled = true;
  setStatus('正在拼版，请稍候…', 'info');
  clearResult();

  const form = new FormData();
  form.append('pdf', selectedFile);
  // 仅启用分册时发送上限；不发送即保持整册行为
  if (limit.value !== null) {
    form.append('sheetsPerSignature', String(limit.value));
  }

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });

    if (!resp.ok) {
      let message = `拼版失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Imposition-Plan');
    if (!planHeader) throw new Error('响应缺少拼版方案');
    const plan = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    resultBlobUrl = URL.createObjectURL(blob);

    renderSummary(plan);
    renderPreview(plan);
    setStatus('拼版完成，可预览页序或下载 PDF。', 'info');
  } catch (err) {
    setStatus(err.message || '拼版失败', 'error');
  } finally {
    imposeBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = `${resultBaseName}-拼版.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

const ORIENTATION_LABELS = {
  portrait: '竖版',
  landscape: '横版',
  square: '方形',
};

function ptToMm(pt) {
  return ((pt * 25.4) / 72).toFixed(1);
}

function renderSummary(plan) {
  const signatureMode = plan.mode === 'signature';

  document.getElementById('sum-mode').textContent = signatureMode ? '分册签帖' : '整册骑马钉';
  document.getElementById('sum-source').textContent = plan.sourceCount;
  document.getElementById('sum-blanks').textContent = plan.paddedCount;
  document.getElementById('sum-sheets').textContent = plan.sheets.length;
  if (plan.panel) {
    const { width, height, orientation } = plan.panel;
    document.getElementById('sum-panel').textContent =
      `${width.toFixed(1)} × ${height.toFixed(1)} pt（约 ${ptToMm(width)} × ${ptToMm(height)} mm）`;
    document.getElementById('sum-orient').textContent =
      ORIENTATION_LABELS[orientation] || orientation;
  }

  const countItem = document.getElementById('sum-signature-count-item');
  const listWrap = document.getElementById('signature-list-wrap');
  if (signatureMode) {
    countItem.hidden = false;
    document.getElementById('sum-signature-count').textContent = plan.signatures.length;
    renderSignatureList(plan);
    listWrap.hidden = false;
  } else {
    countItem.hidden = true;
    listWrap.hidden = true;
  }
  summaryEl.hidden = false;
}

function renderSignatureList(plan) {
  const listEl = document.getElementById('signature-list');
  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const sig of plan.signatures) {
    const li = document.createElement('li');
    li.textContent = `第 ${sig.signature} 帖：原始第 ${sig.sourceStart}～${sig.sourceEnd} 页`
      + `（${sig.sourceCount} 页） · 帖内 ${sig.sheets.length} 张纸 · 末尾补白 ${sig.paddedCount} 页`;
    frag.appendChild(li);
  }
  listEl.appendChild(frag);
}

function renderPreview(plan) {
  const frag = document.createDocumentFragment();
  // 预览按真实纸张比例渲染：宽 = 2 × 面板宽，高 = 面板高
  const sheetRatio = plan.panel && plan.panel.height > 0
    ? (2 * plan.panel.width) / plan.panel.height
    : 2;

  const signatureMode = plan.mode === 'signature';
  for (const sig of plan.signatures) {
    if (signatureMode) {
      const heading = document.createElement('div');
      heading.className = 'signature-heading';
      heading.textContent = `第 ${sig.signature} 帖 / 共 ${plan.signatures.length} 帖`
        + ` · 原始第 ${sig.sourceStart}～${sig.sourceEnd} 页`
        + ` · 补白 ${sig.paddedCount} 页`
        + ` · 帖内 ${sig.sheets.length} 张纸`;
      frag.appendChild(heading);
    }

    const group = document.createElement('div');
    group.className = 'signature-group';
    for (const sheet of sig.sheets) {
      const card = document.createElement('div');
      card.className = 'sheet';

      const title = document.createElement('div');
      title.className = 'sheet-title';
      if (signatureMode) {
        title.textContent = `第 ${sig.signature} 帖 · 帖内第 ${sheet.sheet} / ${sig.sheets.length} 张纸`;
      } else {
        title.textContent = `第 ${sheet.sheet} 张纸 / 共 ${sig.sheets.length} 张`;
      }
      card.appendChild(title);

      card.appendChild(buildSide('正面', sheet.front, false, sheetRatio));
      card.appendChild(buildSide('背面', sheet.back, true, sheetRatio));

      group.appendChild(card);
    }
    frag.appendChild(group);
  }
  sheetsEl.appendChild(frag);
  previewEl.hidden = false;
}

function buildSide(labelText, side, isBack, sheetRatio) {
  const sideEl = document.createElement('div');
  sideEl.className = 'side';

  const label = document.createElement('span');
  label.className = isBack ? 'side-label back' : 'side-label';
  label.textContent = labelText;
  sideEl.appendChild(label);

  const spread = document.createElement('div');
  spread.className = 'spread';
  spread.style.aspectRatio = String(sheetRatio);
  spread.appendChild(buildPanel(side.left, 'left'));
  spread.appendChild(buildPanel(side.right, 'right'));

  sideEl.appendChild(spread);
  return sideEl;
}

function buildPanel(slot, position) {
  const panel = document.createElement('div');
  panel.className = slot.blank ? 'panel blank' : 'panel';

  const pos = document.createElement('span');
  pos.className = `pos ${position}`;
  pos.textContent = position === 'left' ? '左' : '右';
  panel.appendChild(pos);

  if (slot.blank) {
    const tag = document.createElement('span');
    tag.className = 'blank-tag';
    tag.textContent = '空白页';
    panel.appendChild(tag);
  } else {
    const num = document.createElement('span');
    num.textContent = `第 ${slot.page} 页`;
    panel.appendChild(num);
  }
  return panel;
}
