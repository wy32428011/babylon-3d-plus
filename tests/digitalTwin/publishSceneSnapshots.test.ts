import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{ capturePublishSceneSnapshots, validatePreparedPublishScenes, assertPublishSceneInstanceStatePreserved, assertPublishSceneParameterTemplates }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/publishSceneSnapshots'),
]>(['electron/ipc/publishSceneSnapshots.ts']);

const content = (name: string) => JSON.stringify({ version: 5, scene: { name, entities: {}, entityIds: [], sceneSettings: {} } });
test('发布参数使用新版定义：删除旧key和绑定、同key原值跨类型保留、新key补默认', () => {
  const previous: any = { version: 5, scene: { entityIds: ['a'], entities: { a: { id: 'a', components: {
    modelAsset: { sourceUrl: 'old', assetCode: 'A01', parameterConfig: { parameters: [
      { key: 'shared', type: 'number', defaultValue: 1 }, { key: 'removed', type: 'number', defaultValue: 2 },
    ], bindings: [{ target: { name: 'old-node', kind: 'mesh' }, property: 'alpha', value: { param: 'removed' } }] },
    parameterValues: { shared: 9, removed: 8 } }, telemetryBinding: { field: 'speed' },
  } } } } };
  const next = structuredClone(previous);
  const asset = next.scene.entities.a.components.modelAsset;
  asset.parameterConfig = { parameters: [{ key: 'shared', type: 'string', defaultValue: 'new' },
    { key: 'added', type: 'number', defaultValue: 3 }], bindings: [] };
  asset.parameterValues = { shared: 9, added: 3 };
  previous.scene.entities.a.components.modelAsset.lengthUnit = 'millimeter';
  asset.lengthUnit = 'meter';
  previous.scene.entities.a.components.modelAsset.builtInSlotBindingConfig = { enabledParam: 'removed' };
  asset.builtInSlotBindingConfig = { enabledParam: 'added' };
  assert.doesNotThrow(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)));
  asset.parameterValues.shared = 'new';
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /parameterValues.*shared/);
  asset.parameterValues.shared = 9; asset.parameterValues.removed = 8;
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /删除.*removed/);
  delete asset.parameterValues.removed;
  next.scene.entities.a.components.telemetryBinding.field = 'different';
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /telemetryBinding/);
});
test('新增参数必须使用权威新模板默认值，不能由准备结果伪造默认值或省略新key', () => {
  const config = { parameters: [{ key: 'same', type: 'number', defaultValue: 1 },
    { key: 'newTexture', type: 'texture', defaultValue: '  textures\\new.png  ' }] };
  const previous: any = { version: 5, scene: { entities: { a: { components: { modelAsset: {
    sourceUrl: 'old', lengthUnit: 'meter', parameterConfig: { parameters: [{ key: 'same' }] }, parameterValues: { same: 99 },
  } } } } } };
  const next = structuredClone(previous);
  Object.assign(next.scene.entities.a.components.modelAsset, { sourceUrl: 'new',
    parameterConfig: { parameters: [{ key: 'same', type: 'number', defaultValue: 1 },
      { key: 'newTexture', type: 'texture', defaultValue: 'textures/new.png' }] },
    parameterValues: { same: 99, newTexture: 'textures/new.png' } });
  const check = () => assertPublishSceneParameterTemplates(JSON.stringify(previous), JSON.stringify(next), new Map([['new', { parameterConfig: config }]]));
  assert.doesNotThrow(check);
  const historical = structuredClone(previous);
  historical.scene.entities.a.components.modelAsset.parameterValues.newTexture = 'saved.png';
  const historicalNext = structuredClone(next);
  historicalNext.scene.entities.a.components.modelAsset.parameterValues.newTexture = 'saved.png';
  assert.doesNotThrow(() => assertPublishSceneParameterTemplates(JSON.stringify(historical), JSON.stringify(historicalNext),
    new Map([['new', { parameterConfig: config }]])), '旧定义缺失的历史同名显式值仍保留');
  next.scene.entities.a.components.modelAsset.parameterValues.newTexture = 'fake.png';
  next.scene.entities.a.components.modelAsset.parameterConfig.parameters[1].defaultValue = 'fake.png';
  assert.throws(check, /权威.*newTexture/);
  next.scene.entities.a.components.modelAsset.parameterConfig.parameters.pop();
  assert.throws(check, /参数定义.*中台/);
});
test('完整模型新版没有参数配置时删除全部参数值，不能留下孤立旧值', () => {
  const previous: any = { version: 5, scene: { entities: { a: { components: { modelAsset: {
    sourceUrl: 'old', lengthUnit: 'meter', parameterConfig: { parameters: [{ key: 'removed' }] }, parameterValues: { removed: 5 },
  } } } } } };
  const next = structuredClone(previous);
  const asset = next.scene.entities.a.components.modelAsset;
  asset.sourceUrl = 'new'; delete asset.parameterConfig; delete asset.parameterValues;
  const check = () => {
    assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next));
    assertPublishSceneParameterTemplates(JSON.stringify(previous), JSON.stringify(next), new Map([['new', {}]]));
  };
  assert.doesNotThrow(check);
  asset.parameterValues = { removed: 5 };
  assert.throws(check, /已删除/);
});
test('新版参数配置无效时接受已经清理参数的模型，不将参数提示重新升级为发布阻断', () => {
  const previous: any = { version: 5, scene: { entities: { a: { components: { modelAsset: {
    sourceUrl: 'old', lengthUnit: 'meter', parameterConfig: { parameters: [{ key: 'removed' }] }, parameterValues: { removed: 5 },
  } } } } } };
  const next = structuredClone(previous);
  const asset = next.scene.entities.a.components.modelAsset;
  asset.sourceUrl = 'new'; delete asset.parameterConfig; delete asset.parameterValues;
  const invalid = { parameterConfig: { parameters: [{ key: 'broken', type: 'unsupported' }] } };
  const check = () => assertPublishSceneParameterTemplates(JSON.stringify(previous), JSON.stringify(next), new Map([['new', invalid]]));
  assert.doesNotThrow(check);
  asset.parameterValues = { removed: 5 };
  assert.throws(check, /残留旧参数值/);
});
test('主进程拒绝同步结果丢失实体、参数和业务绑定，允许资源版本变化', () => {
  const previous = { version: 5, scene: { entities: { a: { id: 'a', components: {
    modelAsset: { sourceUrl: 'old', sourcePath: 'old', parameterValues: { length: 9 }, assetCode: 'A01' },
    telemetryBinding: { field: 'speed' }, transform: { position: { x: 8 } },
  } } }, entityIds: ['a'] } };
  const next = structuredClone(previous);
  next.scene.entities.a.components.modelAsset.sourceUrl = 'new';
  assert.doesNotThrow(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)));
  next.scene.entities.a.components.modelAsset.parameterValues.length = 10;
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /parameterValues/);
  next.scene.entities.a.components.modelAsset.parameterValues.length = 9;
  next.scene.entities.a.components.telemetryBinding.field = 'other';
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /telemetryBinding/);
  const hidden = structuredClone(previous);
  hidden.scene.entityIds = [];
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(hidden)), /实体/);
});

test('只允许为原点击槽位的缺失设备类型新增真实目标，不允许无关实体', () => {
  const sourceUrl = 'editor-asset://local/' + encodeURIComponent('C:/cache/Model-42-Pump/main.glb');
  const previous = { version: 5, scene: { entities: { click: { id: 'click', components: {
    clickEventBinding: { deviceSlots: [{ deviceType: { sourceUrl, displayName: 'Pump' } }] },
  } } } } };
  const next: any = structuredClone(previous);
  next.scene.entities.recovered = { id: 'recovered', parentId: null, childrenIds: [], components: {
    modelAsset: { sourceUrl }, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  } };
  assert.doesNotThrow(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)));
  next.scene.entities.recovered.components.modelAsset.sourceUrl = sourceUrl.replace('42', '43');
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /未经原点击/);
  delete next.scene.entities.click;
  assert.throws(() => assertPublishSceneInstanceStatePreserved(JSON.stringify(previous), JSON.stringify(next)), /删除/);
});
test('发布准备完整收集场景并使用暂存替换，拒绝遗漏、重复及磁盘变化', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'publish-scenes-'));
  const signal = new AbortController().signal;
  try {
    await mkdir(path.join(root, 'Scenes'));
    const entry = path.join(root, 'Scenes', 'main.scene.json');
    const other = path.join(root, 'Scenes', 'other.scene.json');
    await writeFile(entry, content('entry disk')); await writeFile(other, content('other'));
    const snapshot = await capturePublishSceneSnapshots(root, entry, content('current'), signal);
    assert.equal(snapshot.length, 2);
    assert.equal(JSON.parse(snapshot.find(s => s.isEntry)!.sceneContent).scene.name, 'current');
    const prepared = snapshot.map(s => ({ sceneId: s.sceneId, sceneContent: content('updated ' + s.name) }));
    const overlays = await validatePreparedPublishScenes(snapshot, prepared, root, entry, signal);
    assert.equal(overlays.size, 2);
    assert.equal(await readFile(other, 'utf8'), content('other'));
    await assert.rejects(validatePreparedPublishScenes(snapshot, prepared.slice(1), root, entry, signal), /不完整/);
    await assert.rejects(validatePreparedPublishScenes(snapshot, [prepared[0], prepared[0]], root, entry, signal), /重复|不完整/);
    await writeFile(other, content('edited meanwhile'));
    await assert.rejects(validatePreparedPublishScenes(snapshot, prepared, root, entry, signal), /变化/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
