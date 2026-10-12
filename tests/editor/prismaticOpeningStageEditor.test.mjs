import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { buildPrismaticOpeningPackage } from '../../scripts/build-prismatic-opening-package.mjs';

test('真实分镜表单允许四段零秒，隐藏棱光 renderer 不消费的控件并保留通用配置', async t => {
  const root = await mkdtemp(path.resolve('node_modules/.prismatic-stage-ui-'));
  t.after(async () => {
    if (path.dirname(root) !== path.resolve('node_modules') || !path.basename(root).startsWith('.prismatic-stage-ui-')) throw new Error('临时目录范围无效');
    await rm(root, { recursive: true, force: true });
  });
  const entry = path.join(root, 'entry.tsx');
  await writeFile(entry, `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
import { OpeningStageEditor } from '../../src/editor/opening/OpeningStageEditor';
export const render = binding => renderToStaticMarkup(<OpeningStageEditor binding={binding} disabled={false} onChange={() => {}} />);`);
  await build({ configFile: false, publicDir: false, logLevel: 'silent', esbuild: { jsx: 'automatic' },
    build: { ssr: entry, outDir: path.join(root, 'ssr'), rolldownOptions: { output: { entryFileNames: 'ui.mjs' } } } });
  const { render } = await import(pathToFileURL(path.join(root, 'ssr/ui.mjs')).href);
  const { definition } = await buildPrismaticOpeningPackage(path.join(root, 'packages'));
  const binding = { definition, config: { values: definition.defaults, stages: definition.timeline.stages }, manifestUrl: 'project/manifest.json' };
  binding.config.stages[2].routes = [];
  const html = render(binding);
  assert.equal((html.match(/min="0"/g) ?? []).length, 4);
  for (const label of ['飞线与点位', '分镜底图', '水平平移', '分镜副标题', '分镜说明', '删除分镜', '添加分镜']) assert.equal(html.includes(label), false, label);
  assert.equal(html.includes('固定为四阶段'), true);
  binding.definition.manifest.renderer = 'timeline';
  const timeline = render(binding);
  for (const label of ['飞线与点位', '分镜底图', '水平平移', '分镜副标题', '删除分镜']) assert.equal(timeline.includes(label), true, label);
});
