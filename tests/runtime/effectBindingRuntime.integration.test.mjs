import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { ArcRotateCamera, MeshBuilder, NullEngine, Scene, ShaderMaterial, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    // 与项目隔离编译测试工具一致：资产模块仅返回地址，不在 NullEngine 中加载图片。
    if (url.startsWith(root.href) && /\.(png|jpe?g|webp|gif|svg|glb|gltf)$/i.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (url.startsWith(root.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
      format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { PoiEffectRuntime } = await import('../../src/runtime/babylon/effects/PoiEffectRuntime.ts');
const { createEmptySceneDocument, createModelEntity, createPoiEffectEntity } = await import('../../src/editor/model/SceneDocument.ts');
const { createDefaultEffectConfiguration } = await import('../../src/editor/model/effectConfigurationValidation.ts');
const { createDefaultPoiEffectComponent, sanitizePoiEffectComponent, POI_EFFECT_DEFINITIONS } = await import('../../src/editor/model/poiEffect.ts');
const { getEffectParameterDefinitions } = await import('../../src/editor/model/effectParameterRegistry.ts');
const { deviceTelemetryStore, parseDeviceTelemetryMessage } = await import('../../src/runtime/mqtt/deviceTelemetry.ts');
const { configureEffectDataTransport } = await import('../../src/runtime/effects/EffectDataRuntime.ts');
const { getEffectDiagnostic, selectEffectFollowTarget, resumeEffectFollow } = await import('../../src/runtime/effects/effectDiagnostics.ts');
hooks.deregister();

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const mapping = (field, target) => ({ field, target, scale: 1, offset: 0, values: [] });
const response = fields => ({ success: true, data: { statusCode: 200, responseBody: JSON.stringify(fields) } });

function harness(t) {
  let now = 2000000000000, sequence = 0, running = true;
  t.mock.method(Date, 'now', () => now);
  deviceTelemetryStore.clear(); configureEffectDataTransport(null);
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', -1, 1, 20, new Vector3(1, 2, 3), scene);
  const nodes = new Map();
  const generated = [];
  const runtime = new PoiEffectRuntime(scene, id => nodes.get(id) ?? null, () => running, false, {getRuntimeTargets:()=>generated});
  runtime.now = () => now;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  let document = createEmptySceneDocument('Effect Binding Integration');
  const replace = entity => {
    document = { ...document, entityIds: document.entityIds.includes(entity.id) ? document.entityIds : [...document.entityIds, entity.id], entities: { ...document.entities, [entity.id]: entity } };
    runtime.setDocument(document);
    return entity;
  };
  const model = (id, assetCode, sourceId = 'plant-a', modelPath = 'C:/fixtures/rgv.glb') => {
    const entity = createModelEntity(modelPath, 'asset:///rgv.glb', id);
    entity.id = id;
    entity.components.modelAsset.assetCode = assetCode;
    entity.components.telemetryBinding = { enabled: true, deviceType: 'rgv', assetCode, sourceId };
    const node = new TransformNode(id, scene); nodes.set(id, node);
    const body = MeshBuilder.CreateBox(id + '_body', { width: 4, height: 2, depth: 6 }, scene); body.parent = node; body.position.y = 1;
    replace(entity);
    return { entity, node, body };
  };
  const effect = (kind, configure) => {
    const entity = createPoiEffectEntity(kind); entity.id = 'fx';
    entity.components.poiEffect.configuration = createDefaultEffectConfiguration(entity.components.poiEffect);
    configure?.(entity.components.poiEffect.configuration, entity.components.poiEffect, entity);
    replace(entity); return entity;
  };
  const sync = (entity, visible = true) => { replace(entity); runtime.sync(entity, false, visible, true); };
  const tick = (milliseconds = 300) => { now += milliseconds; scene.onBeforeRenderObservable.notifyObservers(scene); };
  const telemetry = (assetCode, fields, sourceId = 'plant-a') => {
    const snapshot = parseDeviceTelemetryMessage(`dt/factory/logistics/rgv/${assetCode}/twindatadriven/joint`,
      JSON.stringify({ seq: ++sequence, data: Object.entries(fields).map(([p, v]) => ({ e: assetCode, p, v })) }), { sourceId });
    assert.ok(snapshot); deviceTelemetryStore.upsert(snapshot);
  };
  const meshes = (id = 'fx') => runtime.getWorldBoundsMeshes(id).filter(mesh => !mesh.name.endsWith('_poiEffectPickShell'));
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); deviceTelemetryStore.clear(); configureEffectDataTransport(null); });
  return { scene, runtime, camera, nodes, generated, model, effect, sync, tick, telemetry, meshes, replace, get document() { return document; }, setRunning: value => { running = value; } };
}
function entityTarget(configuration, id) { configuration.target.mode = 'entity'; configuration.target.entityId = id; }
function mqtt(configuration, missing = 'pause') { configuration.data.mode = 'inherit'; configuration.data.missing = missing; configuration.data.staleAfterMs = 10000; }
function http(configuration, dataSourceId = '101', assetCode = '000317') {
  configuration.data.mode = 'http'; configuration.data.assetCode = assetCode; configuration.data.http.dataSourceId = dataSourceId;
  configuration.data.http.pollIntervalMs = 500; configuration.data.staleAfterMs = 10000;
  configuration.data.mappings = [mapping('color', 'primaryColor')];
}

test('模型模板 + 数据源 + 字符串资产编号唯一定位实际设备，重号不串源', t => {
  const h = harness(t), a = h.model('a', '000317'), b = h.model('b', '000317', 'plant-b'), c = h.model('c', '000318');
  a.node.position.x = 7; b.node.position.x = 70; c.node.position.x = 700;
  const fx = h.effect('breathing-ring', configuration => {
    Object.assign(configuration.target, { mode: 'model', model: { name: 'RGV', sourcePath: 'C:/fixtures/rgv.glb', sourceUrl: '' }, sourceId: 'plant-a', deviceType: 'rgv', assetCode: '000317' });
  });
  h.sync(fx);
  assert.equal(getEffectDiagnostic('fx').candidates.length, 1); assert.equal(getEffectDiagnostic('fx').candidates[0].id, 'a');
  assert.equal(h.runtime.getGizmoTarget('fx').position.x, 7); assert.equal(fx.components.poiEffect.configuration.target.assetCode, '000317');
});

test('缺失或歧义目标不会任取第一个设备并移动相机', t => {
  const h = harness(t); h.model('a', '000317'); h.model('b', '000318');
  const fx = h.effect('target-follow', configuration => {
    Object.assign(configuration.target, { mode: 'model', model: { name: 'RGV', sourcePath: 'C:/fixtures/rgv.glb', sourceUrl: '' }, sourceId: 'plant-a' });
  });
  const initial = h.camera.target.clone(); h.sync(fx); h.tick(); h.tick();
  assert.equal(getEffectDiagnostic('fx').status, 'ambiguous'); assert.ok(h.camera.target.equalsWithEpsilon(initial));
  const changed = structuredClone(fx); changed.components.poiEffect.configuration.target.assetCode = 'not-present'; h.sync(changed); h.tick();
  assert.equal(getEffectDiagnostic('fx').status, 'missing-target'); assert.ok(h.camera.target.equalsWithEpsilon(initial));
});

test('真实遥测驱动速度、颜色和外部进度，保持几何且不修改场景文档', t => {
  const h = harness(t); h.model('a', '000317');
  const fx = h.effect('path-reveal', configuration => {
    entityTarget(configuration, 'a'); mqtt(configuration); configuration.parameters.progressMode = 'data';
    configuration.data.mappings = [mapping('velocity', 'speed'), mapping('color', 'primaryColor'), mapping('complete', 'visual.progress')];
  });
  h.telemetry('000317', { velocity: 1, color: '#112233', complete: .2 }); h.sync(fx);
  const initialDocument = JSON.stringify(h.document), meshes = h.meshes(), shader = meshes.find(mesh => mesh.material instanceof ShaderMaterial).material;
  h.telemetry('000317', { velocity: 2, color: '#ee9900', complete: .8 }); h.tick(); h.tick(); h.tick();
  assert.deepEqual(h.meshes(), meshes); assert.equal(shader._floats.progress, .8);
  assert.ok(shader._colors3.primary.equalsWithEpsilon({ r: 238 / 255, g: 153 / 255, b: 0 }));
  assert.equal(JSON.stringify(h.document), initialDocument);
  assert.equal(h.runtime.entries.get('fx').resources.spatial.playbackSpeed, 2);
});

test('更换目标资产后 hold 不能沿用上一个设备的投影值', t => {
  const h = harness(t); h.model('a', '000317'); h.model('b', '000318');
  const fx = h.effect('breathing-ring', configuration => { entityTarget(configuration, 'a'); mqtt(configuration, 'hold'); configuration.data.mappings = [mapping('color', 'primaryColor')]; });
  h.telemetry('000317', { color: '#ff0000' }); h.sync(fx);
  const changed = structuredClone(fx); entityTarget(changed.components.poiEffect.configuration, 'b'); h.sync(changed);
  assert.ok(h.meshes().filter(mesh => mesh.material instanceof ShaderMaterial).every(mesh =>
    !mesh.isEnabled() || mesh.material._colors3.primary.toHexString().toLowerCase() !== '#ff0000'));
  assert.equal(getEffectDiagnostic('fx').identity.assetCode, '000318');
});

test('HTTP 数据源切换清除 hold，迟到响应不覆盖新绑定', async t => {
  const h = harness(t), pending = [];
  configureEffectDataTransport({ transport: (request, signal) => new Promise(resolve => pending.push({ request, signal, resolve })) });
  const fx = h.effect('breathing-ring', configuration => { http(configuration); configuration.data.missing = 'hold'; });
  h.sync(fx); assert.equal(pending.length, 1); pending[0].resolve(response({ color: '#ff0000' })); await flush(); h.sync(fx);
  for (let i = 0; i < 4; i++) h.tick();
  assert.equal(pending.length, 2);
  const changed = structuredClone(fx); changed.components.poiEffect.configuration.data.http.dataSourceId = '102'; h.sync(changed);
  assert.equal(pending.length, 3); assert.equal(pending[2].request.dataSourceId, '102');
  assert.ok(h.meshes().filter(mesh => mesh.material instanceof ShaderMaterial).every(mesh =>
    !mesh.isEnabled() || mesh.material._colors3.primary.toHexString().toLowerCase() !== '#ff0000'));
  pending[2].resolve(response({ color: '#00ff00' })); await flush(); h.sync(changed);
  const shader = h.meshes().find(mesh => mesh.material instanceof ShaderMaterial).material;
  assert.equal(shader._colors3.primary.toHexString().toLowerCase(), '#00ff00');
  pending[1].resolve(response({ color: '#0000ff' })); await flush(); h.sync(changed);
  assert.equal(shader._colors3.primary.toHexString().toLowerCase(), '#00ff00');
});

test('隐藏或禁用特效停止发起 HTTP 请求并取消无使用者的在途请求', async t => {
  const h = harness(t), requests = [];
  configureEffectDataTransport({ transport: (request, signal) => new Promise(() => { requests.push({ request, signal }); }) });
  const fx = h.effect('breathing-ring', configuration => http(configuration)); h.sync(fx); assert.equal(requests.length, 1);
  h.sync(fx, false); for (let i = 0; i < 8; i++) h.tick(); await flush();
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
  const disabled = structuredClone(fx); disabled.components.poiEffect.enabled = false; h.sync(disabled, true);
  for (let i = 0; i < 8; i++) h.tick(); await flush(); assert.equal(requests.length, 1);
});

test('中心锚点及局部偏移经过目标父级旋转缩放后转换到正确世界位置', t => {
  const h = harness(t), target = h.model('a', '000317');
  const parent = new TransformNode('parent', h.scene); parent.position.set(3, 5, 7); parent.rotation.y = Math.PI / 2; parent.scaling.set(2, 3, 4);
  target.node.parent = parent; target.node.position.set(2, 0, 1); target.node.rotation.y = .3; target.body.position.set(1, 2, 3);
  const fx = h.effect('breathing-ring', (configuration, component, entity) => {
    entityTarget(configuration, 'a'); configuration.target.anchor = 'center'; configuration.target.offset = { x: 1, y: .5, z: -2 };
    entity.components.transform.position = { x: 4, y: 1, z: -3 }; entity.components.transform.rotation.y = .7; entity.components.transform.scale = { x: 2, y: 2, z: 2 };
  });
  target.body.computeWorldMatrix(true); target.node.computeWorldMatrix(true);
  const expected = target.body.getBoundingInfo().boundingBox.centerWorld.add(Vector3.TransformNormal(new Vector3(1, .5, -2), target.node.getWorldMatrix())).add(new Vector3(4, 1, -3));
  h.sync(fx); assert.ok(h.runtime.getGizmoTarget('fx').position.equalsWithEpsilon(expected, .0001));
  assert.equal(h.runtime.getGizmoTarget('fx').rotation.y, .7); assert.equal(h.runtime.getGizmoTarget('fx').scaling.x, 2);
});

test('定位框完整绑定链保留真实模型几何供自动包围盒计算', t => {
  const h = harness(t), target = h.model('a', '000317'); target.node.position.x = 7;
  const fx = h.effect('cargo-target-frame', configuration => {
    entityTarget(configuration, 'a'); configuration.parameters = { autoBounds: true, padding: .2, cornerRatio: .25 };
  });
  h.sync(fx); h.tick();
  const frame = h.meshes().find(mesh => mesh.metadata.effectRole === 'cargo-frame');
  assert.ok(frame); assert.ok(frame.scaling.equalsWithEpsilon(new Vector3(4.4, 2.4, 6.4)), `实际尺寸 ${frame.scaling}`);
  assert.ok(Math.abs(frame.getAbsolutePosition().x - 7) < .0001);
});

test('定位框切换目标后重新读取新模型包围盒而不保留旧对象缓存', t => {
  const h = harness(t), a = h.model('a', '000317'), b = h.model('b', '000318');
  a.node.position.x = 7; b.node.position.x = 30; b.body.scaling.set(2, 3, 4);
  const fx = h.effect('cargo-target-frame', configuration => { entityTarget(configuration, 'a'); configuration.parameters = { autoBounds: true, padding: .2 }; });
  h.sync(fx); const changed = structuredClone(fx); entityTarget(changed.components.poiEffect.configuration, 'b'); h.sync(changed); h.tick();
  const frame = h.meshes().find(mesh => mesh.metadata.effectRole === 'cargo-frame');
  assert.ok(frame.scaling.equalsWithEpsilon(new Vector3(8.4, 6.4, 24.4)), `切换后尺寸 ${frame.scaling}`);
  frame.computeWorldMatrix(true); assert.ok(Math.abs(frame.getAbsolutePosition().x - 30) < .0001);
});

test('模型未加载或被隐藏时，挂载的空间特效不能在原点或旧位置显示', t => {
  const h = harness(t), target = h.model('a', '000317'); h.nodes.delete('a');
  const fx = h.effect('breathing-ring', configuration => entityTarget(configuration, 'a')); h.sync(fx);
  assert.equal(getEffectDiagnostic('fx').status, 'loading');
  assert.ok(h.meshes().every(mesh => !mesh.isEnabled() || !mesh.isVisible || mesh.visibility === 0), '等待模型期间所有实际视觉必须隐藏');
  h.nodes.set('a', target.node); h.sync(fx); assert.ok(h.meshes().some(mesh => mesh.isEnabled() && mesh.isVisible));
  target.node.setEnabled(false); h.tick();
  assert.ok(h.meshes().every(mesh => !mesh.isEnabled() || !mesh.isVisible || mesh.visibility === 0), '目标隐藏后空间效果也隐藏');
});

test('从设备绑定改为固定点必须释放旧锚点并停止拉回旧设备', t => {
  const h = harness(t), target = h.model('a', '000317'); target.node.position.x = 17;
  const fx = h.effect('breathing-ring', configuration => entityTarget(configuration, 'a')); h.sync(fx);
  const changed = structuredClone(fx); changed.components.poiEffect.configuration.target.mode = 'point'; changed.components.poiEffect.configuration.target.entityId = null;
  changed.components.transform.position = { x: 3, y: 2, z: 1 }; h.sync(changed); h.tick();
  assert.ok(h.runtime.getGizmoTarget('fx').position.equalsWithEpsilon(new Vector3(3, 2, 1)));
  assert.equal(h.scene.transformNodes.some(node => node.name.startsWith('fx::effect-anchor')), false);
});

test('移除 configuration 会释放派生实体/锚点并停止旧 HTTP 数据轮询', async t => {
  const h = harness(t), requests = [];
  h.model('a', '000317'); h.model('b', '000318');
  configureEffectDataTransport({ transport: async request => { requests.push(request); return response({ color: '#ff0000' }); } });
  const fx = h.effect('breathing-ring', configuration => {
    Object.assign(configuration.target, { mode: 'model', model: { name: 'RGV', sourcePath: 'C:/fixtures/rgv.glb', sourceUrl: '' }, sourceId: 'plant-a', selection: 'all' });
    http(configuration); configuration.data.assetCode = '';
  });
  h.sync(fx); await flush(); assert.equal(requests.length, 2); assert.ok(h.runtime.has('fx::effect-target::b'));
  const plain = structuredClone(fx); delete plain.components.poiEffect.configuration; h.sync(plain);
  for (let i = 0; i < 12; i++) { h.tick(); await flush(); }
  assert.equal(h.runtime.has('fx::effect-target::b'), false);
  assert.equal(h.scene.transformNodes.some(node => node.name.includes('::effect-anchor')), false);
  assert.equal(requests.length, 2); assert.equal(getEffectDiagnostic('fx'), undefined);
});

test('删除配置实体释放所有派生对象、锚点、诊断与在途数据请求', async t => {
  const h = harness(t), requests = []; h.model('a', '000317'); h.model('b', '000318');
  configureEffectDataTransport({ transport: (request, signal) => new Promise(() => requests.push({ request, signal })) });
  const fx = h.effect('breathing-ring', configuration => {
    Object.assign(configuration.target, { mode: 'model', model: { name: 'RGV', sourcePath: 'C:/fixtures/rgv.glb', sourceUrl: '' }, selection: 'all' }); http(configuration); configuration.data.assetCode = '';
  });
  h.sync(fx); assert.equal(requests.length, 2); h.runtime.disposeMissing(new Set(['a', 'b']));
  for (let i = 0; i < 8; i++) h.tick(); await flush();
  assert.equal(h.runtime.has('fx'), false); assert.equal(h.runtime.has('fx::effect-target::b'), false);
  assert.equal(h.scene.transformNodes.some(node => node.name.includes('::effect-anchor')), false); assert.equal(getEffectDiagnostic('fx'), undefined);
  assert.ok(requests.every(request => request.signal.aborted));
});

test('46 类特效的已登记配置通过 JSON 保存与组件清洗后不丢字段', () => {
  const kinds = POI_EFFECT_DEFINITIONS.filter(definition => getEffectParameterDefinitions(definition.kind).length).map(definition => definition.kind);
  assert.equal(kinds.length, 46);
  for (const kind of kinds) {
    const component = createDefaultPoiEffectComponent(kind); component.configuration = createDefaultEffectConfiguration(component);
    const configuration = component.configuration;
    Object.assign(configuration.target, { mode: 'model', model: { name: 'RGV', sourcePath: 'C:/fixtures/rgv.glb', sourceUrl: 'asset:///rgv.glb', deviceType: 'RGV', identity: { sourceKey: 'platform-a', kind: 'model', resourceId: '123', modelPath: 'rgv/main.glb' } },
      sourceId: 'plant-a', deviceType: 'rgv', assetCode: '000317', selection: ['target-follow', 'motion-trail'].includes(kind) ? 'single' : 'all', maxTargets: 9, anchor: 'center', nodePath: 'body', offset: { x: 1, y: 2, z: 3 } });
    Object.assign(configuration.data, { mode: 'http', sourceId: 'plant-a', deviceType: 'rgv', assetCode: '000317', expectedIntervalMs: 700, staleAfterMs: 4000, missing: 'hold',
      http: { mode: 'data-source', dataSourceId: '101', namespace: 'factory-a', pollIntervalMs: 750, timeoutMs: 3000 },
      mappings: [mapping('status', 'primaryColor')], dataset: { enabled: true, unitScale: .001, coordinateSpace: 'world', rowsPath: 'data.rows', idPath: 'assetCode', xPath: 'position.x', yPath: 'position.y', zPath: 'position.z', valuePath: 'metric.value', labelPath: 'name' },
      trigger: { enabled: true, field: 'temperature', operator: 'gt', value: '20', debounceMs: 200 } });
    configuration.parameters = Object.fromEntries(getEffectParameterDefinitions(kind).map(definition => [definition.key, structuredClone(definition.default)]));
    const saved = JSON.stringify(component), reopened = sanitizePoiEffectComponent(JSON.parse(saved));
    assert.deepEqual(Object.keys(reopened.configuration.parameters).sort(), Object.keys(configuration.parameters).sort(), kind);
    assert.deepEqual(reopened.configuration.parameters, configuration.parameters, kind);
    assert.deepEqual(reopened.configuration.target, configuration.target, kind);
    assert.deepEqual(reopened.configuration.data, configuration.data, kind);
  }
});

for (const missing of ['hold', 'pause']) {
  test(`world 数据集在线转 stale ${missing} 保留已转换坐标，恢复数据后只转换一次`, t => {
    const h = harness(t); h.model('a', '000317');
    const fx = h.effect('data-bars', (configuration, component, entity) => {
      entityTarget(configuration, 'a'); mqtt(configuration, missing); configuration.data.staleAfterMs = 100;
      configuration.data.dataset = { enabled: true, coordinateSpace: 'world', unitScale: 1, rowsPath: 'rows', idPath: 'id', xPath: 'x', yPath: 'y', zPath: 'z', valuePath: 'value', labelPath: 'name' };
      configuration.parameters.showLabels = false;
      entity.components.transform.position = { x: 10, y: -2, z: 5 };
      entity.components.transform.rotation = { x: 0, y: Math.PI / 2, z: 0 };
      entity.components.transform.scale = { x: 2, y: 3, z: 4 };
    });
    const records = [{ id: 'a', x: 12, y: 2, z: 9, value: 20, name: 'A' }, { id: 'b', x: 5, y: 1, z: -3, value: 40, name: 'B' }];
    h.telemetry('000317', { rows: records }); h.sync(fx);
    const initialDocument = JSON.stringify(h.document), bars = h.meshes().filter(mesh => mesh.metadata.effectRole === 'data-bar');
    const locations = () => bars.map(mesh => { mesh.computeWorldMatrix(true); return mesh.getAbsolutePosition().clone(); });
    const online = locations(); assert.equal(bars.length, 2);
    assert.ok(Math.abs(online[0].x - 12) < .0001); assert.ok(Math.abs(online[0].z - 9) < .0001);
    for (let i = 0; i < 6; i++) h.tick(200);
    assert.equal(getEffectDiagnostic('fx').status, 'stale');
    assert.deepEqual(h.meshes().filter(mesh => mesh.metadata.effectRole === 'data-bar'), bars);
    locations().forEach((position, index) => assert.ok(position.equalsWithEpsilon(online[index], .0001), `stale ${missing} 第 ${index} 根柱位置发生二次转换：${position}`));
    if (missing === 'pause') assert.equal(h.runtime.entries.get('fx').resources.spatial.playbackSpeed, 0);
    h.telemetry('000317', { rows: records.map(record => ({ ...record, x: record.x + 3 })) }); h.sync(fx);
    assert.equal(getEffectDiagnostic('fx').status, 'online');
    assert.ok(Math.abs(locations()[0].x - 15) < .0001);
    assert.equal(JSON.stringify(h.document), initialDocument);
  });

  for (const kind of ['path-reveal', 'dissolve']) {
    test(`${kind} 外部进度在线转 stale ${missing} 保留最终进度模式和画面阶段`, t => {
      const h = harness(t), target = h.model('a', '000317');
      target.body.material = new StandardMaterial('target-material', h.scene);
      const fx = h.effect(kind, (configuration, component) => {
        entityTarget(configuration, 'a'); mqtt(configuration, missing); configuration.data.staleAfterMs = 100;
        configuration.data.mappings = [mapping('completion', 'visual.progress')];
        // 故意保留初始时间模式：由数据绑定层负责把遥测进度变成外部驱动。
        component.visual.duration = 2; component.visual.progress = 0; component.visual.loop = true;
      });
      h.telemetry('000317', { completion: .65 }); h.sync(fx);
      const originalDocument = JSON.stringify(h.document);
      const material = kind === 'dissolve' ? target.body.material : h.meshes().find(mesh => mesh.material instanceof ShaderMaterial).material;
      const phase = () => kind === 'dissolve' ? material.pluginManager.getPlugin('DigitalTwinModelSurface').phase : material._floats.progress;
      assert.equal(phase(), .65);
      for (let i = 0; i < 9; i++) h.tick(200);
      assert.equal(getEffectDiagnostic('fx').status, 'stale'); assert.equal(phase(), .65);
      assert.equal(kind === 'dissolve' ? target.body.material : h.meshes().find(mesh => mesh.material instanceof ShaderMaterial).material, material);
      h.telemetry('000317', { completion: .25 }); h.sync(fx);
      assert.equal(getEffectDiagnostic('fx').status, 'online'); assert.equal(phase(), .25);
      assert.equal(JSON.stringify(h.document), originalDocument);
    });
  }
}

test('节点名称缺失或歧义时给出诊断，完整路径仅绑定指定部件', t => {
  const h = harness(t), target = h.model('a', '000317');
  const left = new TransformNode('left', h.scene), right = new TransformNode('right', h.scene);
  left.parent = target.node; right.parent = target.node;
  const leftMotor = new TransformNode('motor', h.scene), rightMotor = new TransformNode('motor', h.scene);
  leftMotor.id = 'left-motor'; rightMotor.id = 'right-motor'; leftMotor.parent = left; rightMotor.parent = right;
  leftMotor.position.set(2, 3, 4); rightMotor.position.set(20, 30, 40);
  const fx = h.effect('breathing-ring', configuration => { entityTarget(configuration, 'a'); configuration.target.anchor = 'node'; configuration.target.nodePath = 'missing'; });
  h.sync(fx); for (let i = 0; i < 3; i++) h.tick();
  assert.equal(getEffectDiagnostic('fx').status, 'invalid'); assert.match(getEffectDiagnostic('fx').message, /未找到|路径/);
  assert.ok(h.meshes().every(mesh => !mesh.isEnabled()));
  const ambiguous = structuredClone(fx); ambiguous.components.poiEffect.configuration.target.nodePath = 'motor'; h.sync(ambiguous);
  for (let i = 0; i < 3; i++) h.tick();
  assert.equal(getEffectDiagnostic('fx').status, 'invalid'); assert.match(getEffectDiagnostic('fx').message, /不唯一|歧义/);
  const exact = structuredClone(fx); exact.components.poiEffect.configuration.target.nodePath = 'left/motor'; h.sync(exact);
  for (let i = 0; i < 3; i++) h.tick();
  assert.equal(getEffectDiagnostic('fx').status, 'static'); assert.ok(h.runtime.getGizmoTarget('fx').position.equalsWithEpsilon(new Vector3(2, 3, 4)));
});

test('模型特效缺失部件与网格被占用时向统一诊断报告实际状态', t => {
  const h = harness(t); h.model('a', '000317');
  const missing = h.effect('model-outline', configuration => { entityTarget(configuration, 'a'); configuration.target.anchor = 'node'; configuration.target.nodePath = 'not-a-real-node'; });
  h.sync(missing); assert.equal(getEffectDiagnostic('fx').status, 'invalid'); assert.match(getEffectDiagnostic('fx').message, /网格|路径/);
  const first = structuredClone(missing); first.components.poiEffect.configuration.target.anchor = 'origin'; first.components.poiEffect.configuration.target.nodePath = ''; h.sync(first);
  const second = structuredClone(first); second.id = 'fx-second'; h.sync(second);
  assert.equal(getEffectDiagnostic('fx-second').status, 'paused'); assert.match(getEffectDiagnostic('fx-second').message, /占用/);
  const disabled = structuredClone(first); disabled.components.poiEffect.enabled = false; h.sync(disabled);
  for (let i = 0; i < 9; i++) h.tick();
  assert.equal(getEffectDiagnostic('fx-second').status, 'static');
});

const generatedType={name:'运行货物',sourcePath:'C:/generated/box.glb',sourceUrl:'asset:///generated/box.glb'};
function addGenerated(h,id,containerCode,x,state='ready'){
  const node=new TransformNode(id,h.scene);node.position.x=x;h.nodes.set(id,node);
  const body=MeshBuilder.CreateBox(id+'_body',{size:2},h.scene);body.parent=node;
  const descriptor={id,name:id,origin:'generated',model:generatedType,identity:null,containerCode,
    carrierIdentity:{sourceId:'plant-a',deviceType:'rgv',assetCode:'000317'},generatorId:'generator',state,generation:1};
  h.generated.push(descriptor);return {node,descriptor};
}
const frames=h=>{for(let i=0;i<4;i++)h.tick();};
function generatedFollow(h,configure){return h.effect('target-follow',c=>{
  Object.assign(c.target,{mode:'model',model:generatedType,instanceSource:'generated',instanceKey:'containerCode',assetCode:'',deviceType:'',sourceId:''});
  c.parameters.smoothTime=0;c.parameters.maxCatchupSpeed=0;configure?.(c);
});}
test('零编辑实例延迟生成后跟随真实节点，消失与重建保持同一业务锁定及场景不变',t=>{
  const h=harness(t),fx=generatedFollow(h);h.sync(fx);const saved=JSON.stringify(h.document),initial=h.camera.target.clone();
  frames(h);assert.equal(getEffectDiagnostic('fx').status,'missing-target');assert.ok(h.camera.target.equals(initial));
  const a=addGenerated(h,'generated-A','0001',12,'loading');frames(h);
  assert.equal(getEffectDiagnostic('fx').status,'loading');assert.ok(h.camera.target.equals(initial));
  a.descriptor.state='ready';frames(h);assert.equal(h.camera.target.x,12);
  addGenerated(h,'generated-B','0002',50);frames(h);assert.equal(h.camera.target.x,12);
  a.node.dispose();h.nodes.delete('generated-A');h.generated.splice(0,1);frames(h);
  assert.equal(h.camera.target.x,12,'丢失原目标不能跳到其他同类型实例');
  const fresh=addGenerated(h,'generated-A2','0001',20);frames(h);assert.equal(h.camera.target.x,20);
  assert.equal(getEffectDiagnostic('fx').selectedTargetId,'generated-A2');assert.equal(JSON.stringify(h.document),saved);
  h.camera.alpha+=.2;frames(h);const userPose=h.camera.target.clone();fresh.node.position.x=30;frames(h);
  assert.ok(h.camera.target.equals(userPose));assert.equal(getEffectDiagnostic('fx').status,'paused');
  resumeEffectFollow('fx');frames(h);assert.equal(h.camera.target.x,30);
});
test('运行时手动选择和carrier取数保持独立，停止运行清除选择与面板状态',t=>{
  const h=harness(t);addGenerated(h,'A','C01',9);addGenerated(h,'B','C02',25);
  const fx=generatedFollow(h,c=>{c.target.followSelection='manual';c.data.mode='inherit';c.data.inheritFrom='carrier';});
  h.telemetry('000317',{speed:2});h.sync(fx);frames(h);
  assert.equal(getEffectDiagnostic('fx').status,'ambiguous');const saved=JSON.stringify(h.document);
  selectEffectFollowTarget('fx','B');frames(h);assert.equal(h.camera.target.x,25);
  const diagnostic=getEffectDiagnostic('fx');assert.equal(diagnostic.identity.assetCode,'000317');assert.equal(diagnostic.targetIdentity,null);
  assert.equal(diagnostic.carrierIdentity.assetCode,'000317');assert.equal(JSON.stringify(h.document),saved);
  h.setRunning(false);frames(h);assert.equal(getEffectDiagnostic('fx').effectKind,undefined);
  h.setRunning(true);frames(h);assert.equal(getEffectDiagnostic('fx').status,'ambiguous');
});
test('生成前显式完整身份可HTTP取数，跟随仍等待真正模型',async t=>{
  const h=harness(t),requests=[];configureEffectDataTransport({transport:async request=>{requests.push(request);return response({speed:2});}});
  const fx=generatedFollow(h,c=>{c.target.instanceKey='assetCode';c.target.sourceId='plant-a';c.target.deviceType='rgv';c.target.assetCode='000317';c.data.mode='http';c.data.http.dataSourceId='42';});
  const initial=h.camera.target.clone();h.sync(fx);await flush();frames(h);
  assert.equal(requests.length,1);assert.equal(requests[0].assetCode,'000317');assert.equal(getEffectDiagnostic('fx').status,'missing-target');
  assert.equal(getEffectDiagnostic('fx').fields.speed,2);assert.ok(h.camera.target.equals(initial));
});

const derived=id=>'fx::effect-target::'+id;
function multiTarget(c,ids){c.target.mode='entity';c.target.entityId=ids[0]??null;c.target.entityIds=ids;c.target.selection='all';}
test('多个模型独立继承数据，顺序变化和移除不会重建幸存对象，拾取归属同一编辑实体',t=>{
  const h=harness(t);h.model('a','A');h.model('b','B');
  const fx=h.effect('path-reveal',c=>{multiTarget(c,['a','b']);mqtt(c);c.data.mappings=[mapping('velocity','speed'),mapping('color','primaryColor')];});
  h.telemetry('A',{velocity:1,color:'#ff0000'});h.telemetry('B',{velocity:2,color:'#00ff00'});h.sync(fx);frames(h);
  const a=h.meshes(derived('a')),b=h.meshes(derived('b'));assert.ok(a.length&&b.length);
  assert.equal(h.runtime.entries.get(derived('a')).resources.spatial.playbackSpeed,1);assert.equal(h.runtime.entries.get(derived('b')).resources.spatial.playbackSpeed,2);
  assert.ok([...a,...b].every(m=>m.metadata.editorEntityId==='fx'));
  assert.equal(getEffectDiagnostic('fx').targetStates.length,2);assert.equal(getEffectDiagnostic('fx').identity,null);
  const reordered=structuredClone(fx);reordered.components.poiEffect.configuration.target.entityIds=['b','a'];h.sync(reordered);
  assert.deepEqual(h.meshes(derived('a')),a);assert.deepEqual(h.meshes(derived('b')),b);
  const saved=JSON.stringify(h.document);h.telemetry('B',{velocity:3,color:'#0000ff'});frames(h);
  assert.equal(h.runtime.entries.get(derived('a')).resources.spatial.playbackSpeed,1);assert.equal(h.runtime.entries.get(derived('b')).resources.spatial.playbackSpeed,3);assert.equal(JSON.stringify(h.document),saved);
  const removed=structuredClone(fx);multiTarget(removed.components.poiEffect.configuration,['b']);h.sync(removed);
  assert.equal(h.runtime.has(derived('a')),false);assert.ok(a.every(m=>m.isDisposed()));assert.deepEqual(h.meshes(derived('b')),b);
  h.runtime.disposeMissing(new Set());assert.equal(h.runtime.entries.size,0);assert.equal(getEffectDiagnostic('fx'),undefined);
});
test('多模型表面覆盖隔离共享材质，移除一个只恢复对应模型',t=>{
  const h=harness(t),a=h.model('a','A'),b=h.model('b','B'),c=h.model('c','C');
  const original=new StandardMaterial('shared-original',h.scene);for(const model of [a,b,c])model.body.material=original;
  const fx=h.effect('xray',config=>multiTarget(config,['a','b']));h.sync(fx);frames(h);
  assert.notEqual(a.body.material,original);assert.notEqual(b.body.material,original);assert.notEqual(a.body.material,b.body.material);assert.equal(c.body.material,original);
  const kept=b.body.material,removed=structuredClone(fx);multiTarget(removed.components.poiEffect.configuration,['b']);h.sync(removed);frames(h);
  assert.equal(a.body.material,original);assert.equal(b.body.material,kept);assert.equal(c.body.material,original);
  h.runtime.disposeMissing(new Set());assert.equal(b.body.material,original);assert.equal(original.isDisposed?.()??false,false);
});
test('同类型全部匹配包含延迟生成实例，各目标独立轨迹并清理，加载中不阻塞其他模型',t=>{
  const h=harness(t),a=h.model('a','A','plant-a','C:/generated/box.glb');a.entity.components.modelAsset.sourceUrl=generatedType.sourceUrl;h.replace(a.entity);
  const fx=h.effect('motion-trail',c=>{c.target.mode='model';c.target.model=generatedType;c.target.selection='all';});h.sync(fx);frames(h);
  const original=h.runtime.entries.get(derived('a')).resources.spatial;
  const generated=addGenerated(h,'generated','0001',20,'loading');frames(h);assert.equal(h.runtime.has(derived('generated')),false);assert.equal(h.runtime.entries.get(derived('a')).resources.spatial,original);
  generated.descriptor.state='ready';frames(h);assert.ok(h.runtime.has(derived('generated')));assert.notEqual(h.runtime.entries.get(derived('generated')).resources.spatial,original);
  h.generated.splice(0);generated.node.dispose();frames(h);assert.equal(h.runtime.has(derived('generated')),false);assert.equal(h.runtime.entries.get(derived('a')).resources.spatial,original);
});
test('共享薄实例不被表面特效整批误改，独立生成模型仍可正常应用',t=>{
  const h=harness(t);const a=addGenerated(h,'thin','C1',5),b=addGenerated(h,'normal','C2',10);a.descriptor.modelEffectsSupported=false;
  const fx=h.effect('xray',c=>{c.target.mode='model';c.target.model=generatedType;c.target.selection='all';});h.sync(fx);frames(h);
  const states=getEffectDiagnostic('fx').targetStates;assert.equal(states.find(s=>s.id==='thin').status,'invalid');assert.match(states.find(s=>s.id==='thin').message,/薄实例/);
  assert.notEqual(states.find(s=>s.id==='normal').status,'invalid');
});

test('切换为场景雾时旧多目标配置不会创建多个全局效果',t=>{
 const h=harness(t);h.model('a','A');h.model('b','B');
 const fx=h.effect('environment-fog',c=>multiTarget(c,['a','b']));h.sync(fx);frames(h);
 assert.equal(h.runtime.entries.size,1);assert.ok(h.runtime.has('fx'));
});

test('多目标部件锚点失败只报告对应对象，正常目标继续运行',t=>{
 const h=harness(t);h.model('a','A');h.model('b','B');
 const fx=h.effect('breathing-ring',c=>{multiTarget(c,['a','b']);c.target.anchor='node';c.target.nodePath='a_body';});h.sync(fx);frames(h);
 const d=getEffectDiagnostic('fx');assert.equal(d.targetStates.find(s=>s.id==='b').status,'invalid');assert.match(d.targetStates.find(s=>s.id==='b').message,/部件/);
 assert.equal(d.targetStates.find(s=>s.id==='a').status,'static');assert.ok(h.meshes(derived('a')).some(m=>m.isEnabled()));
});
