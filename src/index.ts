/**
 * Yuque to Markdown Converter - Cloudflare Workers Version
 * 将语雀文档转换为 Markdown 格式
 * 支持：1. 上传 .lakebook 文件  2. 输入语雀公开文档 URL
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

interface YuqueDocData {
  title: string;
  body_html: string;
}

interface YuqueTocItem {
  title: string;
  slug: string;
  url: string;
  level: number;
  type: string;
  child_uuid?: string;
  parent_uuid?: string;
}

const TYPE_DOC = 'DOC';
const META_JSON = '$meta.json';

const contentTypeToExtension: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/webp': '.webp',
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

  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].trimEnd();
  }
  output = lines.join('\n');

  for (let i = 0; i < 50; i++) {
    output = output.replace(/\n\n\n/g, '\n\n');
    if (!output.includes('\n\n\n')) {
      break;
    }
  }

  return output;
}

// ============ 语雀 URL 解析和抓取 ============

interface YuqueUrlInfo {
  namespace: string;
  book: string;
  slug?: string;
  isBook: boolean;
}

function parseYuqueUrl(url: string): YuqueUrlInfo | null {
  // 支持的格式:
  // https://www.yuque.com/namespace/book
  // https://www.yuque.com/namespace/book/slug
  // https://yuque.com/namespace/book/slug
  const match = url.match(/^https?:\/\/(?:www\.)?yuque\.com\/([^\/]+)\/([^\/]+)(?:\/([^\/\?#]+))?/);
  if (!match) return null;

  return {
    namespace: match[1],
    book: match[2],
    slug: match[3],
    isBook: !match[3],
  };
}

async function fetchYuqueDoc(namespace: string, book: string, slug: string): Promise<YuqueDocData> {
  // 直接抓取语雀页面
  const url = `https://www.yuque.com/${namespace}/${book}/${slug}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch document: ${response.status}`);
  }

  const html = await response.text();

  // 提取标题
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch ? titleMatch[1].replace(/ · 语雀$/, '').trim() : slug;

  // 提取文档内容 - 语雀的文档内容在 script 标签中的 JSON 数据里
  // 尝试从 window.__INITIAL_STATE__ 中提取
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const doc = state?.doc?.data || state?.data?.book?.toc?.[0];
      if (doc) {
        return {
          title: doc.title || title,
          body_html: doc.body_html || doc.body || '',
        };
      }
    } catch (e) {
      console.error('Failed to parse initial state:', e);
    }
  }

  // 备用方案：提取 article 内容
  const articleMatch = html.match(/<article[^>]*class="[^"]*yuque-doc-content[^"]*"[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    return {
      title,
      body_html: articleMatch[1],
    };
  }

  // 再次备用：尝试提取 ne-viewer-body
  const viewerMatch = html.match(/<div[^>]*class="[^"]*ne-viewer-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
  if (viewerMatch) {
    return {
      title,
      body_html: viewerMatch[1],
    };
  }

  throw new Error('Cannot extract document content from page');
}

async function fetchYuqueBookToc(namespace: string, book: string): Promise<YuqueTocItem[]> {
  // 获取知识库目录
  const url = `https://www.yuque.com/${namespace}/${book}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch book: ${response.status}`);
  }

  const html = await response.text();

  // 从 __INITIAL_STATE__ 中提取目录
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const toc = state?.book?.toc || state?.data?.book?.toc || [];
      return toc.map((item: any) => ({
        title: item.title || '',
        slug: item.slug || item.url || '',
        url: item.url || item.slug || '',
        level: item.depth || item.level || 0,
        type: item.type === 'TITLE' ? 'TITLE' : 'DOC',
      }));
    } catch (e) {
      console.error('Failed to parse initial state:', e);
    }
  }

  throw new Error('Cannot extract TOC from book page');
}

async function convertYuqueUrlToMarkdown(
  yuqueUrl: string,
  downloadImages: boolean
): Promise<JSZip> {
  const urlInfo = parseYuqueUrl(yuqueUrl);
  if (!urlInfo) {
    throw new Error('Invalid Yuque URL format');
  }

  const zip = new JSZip();

  if (urlInfo.isBook) {
    // 整个知识库
    const toc = await fetchYuqueBookToc(urlInfo.namespace, urlInfo.book);
    console.log(`Found ${toc.length} items in book`);

    let pathPrefixed: string[] = [];
    let lastLevel = 0;
    let lastSanitizedTitle = '';
    const usedNames = new Set<string>();

    for (const item of toc) {
      if (!item.title) continue;

      let sanitizedTitle = sanitizeFileName(item.title);
      while (usedNames.has(sanitizedTitle)) {
        sanitizedTitle = sanitizeFileName(item.title) + String(Math.floor(Math.random() * 1000));
      }
      usedNames.add(sanitizedTitle);

      const currentLevel = item.level;

      if (currentLevel > lastLevel) {
        pathPrefixed = [...pathPrefixed, lastSanitizedTitle];
      } else if (currentLevel < lastLevel) {
        const diff = lastLevel - currentLevel;
        pathPrefixed = pathPrefixed.slice(0, -diff);
      }

      if (item.type === 'DOC' && item.slug) {
        try {
          const doc = await fetchYuqueDoc(urlInfo.namespace, urlInfo.book, item.slug);
          let html = doc.body_html;

          const attachmentsMap = new Map<string, { data: Uint8Array; ext: string }>();
          const outputDirPath = pathPrefixed.join('/');

          if (downloadImages && html) {
            html = await downloadImageAndPatchHtml(html, sanitizedTitle, attachmentsMap);

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
        } catch (e) {
          console.error(`Failed to fetch doc ${item.slug}:`, e);
        }
      }

      lastSanitizedTitle = sanitizedTitle;
      lastLevel = currentLevel;
    }
  } else {
    // 单篇文档
    const doc = await fetchYuqueDoc(urlInfo.namespace, urlInfo.book, urlInfo.slug!);
    let html = doc.body_html;
    const sanitizedTitle = sanitizeFileName(doc.title);

    const attachmentsMap = new Map<string, { data: Uint8Array; ext: string }>();

    if (downloadImages && html) {
      html = await downloadImageAndPatchHtml(html, sanitizedTitle, attachmentsMap);

      for (const [attachPath, { data }] of attachmentsMap) {
        zip.file(attachPath, data);
      }
    }

    const markdown = prettyMd(htmlToMarkdown(html));
    zip.file(`${sanitizedTitle}.md`, markdown);
  }

  return zip;
}

// ============ Lakebook 文件处理 ============

async function extractTarGz(data: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  const tarData = ungzip(new Uint8Array(data));

  let offset = 0;
  while (offset < tarData.length) {
    if (offset + 512 > tarData.length) break;

    const header = tarData.slice(offset, offset + 512);

    if (header.every(b => b === 0)) break;

    let fileName = '';
    for (let i = 0; i < 100 && header[i] !== 0; i++) {
      fileName += String.fromCharCode(header[i]);
    }

    let prefix = '';
    for (let i = 345; i < 500 && header[i] !== 0; i++) {
      prefix += String.fromCharCode(header[i]);
    }
    if (prefix) {
      fileName = prefix + '/' + fileName;
    }

    let sizeStr = '';
    for (let i = 124; i < 136 && header[i] !== 0 && header[i] !== 32; i++) {
      sizeStr += String.fromCharCode(header[i]);
    }
    const fileSize = parseInt(sizeStr, 8) || 0;

    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;

    if (typeFlag === '0' || typeFlag === '\0') {
      const fileData = tarData.slice(offset, offset + fileSize);
      files.set(fileName, fileData);
    }

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
  let no = 1;
  let modifiedHtml = html;

  const matches: { original: string; src: string }[] = [];
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    matches.push({ original: match[0], src: match[1] });
  }

  for (const { original, src } of matches) {
    try {
      const response = await fetch(src, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.yuque.com/',
        },
      });
      if (response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const ext = contentTypeToExtension[contentType.split(';')[0]] || '.png';
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

// ============ Worker 入口 ============

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method === 'GET') {
      return new Response(getUploadHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('lakebook') as File | null;
        const yuqueUrl = formData.get('yuqueUrl') as string | null;
        const downloadImages = formData.get('downloadImages') === 'true';

        let zip: JSZip;

        if (yuqueUrl && yuqueUrl.trim()) {
          // 从语雀 URL 抓取
          const urlInfo = parseYuqueUrl(yuqueUrl.trim());
          if (!urlInfo) {
            return new Response(JSON.stringify({ error: '无效的语雀 URL，请输入类似 https://www.yuque.com/xxx/yyy 的链接' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          zip = await convertYuqueUrlToMarkdown(yuqueUrl.trim(), downloadImages);
        } else if (file && file.size > 0) {
          // 处理上传的 lakebook 文件
          const arrayBuffer = await file.arrayBuffer();
          const files = await extractTarGz(arrayBuffer);

          const repoDir = findRepoDir(files);
          if (!repoDir) {
            return new Response(JSON.stringify({ error: '无效的 .lakebook 文件' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const toc = readToc(files, repoDir);
          console.log(`Total ${toc.length} files`);

          zip = await extractRepos(files, repoDir, toc, downloadImages);
        } else {
          return new Response(JSON.stringify({ error: '请上传文件或输入语雀 URL' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const zipBlob = await zip.generateAsync({ type: 'arraybuffer' });

        return new Response(zipBlob, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="markdown-output.zip"',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        console.error('Error processing:', error);
        return new Response(
          JSON.stringify({ error: '处理失败', details: String(error) }),
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
  <title>语雀文档转 Markdown</title>
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
      max-width: 520px;
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
    .tabs {
      display: flex;
      margin-bottom: 20px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #ddd;
    }
    .tab {
      flex: 1;
      padding: 12px;
      text-align: center;
      cursor: pointer;
      background: #f5f5f5;
      color: #666;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s ease;
      border: none;
    }
    .tab:first-child { border-right: 1px solid #ddd; }
    .tab.active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
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
    .upload-area input[type="file"] {
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
    .url-input-area {
      margin-bottom: 20px;
    }
    .url-input-area label {
      display: block;
      color: #333;
      font-size: 14px;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .url-input-area input[type="text"] {
      width: 100%;
      padding: 14px;
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.3s ease;
    }
    .url-input-area input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }
    .url-input-area .hint {
      color: #999;
      font-size: 12px;
      margin-top: 8px;
      line-height: 1.6;
    }
    .url-input-area .hint code {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
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
    button[type="submit"] {
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
    button[type="submit"]:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
    }
    button[type="submit"]:disabled {
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
      font-size: 14px;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>语雀文档转 Markdown</h1>
    <p class="subtitle">支持公开文档 URL 或 .lakebook 文件</p>

    <form id="uploadForm" enctype="multipart/form-data">
      <div class="tabs">
        <button type="button" class="tab active" data-tab="url">输入 URL</button>
        <button type="button" class="tab" data-tab="file">上传文件</button>
      </div>

      <div id="urlTab" class="tab-content active">
        <div class="url-input-area">
          <label for="urlInput">语雀文档 URL</label>
          <input type="text" id="urlInput" name="yuqueUrl" placeholder="https://www.yuque.com/xxx/yyy/zzz">
          <p class="hint">
            支持单篇文档: <code>yuque.com/用户/知识库/文档</code><br>
            支持整个知识库: <code>yuque.com/用户/知识库</code>
          </p>
        </div>
      </div>

      <div id="fileTab" class="tab-content">
        <div class="upload-area" id="uploadArea">
          <input type="file" name="lakebook" id="fileInput" accept=".lakebook">
          <div class="upload-icon">📄</div>
          <div class="upload-text">点击或拖拽 .lakebook 文件到此处</div>
          <div class="file-name" id="fileName"></div>
        </div>
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
      <span id="progressText">正在处理中，请稍候...</span>
    </div>

    <div class="error" id="error"></div>
  </div>

  <script>
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    const urlInput = document.getElementById('urlInput');
    const submitBtn = document.getElementById('submitBtn');
    const uploadForm = document.getElementById('uploadForm');
    const progress = document.getElementById('progress');
    const progressText = document.getElementById('progressText');
    const error = document.getElementById('error');
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    let currentTab = 'url';

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        currentTab = tabName;

        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        tabContents.forEach(content => {
          content.classList.remove('active');
          if (content.id === tabName + 'Tab') {
            content.classList.add('active');
          }
        });

        updateSubmitButton();
      });
    });

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
        updateFileDisplay(files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        updateFileDisplay(fileInput.files[0]);
      }
    });

    urlInput.addEventListener('input', updateSubmitButton);

    function updateFileDisplay(file) {
      fileName.textContent = file.name;
      updateSubmitButton();
    }

    function updateSubmitButton() {
      if (currentTab === 'url') {
        submitBtn.disabled = !urlInput.value.trim();
      } else {
        submitBtn.disabled = !fileInput.files || fileInput.files.length === 0;
      }
    }

    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      error.classList.remove('show');
      progress.classList.add('show');
      progressText.textContent = currentTab === 'url'
        ? '正在抓取语雀文档...'
        : '正在处理文件...';
      submitBtn.disabled = true;

      const formData = new FormData(uploadForm);

      if (currentTab === 'url') {
        formData.delete('lakebook');
      } else {
        formData.delete('yuqueUrl');
      }

      try {
        const response = await fetch('/', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error || result.details || 'Unknown error');
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
        error.textContent = err.message;
        error.classList.add('show');
      } finally {
        progress.classList.remove('show');
        updateSubmitButton();
      }
    });

    // 初始化
    updateSubmitButton();
  </script>
</body>
</html>`;
}
