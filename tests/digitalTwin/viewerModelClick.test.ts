import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { ClickEventBindingEffect } from '../../src/editor/model/components.ts';

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
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

test('换层站台不属于点击单元，不触发高亮或库位事件', () => {
  const f = fixture(['highlight', 'focus'], true);
  f.scene.entities.locator.components.locator!.builtInBinding!.kind = 'layerChangePlatform';
  f.handler('locator', { locatorEntityId: 'locator', row: 1, column: -1, layer: 2 });
  assert.deepEqual(f.selections, []);
  assert.deepEqual(f.highlights, []);
  assert.deepEqual(f.events, []);
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

test('模型、货格和生成产物禁用聚焦时保留选中、高亮、手动事件及大屏，恢复后可聚焦', () => {
  const f = fixture(['highlight', 'focus', 'show-chart']);
  f.scene.entities.model.components.modelAsset!.assetCode = '001005';
  const chart = { id: 'chart-click', projectId: 'project-1', screenId: 'screen-click', name: '点击大屏' };
  const binding = f.scene.entities.binding.components.clickEventBinding!;
  binding.events[0].chart = chart;
  binding.events.push({ eventType: 'click-cell', effects: ['highlight', 'focus', 'show-chart'], chart });
  const generated = generatorFixture([{
    eventType: 'click', effects: ['highlight', 'focus', 'show-chart'], chart,
  }]);
  const generatedUnit = {
    bindingEntityId: 'generator', assetCode: '001005', highlightEntityId: 'runtime_conveyor_cargo:1',
    unitKind: 'cargo' as const, containerCode: '000317', hostEntityId: 'host',
  };
  const cell = { row: 2, column: 3, layer: 1 };
  for (const target of ['model', 'cell', 'generated'] as const) {
    const calls: { begin: number; selections: string[][]; highlights: unknown[]; focuses: unknown[];
      events: string[]; emitted: unknown[]; screens: unknown[] } = {
      begin: 0, selections: [], highlights: [], focuses: [], events: [], emitted: [], screens: [],
    };
    const handler = createViewerModelClickHandler(target === 'generated' ? generated.scene : f.scene, {
      beginSelection: () => { calls.begin++; },
      updateSelection: (ids) => calls.selections.push([...ids]),
      setSlotHighlight: (id, cell) => calls.highlights.push({ id, cell }),
      focusTarget: (id, cell) => calls.focuses.push({ id, cell }),
      triggerManualEvents: (id) => calls.events.push(id),
      setHighlightExcludeTrack: () => {},
      emitAssetClicked: (payload) => calls.emitted.push(payload),
      showScreen: (screen) => calls.screens.push(screen),
    });
    // 同一处理器依次禁止、恢复、再次禁止聚焦，其他副作用始终一致。
    for (const focus of [false, true, false]) {
      calls.begin = 0;
      calls.selections.length = calls.highlights.length = calls.focuses.length = 0;
      calls.events.length = calls.emitted.length = calls.screens.length = 0;
      handler(target === 'generated' ? null : target === 'cell' ? 'locator' : 'model',
        target === 'cell' ? { locatorEntityId: 'locator', ...cell } : null,
        { focus, ...(target === 'generated' ? { generatedUnit } : {}) });
      const entityId = target === 'generated' ? generatedUnit.highlightEntityId : 'model';
      assert.equal(calls.begin, 1);
      assert.deepEqual(calls.selections, [target === 'cell' ? [] : [entityId]]);
      assert.deepEqual(calls.highlights, [target === 'cell' ? { id: 'locator', cell } : { id: '', cell: null }]);
      assert.deepEqual(calls.events, [entityId]);
      assert.deepEqual(calls.focuses, focus ? [{
        id: target === 'cell' ? 'locator' : entityId, cell: target === 'cell' ? cell : undefined,
      }] : []);
      assert.deepEqual(calls.emitted, [{
        assetCode: '001005', chartId: 'chart-click',
        ...(target === 'cell' ? { slot: cell } : {}),
        ...(target === 'generated' ? {
          unit: { kind: 'cargo', containerCode: '000317' },
          host: { entityId: 'host', assetCode: '999999' },
        } : {}),
      }]);
      assert.deepEqual(calls.screens, [{ projectId: 'project-1', screenId: 'screen-click' }]);
    }
  }
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

test('生成器产物命中：货箱高亮产物自身，事件载荷说明箱号与承运设备', () => {
  const f = generatorFixture([{
    eventType: 'click',
    effects: ['highlight', 'focus', 'show-chart'],
    chart: { id: 'chart-cargo', name: '货物大屏' },
  }]);
  f.handler(null, null, {
    generatedUnit: {
      bindingEntityId: 'generator',
      assetCode: '001005',
      highlightEntityId: 'runtime_conveyor_cargo:1',
      unitKind: 'cargo',
      containerCode: '000317',
      hostEntityId: 'host',
    },
  });
  assert.deepEqual(f.selections, [['runtime_conveyor_cargo:1']]);
  assert.deepEqual(f.focuses, [{ id: 'runtime_conveyor_cargo:1', cell: undefined }]);
  assert.deepEqual(f.emitted, [{
    assetCode: '001005',
    chartId: 'chart-cargo',
    unit: { kind: 'cargo', containerCode: '000317' },
    host: { entityId: 'host', assetCode: '999999' },
  }]);
});

test('生成器产物命中：动态设备实例上报自身编号并高亮合成实体 id', () => {
  const f = generatorFixture([{ eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-agv', name: 'AGV 大屏' } }]);
  f.handler(null, null, {
    generatedUnit: { bindingEntityId: 'generator', assetCode: 'AGV-77', highlightEntityId: 'spawned:spawn-1', unitKind: 'spawned-device' },
  });
  assert.deepEqual(f.selections, [['spawned:spawn-1']]);
  assert.deepEqual(f.emitted, [{ assetCode: 'AGV-77', chartId: 'chart-agv', unit: { kind: 'spawned-device', assetCode: 'AGV-77' } }]);
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
