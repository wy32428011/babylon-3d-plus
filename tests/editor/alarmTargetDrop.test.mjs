import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlarmTestModules } from '../helpers/alarmTestModules.mjs';

const modules = await buildAlarmTestModules();
const alarm = await modules.ssrLoadModule('/src/editor/model/alarmManager.ts');
const { createModelGeneratorTargetFromAsset } = await modules.ssrLoadModule('/src/editor/model/modelGenerator.ts');
const { encodeModelAssetDragPayload, decodeModelAssetDragPayload } = await modules.ssrLoadModule('/src/editor/assets/AssetDatabase.ts');
const sourceKey = 'a'.repeat(64);
const url = value => 'editor-asset://local/' + encodeURIComponent(value);
const libraryPath = 'C:/SharedResources/Assets/Models/Model-42-设备/device.glb';
const libraryAsset = { id: libraryPath, path: libraryPath, sourceUrl: url(libraryPath), name: '设备模型', kind: 'model', libraryKind: 'model', lengthUnit: 'meter', unitScaleToMeters: 1 };

function drop(asset = libraryAsset) {
  const decoded = decodeModelAssetDragPayload(encodeModelAssetDragPayload(asset));
  assert.ok(decoded);
  const model = createModelGeneratorTargetFromAsset(decoded);
  assert.ok(model);
  return alarm.normalizeAlarmManager({ ...alarm.createDefaultAlarmManager(), listenProperty: 'CUSTOM PROPERTY', customProperty: 'normal', customValue: 'true', warehouseAlarm: false,
    targets: [{ ...alarm.resizeAlarmTargets([], 1)[0], model }],
  });
}

function device(id, { source = sourceKey, identity = true, resourceId = '42', kind = 'model', modelPath = 'device.glb' } = {}) {
  const path = `D:/SharedResources/.babylon-editor/scene-model-versions/${source}/${'b'.repeat(64)}/Assets/Models/${kind}-${resourceId}-设备-012345abcdef/${modelPath}`;
  return { id, name: '设备', components: { modelAsset: { sourcePath: path, sourceUrl: url(path), assetCode: id,
    ...(identity ? { dataPlatformModel: { sourceKey: source, kind, resourceId, modelPath } } : {}),
  }, telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'device', staleAfterMs: 1000 } } };
}
const scene = devices => ({ entityIds: devices.map(value => value.id), entities: Object.fromEntries(devices.map(value => [value.id, value])) });

test('普通库拖放未携带sourceKey时仍找到同资源的场景快照实例并触发normal=true', () => {
  const c = drop();
  assert.equal(c.targets[0].model.modelAsset.dataPlatformModel, undefined, '复现真实普通库条目的缺省元数据');
  const doc = scene([device('A'), device('B'), device('other-id', { resourceId: '43' }), device('other-kind', { kind: 'combo' }), device('other-part', { modelPath: 'parts/device.glb' })]);
  assert.deepEqual(alarm.resolveAlarmTargets(doc, c).map(value => value.id), ['A', 'B']);
  for (const target of alarm.resolveAlarmTargets(doc, c)) {
    assert.equal(alarm.resolveAlarmTrigger(c, target, { receivedAt: 1000, fields: { normal: true }, faulted: false }, 1500), 'fire');
  }
});

test('带身份的库条目兼容旧实体，但不跨场景快照来源匹配', () => {
  const c = drop({ ...libraryAsset, dataPlatformSourceKey: sourceKey });
  const doc = scene([device('legacy', { identity: false }), device('foreign', { source: 'c'.repeat(64), identity: false })]);
  assert.deepEqual(alarm.resolveAlarmTargets(doc, c).map(value => value.id), ['legacy']);
});

test('缺少来源的库条目遇到多个来源的相同资源时不扩大监控范围', () => {
  const doc = scene([device('A'), device('foreign', { source: 'c'.repeat(64) })]);
  assert.deepEqual(alarm.resolveAlarmTargets(doc, drop()), []);
  assert.deepEqual(alarm.resolveAlarmTargets(doc, drop({ ...libraryAsset, dataPlatformSourceKey: sourceKey })).map(value => value.id), ['A']);
});

test('多个来源时保留精确路径匹配，显式设备选择可以消除来源歧义', () => {
  const exact = device('exact');
  Object.assign(exact.components.modelAsset, { sourcePath: libraryPath, sourceUrl: url(libraryPath) });
  const doc = scene([exact, device('foreign', { source: 'c'.repeat(64) })]);
  const c = drop();
  assert.deepEqual(alarm.resolveAlarmTargets(doc, c).map(value => value.id), ['exact']);
  c.targets[0].entityId = 'foreign';
  assert.deepEqual(alarm.resolveAlarmTargets(doc, c).map(value => value.id), ['foreign']);
});

test('URL完全相同也不能覆盖已知来源冲突', () => {
  const foreign = device('foreign', { source: 'c'.repeat(64) });
  Object.assign(foreign.components.modelAsset, { sourcePath: libraryPath, sourceUrl: url(libraryPath) });
  const c = drop({ ...libraryAsset, dataPlatformSourceKey: sourceKey });
  assert.deepEqual(alarm.resolveAlarmTargets(scene([foreign]), c), []);
});

test('普通本地同名模型不按文件名匹配，明确实体选择仍可限定单台设备', () => {
  const local = { ...libraryAsset, path: 'C:/local/device.glb', sourceUrl: url('C:/local/device.glb') };
  const doc = scene([device('A'), device('B')]);
  assert.deepEqual(alarm.resolveAlarmTargets(doc, drop(local)), []);
  const c = drop(); c.targets[0].entityId = 'B';
  assert.deepEqual(alarm.resolveAlarmTargets(doc, c).map(value => value.id), ['B']);
});
