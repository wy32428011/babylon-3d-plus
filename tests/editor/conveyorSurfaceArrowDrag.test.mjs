import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.conveyor-arrow-drag-test-'));
after(async () => {
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.conveyor-arrow-drag-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { createPoiEffectLibraryItems } from '../../src/editor/assets/projectLibrary.ts';",
  "export { BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
  "export { readConveyorSurfaceArrowStyleDrop } from '../../src/editor/assets/conveyorSurfaceArrowDrag.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const { createPoiEffectLibraryItems, BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload, readConveyorSurfaceArrowStyleDrop } = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);

function transfer(payload, types = [BUILT_IN_ASSET_DRAG_MIME_TYPE], fileCount = 0) {
  return { types, files: { length: fileCount }, getData: mime => mime === BUILT_IN_ASSET_DRAG_MIME_TYPE ? payload : '' };
}

test('十种可选箭头均在可拖拽内置库，其他旧特效保持隐藏', () => {
  const items = createPoiEffectLibraryItems();
  for (const effectKind of ['conveyor-direction', 'moving-double-arrow', 'pipeline-flow-arrows', 'flow-arrows', 'conveyor-arrow-single', 'conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-ribbon', 'conveyor-arrow-double', 'conveyor-arrow-speed']) {
    assert.equal(items.filter(item => item.builtIn?.kind === 'poi-effect' && item.builtIn.effectKind === effectKind).length, 1);
  }
  for (const effectKind of ['radar-scan', 'locator-beam', 'fire', 'smoke', 'pipeline-flow-particles']) {
    assert.equal(items.some(item => item.builtIn?.effectKind === effectKind), false);
  }
});

test('样式槽接受十种内置箭头，拒绝其他特效、模型、无效载荷和外部文件', () => {
  for (const effectKind of ['conveyor-direction', 'moving-double-arrow', 'pipeline-flow-arrows', 'flow-arrows', 'conveyor-arrow-single', 'conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-ribbon', 'conveyor-arrow-double', 'conveyor-arrow-speed']) {
    assert.equal(readConveyorSurfaceArrowStyleDrop(transfer(encodeBuiltInAssetDragPayload({ kind: 'poi-effect', effectKind }))), effectKind);
  }
  for (const payload of ['bad json', '', 'null', '{}',
    JSON.stringify({ kind: 'poi-effect', effectKind: 'radar-scan' }),
    JSON.stringify({ kind: 'poi-effect', effectKind: 'building-outline' }),
    JSON.stringify({ kind: 'mesh', meshKind: 'cube' }),
    JSON.stringify({ kind: 'model', sourceUrl: 'file://model.glb' })]) {
    assert.equal(readConveyorSurfaceArrowStyleDrop(transfer(payload)), null);
  }
  const valid = encodeBuiltInAssetDragPayload({ kind: 'poi-effect', effectKind: 'conveyor-direction' });
  assert.equal(readConveyorSurfaceArrowStyleDrop(transfer(valid, ['text/plain'])), null);
  assert.equal(readConveyorSurfaceArrowStyleDrop(transfer(valid, [BUILT_IN_ASSET_DRAG_MIME_TYPE, 'Files'], 1)), null);
  assert.equal(readConveyorSurfaceArrowStyleDrop(transfer(valid, [BUILT_IN_ASSET_DRAG_MIME_TYPE, 'Files'], 0)), null);
  assert.equal(readConveyorSurfaceArrowStyleDrop(transfer(valid), true), null);
});
