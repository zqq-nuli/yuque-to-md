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

1. 访问部署的 URL
2. 上传 `.lakebook` 文件
3. 选择是否下载图片
4. 点击"转换并下载"
5. 下载生成的 ZIP 文件

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
