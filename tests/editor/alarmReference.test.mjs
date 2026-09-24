import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAlarmTestModules } from '../helpers/alarmTestModules.mjs';

const modules = await buildAlarmTestModules(true);
const { ALARM_APPEARANCE_PRESETS, createAlarmAppearancePreset } = await modules.ssrLoadModule('/src/editor/model/alarmAppearancePresets.ts');
const { createAlarmManagerEntity, normalizeAlarmManager, resolveAlarmTrigger } = await modules.ssrLoadModule('/src/editor/model/alarmManager.ts');
const { createEmptySceneDocument } = await modules.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { serializeScene, deserializeScene } = await modules.ssrLoadModule('/src/editor/project/SceneSerializer.ts');

test('参考图十二项具有独立外观类型，局部报警效果保留设备原外观', () => {
  assert.equal(ALARM_APPEARANCE_PRESETS.length, 12);
  assert.equal(new Set(ALARM_APPEARANCE_PRESETS.map(preset => preset.id)).size, 12);
  assert.deepEqual(ALARM_APPEARANCE_PRESETS.map(preset => preset.effectKind), ['model-color', 'model-flash', 'breathing-ring', 'model-outline', 'warning-beacon', 'alarm-icon', 'light-pillar', 'ripple-ring', 'alarm-zone', 'alarm-label', 'smoke-plume', 'alarm-route']);
  assert.ok(ALARM_APPEARANCE_PRESETS.slice(2).every(preset => !preset.tintModel));
  assert.throws(() => createAlarmAppearancePreset('not-an-alarm-preset'), /未知报警外观样式/);
});

test('十二项外观的颜色、视觉与专用参数随场景保存重开，报警条件仍由管理器控制', () => {
  const scene = createEmptySceneDocument('十二项报警参考图');
  const expected = new Map();
  for (const preset of ALARM_APPEARANCE_PRESETS) {
    const entity = createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
    const effect = createAlarmAppearancePreset(preset.id);
    effect.primaryColor = '#ff9900';
    entity.components.alarmManager = normalizeAlarmManager({ ...entity.components.alarmManager, listenProperty: 'CUSTOM PROPERTY', customProperty: 'normal', customValue: 'true', warehouseAlarm: false, overrideColorEnabled: preset.tintModel, appearanceEffect: effect });
    scene.entityIds.push(entity.id); scene.entities[entity.id] = entity;
    expected.set(entity.id, entity.components.alarmManager);
  }
  const reopened = deserializeScene(serializeScene(scene));
  const target = { id: 'device-A', components: { modelAsset: { assetCode: 'A' }, telemetryBinding: { enabled: true, deviceType: 'device', staleAfterMs: 500 } } };
  for (const [id, config] of expected) {
    const restored = reopened.entities[id].components.alarmManager;
    assert.deepEqual(restored, config);
    assert.equal(restored.appearanceEffect.primaryColor, '#ff9900');
    assert.equal(resolveAlarmTrigger(restored, target, { receivedAt: 1000, fields: { normal: true }, faulted: false }, 86400000), 'fire');
    assert.equal(resolveAlarmTrigger(restored, target, { receivedAt: 1000, fields: { normal: false }, faulted: false }, 86400000), null);
  }
});

test('预设实例互不共享参数，旧报警场景缺少颜色开关时仍保留原有覆盖行为', () => {
  const first = createAlarmAppearancePreset('beacon'), second = createAlarmAppearancePreset('beacon');
  first.configuration.parameters.domeRadius = 2;
  assert.equal(second.configuration.parameters.domeRadius, .22);
  first.primaryColor = '#00ff00';
  assert.notEqual(first.primaryColor, second.primaryColor);
  const legacy = createAlarmManagerEntity({ x: 0, y: 0, z: 0 }).components.alarmManager;
  delete legacy.overrideColorEnabled;
  assert.equal(normalizeAlarmManager(legacy).overrideColorEnabled, true);
});
