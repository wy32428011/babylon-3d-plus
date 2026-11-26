import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { ClickEventBindingEffect } from '../../src/editor/model/components.ts';
import type { DigitalTwinDeviceContext } from '../../src/player/digitalTwinInteractionProtocol.ts';
import { isDigitalTwinClickPayload } from '../../src/player/digitalTwinInteractionProtocol.ts';

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
  optimizeDeps: { noDiscovery: true },
});
after(() => server.close());
const { createViewerModelClickHandler } = await server.ssrLoadModule('/src/player/viewerModelClick.ts') as typeof import('../../src/player/viewerModelClick.ts');
const { sanitizeClickEventBindingComponent } = await server.ssrLoadModule('/src/editor/model/clickEventBinding.ts') as typeof import('../../src/editor/model/clickEventBinding.ts');

test('跟随移动效果通过场景序列化清洗后仍然保留', () => {
  const component = sanitizeClickEventBindingComponent({
    deviceSlots: [],
    events: [{ id: 'follow-click', eventType: 'click', effects: ['highlight', 'focus', 'follow'] }],
  });
  assert.deepEqual(component.events[0].effects, ['highlight', 'focus', 'follow']);
});

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
  const contexts: (DigitalTwinDeviceContext | null)[] = [];
  const handler = createViewerModelClickHandler(scene, {
    emitDeviceContext: context => contexts.push(context),
    updateSelection: (ids) => selections.push([...ids]),
    setSlotHighlight: (id, cell) => highlights.push({ id, cell }),
    focusTarget: (id, cell) => focuses.push({ id, cell }),
    triggerManualEvents: (id) => events.push(id),
    setHighlightExcludeTrack: (ids) => trackExclusions.push([...ids]),
  });
  return { handler, selections, highlights, focuses, events, trackExclusions, contexts, scene };
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
        entityId: target === 'generated' ? 'host' : 'model',
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
  const follows: unknown[] = [];
  const emitted: unknown[] = [];
  const contexts: (DigitalTwinDeviceContext | null)[] = [];
  const handler = createViewerModelClickHandler(scene, {
    emitDeviceContext: context => contexts.push(context),
    updateSelection: (ids) => selections.push([...ids]),
    setSlotHighlight: () => {},
    focusTarget: (id, cell) => focuses.push({ id, cell }),
    followTarget: (id, cell) => follows.push({ id, cell }),
    triggerManualEvents: () => {},
    setHighlightExcludeTrack: () => {},
    emitAssetClicked: (payload) => emitted.push(payload),
  });
  return { handler, selections, focuses, follows, emitted, contexts, scene };
}

test('AGV 与输送线货箱的跟随效果使用产物运行时 id，且不与聚焦重复执行', () => {
  for (const generatedUnit of [
    {
      bindingEntityId: 'generator', assetCode: 'AGV-77', highlightEntityId: 'spawned:agv-77',
      unitKind: 'spawned-device' as const,
    },
    {
      bindingEntityId: 'generator', assetCode: '001005', highlightEntityId: 'runtime_conveyor_cargo:1',
      unitKind: 'cargo' as const, containerCode: '000317', hostEntityId: 'host',
    },
  ]) {
    const f = generatorFixture([{ eventType: 'click', effects: ['focus', 'follow'] }]);
    f.handler(null, null, { generatedUnit });
    assert.deepEqual(f.focuses, []);
    assert.deepEqual(f.follows, [{ id: generatedUnit.highlightEntityId, cell: undefined }]);
  }
});

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
    entityId: 'host',
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
  assert.deepEqual(f.emitted, [{ assetCode: 'AGV-77', entityId: 'spawned:spawn-1', chartId: 'chart-agv', unit: { kind: 'spawned-device', assetCode: 'AGV-77' } }]);
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


test('无 inspection 的默认点击和仅高亮点击发送类型与参数，空白清空上下文', () => {
  for (const effects of [undefined, ['highlight']] as const) {
    const f = fixture(effects ? [...effects] : undefined);
    const model = f.scene.entities.model.components.modelAsset!;
    Object.assign(model, { assetCode: '001005', deviceType: 'conveyor', parameterValues: {
      length: 0, enabled: false, position: { x: 1, y: 2, z: 3 }, label: '000021',
    } });
    f.handler('model');
    assert.deepEqual(f.contexts, [{ assetCode: '001005', entityId: 'model', deviceType: 'conveyor',
      parameterValues: { length: 0, enabled: false, position: { x: 1, y: 2, z: 3 }, label: '000021' } }]);
    assert.equal(isDigitalTwinClickPayload(f.contexts[0]), true);
    (model.parameterValues!.position as { x: number }).x = 9;
    assert.deepEqual(f.contexts[0]!.parameterValues!.position, { x: 1, y: 2, z: 3 });
    f.handler(null);
    assert.equal(f.contexts.at(-1), null);
  }
});

test('ignore 不覆盖已选择设备；聚焦命令触发的点击仍提供设备上下文', () => {
  const f = fixture(['highlight']);
  f.scene.entities.model.components.modelAsset!.assetCode = '000021';
  f.handler('model', null, { fromFocusCommand: true, focus: false });
  f.handler('other');
  assert.deepEqual(f.contexts, [{ assetCode: '000021', entityId: 'model' }]);
  f.handler(null);
  assert.equal(f.contexts.at(-1), null);
});

test('旧模型不从中文分类、遥测或 inspection 类型猜编码，真实编号保持前导零', () => {
  const f = fixture();
  Object.assign(f.scene.entities.model.components.modelAsset!, {
    assetCode: 'SCENE-01', deviceType: '输送机',
    parameterScriptMetadata: [{ values: { deviceType: { value: '输送机' } } }],
    dataDrivenConfig: { device: { devType: 'conveyor' } },
    inspection: { device: { namespace: 'warehouse-a', deviceType: 'conveyor', deviceNo: '000021' } },
  });
  f.handler('model');
  assert.deepEqual(f.contexts, [{ assetCode: 'SCENE-01', entityId: 'model', namespace: 'warehouse-a', deviceNo: '000021' }]);
});

test('超限或非法参数只标记不可用，基础设备点击仍可通过协议预算', () => {
  const invalidValues: unknown[] = [
    { oversized: 'x'.repeat(16_385) },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['p' + i, i])),
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['p' + i, { x: 0, y: 0, z: 0 }])),
    { nested: { deeper: { value: 1 } } }, { invalid: Infinity },
    JSON.parse('{"__proto__":true}'),
  ];
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; invalidValues.push(cycle);
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { throw new Error('不能执行访问器'); } });
  invalidValues.push(getter);
  for (const parameterValues of invalidValues) {
    const f = fixture();
    Object.assign(f.scene.entities.model.components.modelAsset!, { assetCode: 'ASSET-1', deviceType: 'stacker', parameterValues });
    f.handler('model');
    assert.deepEqual(f.contexts, [{ assetCode: 'ASSET-1', entityId: 'model', deviceType: 'stacker', parametersUnavailable: true }]);
    assert.equal(isDigitalTwinClickPayload(f.contexts[0]), true);
  }
});

test('货箱上下文使用承运设备；动态设备不会继承生成器模板实例身份', () => {
  const f = generatorFixture([{ eventType: 'click', effects: ['highlight'] }]);
  Object.assign(f.scene.entities.host.components.modelAsset!, {
    deviceType: 'conveyor', parameterValues: { length: 6 },
    inspection: { device: { namespace: 'wh', deviceType: 'conveyor', deviceNo: '000021' } },
  });
  f.scene.entities.generator.components.modelAsset = {
    ...f.scene.entities.host.components.modelAsset!, assetCode: 'GENERATOR', deviceType: 'fake_template',
  };
  f.handler(null, null, { generatedUnit: { bindingEntityId: 'generator', assetCode: '999999',
    highlightEntityId: 'cargo:1', unitKind: 'cargo', hostEntityId: 'host' } });
  assert.deepEqual(f.contexts[0], { assetCode: '999999', entityId: 'host', deviceType: 'conveyor',
    namespace: 'wh', deviceNo: '000021', parameterValues: { length: 6 } });
  f.handler(null, null, { generatedUnit: { bindingEntityId: 'generator', assetCode: 'AGV-0002',
    highlightEntityId: 'spawned:2', unitKind: 'spawned-device' } });
  assert.deepEqual(f.contexts[1], { assetCode: 'AGV-0002', entityId: 'spawned:2' });
});


test('中台类型更新后不混用旧 inspection 的另一类设备身份', () => {
  const f = fixture();
  Object.assign(f.scene.entities.model.components.modelAsset!, {
    assetCode: 'SCENE-01', deviceType: 'conveyor',
    inspection: { device: { namespace: 'wh', deviceType: 'stacker', deviceNo: '000021' } },
  });
  f.handler('model');
  assert.deepEqual(f.contexts, [{ assetCode: 'SCENE-01', entityId: 'model', deviceType: 'conveyor' }]);
});
