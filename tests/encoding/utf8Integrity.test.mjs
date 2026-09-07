import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const scanRoots = ['electron', 'src'];
const rootFiles = ['index.html', 'src/player/index.html', 'vite.config.ts', 'vite.viewer.config.ts'];
const textExtensions = new Set([
  '.css',
  '.cts',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);

const mojibakePatterns = [
  { label: 'Unicode replacement character', pattern: /\uFFFD/u },
  { label: 'GBK replacement marker', pattern: /锟斤拷/u },
  { label: 'UTF-8 decoded as Windows-1252', pattern: /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[\u0080-\u00BF]{2})/u },
  { label: 'UTF-8 Chinese decoded as Latin-1', pattern: /(?:ä¸|ä¹|äº|å[\u0080-\u00BF]|æ[\u0080-\u00BF]|ç[\u0080-\u00BF]|è[\u0080-\u00BF]|é[\u0080-\u00BF])/u },
];

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTextFiles(absolutePath);
    return textExtensions.has(path.extname(entry.name).toLowerCase()) ? [absolutePath] : [];
  }));
  return nestedFiles.flat();
}

function formatLocation(filePath, source, offset) {
  const beforeMatch = source.slice(0, offset);
  const line = beforeMatch.split(/\r?\n/u).length;
  return `${path.relative(workspaceRoot, filePath)}:${line}`;
}

test('编辑器与 Viewer 文本资源保持严格 UTF-8 且不包含常见乱码', async () => {
  const files = [
    ...rootFiles.map((fileName) => path.join(workspaceRoot, fileName)),
    ...(await Promise.all(scanRoots.map((root) => collectTextFiles(path.join(workspaceRoot, root))))).flat(),
  ];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const failures = [];

  for (const filePath of files) {
    let source;
    try {
      source = decoder.decode(await readFile(filePath));
    } catch (error) {
      failures.push(`${path.relative(workspaceRoot, filePath)}: 不是有效的 UTF-8（${error.message}）`);
      continue;
    }

    for (const { label, pattern } of mojibakePatterns) {
      const match = pattern.exec(source);
      if (match) failures.push(`${formatLocation(filePath, source, match.index)}: ${label} “${match[0]}”`);
    }
  }

  assert.deepEqual(failures, [], `发现可能导致页面乱码的文本：\n${failures.join('\n')}`);
});

test('Electron 文本文件入口不得使用会静默插入替换字符的宽松 fs.readFile 解码', async () => {
  const electronFiles = await collectTextFiles(path.join(workspaceRoot, 'electron'));
  const failures = [];

  for (const filePath of electronFiles) {
    const source = await readFile(filePath, 'utf8');
    const pattern = /fs\.readFile\([\s\S]{0,300}?['"]utf-?8['"]/gu;
    for (const match of source.matchAll(pattern)) {
      failures.push(formatLocation(filePath, source, match.index));
    }
  }

  assert.deepEqual(failures, [], `以下文本入口仍会把损坏字节静默解码为乱码：\n${failures.join('\n')}`);
});

test('编辑器和 Viewer HTML/CSS 明确声明 UTF-8 与中文字体回退', async () => {
  for (const htmlPath of ['index.html', 'src/player/index.html']) {
    const html = await readFile(path.join(workspaceRoot, htmlPath), 'utf8');
    assert.match(html, /<meta\s+charset=["']?UTF-8["']?\s*\/?>/iu, `${htmlPath} 缺少 UTF-8 charset`);
  }

  for (const cssPath of ['src/styles/global.css', 'src/player/player.css']) {
    const css = await readFile(path.join(workspaceRoot, cssPath), 'utf8');
    assert.match(css, /font-family:[^;]*"Microsoft YaHei"/u, `${cssPath} 缺少中文字体回退`);
  }
});
