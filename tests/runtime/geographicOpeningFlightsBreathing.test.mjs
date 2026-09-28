import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
      format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
let createGeographicOpeningFlights, createDefaultSceneOpeningAnimation;
try {
  ({ createGeographicOpeningFlights } = await import('../../src/runtime/opening/GeographicOpeningFlights.ts'));
  ({ createDefaultSceneOpeningAnimation } = await import('../../src/editor/model/sceneOpeningAnimation.ts'));
} finally { hooks.deregister(); }

// 这里只替代 Canvas 绘图环境；节点、顶点缓冲、材质、纹理及释放均使用真实 Babylon 对象。
function canvas() {
  const context = {
    clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, stroke() {}, fillText() {},
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    measureText: text => ({ width: Array.from(text).length * 42 }),
  };
  return { width: 1, height: 1, getContext: () => context, remove() {} };
}

function fixture(t, settingsPatch = {}, optionsPatch = {}) {
  const engine = new NullEngine(); engine.createCanvas = canvas;
  const scene = new Scene(engine); void scene.defaultMaterial;
  const settings = { ...createDefaultSceneOpeningAnimation(), breathingEnabled: true, breathingIntensity: 0.65,
    breathingPeriodSeconds: 4, ...settingsPatch };
  const resources = () => ({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length,
    disposeObservers: scene.onDisposeObservable.observers.length });
  const original = resources();
  const flights = createGeographicOpeningFlights(scene, settings, {
    destinations: settings.chinaDestinations.slice(0, 3), startTime: 0, endTime: 30,
    namePrefix: 'test-flight', referenceViewHeight: 0.5, showOrigin: true, showLabels: true, ...optionsPatch,
  });
  t.after(() => { flights.dispose(); scene.dispose(); engine.dispose(); });
  const mesh = name => scene.getMeshByName('test-flight-' + name);
  const snapshot = () => ({ origin: { scale: mesh('origin').scaling.asArray(), alpha: mesh('origin').visibility },
    endpoint: { scale: mesh('destination-0').scaling.asArray(), alpha: mesh('destination-0').visibility },
    comet: { scale: mesh('comet-0').scaling.asArray(), alpha: mesh('comet-0').visibility },
    trail: Array.from(mesh('tail-0').getVerticesData(VertexBuffer.ColorKind)),
    labels: [0, 1, 2].map(index => ({ alpha: mesh('label-' + index).visibility, scale: mesh('label-' + index).scaling.asArray(), guideAlpha: mesh('label-guide-' + index).alpha })),
  });
  return { flights, scene, mesh, snapshot, resources, original };
}

test('真实呼吸时钟独立于飞行时间，节点错相但文字和主弧线保持稳定', t => {
  const f = fixture(t);
  f.flights.update(5, 1, 0.5, 0.25); const first = f.snapshot();
  const firstPosition = f.mesh('comet-core-0').position.asArray();
  const arcAlpha = f.mesh('arc-0').visibility;
  f.flights.update(5, 1, 0.5, 1.25); const second = f.snapshot();
  assert.notDeepEqual(second.origin, first.origin, '中国停留中即使飞行阶段参数不变，真实时钟仍驱动枢纽呼吸');
  assert.notDeepEqual(second.endpoint, first.endpoint);
  assert.notDeepEqual(second.comet, first.comet);
  assert.notDeepEqual(second.trail, first.trail);
  assert.ok(Math.abs(second.trail.at(-1) - first.trail.at(-1)) < 0.1, '尾迹只作轻微明暗起伏');
  assert.deepEqual(second.labels, first.labels, '标签和引导线不应随呼吸闪烁');
  assert.equal(f.mesh('arc-0').visibility, arcAlpha, '金白主弧线保持稳定');
  assert.deepEqual(f.mesh('comet-core-0').position.asArray(), firstPosition, '呼吸时钟不改写飞线位置');
  assert.equal(f.mesh('destination-0').material, f.mesh('destination-1').material);
  assert.notEqual(f.mesh('destination-0').visibility, f.mesh('destination-1').visibility, '共享材质的不同节点仍需保持独立相位');
  f.flights.update(5, 1, 0.5, 0.25);
  assert.deepEqual(f.snapshot(), first, 'seek到相同时间产生相同画面状态');
});

test('开关关闭、强度零或reduced时恢复静态节点并关闭脉冲，飞线继续流动', t => {
  for (const [settings, options] of [
    [{ breathingEnabled: false }, {}], [{ breathingIntensity: 0 }, {}], [{ breathingIntensity: Number.NaN }, {}],
    [{}, { animateBreathing: false }], [{ motionPreference: 'reduced' }, {}],
  ]) {
    const f = fixture(t, settings, options);
    f.flights.update(5, 1, 0.5, 0); const first = f.snapshot();
    f.flights.update(5, 1, 0.5, 2); assert.deepEqual(f.snapshot(), first);
    assert.ok(f.scene.meshes.filter(mesh => mesh.name.startsWith('test-flight-origin-pulse-')).every(mesh => !mesh.isEnabled()));
    assert.equal(f.mesh('origin').visibility, 1);
    assert.equal(f.mesh('destination-0').visibility, 1);
    const head = f.mesh('comet-core-0').position.asArray();
    f.flights.update(5.5, 1, 0.5, 2);
    assert.notDeepEqual(f.mesh('comet-core-0').position.asArray(), head);
    assert.deepEqual(f.mesh('origin').scaling.asArray(), first.origin.scale, '旧origin的sin缩放也必须停用');
  }
});

test('重复更新不会增加资源，淡出保持归零，销毁清理所有节点和纹理', async t => {
  const f = fixture(t);
  const allocated = f.resources();
  for (let index = 0; index < 80; index++) f.flights.update(5, 1, 0.5, index / 10);
  assert.deepEqual(f.resources(), allocated);
  f.flights.update(5, 0, 0.5, 3);
  assert.ok(f.scene.meshes.every(mesh => !mesh.isEnabled()));
  f.flights.dispose(); f.flights.dispose();
  // Babylon Observable 将已标记移除的观察者延迟到下一任务清理。
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.resources(), f.original);
});
