import { rolldown } from 'rolldown';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('.', import.meta.url);
const bundle = await rolldown({
  input: fileURLToPath(new URL('prototype.js', directory)),
  treeshake: true,
});
const { output } = await bundle.generate({
  format: 'iife',
  codeSplitting: false,
  minify: true,
});
const code = output.filter((chunk) => chunk.type === 'chunk').map((chunk) => chunk.code).join('\n');
const css = await readFile(new URL('prototype.css', directory), 'utf8');
const template = await readFile(new URL('index.html', directory), 'utf8');
const html = template
  .replace('<link rel="stylesheet" href="./prototype.css" />', `<style>${css}</style>`)
  .replace('<script type="module" src="./prototype.js"></script>', () => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`);
const target = new URL('设备爆炸图-三端交互原型.html', directory);
await writeFile(target, html, 'utf8');
console.log(`已生成离线单文件原型：${fileURLToPath(target)}（${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB）`);
await bundle.close();
