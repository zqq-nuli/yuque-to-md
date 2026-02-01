/**
 * HTML to Markdown converter
 * 简化版的 markdownify 实现
 */

interface ConvertOptions {
  headingStyle?: 'ATX' | 'SETEXT';
}

const defaultOptions: ConvertOptions = {
  headingStyle: 'ATX',
};

// 简单的 HTML 实体解码
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'g'), char);
  }

  // 处理数字实体
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

  return result;
}

// 简单的 HTML 解析器
class SimpleHtmlParser {
  private html: string;
  private pos: number;

  constructor(html: string) {
    this.html = html;
    this.pos = 0;
  }

  parse(): Node {
    const root: Node = { type: 'root', children: [] };
    this.parseChildren(root);
    return root;
  }

  private parseChildren(parent: Node): void {
    while (this.pos < this.html.length) {
      if (this.html[this.pos] === '<') {
        if (this.html.substring(this.pos, this.pos + 2) === '</') {
          return; // 结束标签
        }
        if (this.html.substring(this.pos, this.pos + 4) === '<!--') {
          this.skipComment();
          continue;
        }
        const element = this.parseElement();
        if (element) {
          parent.children = parent.children || [];
          parent.children.push(element);
        }
      } else {
        const text = this.parseText();
        if (text.trim() || text.includes(' ')) {
          parent.children = parent.children || [];
          parent.children.push({ type: 'text', content: text });
        }
      }
    }
  }

  private skipComment(): void {
    const end = this.html.indexOf('-->', this.pos);
    if (end !== -1) {
      this.pos = end + 3;
    } else {
      this.pos = this.html.length;
    }
  }

  private parseElement(): Node | null {
    const start = this.pos;
    this.pos++; // skip '<'

    // 解析标签名
    const tagNameMatch = this.html.substring(this.pos).match(/^([a-zA-Z0-9]+)/);
    if (!tagNameMatch) {
      return null;
    }
    const tagName = tagNameMatch[1].toLowerCase();
    this.pos += tagName.length;

    // 解析属性
    const attributes: Record<string, string> = {};
    while (this.pos < this.html.length && this.html[this.pos] !== '>' && this.html[this.pos] !== '/') {
      this.skipWhitespace();
      if (this.html[this.pos] === '>' || this.html[this.pos] === '/') break;

      const attrMatch = this.html.substring(this.pos).match(/^([a-zA-Z0-9_-]+)(?:="([^"]*)")?/);
      if (attrMatch) {
        attributes[attrMatch[1]] = attrMatch[2] || '';
        this.pos += attrMatch[0].length;
      } else {
        this.pos++;
      }
    }

    // 自闭合标签
    const selfClosing = ['img', 'br', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];
    if (this.html[this.pos] === '/') {
      this.pos++;
    }
    if (this.html[this.pos] === '>') {
      this.pos++;
    }

    const node: Node = {
      type: 'element',
      tagName,
      attributes,
      children: [],
    };

    if (!selfClosing.includes(tagName)) {
      this.parseChildren(node);

      // 跳过结束标签
      const endTag = `</${tagName}>`;
      const endPos = this.html.toLowerCase().indexOf(endTag.toLowerCase(), this.pos);
      if (endPos !== -1) {
        this.pos = endPos + endTag.length;
      }
    }

    return node;
  }

  private parseText(): string {
    let text = '';
    while (this.pos < this.html.length && this.html[this.pos] !== '<') {
      text += this.html[this.pos];
      this.pos++;
    }
    return text;
  }

  private skipWhitespace(): void {
    while (this.pos < this.html.length && /\s/.test(this.html[this.pos])) {
      this.pos++;
    }
  }
}

interface Node {
  type: 'root' | 'element' | 'text';
  tagName?: string;
  attributes?: Record<string, string>;
  children?: Node[];
  content?: string;
}

function nodeToMarkdown(node: Node, options: ConvertOptions): string {
  if (node.type === 'text') {
    return decodeHtmlEntities(node.content || '');
  }

  if (node.type === 'root') {
    return (node.children || []).map(child => nodeToMarkdown(child, options)).join('');
  }

  const tagName = node.tagName || '';
  const children = (node.children || []).map(child => nodeToMarkdown(child, options)).join('');
  const attrs = node.attributes || {};

  switch (tagName) {
    case 'h1':
      return options.headingStyle === 'ATX' ? `\n# ${children.trim()}\n\n` : `\n${children.trim()}\n${'='.repeat(children.trim().length)}\n\n`;
    case 'h2':
      return options.headingStyle === 'ATX' ? `\n## ${children.trim()}\n\n` : `\n${children.trim()}\n${'-'.repeat(children.trim().length)}\n\n`;
    case 'h3':
      return `\n### ${children.trim()}\n\n`;
    case 'h4':
      return `\n#### ${children.trim()}\n\n`;
    case 'h5':
      return `\n##### ${children.trim()}\n\n`;
    case 'h6':
      return `\n###### ${children.trim()}\n\n`;

    case 'p':
      return `\n${children}\n\n`;

    case 'br':
      return '\n';

    case 'hr':
      return '\n---\n\n';

    case 'strong':
    case 'b':
      return `**${children}**`;

    case 'em':
    case 'i':
      return `*${children}*`;

    case 'code':
      return `\`${children}\``;

    case 'pre':
      // 检查是否有 data-language 属性
      const lang = attrs['data-language'] || attrs['class']?.match(/language-(\w+)/)?.[1] || '';
      const codeContent = children.replace(/^\n+|\n+$/g, '');
      return `\n\`\`\`${lang}\n${codeContent}\n\`\`\`\n\n`;

    case 'blockquote':
      const lines = children.trim().split('\n');
      return '\n' + lines.map(line => `> ${line}`).join('\n') + '\n\n';

    case 'ul':
      return `\n${children}\n`;

    case 'ol':
      return `\n${children}\n`;

    case 'li':
      // 检查父元素类型来决定使用哪种标记
      return `- ${children.trim()}\n`;

    case 'a':
      const href = attrs.href || '';
      const title = attrs.title ? ` "${attrs.title}"` : '';
      if (!href) return children;
      return `[${children}](${href}${title})`;

    case 'img':
      const src = attrs.src || '';
      const alt = attrs.alt || '';
      const imgTitle = attrs.title ? ` "${attrs.title}"` : '';
      return `![${alt}](${src}${imgTitle})`;

    case 'table':
      return `\n${children}\n`;

    case 'thead':
      return children;

    case 'tbody':
      return children;

    case 'tr':
      const cells = (node.children || [])
        .filter(child => child.tagName === 'td' || child.tagName === 'th')
        .map(child => nodeToMarkdown(child, options).trim());

      // 检查是否是表头行
      const isHeader = (node.children || []).some(child => child.tagName === 'th');
      const row = `| ${cells.join(' | ')} |\n`;

      if (isHeader) {
        const separator = `| ${cells.map(() => '---').join(' | ')} |\n`;
        return row + separator;
      }
      return row;

    case 'td':
    case 'th':
      return children;

    case 'del':
    case 's':
    case 'strike':
      return `~~${children}~~`;

    case 'sup':
      return `^${children}^`;

    case 'sub':
      return `~${children}~`;

    case 'div':
    case 'span':
    case 'section':
    case 'article':
    case 'header':
    case 'footer':
    case 'main':
    case 'aside':
    case 'nav':
      return children;

    case 'script':
    case 'style':
    case 'noscript':
      return '';

    default:
      return children;
  }
}

export function htmlToMarkdown(html: string, options: ConvertOptions = {}): string {
  const mergedOptions = { ...defaultOptions, ...options };

  if (!html || !html.trim()) {
    return '';
  }

  const parser = new SimpleHtmlParser(html);
  const tree = parser.parse();
  const markdown = nodeToMarkdown(tree, mergedOptions);

  return markdown;
}
