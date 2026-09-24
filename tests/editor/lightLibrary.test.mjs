import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.light-library-test-'));
after(async () => {
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.light-library-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export * from '../../src/editor/assets/projectLibrary.ts';",
  "export { LIGHT_KINDS, LIGHT_DESCRIPTIONS } from '../../src/editor/model/lightSettings.ts';",
  "export { encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
  "export { ResourceCard } from '../../src/editor/ui/ResourceCard.tsx';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const {
  BUILT_IN_LIGHT_LIBRARY_ITEMS, BUILT_IN_MODEL_LIBRARY_ITEMS, ENVIRONMENT_LIGHT_LIBRARY_ITEM,
  LIGHT_KINDS, LIGHT_DESCRIPTIONS, isBuiltInProjectLibraryItem, isEnvironmentLightProjectLibraryItem,
  encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload, ResourceCard, PROJECT_LIBRARIES,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

test('五种真实灯光按照参考顺序提供创建与拖拽入口，并保留旧入口 ID', () => {
  assert.deepEqual(BUILT_IN_LIGHT_LIBRARY_ITEMS.map(item => item.builtIn.lightKind), LIGHT_KINDS);
  for (const item of BUILT_IN_LIGHT_LIBRARY_ITEMS) {
    assert.ok(BUILT_IN_MODEL_LIBRARY_ITEMS.includes(item));
    assert.ok(isBuiltInProjectLibraryItem(item));
    assert.deepEqual(decodeBuiltInAssetDragPayload(encodeBuiltInAssetDragPayload(item.builtIn)), item.builtIn);
    assert.ok(item.description.startsWith(LIGHT_DESCRIPTIONS[item.builtIn.lightKind]));
  }
  for (const id of ['builtin-directional-light', 'builtin-point-light', 'builtin-hemispheric-light']) {
    assert.ok(BUILT_IN_LIGHT_LIBRARY_ITEMS.some(item => item.id === id));
  }
});

test('环境光复用天空盒资源入口，并明确额外阴影能力未接入', () => {
  assert.ok(isEnvironmentLightProjectLibraryItem(ENVIRONMENT_LIGHT_LIBRARY_ITEM));
  assert.equal(ENVIRONMENT_LIGHT_LIBRARY_ITEM.openLibrary, 'skybox');
  assert.equal(isBuiltInProjectLibraryItem(ENVIRONMENT_LIGHT_LIBRARY_ITEM), false);
  assert.match(ENVIRONMENT_LIGHT_LIBRARY_ITEM.description, /HDR\/EXR/);
  assert.match(ENVIRONMENT_LIGHT_LIBRARY_ITEM.description, /不自动产生投射阴影/);
  assert.match(ENVIRONMENT_LIGHT_LIBRARY_ITEM.description, /IBL Shadows 当前未接入/);
});

test('六种灯光缩略图各自独立，可离线显示且不包含外部资源', () => {
  const items = [...BUILT_IN_LIGHT_LIBRARY_ITEMS, ENVIRONMENT_LIGHT_LIBRARY_ITEM];
  assert.equal(new Set(items.map(item => item.thumbnailUrl)).size, 6);
  for (const item of items) {
    assert.match(item.thumbnailUrl, /^data:image\/svg\+xml,/);
    const svg = decodeURIComponent(item.thumbnailUrl.slice(item.thumbnailUrl.indexOf(',') + 1));
    assert.match(svg, /viewBox="0 0 220 150"/);
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|undefined|NaN/);
  }
});

test('资源卡片同时暴露简短说明和完整描述，环境光入口不宣称拖入创建', () => {
  const item = ENVIRONMENT_LIGHT_LIBRARY_ITEM;
  const html = renderToStaticMarkup(createElement(ResourceCard, {
    item, library: PROJECT_LIBRARIES[0], title: '点击进入天空盒库', draggable: false,
  }));
  assert.match(html, /draggable="false"/);
  assert.match(html, /aria-description="使用 HDR\/EXR/);
  assert.match(html, /全局照明与反射/);
  assert.match(html, /IBL Shadows 当前未接入/);
});
