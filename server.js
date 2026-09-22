'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { imposePdf, normalizeSheetsPerSignature } = require('./lib/impose');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024
  || 50 * 1024 * 1024;

// 上传文件仅保留在内存中（拼版后直接返回，不写磁盘）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 拼版接口：上传 PDF，返回拼版后的 PDF；拼版页序方案通过响应头回传
app.post('/api/impose', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请通过字段 pdf 上传一个 PDF 文件' });
    }
    // 部分浏览器会以 application/octet-stream 上传，故以 PDF 文件头魔数为准
    const isPdf = req.file.buffer.slice(0, 5).toString('latin1') === '%PDF-'
      || (!req.file.mimetype || req.file.mimetype === 'application/octet-stream'
        && /\.pdf$/i.test(req.file.originalname || ''));
    if (!isPdf) {
      return res.status(400).json({ error: '仅支持 PDF 文件' });
    }

    // 分册签帖：每帖最多纸张数（1～20 整数）；字段缺省/为空表示整册模式
    // 非法上限属于请求参数错误，明确返回 400
    let sheetsPerSignature;
    try {
      sheetsPerSignature = normalizeSheetsPerSignature(req.body && req.body.sheetsPerSignature);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { pdfBytes, plan } = await imposePdf(req.file.buffer, { sheetsPerSignature });

    // 页序方案为纯 ASCII JSON，放入自定义响应头供前端渲染预览
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="booklet-imposed.pdf"');
    res.setHeader('X-Imposition-Plan', encodeURIComponent(JSON.stringify(plan)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Imposition-Plan');
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    const message = err && err.message ? err.message : '拼版失败';
    // 加密 PDF、损坏文件、超大文件等都返回 422，便于前端提示
    const status = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
    if (status === 413) {
      return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
    }
    return res.status(422).json({ error: `无法处理该 PDF：${message}` });
  }
});

// JSON 解析错误等兜底
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
  }
  return res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`小册子拼版应用已启动: http://localhost:${PORT}`);
});
