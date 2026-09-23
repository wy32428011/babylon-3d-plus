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
  const trackExclusions: string[][] = [];
  const handler = createViewerModelClickHandler(scene, {
    updateSelection: (ids) => selections.push([...ids]),
    setSlotHighlight: (id, cell) => highlights.push({ id, cell }),
    focusTarget: (id, cell) => focuses.push({ id, cell }),
    triggerManualEvents: (id) => events.push(id),
    setHighlightExcludeTrack: (ids) => trackExclusions.push([...ids]),
  });
  return { handler, selections, highlights, focuses, events, trackExclusions, scene };
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
    setHighlightExcludeTrack: () => {},
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
    setHighlightExcludeTrack: () => {},
    emitAssetClicked: (payload) => emitted.push(payload),
  });
  handler('model');
  assert.deepEqual(emitted, []);
});

test('highlight 忽略固定轨道参数随点击透传，其余分支清空排除集合', () => {
  const sourceUrl = 'editor-asset://local/stacker.glb';
  const scene = {
    entities: {
      model: { id: 'model', components: { modelAsset: { sourceUrl } } },
      binding: { id: 'binding', components: { clickEventBinding: {
        deviceSlots: [{ deviceType: { sourceUrl } }],
        events: [{ eventType: 'click', effects: ['highlight'], highlight: { excludeFixedTrack: true } }],
      } } },
    },
  } as unknown as SceneDocument;
  const trackExclusions: string[][] = [];
  const handler = createViewerModelClickHandler(scene, {
    updateSelection: () => {},
    setSlotHighlight: () => {},
    focusTarget: () => {},
    triggerManualEvents: () => {},
    setHighlightExcludeTrack: (ids) => trackExclusions.push([...ids]),
  });

  handler('model', null, { focus: false });
  assert.deepEqual(trackExclusions, [['model']]);
  handler(null);
  assert.deepEqual(trackExclusions, [['model'], []]);

  const plain = fixture(['highlight']);
  plain.handler('model', null, { focus: false });
  assert.deepEqual(plain.trackExclusions, [[]]);
});

/** 生成器实体自带的绑定：无设备类型槽位，只按产物命中接管。 */
function generatorFixture(events: unknown[] | null) {
  const scene = {
    entities: {
      host: { id: 'host', components: { modelAsset: { sourceUrl: 'editor-asset://local/conveyor.glb', assetCode: '999999' } } },
      ...(events ? { generator: { id: 'generator', components: {
        modelGenerator: { defaultTarget: null, rules: [] },
        clickEventBinding: { deviceSlots: [], events },
      } } } : {}),
    },
  } as unknown as SceneDocument;
  const selections: string[][] = [];
  const focuses: unknown[] = [];
  const emitted: unknown[] = [];
  const handler = createViewerModelClickHandler(scene, {
    updateSelection: (ids) => selections.push([...ids]),
    setSlotHighlight: () => {},
    focusTarget: (id, cell) => focuses.push({ id, cell }),
    triggerManualEvents: () => {},
    setHighlightExcludeTrack: () => {},
    emitAssetClicked: (payload) => emitted.push(payload),
  });
  return { handler, selections, focuses, emitted, scene };
}

test('生成器产物命中：货箱高亮宿主设备并上报宿主编号，而不是宿主自己的 modelAsset 编号', () => {
  const f = generatorFixture([{
    eventType: 'click',
    effects: ['highlight', 'focus', 'show-chart'],
    chart: { id: 'chart-cargo', name: '货物大屏' },
  }]);
  f.handler(null, null, {
    generatedUnit: { bindingEntityId: 'generator', assetCode: '001005', highlightEntityId: 'host' },
  });
  assert.deepEqual(f.selections, [['host']]);
  assert.deepEqual(f.focuses, [{ id: 'host', cell: undefined }]);
  assert.deepEqual(f.emitted, [{ assetCode: '001005', chartId: 'chart-cargo' }]);
});

test('生成器产物命中：动态设备实例上报自身编号并高亮合成实体 id', () => {
  const f = generatorFixture([{ eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-agv', name: 'AGV 大屏' } }]);
  f.handler(null, null, {
    generatedUnit: { bindingEntityId: 'generator', assetCode: 'AGV-77', highlightEntityId: 'spawned:spawn-1' },
  });
  assert.deepEqual(f.selections, [['spawned:spawn-1']]);
  assert.deepEqual(f.emitted, [{ assetCode: 'AGV-77', chartId: 'chart-agv' }]);
});

test('生成器未配置点击事件时产物命中回落到常规点击', () => {
  // 只配了 click-cell 的生成器绑定不接管产物点击，产物所在位置没有实体时走默认清空选区。
  const f = generatorFixture([{ eventType: 'click-cell', effects: ['highlight'] }]);
  f.handler('host', null, {
    generatedUnit: { bindingEntityId: 'generator', assetCode: '001005', highlightEntityId: 'host' },
  });
  assert.deepEqual(f.selections, [['host']]);
  assert.deepEqual(f.emitted, []);
});

test('生成器实体不存在绑定组件时产物命中回落到默认点击（清空选区）', () => {
  const f = generatorFixture(null);
  f.handler(null, null, {
    generatedUnit: { bindingEntityId: 'generator', assetCode: '001005', highlightEntityId: 'host' },
  });
  assert.deepEqual(f.selections, [[]]);
  assert.deepEqual(f.emitted, []);
});
