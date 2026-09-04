import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { ClickEventBindingEffect } from '../../src/editor/model/components.ts';

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
after(() => server.close());
const { createViewerModelClickHandler } = await server.ssrLoadModule('/src/player/viewerModelClick.ts') as typeof import('../../src/player/viewerModelClick.ts');

function fixture(effects?: ClickEventBindingEffect[], cellEvent = false) {
  const sourceUrl = 'editor-asset://local/shelf.glb';
  const scene = {
    entities: {
      model: { id: 'model', components: { modelAsset: { sourceUrl, builtInSlotBindingConfig: { dimensionMapping: { columns: 'columns', layers: 'layers' } } } } },
      locator: { id: 'locator', components: { locator: { builtInBinding: { hostEntityId: 'model' } } } },
      other: { id: 'other', components: { modelAsset: { sourceUrl: 'editor-asset://local/other.glb' } } },
      ...(effects ? { binding: { id: 'binding', components: { clickEventBinding: {
        deviceSlots: [{ deviceType: { sourceUrl } }],
        events: [{ eventType: cellEvent ? 'click-cell' : 'click', effects }],
      } } } } : {}),
    },
  } as unknown as SceneDocument;
  const selections: string[][] = [];
  const highlights: unknown[] = [];
  const focuses: unknown[] = [];
  const events: string[] = [];
  const handler = createViewerModelClickHandler(scene, {
    updateSelection: (ids) => selections.push([...ids]),
    setSlotHighlight: (id, cell) => highlights.push({ id, cell }),
    focusTarget: (id, cell) => focuses.push({ id, cell }),
    triggerManualEvents: (id) => events.push(id),
  });
  return { handler, selections, highlights, focuses, events, scene };
}

test('搜索和鼠标点击共用选中与手动事件，搜索不重复覆盖相机聚焦', () => {
  const f = fixture(['highlight', 'focus']);
  f.handler('model', null, { focus: false });
  assert.deepEqual(f.selections, [['model']]);
  assert.deepEqual(f.events, ['model']);
  assert.deepEqual(f.focuses, []);
  f.handler('model');
  assert.deepEqual(f.focuses, [{ id: 'model', cell: undefined }]);
});

test('内置虚拟货格搜索沿用宿主的点击单元绑定并传递格子坐标', () => {
  const f = fixture(['highlight', 'focus'], true);
  const cell = { locatorEntityId: 'locator', row: 2, column: 3, layer: 4 };
  f.handler('locator', cell, { focus: false });
  assert.deepEqual(f.selections, [[]]);
  assert.deepEqual(f.highlights, [{ id: 'locator', cell: { row: 2, column: 3, layer: 4 } }]);
  assert.deepEqual(f.events, ['model']);
  assert.deepEqual(f.focuses, []);
});

test('无绑定沿用默认点击；接管时未注册目标忽略，空白清除选中', () => {
  const plain = fixture();
  plain.handler('model', null, { focus: false });
  assert.deepEqual(plain.events, ['model']);
  const bound = fixture(['highlight']);
  bound.handler('other');
  assert.deepEqual(bound.events, []);
  assert.deepEqual(bound.selections, []);
  bound.handler(null);
  assert.deepEqual(bound.selections, [[]]);
  assert.deepEqual(bound.highlights, [{ id: '', cell: null }]);
});

test('命中 show-chart 效果时向宿主页面发送点击事件载荷', () => {
  const sourceUrl = 'editor-asset://local/shelf.glb';
  const scene = {
    entities: {
      model: { id: 'model', components: { modelAsset: { sourceUrl, assetCode: '001005', builtInSlotBindingConfig: { dimensionMapping: { columns: 'columns', layers: 'layers' } } } } },
      locator: { id: 'locator', components: { locator: { builtInBinding: { hostEntityId: 'model' } } } },
      binding: { id: 'binding', components: { clickEventBinding: {
        deviceSlots: [{ deviceType: { sourceUrl } }],
        events: [
          { eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-click', projectId: 'project-1', screenId: 'screen-click', name: '点击大屏' } },
          { eventType: 'click-cell', effects: ['show-chart'], chart: { id: 'chart-cell', projectId: 'project-1', screenId: 'screen-cell', name: '单元大屏' } },
        ],
      } } },
    },
  } as unknown as SceneDocument;
  const emitted: unknown[] = [];
  const shownScreens: unknown[] = [];
  const handler = createViewerModelClickHandler(scene, {
    updateSelection: () => {},
    setSlotHighlight: () => {},
    focusTarget: () => {},
    triggerManualEvents: () => {},
    emitAssetClicked: (payload) => emitted.push(payload),
    showScreen: (screen) => shownScreens.push(screen),
  });

  handler('model', null, { focus: false });
  assert.deepEqual(emitted, [{ assetCode: '001005', chartId: 'chart-click' }]);
  assert.deepEqual(shownScreens, [{ projectId: 'project-1', screenId: 'screen-click' }]);

  handler('locator', { locatorEntityId: 'locator', row: 2, column: 3, layer: 1 }, { focus: false });
  assert.deepEqual(emitted, [
    { assetCode: '001005', chartId: 'chart-click' },
    { assetCode: '001005', slot: { row: 2, column: 3, layer: 1 }, chartId: 'chart-cell' },
  ]);
  assert.deepEqual(shownScreens, [
    { projectId: 'project-1', screenId: 'screen-click' },
    { projectId: 'project-1', screenId: 'screen-cell' },
  ]);
});

test('效果不含 show-chart 时不发送宿主事件', () => {
  const f = fixture(['highlight']);
  const emitted: unknown[] = [];
  const handler = createViewerModelClickHandler(f.scene, {
    updateSelection: () => {},
    setSlotHighlight: () => {},
    focusTarget: () => {},
    triggerManualEvents: () => {},
    emitAssetClicked: (payload) => emitted.push(payload),
  });
  handler('model');
  assert.deepEqual(emitted, []);
});
