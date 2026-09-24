import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Mesh, NullEngine, Scene, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';

const sourceUrl = new URL('../../src/runtime/babylon/effects/AlarmReferenceEffects.ts', import.meta.url);
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sourceUrl.href) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText };
    return next(url, context);
  },
});
let AlarmReferenceEffects, supportsAlarmReferenceEffect;
try { ({ AlarmReferenceEffects, supportsAlarmReferenceEffect } = await import(sourceUrl.href)); }
finally { hooks.deregister(); }

function component(kind, parameters = {}, visual = {}) {
  return { effectKind: kind, enabled: true, primaryColor: '#ff3045', secondaryColor: '#ff991f', intensity: 1, speed: 1, density: 1,
    configuration: { version: 2, parameters },
    visual: { targetEntityId: null, radius: 2.5, height: 1.1, width: 0.14, opacity: 0.8, duration: 2, progress: 1,
      loop: true, axis: 'y', amount: 3, points: [{ x: -6, y: 0, z: 0 }, { x: -3, y: 0, z: 2 }, { x: 2, y: 0, z: 1 }],
      values: [1], labels: [], ...visual } };
}
function setup(t, config) {
  const engine = new NullEngine(), scene = new Scene(engine), root = new TransformNode('root', scene);
  void scene.defaultMaterial;
  const baseline = { materials: scene.materials.length, textures: scene.textures.length };
  const effect = new AlarmReferenceEffects('alarm', scene, root, config);
  t.after(() => { effect.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, root, effect, baseline };
}

test('四种参考图报警类型创建有限可见几何并完整释放', t => {
  for (const kind of ['alarm-icon', 'alarm-zone', 'alarm-label', 'alarm-route']) {
    assert.equal(supportsAlarmReferenceEffect(kind), true);
    const { effect, scene, root, baseline } = setup(t, component(kind));
    assert.ok(effect.meshes.length > 0 && effect.meshes.length <= 132);
    for (const mesh of effect.meshes) {
      assert.equal(mesh.parent, root);
      assert.equal(mesh.isPickable, false);
      assert.ok(mesh.getTotalVertices() <= 12000);
      assert.ok(mesh.getVerticesData(VertexBuffer.PositionKind).every(Number.isFinite));
    }
    effect.tick(.1);
    effect.dispose(); effect.dispose();
    assert.equal(scene.meshes.length, 0);
    assert.equal(scene.materials.length, baseline.materials);
    assert.equal(scene.textures.length, baseline.textures);
    assert.equal(root.isDisposed(), false);
  }
  assert.equal(supportsAlarmReferenceEffect('warning-beacon'), false);
});

test('悬浮告警图标始终朝相机，浮动可暂停且颜色修改保留几何', t => {
  const c = component('alarm-icon', { iconSize: 1.3, floatAmplitude: .2 });
  const { effect } = setup(t, c);
  const icon = effect.meshes.find(m => m.metadata.effectRole === 'alarm-icon');
  assert.equal(icon.billboardMode, Mesh.BILLBOARDMODE_ALL);
  const height = icon.position.y; effect.tick(.1);
  assert.notEqual(icon.position.y, height);
  const paused = icon.position.y; effect.updatePlaybackSpeed(0); effect.tick(.2);
  assert.equal(icon.position.y, paused);
  effect.update({ ...c, primaryColor: '#ff00ff' });
  assert.equal(effect.meshes.find(m => m.metadata.effectRole === 'alarm-icon'), icon);
  assert.equal(icon.material.emissiveColor.toHexString(), '#FF00FF');
});

test('地面警戒圈分段且仅参数改动重建，零透明度、隐藏和重新启用均生效', t => {
  const c = component('alarm-zone', { segments: 18, gapRatio: .3, showWarning: false });
  const { effect, scene } = setup(t, c);
  const first = effect.meshes[0];
  assert.equal(first.metadata.effectRole, 'alarm-zone-primary');
  const y = first.getVerticesData(VertexBuffer.PositionKind).filter((_, i) => i % 3 === 1);
  assert.ok(y.every(v => v === 0));
  effect.update({ ...c, visual: { ...c.visual, opacity: 0 } });
  assert.equal(effect.meshes[0], first);
  assert.ok(effect.materials.every(m => m.alpha === 0));
  effect.setActive(false); assert.ok(effect.meshes.every(m => !m.isEnabled()));
  effect.update({ ...c, configuration: { ...c.configuration, parameters: { segments: 24, showWarning: false } } });
  assert.equal(first.isDisposed(), true);
  assert.ok(effect.meshes.every(m => !m.isEnabled()));
  effect.setActive(true); assert.ok(effect.meshes.every(m => m.isEnabled()));
  assert.equal(scene.meshes.length, effect.meshes.length);
});

test('告警卡片尺寸可调，未配置时间时不制造当前时间', t => {
  const c = component('alarm-label', { cardWidth: 3.2, cardHeight: 1.8, offsetX: 2, title: '堆垛机-01', timeText: '' });
  const { effect } = setup(t, c);
  const card = effect.meshes.find(m => m.metadata.effectRole === 'alarm-label');
  assert.equal(card.billboardMode, Mesh.BILLBOARDMODE_ALL);
  assert.equal(card.scaling.x, 3.2); assert.equal(card.scaling.y, 1.8);
  assert.equal(card.position.x, 2); assert.equal(card.metadata.timeText, '');
  effect.update({ ...c, configuration: { ...c.configuration, parameters: { ...c.configuration.parameters, title: '设备B', timeText: '2026-09-24 13:20:00' } } });
  assert.equal(effect.meshes.find(m => m.metadata.effectRole === 'alarm-label'), card);
  assert.equal(card.metadata.timeText, '2026-09-24 13:20:00');
});

test('报警路径终点归到设备锚点并随模型根移动，箭头朝终点前进', t => {
  const c = component('alarm-route', { arrowSpacing: 1, arrowSize: .3, elevation: .04 }, {
    points: [{ x: -6, y: 0, z: 0 }, { x: -3, y: 0, z: 0 }, { x: 9, y: 0, z: 8 }],
  });
  const { effect, root } = setup(t, c);
  const endpoint = effect.meshes.find(m => m.metadata.effectRole === 'alarm-route-endpoint');
  assert.ok(endpoint.position.equalsWithEpsilon(new Vector3(0, .04, 0)));
  const arrow = effect.meshes.find(m => m.metadata.effectRole === 'alarm-route-arrow');
  const before = arrow.position.x; effect.tick(.1);
  assert.ok(arrow.position.x > before);
  arrow.computeWorldMatrix(true);
  assert.ok(Vector3.TransformNormal(Vector3.Forward(), arrow.getWorldMatrix()).normalize().x > .999);
  root.position.set(10, 3, -4); endpoint.computeWorldMatrix(true);
  assert.ok(endpoint.getAbsolutePosition().equalsWithEpsilon(new Vector3(10, 3.04, -4)));
});

test('异常路径与超密箭头仍限制资源，重复帧不新增资源和帧监听', t => {
  const { effect, scene } = setup(t, component('alarm-route', { arrowSpacing: .00001, arrowSize: 1 }, {
    points: [{ x: NaN, y: 0, z: 0 }, { x: -100000, y: 0, z: 0 }, { x: -100000, y: 0, z: 0 }],
  }));
  assert.ok(effect.meshes.filter(m => m.metadata.effectRole === 'alarm-route-arrow').length <= 128);
  const meshes = [...effect.meshes], materialCount = scene.materials.length, observers = scene.onBeforeRenderObservable.observers.length;
  for (let i = 0; i < 40; i++) effect.tick(.1);
  assert.deepEqual(effect.meshes, meshes); assert.equal(scene.materials.length, materialCount);
  assert.equal(scene.onBeforeRenderObservable.observers.length, observers);
});
