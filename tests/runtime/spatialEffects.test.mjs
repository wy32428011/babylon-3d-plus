import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MeshBuilder, NullEngine, Scene, ShaderMaterial, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import ts from 'typescript';

const sourceUrl = new URL('../../src/runtime/babylon/effects/SpatialEffects.ts', import.meta.url);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === sourceUrl.href) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});
let SpatialEffects;
let supportsSpatialEffect;
try { ({ SpatialEffects, supportsSpatialEffect } = await import(sourceUrl.href)); }
finally { hooks.deregister(); }

const kinds = ['boundary-flow', 'area-fill', 'ripple-ring', 'breathing-ring', 'radar-sector', 'light-pillar',
  'energy-dome', 'flow-path', 'flow-arrows', 'fly-line', 'motion-trail', 'path-reveal', 'pipe-flow',
  'heatmap', 'region-level', 'data-bars', 'camera-frustum', 'rain', 'snow', 'water-surface', 'flame', 'smoke-plume'];

function config(kind, overrides = {}) {
  return {
    enabled: true, effectKind: kind, primaryColor: '#22dfff', secondaryColor: '#ff6633', intensity: 1,
    speed: 1, density: 1, ...overrides,
    visual: { targetEntityId: null, radius: 5, height: 4, width: 0.3, opacity: 0.75, duration: 4,
      progress: 0.5, loop: true, axis: 'y', amount: 12,
      points: [{ x: -4, y: 0, z: -3 }, { x: 3, y: 0, z: -3 }, { x: 3, y: 0, z: 3 }],
      values: [10, 50, 100], labels: ['A 区', 'B 区', 'C 区'], ...overrides.visual },
  };
}

function harness(t) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // Babylon 在首次上传自定义几何时惰性创建场景共享默认材质，不属于特效私有资源。
  void scene.defaultMaterial;
  const root = new TransformNode('effect-root', scene);
  const resources = [];
  t.after(() => { for (const effect of resources) effect.dispose(); root.dispose(); scene.dispose(); engine.dispose(); });
  return { engine, scene, root, create(kind, overrides, resolve) {
    const effect = new SpatialEffects(kind, scene, root, config(kind, overrides), resolve);
    resources.push(effect);
    return effect;
  } };
}

test('新版空间效果名单完整，旧类型继续交给兼容运行时', () => {
  for (const kind of kinds) assert.equal(supportsSpatialEffect(kind), true, kind);
  for (const kind of ['radar-scan', 'fire', 'locator-beam', 'smoke', 'moving-double-arrow', 'unknown']) {
    assert.equal(supportsSpatialEffect(kind), false, kind);
  }
});

test('所有空间效果产生有限几何并完整释放，始终不注册独立帧监听', t => {
  const { scene, root, create } = harness(t);
  const observerCount = scene.onBeforeRenderObservable.observers.length;
  const baselineMaterials = scene.materials.length;
  for (const kind of kinds) {
    const effect = create(kind);
    assert.ok(effect.meshes.length > 0 && effect.meshes.length <= 180, `${kind} meshes`);
    for (const mesh of effect.meshes) {
      assert.equal(mesh.parent, root, `${kind} parent`);
      assert.equal(mesh.isPickable, false);
      assert.ok(mesh.getTotalVertices() > 0 && mesh.getTotalVertices() <= 12000, `${kind} vertex budget`);
      assert.ok(mesh.getVerticesData(VertexBuffer.PositionKind).every(Number.isFinite), `${kind} finite`);
    }
    effect.tick(0.1);
    assert.equal(scene.onBeforeRenderObservable.observers.length, observerCount);
    effect.dispose();
    effect.dispose();
    assert.equal(scene.meshes.length, 0, `${kind} mesh cleanup`);
    assert.equal(scene.materials.length, baselineMaterials, `${kind} material cleanup`);
    assert.equal(scene.textures.length, 0, `${kind} texture cleanup`);
    assert.equal(root.isDisposed(), false);
  }
});

test('箭头沿配置折线移动，飞线遵循端点与可配拱高', t => {
  const { create } = harness(t);
  const path = [{ x: 2, y: 1, z: 1 }, { x: 12, y: 1, z: 1 }, { x: 12, y: 1, z: 11 }];
  const arrows = create('flow-arrows', { visual: { points: path, amount: 4 } });
  const moving = arrows.meshes.filter(mesh => mesh.metadata?.effectRole === 'moving-arrow');
  assert.equal(moving.length, 4);
  for (const mesh of moving) assert.ok(Math.abs(mesh.position.z - 1) < 0.001 || Math.abs(mesh.position.x - 12) < 0.001);
  const before = moving.map(mesh => mesh.position.clone());
  arrows.tick(0.25);
  assert.ok(moving.some((mesh, index) => !mesh.position.equals(before[index])));
  const flying = create('fly-line', { visual: { points: [path[0], path[2]], height: 8 } });
  const arc = flying.meshes.find(mesh => mesh.metadata?.effectRole === 'fly-arc');
  const positions = arc.getVerticesData(VertexBuffer.PositionKind);
  const ys = positions.filter((_, index) => index % 3 === 1);
  assert.ok(Math.max(...ys) >= 8.9, '拱顶应达到起点高度 + 配置高度');
  assert.ok(Math.max(...ys) < 9.5, '不能按半径或固定高度替代配置拱高');
});

test('暂停、零速、非循环终点保持当前几何与着色器相位', t => {
  const { create } = harness(t);
  const effect = create('radar-sector');
  effect.tick(0.2);
  const shader = effect.materials.find(value => value instanceof ShaderMaterial);
  const phase = shader._floats.time;
  assert.ok(phase > 0);
  effect.setActive(false);
  effect.tick(1);
  assert.equal(shader._floats.time, phase);
  effect.setActive(true);
  effect.tick(0.1);
  assert.ok(shader._floats.time > phase);
  const stopped = create('rain', { speed: 0 });
  const rainMaterial = stopped.materials.find(value => value instanceof ShaderMaterial);
  stopped.tick(1);
  assert.equal(rainMaterial._floats.time, 0);
  const once = create('flow-arrows', { visual: { duration: 0.1, loop: false } });
  once.tick(0.1);
  const endPositions = once.meshes.map(mesh => mesh.position.asArray());
  once.tick(1);
  assert.deepEqual(once.meshes.map(mesh => mesh.position.asArray()), endPositions);
});

test('同一实例原位调速暂停并恢复，保留资源与当前相位', t => {
  const { create } = harness(t);
  const effect = create('flow-arrows');
  effect.tick(0.2);
  const meshes = [...effect.meshes], materials = [...effect.materials];
  const shader = effect.materials.find(value => value instanceof ShaderMaterial);
  const phase = shader._floats.time;
  const positions = meshes.map(mesh => mesh.position.asArray());
  effect.updatePlaybackSpeed(0);
  effect.tick(0.25);
  assert.equal(shader._floats.time, phase);
  assert.deepEqual(meshes.map(mesh => mesh.position.asArray()), positions);
  effect.updatePlaybackSpeed(2);
  effect.tick(0.1);
  assert.ok(Math.abs(shader._floats.time - phase - 0.05) < 0.000001);
  assert.deepEqual(effect.meshes, meshes);
  assert.deepEqual(effect.materials, materials);
  const resumedPhase = shader._floats.time;
  effect.updatePlaybackSpeed(Number.NaN);
  effect.tick(0.1);
  assert.equal(shader._floats.time, resumedPhase);
});

test('真实运动拖尾使用目标世界坐标转换到特效局部，历史长度有界', t => {
  const { scene, root, create } = harness(t);
  root.position.set(100, 0, 0);
  const target = MeshBuilder.CreateBox('vehicle', {}, scene);
  const trail = create('motion-trail', { visual: { targetEntityId: 'vehicle', amount: 8 } }, id => id === 'vehicle' ? target : null);
  target.position.set(103, 2, 5);
  trail.tick(0.1);
  target.position.set(104, 2, 6);
  trail.tick(0.1);
  const mesh = trail.meshes.find(mesh => mesh.metadata?.effectRole === 'motion-history');
  assert.equal(mesh.metadata.trailMode, 'target');
  for (let index = 0; index < 200; index += 1) { target.position.x += 0.1; trail.tick(0.03); }
  const points = mesh.getVerticesData(VertexBuffer.PositionKind);
  assert.ok(points.length <= 128 * 2 * 3);
  assert.ok(Math.max(...points.filter((_, index) => index % 3 === 0)) < 30, '不应混入目标绝对坐标');
  const demo = create('motion-trail');
  assert.equal(demo.meshes.find(mesh => mesh.metadata?.effectRole === 'motion-history').metadata.trailMode, 'path-demo');
});

test('热力图使用空间采样点与数值，数据柱高度和标签由输入驱动', t => {
  const { create } = harness(t);
  const heat = create('heatmap', { visual: { values: [0, 100, 0] } });
  const heatMesh = heat.meshes.find(mesh => mesh.metadata?.effectRole === 'heat-field');
  const colors = heatMesh.getVerticesData(VertexBuffer.ColorKind);
  assert.ok(colors.length > 100);
  assert.ok(new Set(colors.map(value => Math.round(value * 100))).size > 20, '热区应插值渐变');
  const bars = create('data-bars', { visual: { values: [20, 100], labels: ['入库', '出库'], height: 10 } });
  const dataBars = bars.meshes.filter(mesh => mesh.metadata?.effectRole === 'data-bar');
  assert.equal(dataBars.length, 2);
  assert.deepEqual(dataBars.map(mesh => mesh.metadata.value), [20, 100]);
  assert.deepEqual(dataBars.map(mesh => mesh.metadata.label), ['入库', '出库']);
  const heights = dataBars.map(mesh => mesh.getBoundingInfo().boundingBox.extendSize.y * 2);
  assert.ok(Math.abs(heights[0] - 2) < 0.01 && Math.abs(heights[1] - 10) < 0.01);
});

test('雨雪与烟火的单网格粒子有界且不启动不受控粒子系统', t => {
  const { scene, create } = harness(t);
  for (const kind of ['rain', 'snow', 'flame', 'smoke-plume']) {
    const effect = create(kind, { density: 200, visual: { amount: 100000 } });
    const particles = effect.meshes.find(mesh => mesh.metadata?.effectRole === 'shader-particles');
    assert.ok(particles.getTotalVertices() <= 4096);
    assert.equal(scene.particleSystems.length, 0);
    assert.ok(effect.materials.every(material => !material.disableDepthTest));
  }
});

test('多余输入点和退化路径不会产生无限预算或非有限几何，零透明度保留', t => {
  const { create } = harness(t);
  const points = Array.from({ length: 10000 }, (_, index) => ({ x: index, y: 0, z: index % 2 }));
  const effect = create('flow-path', { visual: { points, opacity: 0 } });
  assert.ok(effect.meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0) < 12000);
  assert.ok(effect.materials.filter(value => value instanceof ShaderMaterial).every(value => value._floats.opacity === 0));
  const degenerate = create('pipe-flow', { visual: { points: [{ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }] } });
  for (const mesh of degenerate.meshes) assert.ok(mesh.getVerticesData(VertexBuffer.PositionKind).every(Number.isFinite));
});

test('合法64条数据全部渲染，负值数据柱向下显示', t => {
  const { create } = harness(t);
  const values = Array.from({ length: 64 }, (_, index) => index === 63 ? -64 : index + 1);
  const points = values.map((_, index) => ({ x: index, y: 0, z: 0 }));
  const bars = create('data-bars', { visual: { values, points, height: 8 } });
  const dataBars = bars.meshes.filter(mesh => mesh.metadata?.effectRole === 'data-bar');
  assert.equal(dataBars.length, 64);
  assert.equal(dataBars[63].position.y, -4);
  assert.equal(dataBars[63].metadata.value, -64);
  const regions = create('region-level', { visual: { values, points } });
  assert.equal(regions.meshes.filter(mesh => mesh.metadata?.effectRole === 'region-cell').length, 64);
});

test('凹区域按轮廓耳切，填充三角面面积保持正确', t => {
  const { create } = harness(t);
  const points = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]].map(([x, z]) => ({ x, y: 0, z }));
  const effect = create('area-fill', { visual: { points } });
  const mesh = effect.meshes.find(mesh => mesh.metadata?.effectRole === 'area-polygon');
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind), indices = mesh.getIndices();
  let area = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = indices.slice(index, index + 3).map(vertex => Vector3.FromArray(positions, vertex * 3));
    area += Vector3.Cross(b.subtract(a), c.subtract(a)).length() * 0.5;
  }
  assert.equal(indices.length, 12);
  assert.ok(Math.abs(area - 7) < 0.000001, 'L形区域面积应为7，不能用凸包填满');
});

test('运动目标停止后的拖尾在配置时长内渐隐', t => {
  const { scene, create } = harness(t);
  const target = MeshBuilder.CreateBox('moving-vehicle', {}, scene);
  const effect = create('motion-trail', { visual: { targetEntityId: 'vehicle', duration: 1 } }, () => target);
  effect.tick(0.1); target.position.x = 2; effect.tick(0.1);
  const trail = effect.meshes.find(mesh => mesh.metadata?.effectRole === 'motion-history');
  assert.equal(trail.visibility, 1);
  effect.tick(0.25); effect.tick(0.25);
  assert.ok(trail.material._floats.opacity > 0 && trail.material._floats.opacity < 0.75);
  effect.tick(0.25); effect.tick(0.25);
  assert.equal(trail.visibility, 0);
});

test('路径节点随配置进度逐段点亮，演示拖尾不连接首尾跳变点', t => {
  const { create } = harness(t);
  const path = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }];
  const effect = create('path-reveal', { speed: 0, visual: { points: path, progress: 0.5 } });
  const nodes = effect.meshes.filter(mesh => mesh.metadata?.effectRole === 'path-node');
  assert.equal(nodes[0].material, nodes[1].material);
  assert.notEqual(nodes[1].material, nodes[2].material);
  assert.ok(nodes[1].material.alpha > nodes[2].material.alpha);
  const trail = create('motion-trail', { visual: { points: path } });
  trail.tick(0.05);
  const positions = trail.meshes[0].getVerticesData(VertexBuffer.PositionKind);
  assert.ok(Math.max(...positions.filter((_, index) => index % 3 === 0)) < 1, '首段演示不应从终点跨越回起点');
});

test('单个热区保留实际坐标，重合采样点不破坏后续数值配对', t => {
  const { create } = harness(t);
  const source = { x: 2, y: 0, z: 1 };
  const single = create('heatmap', { visual: { points: [source], values: [100], width: 1 } });
  const colorAtSource = single.meshes[0].getVerticesData(VertexBuffer.ColorKind).slice((24 * 41 + 28) * 4, (24 * 41 + 28) * 4 + 4);
  assert.ok(colorAtSource[0] > 0.9 && colorAtSource[1] < 0.2, '单热点的峰值应在配置位置');
  const low = { x: -3, y: 0, z: -3 };
  const overlapping = create('heatmap', { visual: { points: [low, low, source], values: [0, 0, 100], width: 1 } });
  const ordinary = create('heatmap', { visual: { points: [low, source], values: [0, 100], width: 1 } });
  assert.deepEqual(overlapping.meshes[0].getVerticesData(VertexBuffer.ColorKind), ordinary.meshes[0].getVerticesData(VertexBuffer.ColorKind));
});
