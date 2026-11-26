import assert from 'node:assert/strict';
import test from 'node:test';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

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
  const server = await createP4SsrTestModules([
    '/src/editor/model/clickEventBinding.ts',
  ]);
  t.after(async () => server.close());

  const {
    buildClickEventAssetClickedPayload,
    createDefaultClickEventBindingComponent,
    createGeneratorClickEventBindingComponent,
    resolveClickEventBindingClick,
    resolveGeneratedUnitClick,
    sanitizeClickEventBindingComponent,
  } = await server.ssrLoadModule('/src/editor/model/clickEventBinding.ts');

  await t.test('共享库绑定命中工程快照、不同修订与发布路径中的同一模型资源', () => {
    const url = (path) => `editor-asset://local/${encodeURIComponent(path)}`;
    const registered = url('D:/workspace/SharedResources/Assets/Models/Model-2080101858762530818-双立柱堆垛机/stacker.glb');
    const paths = [
      'D:/workspace/Projects/123/Assets/Models/Model-2080101858762530818-双立柱堆垛机/stacker.glb',
      'E:/import/Assets/Models/Model-2080101858762530818-新名称__zsrc-123456/stacker.glb',
      'project/assets/models/Model-2080101858762530818-双立柱堆垛机-abcdef/stacker.glb',
    ];
    for (const path of paths) {
      const scene = createScene(
        createModelEntity('stacker-1', url(path)),
        createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(registered)] })),
      );
      assert.equal(resolveClickEventBindingClick(scene, 'stacker-1').kind, 'trigger', path);
    }
  });

  await t.test('跨目录匹配不能把同名的不同资源或同包不同模型误认成已绑定设备', () => {
    const url = (path) => `editor-asset://local/${encodeURIComponent(path)}`;
    const registered = url('D:/shared/Model-2080101858762530818-堆垛机/stacker.glb');
    for (const path of [
      'D:/project/Model-2080101858762530819-堆垛机/stacker.glb',
      'D:/project/Model-2080101858762530818-堆垛机/other.glb',
      'D:/project/Model-2080101858762530818-堆垛机/sub/stacker.glb',
      'D:/project/local-copy/stacker.glb',
    ]) {
      const scene = createScene(
        createModelEntity('other', url(path)),
        createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(registered)] })),
      );
      assert.equal(resolveClickEventBindingClick(scene, 'other').kind, 'ignore', path);
    }
  });

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

  await t.test('旧发布包缺少 assetId 仍保留设备，但不能绕过资源 URL 校验', () => {
    const device = registeredSlot(REGISTERED_URL).deviceType;
    delete device.assetId;
    const normalizeDevice = (overrides = {}) => sanitizeClickEventBindingComponent({
      ...createBindingComponent(),
      deviceSlots: [{ id: 'slot', deviceType: { ...device, ...overrides } }],
    }).deviceSlots[0].deviceType;
    assert.equal(normalizeDevice().assetId, device.id);
    assert.equal(normalizeDevice().sourceUrl, REGISTERED_URL);
    for (const sourceUrl of ['', 'https://example.com/model.glb', 'file:///C:/model.glb', 'javascript:alert(1)']) {
      assert.equal(normalizeDevice({ sourceUrl }), null);
    }
    assert.equal(normalizeDevice({ sourcePath: '' }), null);
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
        { id: 'with-chart', eventType: 'click', effects: ['show-chart'], chart: { id: ' chart-1 ', projectId: ' project-1 ', screenId: ' screen-1 ', name: ' 吞吐大屏 ', thumbnailUrl: 'https://data-platform.example.com/thumb.png' } },
        { id: 'no-effect', eventType: 'click', effects: ['highlight'], chart: { id: 'chart-2', name: '应被丢弃' } },
        { id: 'empty-id', eventType: 'click', effects: ['show-chart'], chart: { id: '  ', name: '空id' } },
        { id: 'bad-thumb', eventType: 'click', effects: ['show-chart'], chart: { id: 'chart-3', name: '非法缩略图', thumbnailUrl: 'file:///C:/fake.png' } },
        { id: 'legacy-screen', eventType: 'click', effects: ['show-chart'], chart: { id: 'data-platform-screen:project-old:screen-old', name: '旧绑定大屏' } },
      ],
    });
    assert.deepEqual(component.events[0].chart, { id: 'chart-1', projectId: 'project-1', screenId: 'screen-1', name: '吞吐大屏', thumbnailUrl: 'https://data-platform.example.com/thumb.png' });
    assert.equal('chart' in component.events[1], false);
    assert.equal('chart' in component.events[2], false);
    assert.deepEqual(component.events[3].chart, { id: 'chart-3', name: '非法缩略图' });
    assert.deepEqual(component.events[4].chart, {
      id: 'data-platform-screen:project-old:screen-old',
      projectId: 'project-old',
      screenId: 'screen-old',
      name: '旧绑定大屏',
    });
  });

  await t.test('点击决策透传命中事件的图表id和所属大屏', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events: [{ id: 'event-1', eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-9', projectId: 'project-9', screenId: 'screen-9', name: '演示大屏' } }],
      })),
    );
    const resolution = resolveClickEventBindingClick(scene, 'stacker-1');
    assert.equal(resolution.kind, 'trigger');
    if (resolution.kind !== 'trigger') return;
    assert.equal(resolution.chartId, 'chart-9');
    assert.deepEqual(resolution.screen, { projectId: 'project-9', screenId: 'screen-9' });
  });

  await t.test('sanitize 仅在含 highlight 效果且为 true 时保留忽略固定轨道参数', () => {
    const component = sanitizeClickEventBindingComponent({
      deviceSlots: [],
      events: [
        { id: 'with-highlight', eventType: 'click', effects: ['highlight'], highlight: { excludeFixedTrack: true } },
        { id: 'false-flag', eventType: 'click', effects: ['highlight'], highlight: { excludeFixedTrack: false } },
        { id: 'bad-flag', eventType: 'click', effects: ['highlight'], highlight: { excludeFixedTrack: 'yes' } },
        { id: 'no-effect', eventType: 'click', effects: ['focus'], highlight: { excludeFixedTrack: true } },
      ],
    });
    assert.deepEqual(component.events[0].highlight, { excludeFixedTrack: true });
    assert.equal('highlight' in component.events[1], false);
    assert.equal('highlight' in component.events[2], false);
    assert.equal('highlight' in component.events[3], false);
  });

  await t.test('点击决策透传命中事件的忽略固定轨道参数', () => {
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events: [{ id: 'event-1', eventType: 'click', effects: ['highlight'], highlight: { excludeFixedTrack: true } }],
      })),
    );
    const resolution = resolveClickEventBindingClick(scene, 'stacker-1');
    assert.equal(resolution.kind, 'trigger');
    if (resolution.kind !== 'trigger') return;
    assert.equal(resolution.highlightExcludeFixedTrack, true);

    const plainScene = createScene(
      createModelEntity('stacker-2', REGISTERED_URL),
      createBindingEntity('binding-2', createBindingComponent({
        deviceSlots: [registeredSlot(REGISTERED_URL)],
        events: [{ id: 'event-2', eventType: 'click', effects: ['highlight'] }],
      })),
    );
    const plain = resolveClickEventBindingClick(plainScene, 'stacker-2');
    assert.equal(plain.kind, 'trigger');
    if (plain.kind !== 'trigger') return;
    assert.equal('highlightExcludeFixedTrack' in plain, false);
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
    assert.deepEqual(buildClickEventAssetClickedPayload(scene, trigger), { assetCode: '001005', entityId: 'stacker-1', chartId: 'chart-9' });
    assert.equal(buildClickEventAssetClickedPayload(scene, { kind: 'clear' }), null);

    const noChartScene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('binding-1', createBindingComponent({ deviceSlots: [registeredSlot(REGISTERED_URL)] })),
    );
    assert.equal(buildClickEventAssetClickedPayload(noChartScene, resolveClickEventBindingClick(noChartScene, 'stacker-1')), null);
  });

  await t.test('生成器默认绑定不带设备类型也不带事件', () => {
    assert.deepEqual(createGeneratorClickEventBindingComponent(), { deviceSlots: [], events: [] });
    // 生成器绑定不参与「按设备类型全场接管」，只有明确配了事件才会接管产物点击。
    const scene = createScene(
      createModelEntity('stacker-1', REGISTERED_URL),
      createBindingEntity('generator-1', createGeneratorClickEventBindingComponent()),
    );
    assert.deepEqual(resolveClickEventBindingClick(scene, 'stacker-1'), { kind: 'pass-through' });
  });

  await t.test('生成器产物命中：货箱高亮自身并随事件上报承运设备，动态设备报自身编号', () => {
    const generatorScene = createScene(
      { id: 'conveyor-1', name: '宿主输送线', components: { modelAsset: { sourceUrl: OTHER_URL, assetCode: '001005' } } },
      createBindingEntity('generator-1', createBindingComponent({
        deviceSlots: [],
        events: [{ id: 'event-1', eventType: 'click', effects: ['highlight', 'focus'] }],
      })),
    );
    // 货箱没有自己的资产编号：assetCode 上报承运设备编号，高亮/聚焦目标是产物自身合成 id。
    assert.deepEqual(
      resolveGeneratedUnitClick(generatorScene, {
        bindingEntityId: 'generator-1',
        assetCode: '001005',
        highlightEntityId: 'runtime_conveyor_cargo:1',
        unitKind: 'cargo',
        containerCode: '000317',
        hostEntityId: 'conveyor-1',
      }),
      {
        kind: 'trigger',
        entityId: 'runtime_conveyor_cargo:1',
        effects: ['highlight', 'focus'],
        reportAssetCode: '001005',
        generatedUnit: {
          kind: 'cargo',
          containerCode: '000317',
          host: { entityId: 'conveyor-1', assetCode: '001005', name: '宿主输送线' },
        },
      },
    );
    // 动态设备实例自带编号：上报自身，高亮目标是实例合成 id。
    const spawned = resolveGeneratedUnitClick(generatorScene, {
      bindingEntityId: 'generator-1',
      assetCode: 'AGV-77',
      highlightEntityId: 'spawned:spawn-1 AGV-77',
      unitKind: 'spawned-device',
    });
    assert.equal(spawned.kind, 'trigger');
    if (spawned.kind !== 'trigger') return;
    assert.equal(spawned.entityId, 'spawned:spawn-1 AGV-77');
    assert.equal(spawned.reportAssetCode, 'AGV-77');
    assert.deepEqual(spawned.generatedUnit, { kind: 'spawned-device', assetCode: 'AGV-77' });
  });

  await t.test('生成器未配绑定或未配 click 事件时返回 null，点击回落到常规拾取', () => {
    const noComponent = createScene(createModelEntity('stacker-1', REGISTERED_URL));
    assert.equal(resolveGeneratedUnitClick(noComponent, {
      bindingEntityId: 'generator-1', assetCode: '001005', highlightEntityId: 'conveyor-1',
    }), null);

    const noEvent = createScene(createBindingEntity('generator-1', createGeneratorClickEventBindingComponent()));
    assert.equal(resolveGeneratedUnitClick(noEvent, {
      bindingEntityId: 'generator-1', assetCode: '001005', highlightEntityId: 'conveyor-1',
    }), null);

    // click-cell 事件对产物无效，只有 click 才接管。
    const cellOnly = createScene(createBindingEntity('generator-1', createBindingComponent({
      deviceSlots: [],
      events: [{ id: 'event-1', eventType: 'click-cell', effects: ['highlight'] }],
    })));
    assert.equal(resolveGeneratedUnitClick(cellOnly, {
      bindingEntityId: 'generator-1', assetCode: '001005', highlightEntityId: 'conveyor-1',
    }), null);
  });

  await t.test('产物点击透传忽略固定轨道参数与图表参数', () => {
    const scene = createScene(createBindingEntity('generator-1', createBindingComponent({
      deviceSlots: [],
      events: [{
        id: 'event-1',
        eventType: 'click',
        effects: ['highlight', 'show-chart'],
        highlight: { excludeFixedTrack: true },
        chart: { id: 'chart-9', projectId: 'project-9', screenId: 'screen-9', name: '演示大屏' },
      }],
    })));
    const resolution = resolveGeneratedUnitClick(scene, {
      bindingEntityId: 'generator-1', assetCode: '001005', highlightEntityId: 'conveyor-1',
    });
    assert.equal(resolution.kind, 'trigger');
    if (resolution.kind !== 'trigger') return;
    assert.equal(resolution.highlightExcludeFixedTrack, true);
    assert.equal(resolution.chartId, 'chart-9');
    assert.deepEqual(resolution.screen, { projectId: 'project-9', screenId: 'screen-9' });
  });

  await t.test('show-chart 载荷优先使用产物上报编号，并说明产物身份与承运设备', () => {
    // 产物的高亮目标已不是场景实体，载荷里的承运设备信息只能来自拾取上下文透传的 hostEntityId。
    const scene = createScene(
      { id: 'conveyor-1', name: 'conveyor-1', components: { modelAsset: { sourceUrl: OTHER_URL, assetCode: '999999' } } },
      createBindingEntity('generator-1', createBindingComponent({
        deviceSlots: [],
        events: [{ id: 'event-1', eventType: 'click', effects: ['show-chart'], chart: { id: 'chart-9', name: '演示大屏' } }],
      })),
    );
    const resolution = resolveGeneratedUnitClick(scene, {
      bindingEntityId: 'generator-1',
      assetCode: '001005',
      highlightEntityId: 'runtime_conveyor_cargo:1',
      unitKind: 'cargo',
      containerCode: '000317',
      hostEntityId: 'conveyor-1',
    });
    assert.deepEqual(buildClickEventAssetClickedPayload(scene, resolution), {
      assetCode: '001005',
      entityId: 'conveyor-1',
      chartId: 'chart-9',
      unit: { kind: 'cargo', containerCode: '000317' },
      host: { entityId: 'conveyor-1', assetCode: '999999', name: 'conveyor-1' },
    });

    // 动态设备实例的合成 id 不是场景实体，上报编号只能来自 reportAssetCode。
    const spawned = resolveGeneratedUnitClick(scene, {
      bindingEntityId: 'generator-1', assetCode: 'AGV-77', highlightEntityId: 'spawned:spawn-1', unitKind: 'spawned-device',
    });
    assert.deepEqual(buildClickEventAssetClickedPayload(scene, spawned), {
      assetCode: 'AGV-77',
      entityId: 'spawned:spawn-1',
      chartId: 'chart-9',
      unit: { kind: 'spawned-device', assetCode: 'AGV-77' },
    });
  });
});


test('中台设备类型经过拖拽、实体创建、场景往返、刷新与生成器模板保持编码', async t => {
  const modules = [
    '/src/editor/assets/AssetDatabase.ts', '/src/editor/model/SceneDocument.ts',
    '/src/editor/project/SceneSerializer.ts', '/src/editor/model/modelGenerator.ts',
    '/src/editor/store/slices/projectAssetRefresh.ts', '/src/editor/model/clickEventBinding.ts',
  ];
  const server = await createP4SsrTestModules(modules);
  t.after(() => server.close());
  const [assets, documents, serializer, generators, refresh, clicks] = await Promise.all(modules.map(p => server.ssrLoadModule(p)));
  const source = { id: 'asset-1', name: 'conveyor.glb', path: 'models/conveyor.glb',
    sourceUrl: REGISTERED_URL, kind: 'model', libraryKind: 'model', deviceType: 'conveyor', lengthUnit: 'meter' };
  const asset = assets.decodeModelAssetDragPayload(JSON.stringify(source));
  assert.equal(asset.deviceType, 'conveyor');
  const entity = documents.createModelEntity(asset.path, asset.sourceUrl, asset.name,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, asset.deviceType);
  const scene = documents.createEmptySceneDocument();
  scene.entities[entity.id] = entity;
  scene.entityIds.push(entity.id);
  const restored = serializer.deserializeScene(serializer.serializeScene(scene));
  assert.equal(restored.entities[entity.id].components.modelAsset.deviceType, 'conveyor');
  const target = generators.createModelGeneratorTargetFromAsset(asset);
  assert.equal(target.modelAsset.deviceType, 'conveyor');
  assert.equal(generators.sanitizeModelAssetTemplate(target.modelAsset).deviceType, 'conveyor');
  const updated = refresh.createRefreshedModelAsset(entity.components.modelAsset, { ...asset, deviceType: 'stacker' });
  assert.equal(updated.deviceType, 'stacker');
  const removed = refresh.createRefreshedModelAsset(updated, { ...asset, deviceType: undefined });
  assert.equal(removed.deviceType, undefined);
  const payload = clicks.buildClickEventAssetClickedPayload(scene, { kind: 'trigger', entityId: entity.id, effects: ['show-chart'] });
  assert.equal(payload.deviceType, 'conveyor');
  assert.equal(payload.entityId, entity.id);
  delete entity.components.modelAsset.deviceType;
  const legacy = serializer.deserializeScene(serializer.serializeScene(scene));
  assert.equal(legacy.entities[entity.id].components.modelAsset.deviceType, undefined);
  assert.equal(assets.decodeModelAssetDragPayload(JSON.stringify({ ...source, deviceType: '输送机' })).deviceType, undefined);
});

test('组合模型在第二场景解除组合并添加点击事件后，中台与本地模型均可正常触发点击，且清理残留 compositionNodeId', async (t) => {
  const modules = [
    '/src/editor/composition/composition.ts',
    '/src/editor/model/SceneDocument.ts',
    '/src/editor/project/SceneSerializer.ts',
    '/src/editor/store/slices/sceneHierarchyOperations.ts',
    '/src/editor/model/clickEventBinding.ts',
    '/electron/shared/clickEventModelIdentity.ts',
  ];
  const server = await createP4SsrTestModules(modules);
  t.after(() => server.close());
  const [compMod, docMod, serializerMod, hierarchyMod, clickMod, identityMod] = await Promise.all(modules.map((p) => server.ssrLoadModule(p)));

  const sourceKey = 'a'.repeat(64);
  const platformFile = 'D:/workspace/SharedResources/Assets/Models/Model-2080101858762530818-双立柱堆垛机/stacker.glb';
  const localFile = 'D:/workspace/Projects/P1/Assets/Models/LocalConveyor/conveyor.glb';
  const unrelatedFile = 'D:/workspace/Projects/P1/Assets/Models/Unrelated/other.glb';
  const toUrl = (f) => 'editor-asset://local/' + encodeURIComponent(f);

  // 场景一：放置中台模型与本地模型并采集为组合模板，模拟物化为固定包路径（models/0、models/1）并移除 dataPlatformModel
  const scene1 = docMod.createEmptySceneDocument('场景一');
  const m1 = docMod.createModelEntity(platformFile, toUrl(platformFile), '堆垛机');
  m1.components.modelAsset.dataPlatformModel = { sourceKey, kind: 'model', resourceId: '2080101858762530818', modelPath: 'stacker.glb' };
  const m2 = docMod.createModelEntity(localFile, toUrl(localFile), '输送机');
  scene1.entities[m1.id] = m1;
  scene1.entities[m2.id] = m2;
  scene1.entityIds.push(m1.id, m2.id);

  const captured = compMod.captureComposition(scene1, [m1.id, m2.id], '产线组合');
  const packagePath = 'D:/workspace/SharedResources/Assets/Compositions/comp-1/rev-1';
  const contentSha256 = 'b'.repeat(64);
  const materializedDef = structuredClone(captured.definition);
  materializedDef.nodes.forEach((node, index) => {
    const asset = node.components.modelAsset;
    const originModel = identityMod.resolveCompositionOriginModelIdentity(asset);
    const fileName = index === 0 ? 'stacker.glb' : 'conveyor.glb';
    const packedPath = `${packagePath}/models/${index}/${fileName}`;
    delete asset.dataPlatformModel;
    asset.sourcePath = packedPath;
    asset.sourceUrl = toUrl(packedPath);
    asset.sourceSnapshot = {
      contentSha256,
      composition: true,
      compositionResource: { schemaVersion: 1, resourceType: 'ENV_MODEL', libraryId: 'comp-1', revision: 'rev-1', packagePath },
      ...(originModel ? { originModel } : {}),
    };
  });

  // 场景二：放置两份组合实例并解除组合
  const placed1 = compMod.instantiateComposition(materializedDef, { x: 0, y: 0, z: 0 }, {
    libraryId: 'comp-1', revision: 'rev-1', resourceType: 'ENV_MODEL', packagePath, contentSha256,
  });
  const placed2 = compMod.instantiateComposition(materializedDef, { x: 10, y: 0, z: 0 }, {
    libraryId: 'comp-1', revision: 'rev-1', resourceType: 'ENV_MODEL', packagePath, contentSha256,
  });
  let scene2 = docMod.createEmptySceneDocument('场景二');
  for (const e of [placed1.root, ...placed1.entities, placed2.root, ...placed2.entities]) {
    scene2.entities[e.id] = e;
    scene2.entityIds.push(e.id);
  }
  const unrelated = docMod.createModelEntity(unrelatedFile, toUrl(unrelatedFile), '无关设备');
  scene2.entities[unrelated.id] = unrelated;
  scene2.entityIds.push(unrelated.id);

  scene2 = hierarchyMod.ungroupFoldersInScene(scene2, [placed1.root.id, placed2.root.id]);
  for (const id of [...placed1.entities, ...placed2.entities].map((e) => e.id)) {
    assert.equal(scene2.entities[id].parentId, null);
    assert.equal(scene2.entities[id].compositionNodeId, undefined, '解组后必须清理残留 compositionNodeId');
  }
  // 解组后的两份同源组合实例再次选中重新组合不报重复节点错误，且保留 originModel
  const regrouped = compMod.captureComposition(scene2, [placed1.entities[0].id, placed2.entities[0].id], '二次组合');
  assert.deepEqual(
    identityMod.resolveCompositionOriginModelIdentity(regrouped.definition.nodes[0].components.modelAsset),
    materializedDef.nodes[0].components.modelAsset.sourceSnapshot.originModel,
  );

  // 添加来自模型库的点击事件绑定（中台模型 + 本地模型）
  const binding = docMod.createClickEventBindingEntity();
  binding.components.clickEventBinding = {
    deviceSlots: [
      { id: 'slot-1', deviceType: clickMod.createClickEventBindingDeviceTypeFromAsset({
        id: 'asset-platform', name: 'stacker.glb', path: platformFile, sourceUrl: toUrl(platformFile),
        kind: 'model', libraryKind: 'model', dataPlatformSourceKey: sourceKey, dataPlatformResourceId: '2080101858762530818',
      }) },
      { id: 'slot-2', deviceType: clickMod.createClickEventBindingDeviceTypeFromAsset({
        id: 'asset-local', name: 'conveyor.glb', path: localFile, sourceUrl: toUrl(localFile),
        kind: 'model', libraryKind: 'model',
      }) },
    ],
    events: [{ id: 'ev-1', eventType: 'click', effects: ['highlight', 'focus'] }],
  };
  scene2.entities[binding.id] = binding;
  scene2.entityIds.push(binding.id);

  // 保存重载后仍能正常命中
  const reloaded = serializerMod.deserializeScene(serializerMod.serializeScene(scene2));
  assert.equal(clickMod.resolveClickEventBindingClick(reloaded, placed1.entities[0].id).kind, 'trigger', '解组后的中台模型必须触发点击事件');
  assert.equal(clickMod.resolveClickEventBindingClick(reloaded, placed1.entities[1].id).kind, 'trigger', '解组后的本地模型必须触发点击事件');
  assert.equal(clickMod.resolveClickEventBindingClick(reloaded, unrelated.id).kind, 'ignore', '未绑定模型仍保持 ignore');
});
