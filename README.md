# Lakebook to Markdown Converter - Cloudflare Workers Version

将语雀（Yuque）的 `.lakebook` 文件转换为 Markdown 格式的 Cloudflare Workers 应用。

## 功能特性

- 上传 `.lakebook` 文件并转换为 Markdown
- 保持原有的目录结构
- 可选下载图片到本地
- 返回打包好的 ZIP 文件
- 美观的 Web 界面

## 安装

```bash
cd lakebook-worker
npm install
```

## 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787` 即可使用。

## 部署到 Cloudflare Workers

```bash
npm run deploy
```

## 使用方式

### Web 界面

**方式一：上传 .lakebook 文件（推荐）**

1. 在语雀知识库设置中导出 `.lakebook` 文件
2. 访问部署的 URL
3. 上传 `.lakebook` 文件
4. 选择是否下载图片
5. 点击"转换并下载"
6. 下载生成的 ZIP 文件

**如何获取 .lakebook 文件：**
1. 打开语雀知识库
2. 点击右上角的"设置"图标
3. 选择"导出知识库"
4. 选择 "lakebook 格式"
5. 等待导出完成后下载

**方式二：输入语雀 URL**

1. 访问部署的 URL
2. 切换到"输入 URL"标签
3. 输入公开的语雀知识库或文档 URL
4. 点击"转换并下载"

> ⚠️ 注意：由于语雀的反爬虫保护，URL 模式可能在某些部署环境（如 Cloudflare Workers）中无法正常工作。建议优先使用 .lakebook 文件方式。

### API 调用

```bash
curl -X POST \
  -F "lakebook=@your-file.lakebook" \
  -F "downloadImages=true" \
  https://your-worker.workers.dev \
  --output output.zip
```

## 与 Python 版本的区别

| 特性 | Python 版本 | Workers 版本 |
|------|------------|--------------|
| 运行环境 | 本地命令行 | 云端/浏览器 |
| 输出方式 | 直接写入文件系统 | 返回 ZIP 文件 |
| 图片下载 | 下载到本地目录 | 打包到 ZIP 中 |
| 部署方式 | 需要 Python 环境 | 无服务器部署 |

## 技术栈

- Cloudflare Workers
- TypeScript
- JSZip - ZIP 文件处理
- pako - gzip 解压
- js-yaml - YAML 解析
- 自定义 HTML to Markdown 转换器

## 限制

- Workers 有 128MB 内存限制
- 单次请求最长 30 秒（付费版可延长）
- 适合中小型 lakebook 文件

## License

MIT
