/**
 * Lakebook to Markdown Converter - Cloudflare Workers Version
 * 将语雀 .lakebook 文件转换为 Markdown 格式
 */

import JSZip from 'jszip';
import * as yaml from 'js-yaml';
import { htmlToMarkdown } from './html-to-md';
import { ungzip } from 'pako';

export interface Env {
  DOWNLOAD_IMAGES: string;
}

interface TocItem {
  type: string;
  url?: string;
  level?: number;
  title?: string;
}

interface MetaFile {
  meta: string;
}

interface DocFile {
  doc: {
    body?: string;
    body_asl?: string;
  };
}

const TYPE_DOC = 'DOC';
const META_JSON = '$meta.json';

const contentTypeToExtension: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'image/png': '.png',
};

function sanitizeFileName(name: string): string {
  return name
    .replace(/\//g, '_')
    .replace(/\\/g, '_')
    .replace(/ /g, '_')
    .replace(/\?/g, '_')
    .replace(/\*/g, '_')
    .replace(/</g, '_')
    .replace(/>/g, '_')
    .replace(/\|/g, '_')
    .replace(/"/g, '_')
    .replace(/:/g, '_');
}

function prettyMd(text: string): string {
  let output = text;

  // 去除每行末尾空格
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].trimEnd();
  }
  output = lines.join('\n');

  // 合并多余空行
  for (let i = 0; i < 50; i++) {
    output = output.replace(/\n\n\n/g, '\n\n');
    if (!output.includes('\n\n\n')) {
      break;
    }
  }

  return output;
}

async function extractTarGz(data: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  // 解压 gzip
  const tarData = ungzip(new Uint8Array(data));

  // 解析 tar 格式
  let offset = 0;
  while (offset < tarData.length) {
    // 读取 tar header (512 bytes)
    if (offset + 512 > tarData.length) break;

    const header = tarData.slice(offset, offset + 512);

    // 检查是否为空 header（文件结束）
    if (header.every(b => b === 0)) break;

    // 提取文件名 (前 100 bytes)
    let fileName = '';
    for (let i = 0; i < 100 && header[i] !== 0; i++) {
      fileName += String.fromCharCode(header[i]);
    }

    // 检查 ustar 格式的前缀 (offset 345, 155 bytes)
    let prefix = '';
    for (let i = 345; i < 500 && header[i] !== 0; i++) {
      prefix += String.fromCharCode(header[i]);
    }
    if (prefix) {
      fileName = prefix + '/' + fileName;
    }

    // 提取文件大小 (offset 124, 12 bytes, octal)
    let sizeStr = '';
    for (let i = 124; i < 136 && header[i] !== 0 && header[i] !== 32; i++) {
      sizeStr += String.fromCharCode(header[i]);
    }
    const fileSize = parseInt(sizeStr, 8) || 0;

    // 提取文件类型 (offset 156, 1 byte)
    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;

    // 只处理普通文件
    if (typeFlag === '0' || typeFlag === '\0') {
      const fileData = tarData.slice(offset, offset + fileSize);
      files.set(fileName, fileData);
    }

    // 跳过文件数据（按 512 字节对齐）
    offset += Math.ceil(fileSize / 512) * 512;
  }

  return files;
}

function findRepoDir(files: Map<string, Uint8Array>): string {
  for (const path of files.keys()) {
    const parts = path.split('/');
    if (parts.length >= 2 && parts[1] === META_JSON) {
      return parts[0];
    }
  }
  return '';
}

function readToc(files: Map<string, Uint8Array>, repoDir: string): TocItem[] {
  const metaPath = `${repoDir}/${META_JSON}`;
  const metaData = files.get(metaPath);
  if (!metaData) {
    throw new Error('Meta file not found');
  }

  const metaStr = new TextDecoder('utf-8').decode(metaData);
  const metaFile: MetaFile = JSON.parse(metaStr);
  const meta = JSON.parse(metaFile.meta);
  const tocStr = meta.book?.tocYml || '';
  return yaml.load(tocStr) as TocItem[];
}

async function downloadImageAndPatchHtml(
  html: string,
  sanitizedTitle: string,
  attachmentsMap: Map<string, { data: Uint8Array; ext: string }>
): Promise<string> {
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let match;
  let no = 1;
  let modifiedHtml = html;

  const matches: { original: string; src: string }[] = [];
  while ((match = imgRegex.exec(html)) !== null) {
    matches.push({ original: match[0], src: match[1] });
  }

  for (const { original, src } of matches) {
    try {
      const response = await fetch(src);
      if (response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const ext = contentTypeToExtension[contentType] || '.png';
        const data = new Uint8Array(await response.arrayBuffer());
        const fileName = `${sanitizedTitle}_${String(no).padStart(3, '0')}${ext}`;

        attachmentsMap.set(`attachments/${fileName}`, { data, ext });

        const newSrc = `./attachments/${fileName}`;
        const newImgTag = original.replace(src, newSrc);
        modifiedHtml = modifiedHtml.replace(original, newImgTag);
        no++;
      }
    } catch (e) {
      console.error(`Failed to download image: ${src}`, e);
    }
  }

  return modifiedHtml;
}

async function extractRepos(
  files: Map<string, Uint8Array>,
  repoDir: string,
  toc: TocItem[],
  downloadImage: boolean
): Promise<JSZip> {
  const zip = new JSZip();
  let lastLevel = 0;
  let lastSanitizedTitle = '';
  let pathPrefixed: string[] = [];
  const usedNames = new Set<string>();

  for (const item of toc) {
    const type = item.type;
    const url = String(item.url || '');
    const currentLevel = item.level || 0;
    const title = String(item.title || '');

    if (!title) continue;

    let sanitizedTitle = sanitizeFileName(title);
    while (usedNames.has(sanitizedTitle)) {
      sanitizedTitle = sanitizeFileName(title) + String(Math.floor(Math.random() * 1000));
    }
    usedNames.add(sanitizedTitle);

    if (currentLevel > lastLevel) {
      pathPrefixed = [...pathPrefixed, lastSanitizedTitle];
    } else if (currentLevel < lastLevel) {
      const diff = lastLevel - currentLevel;
      pathPrefixed = pathPrefixed.slice(0, -diff);
    }

    if (type === TYPE_DOC) {
      const outputDirPath = pathPrefixed.join('/');
      const rawPath = `${repoDir}/${url}.json`;
      const rawData = files.get(rawPath);

      if (rawData) {
        const docStr = new TextDecoder('utf-8').decode(rawData);
        const doc: DocFile = JSON.parse(docStr);
        let html = doc.doc.body || doc.doc.body_asl || '';

        const attachmentsMap = new Map<string, { data: Uint8Array; ext: string }>();

        if (downloadImage && html) {
          html = await downloadImageAndPatchHtml(html, sanitizedTitle, attachmentsMap);

          // 添加附件到 zip
          for (const [attachPath, { data }] of attachmentsMap) {
            const fullPath = outputDirPath
              ? `${outputDirPath}/${attachPath}`
              : attachPath;
            zip.file(fullPath, data);
          }
        }

        const markdown = prettyMd(htmlToMarkdown(html));
        const outputPath = outputDirPath
          ? `${outputDirPath}/${sanitizedTitle}.md`
          : `${sanitizedTitle}.md`;
        zip.file(outputPath, markdown);
      }
    }

    lastSanitizedTitle = sanitizedTitle;
    lastLevel = currentLevel;
  }

  return zip;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 处理 CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 首页 - 显示上传表单
    if (request.method === 'GET') {
      return new Response(getUploadHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 处理上传
    if (request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('lakebook') as File | null;
        const downloadImages = formData.get('downloadImages') === 'true';

        if (!file) {
          return new Response(JSON.stringify({ error: 'No file uploaded' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const arrayBuffer = await file.arrayBuffer();

        // 解压 tar.gz
        const files = await extractTarGz(arrayBuffer);

        // 找到 repo 目录
        const repoDir = findRepoDir(files);
        if (!repoDir) {
          return new Response(JSON.stringify({ error: 'Invalid .lakebook file' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // 读取目录结构
        const toc = readToc(files, repoDir);
        console.log(`Total ${toc.length} files`);

        // 转换并生成 zip
        const zip = await extractRepos(files, repoDir, toc, downloadImages);

        // 生成 zip 文件
        const zipBlob = await zip.generateAsync({ type: 'arraybuffer' });

        return new Response(zipBlob, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="markdown-output.zip"',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        console.error('Error processing file:', error);
        return new Response(
          JSON.stringify({ error: 'Failed to process file', details: String(error) }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    return new Response('Method not allowed', { status: 405 });
  },
};

function getUploadHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lakebook to Markdown Converter</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 24px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .upload-area {
      border: 2px dashed #ddd;
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s ease;
      margin-bottom: 20px;
    }
    .upload-area:hover, .upload-area.dragover {
      border-color: #667eea;
      background: #f8f9ff;
    }
    .upload-area input {
      display: none;
    }
    .upload-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
    .upload-text {
      color: #666;
      font-size: 14px;
    }
    .file-name {
      margin-top: 10px;
      color: #667eea;
      font-weight: 500;
    }
    .options {
      margin-bottom: 20px;
    }
    .option {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px;
      background: #f5f5f5;
      border-radius: 8px;
    }
    .option input[type="checkbox"] {
      width: 18px;
      height: 18px;
    }
    .option label {
      color: #333;
      font-size: 14px;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .progress {
      display: none;
      margin-top: 20px;
      text-align: center;
      color: #666;
    }
    .progress.show { display: block; }
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid #f3f3f3;
      border-top: 2px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 10px;
      vertical-align: middle;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .error {
      color: #e74c3c;
      margin-top: 20px;
      padding: 10px;
      background: #ffeaea;
      border-radius: 8px;
      display: none;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📚 Lakebook to Markdown</h1>
    <p class="subtitle">将语雀 .lakebook 文件转换为 Markdown 格式</p>

    <form id="uploadForm" enctype="multipart/form-data">
      <div class="upload-area" id="uploadArea">
        <input type="file" name="lakebook" id="fileInput" accept=".lakebook">
        <div class="upload-icon">📄</div>
        <div class="upload-text">点击或拖拽 .lakebook 文件到此处</div>
        <div class="file-name" id="fileName"></div>
      </div>

      <div class="options">
        <div class="option">
          <input type="checkbox" id="downloadImages" name="downloadImages" value="true">
          <label for="downloadImages">下载图片到本地</label>
        </div>
      </div>

      <button type="submit" id="submitBtn" disabled>转换并下载</button>
    </form>

    <div class="progress" id="progress">
      <span class="spinner"></span>
      <span>正在处理中，请稍候...</span>
    </div>

    <div class="error" id="error"></div>
  </div>

  <script>
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const submitBtn = document.getElementById('submitBtn');
    const uploadForm = document.getElementById('uploadForm');
    const progress = document.getElementById('progress');
    const error = document.getElementById('error');

    uploadArea.addEventListener('click', () => fileInput.click());

    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        fileInput.files = files;
        updateFileName(files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        updateFileName(fileInput.files[0]);
      }
    });

    function updateFileName(file) {
      fileName.textContent = file.name;
      submitBtn.disabled = false;
    }

    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      error.classList.remove('show');
      progress.classList.add('show');
      submitBtn.disabled = true;

      const formData = new FormData(uploadForm);

      try {
        const response = await fetch('/', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error || 'Unknown error');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'markdown-output.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        error.textContent = '错误: ' + err.message;
        error.classList.add('show');
      } finally {
        progress.classList.remove('show');
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
