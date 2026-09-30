import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SCENE_MODEL_ENTRANCE_SETTINGS, normalizeSceneModelEntranceSettings } from '../../src/editor/model/sceneModelEntrance.ts';
import { updateSceneModelEntranceCommand } from '../../src/editor/commands/sceneModelEntranceCommands.ts';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';

test('旧场景入场默认关闭，目标数组独立', () => {
  const first = normalizeSceneModelEntranceSettings(undefined);
  assert.deepEqual(first, DEFAULT_SCENE_MODEL_ENTRANCE_SETTINGS);
  first.targetEntityIds.push('one');
  assert.deepEqual(normalizeSceneModelEntranceSettings(null).targetEntityIds, []);
  assert.deepEqual(DEFAULT_SCENE_MODEL_ENTRANCE_SETTINGS.targetEntityIds, []);
});

test('八种效果与显式零值完整保留', () => {
  for (const effect of ['fade', 'scan', 'dissolve', 'hologram', 'particles', 'assembly', 'radial', 'stagger']) {
    const saved = { ...DEFAULT_SCENE_MODEL_ENTRANCE_SETTINGS, enabled: true, effect,
      delaySeconds: 0, intensity: 0, staggerSeconds: 0, spreadMeters: 0,
      assemblyDistanceMeters: 0, loop: true, loopIntervalSeconds: 0,
      scope: 'selected', targetEntityIds: ['device-1', 'mesh-2'], color: '#AABBCC' };
    assert.deepEqual(normalizeSceneModelEntranceSettings(saved), saved);
  }
});

test('异常数字回退，越界钳制，非法枚举和颜色隔离', () => {
  const settings = normalizeSceneModelEntranceSettings({ enabled: 'true', effect: 'bad',
    durationSeconds: Infinity, delaySeconds: -3, intensity: 99, axis: 'bad', reverse: 'false',
    particleCount: 50.8, particleSize: 99, spreadMeters: -1, assemblyDistanceMeters: 100,
    staggerSeconds: NaN, loopIntervalSeconds: '0', color: 'url(secret)', scope: 'bad',
    targetEntityIds: [' one ', null, 'one', '', 1, 'two'] });
  assert.equal(settings.enabled, false);
  assert.equal(settings.effect, 'scan');
  assert.equal(settings.durationSeconds, 2.5);
  assert.equal(settings.delaySeconds, 0);
  assert.equal(settings.intensity, 5);
  assert.equal(settings.axis, 'y');
  assert.equal(settings.reverse, false);
  assert.equal(settings.particleCount, 51);
  assert.equal(settings.particleSize, 12);
  assert.equal(settings.spreadMeters, 0);
  assert.equal(settings.assemblyDistanceMeters, 30);
  assert.equal(settings.staggerSeconds, 0.15);
  assert.equal(settings.loopIntervalSeconds, 1);
  assert.equal(settings.color, '#00ccff');
  assert.equal(settings.scope, 'all');
  assert.deepEqual(settings.targetEntityIds, ['one', 'two']);
  assert.equal(normalizeSceneModelEntranceSettings({ durationSeconds: -1 }).durationSeconds, 0.2);
  assert.equal(normalizeSceneModelEntranceSettings({ particleCount: 99999 }).particleCount, 5000);
});

test('命令快照独立且撤销仅恢复入场字段，保留后来保存的其他设置', () => {
  const before = normalizeSceneModelEntranceSettings(undefined);
  const after = { ...before, enabled: true, targetEntityIds: ['device'] };
  const command = updateSceneModelEntranceCommand(before, after);
  after.targetEntityIds.push('later');
  const scene = { sceneSettings: { modelEntrance: before, camera: { viewDistance: 2000 }, marker: 'preserve' } } as unknown as SceneDocument;
  const changed = command.execute(scene);
  assert.equal(command.label, '修改模型入场动画');
  assert.deepEqual(changed.sceneSettings.modelEntrance?.targetEntityIds, ['device']);
  const restored = command.undo({ ...changed, sceneSettings: { ...changed.sceneSettings, camera: { ...changed.sceneSettings.camera, viewDistance: 3000 } } });
  assert.deepEqual(restored.sceneSettings.modelEntrance, before);
  assert.equal(restored.sceneSettings.camera.viewDistance, 3000);
  assert.equal((restored.sceneSettings as unknown as { marker: string }).marker, 'preserve');
});
