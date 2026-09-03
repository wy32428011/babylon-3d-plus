import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const REGISTERED_URL = 'editor-asset://local/models/stacker.glb';
const OTHER_URL = 'editor-asset://local/models/conveyor.glb';

function createModelEntity(id, sourceUrl) {
  return {
    id,
    name: id,
    components: { modelAsset: { sourceUrl } },
  };
}

function createBindingEntity(id, component) {
  return {
    id,
    name: id,
    components: { clickEventBinding: component },
  };
}

function createScene(...entities) {
  return {
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
  };
}

function createBindingComponent(overrides = {}) {
  return {
    deviceSlots: [{ id: 'slot-1', deviceType: null }],
    events: [{ id: 'event-1', eventType: 'click', effects: ['highlight', 'focus'] }],
    ...overrides,
  };
}

function registeredSlot(sourceUrl) {
  return {
    id: 'slot-1',
    deviceType: {
      id: 'device-1',
      assetId: 'asset-1',
      displayName: '堆垛机',
      sourcePath: 'models/stacker.glb',
      sourceUrl,
    },
  };
}

test('点击事件绑定：接管决策与清理迁移', async (t) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(async () => server.close());

  const {
    buildClickEventAssetClickedPayload,
    createDefaultClickEventBindingComponent,
    resolveClickEventBindingClick,
    sanitizeClickEventBindingComponent,
  } = await server.ssrLoadModule('/src/editor/model/clickEventBinding.ts');

  await t.test('场景无点击事件绑定时 pass-through，走默认点击行为', () => {
    const scene = createScene(createModelEntity('stacker-1', REGISTERED_URL));
    assert.deepEqual(resolveClickEventBindingClick(scene, 'stacker-1'), { kind: 'pass-through' });
    assert.deepEqual(resolveClickEventBindingClick(scene, null), { kind: 'pass-through' });
  });

  await t.test('绑定全部为空槽时不接管', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent()),
    );
    assert.deepEqual(resolveClickEventBindingClick(scene, 'stacker-1'), { kind: 'pass-through' });
  });

  await t.test('接管激活后点空白 → clear', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(REGISTERED_URL)] })),
    );
    assert.deepEqual(resolveClickEventBindingClick(scene, null), { kind: 'clear' });
  });

  await t.test('接管激活后点未注册模型 → ignore，无任何效果', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createModelEntity('conveyor-1', OTHER_URL),
      createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(REGISTERED_URL)] })),
    );
    assert.deepEqual(resolveClickEventBindingClick(scene, 'conveyor-1'), { kind: 'ignore' });
  });

  await t.test('命中注册设备但无 click 事件 → ignore', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events: [],
      })),
    );
    assert.deepEqual(resolveClickEventBindingClick(scene, 'stacker-1'), { kind: 'ignore' });
  });

  await t.test('命中注册设备 → trigger，效果取第一条 click 事件', () => {
    const events = [
      { id: 'event-1', eventType: 'click', effects: ['focus'] },
      { id: 'event-2', eventType: 'click', effects: ['highlight'] },
    ];
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events,
      })),
    );
    assert.deepEqual(resolveClickEventBindingClick(scene, 'stacker-1'), {
      kind: 'trigger',
      entityId: 'stacker-1',
      effects: ['focus'],
    });
  });

  await t.test('同模型包多个实例都命中（按 sourceUrl 匹配）', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createModelEntity('stacker-2', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(REGISTERED_URL)] })),
    );
    const resolution = resolveClickEventBindingClick(scene, 'stacker-2');
    assert.equal(resolution.kind, 'trigger');
    if (resolution.kind === 'trigger') assert.equal(resolution.entityId, 'stacker-2');
  });

  await t.test('默认组件带一条 click + highlight/focus 事件', () => {
    const component = createDefaultClickEventBindingComponent();
    assert.equal(component.deviceSlots.length, 0);
    assert.equal(component.events.length, 1);
    assert.equal(component.events[0].eventType, 'click');
    assert.deepEqual(component.events[0].effects, ['highlight', 'focus']);
  });

  await t.test('旧版单事件格式（顶层 eventType/effects）迁移为 events 数组', () => {
    const legacy = { deviceSlots: [], eventType: 'click', effects: ['focus'] };
    const component = sanitizeClickEventBindingComponent(legacy);
    assert.equal(component.events.length, 1);
    assert.equal(component.events[0].eventType, 'click');
    assert.deepEqual(component.events[0].effects, ['focus']);
    assert.equal('eventType' in component, false);
  });

  await t.test('sanitize 过滤非法事件与效果，保留合法配置', () => {
    const component = sanitizeClickEventBindingComponent({
      deviceSlots: [],
      events: [
        { id: 'ok', eventType: 'click', effects: ['highlight', 'unknown-effect', 'focus', 'highlight'] },
        { eventType: 'not-a-type', effects: 'nope' },
        'garbage',
      ],
    });
    assert.equal(component.events.length, 2);
    assert.equal(component.events[0].id, 'ok');
    assert.deepEqual(component.events[0].effects, ['highlight', 'focus']);
    assert.equal(component.events[1].eventType, 'click');
    assert.deepEqual(component.events[1].effects, []);
  });

  await t.test('sanitize 仅在含 show-chart 效果时保留图表参数', () => {
    const component = sanitizeClickEventBindingComponent({
      deviceSlots: [],
      events: [
        { id: 'with-chart', eventType: 'click', effects: ['show-chart'], chart: { id: ' chart-1 ', name: ' 吞吐大屏 ', thumbnailUrl: 'https://data-platform.example.com/thumb.png' } },
        { id: 'no-effect', eventType: 'click', effects: ['highlight'], chart: { id: 'chart-2', name: '应被丢弃' } },
        { id: 'empty-id', eventType: 'click', effects: ['show-chart'], chart: { id: '  ', name: '空id' } },
        { id: 'bad-thumb', eventType: 'click', effects: ['show-chart'], chart: { id: 'chart-3', name: '非法缩略图', thumbnailUrl: 'file:///C:/fake.png' } },
      ],
    });
    assert.deepEqual(component.events[0].chart, { id: 'chart-1', name: '吞吐大屏', thumbnailUrl: 'https://data-platform.example.com/thumb.png' });
    assert.equal('chart' in component.events[1], false);
    assert.equal('chart' in component.events[2], false);
    assert.deepEqual(component.events[3].chart, { id: 'chart-3', name: '非法缩略图' });
  });

  await t.test('点击决策透传命中事件的图表id', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events: [{ id: 'event-1', eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-9', name: '演示大屏' } }],
      })),
    );
    const resolution = resolveClickEventBindingClick(scene, 'stacker-1');
    assert.equal(resolution.kind, 'trigger');
    if (resolution.kind !== 'trigger') return;
    assert.equal(resolution.chartId, 'chart-9');
  });

  await t.test('show-chart 载荷：资产编号 + 图表id；非 show-chart 或无绑定返回 null', () => {
    const scene = createScene(
      { id: 'stacker-1', name: 'stacker-1', components: { modelAsset: { sourceUrl: REGISTERED_URL, assetCode: '001005' } } },
      createBindingEntity('binding-1', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events: [{ id: 'event-1', eventType: 'click', effects: ['show-chart'], chart: { id: 'chart-9', name: '演示大屏' } }],
      })),
    );
    const trigger = resolveClickEventBindingClick(scene, 'stacker-1');
    assert.deepEqual(buildClickEventAssetClickedPayload(scene, trigger), { assetCode: '001005', chartId: 'chart-9' });
    assert.equal(buildClickEventAssetClickedPayload(scene, { kind: 'clear' }), null);

    const noChartScene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(REGISTERED_URL)] })),
    );
    assert.equal(buildClickEventAssetClickedPayload(noChartScene, resolveClickEventBindingClick(noChartScene, 'stacker-1')), null);
  });
});
