# 骑马钉小册子 PDF 拼版（Booklet Imposer）

供小型印刷店使用的小册子 PDF 拼版 Web 应用。上传 PDF 后，系统按**每张纸容纳 4 页**的骑马钉规则自动重排页码，提供每张纸正反页序预览，并可下载拼版后的 PDF。

技术栈：Node.js + Express + 原生 HTML/CSS/JavaScript + [pdf-lib](https://pdf-lib.js.org/)。

## 拼版规则

- 每张纸正反两面共放置 4 个页面（每面左右各一页）。
- 页数不是 4 的倍数时，在**文档末尾补空白页**后再拼版。
- 页码排列（从外向内，逐层递进）：
  - 第 1 张纸 **正面**：`末页 | 首页`
  - 第 1 张纸 **背面**：`第 2 页 | 倒数第 2 页`
  - 第 2 张纸 **正面**：`倒数第 3 页 | 第 3 页`
  - 第 2 张纸 **背面**：`第 4 页 | 倒数第 4 页`
  - ……依次向内递进。
- 输出纸张为横向，尺寸 = `2 × 面板宽` × `面板高`（如 A4 竖版小册子 → A3 横向）；每个原始页按**原页面尺寸 1:1**放置，不缩放。
- **混合尺寸适配**：各页尺寸或旋转方向（/Rotate）不一致时，按每页**旋转后的有效宽高**取全部页面宽高的最大值作为**统一面板尺寸**；每页按其显示方向 1:1 居中放入对应半区，空余区域透明留白。拼版摘要中会显示统一面板尺寸与页面方向（竖版 / 横版 / 方形）。

> 说明：页面尺寸不一致或带旋转的 PDF 会按上述规则自动适配，无需预先统一页面尺寸；页序与末尾补白规则不受影响。

## 一条命令启动（Docker Compose）

需安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up -d --build
```

镜像构建时自动完成 `npm install`，容器启动即服务就绪，无需手动安装依赖。

启动后访问：

```
http://localhost:3000
```

停止：

```bash
docker compose down
```

## 本地运行（不使用 Docker）

要求 Node.js >= 18。

```bash
npm install
npm start
```

然后访问 http://localhost:3000 。

## 配置

通过环境变量配置（在 `docker-compose.yml` 的 `environment` 中修改）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口（容器内端口） |
| `MAX_FILE_SIZE_MB` | `50` | 单个上传 PDF 的大小上限（MB） |

如需更换宿主机映射端口，修改 `docker-compose.yml` 中 `ports` 的左侧端口，例如 `"8080:3000"`，然后访问 http://localhost:8080 。

## 使用方式

1. 浏览器打开应用，点击或拖入要拼版的 PDF。
2. 点击「开始拼版」。
3. 查看拼版摘要（原始页数 / 补白页数 / 用纸张数 / 统一面板尺寸 / 页面方向）与每张纸正反面的页码预览；斜纹块表示补的空白页。
4. 点击「下载拼版 PDF」保存，文件名自动在原文件名后加 `-拼版` 后缀。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/impose` | multipart 表单字段 `pdf` 上传 PDF；返回拼版 PDF，页序方案在响应头 `X-Imposition-Plan`（URL 编码的 JSON，含 `panel` 统一面板尺寸与方向） |
| `GET` | `/api/health` | 健康检查，返回 `{ "ok": true }` |

## 目录结构

```
.
├── server.js            # Express 服务与上传/下载接口
├── lib/impose.js        # 骑马钉页序计算与 pdf-lib 拼版核心
├── public/              # 原生前端（index.html / style.css / app.js）
├── Dockerfile
├── docker-compose.yml
└── package.json
```
