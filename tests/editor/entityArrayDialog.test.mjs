import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

test('组合阵列弹框显示完整实体数量和自动编号，普通阵列保留自定义编号', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'composition-array-dialog-'));
  let server;
  try {
    server = await createServer({ cacheDir: path.join(temporary, 'vite'), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
    const { EntityArrayDialog } = await server.ssrLoadModule('/src/editor/ui/EntityArrayDialog.tsx');
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const props = { value: { copyCount: 3, direction: 'x', spacingMeters: 1, assetNumberRule: '' },
      assetNumberedSourceCount: 0, onChange() {}, onCancel() {}, onConfirm() {} };
    const composition = renderToStaticMarkup(createElement(EntityArrayDialog, { ...props, compositionArray: { createdEntityCount: 21 } }));
    assert.match(composition, /内部成员自动生成新编号/);
    assert.match(composition, /预计新增实体：21/);
    assert.doesNotMatch(composition, /<span>资产编号规则<\/span>/);
    const ordinary = renderToStaticMarkup(createElement(EntityArrayDialog, { ...props, assetNumberedSourceCount: 1 }));
    assert.match(ordinary, /<span>资产编号规则<\/span>/);
    assert.doesNotMatch(ordinary, /预计新增实体/);
    const blocked = renderToStaticMarkup(createElement(EntityArrayDialog, { ...props,
      compositionArray: { createdEntityCount: 10001 }, validationError: '单次新增实体不能超过 10000 个。' }));
    assert.match(blocked, /单次新增实体不能超过 10000 个/);
    assert.match(blocked, /class="primary" disabled/);
    for (const compositionArray of [undefined, { createdEntityCount: 21 }]) {
      const negative = renderToStaticMarkup(createElement(EntityArrayDialog, { ...props,
        value: { ...props.value, spacingMeters: -0.5 }, compositionArray }));
      assert.match(negative, /value="-0.5"/);
      assert.doesNotMatch(negative, /min="0"/);
      assert.doesNotMatch(negative, /class="primary" disabled/);
      assert.doesNotMatch(negative, /hierarchy-array-dialog-error/);
    }
  } finally {
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
