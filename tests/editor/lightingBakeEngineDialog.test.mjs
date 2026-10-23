import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporary = await mkdtemp(path.resolve('node_modules/.lighting-engine-dialog-'));
after(async () => {
  assert.equal(path.dirname(temporary), path.resolve('node_modules'));
  assert.match(path.basename(temporary), /^\.lighting-engine-dialog-/);
  await rm(temporary, { recursive: true, force: true });
});
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { LightingBakeEngineDialog } from '../../src/editor/panels/LightingBakeEngineDialog.tsx'; export const render = props => renderToStaticMarkup(createElement(LightingBakeEngineDialog, props));");
await build({ configFile:false, publicDir:false, logLevel:'silent', build:{ ssr:entry, outDir:path.join(temporary, 'dist'), rolldownOptions:{ output:{ entryFileNames:'ui.mjs' } } } });
const { render } = await import(pathToFileURL(path.join(temporary, 'dist/ui.mjs')).href);

test('未打开时不挂载配置草稿或配置表单', () => {
  assert.equal(render({ open:false, onClose() {} }), '');
});

test('窗口直接提供路径选择、检测、自动发现及保存，并说明本机作用域', () => {
  const markup = render({ open:true, onClose() {} });
  for (const label of ['本机烘焙引擎', '当前用户', '所有工程共用', 'Blender 可执行文件', '浏览…', '检测', '恢复自动查找', '保存并关闭', '当前生效引擎', '来源']) assert.ok(markup.includes(label), label);
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /type="submit"[^>]*disabled/);
  assert.match(markup, /正在读取本机配置/);
});

test('后台任务状态会向用户解释配置只读原因', () => {
  assert.match(render({ open:true, disabled:true, onClose() {} }), /烘焙任务正在进行/);
});
