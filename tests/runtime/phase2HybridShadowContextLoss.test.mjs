import assert from 'node:assert/strict';
import test from 'node:test';
import '../../src/runtime/babylon/babylonSideEffects.ts';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';
import { HybridShadowCache, HybridShadowMeshState } from '../../src/runtime/babylon/HybridShadowCache.ts';
import { SceneRenderPassDiagnostics } from '../../src/runtime/babylon/SceneRenderPassDiagnostics.ts';

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 4, -8), scene);
  camera.setTarget(Vector3.Zero());
  const cube = MeshBuilder.CreateBox('static-caster', {}, scene);
  const light = new DirectionalLight('sun', new Vector3(-1, -2, 1), scene);
  light.autoCalcShadowZBounds = true;
  const generator = new ShadowGenerator(128, light);
  generator.addShadowCaster(cube, false);
  const map = generator.getShadowMap(), originalRender = map.customRenderFunction;
  const state = new HybridShadowMeshState();
  state.setMeshes([cube], new Map([[cube, { mobility: 'static', castShadows: true, receiveShadows: true }]]));
  engine.onContextLostObservable.add(() => {});
  engine.onContextRestoredObservable.add(() => {});
  const observables = [engine.onContextLostObservable, engine.onContextRestoredObservable,
    scene.onBeforeRenderTargetsRenderObservable, scene.onAfterRenderObservable, generator.onAfterShadowMapRenderMeshObservable,
    map.onBeforeBindObservable, map.onClearObservable, map.onAfterUnbindObservable];
  const observers = () => observables.map(list => list.observers.filter(observer => !observer._willBeUnregistered));
  const originalObservers = observers();
  const cache = new HybridShadowCache(generator, state);
  const warm = async () => {
    scene.render();
    await scene.whenReadyAsync();
    scene.render();
    scene.render();
    assert.ok(cache.metrics.staticRenders > 0);
    assert.equal(cache.cachedFaces, 1);
    assert.equal(cache.textureBytes, 0);
  };
  const dispose = () => { cache.dispose(); state.dispose(); scene.dispose(); engine.dispose(); };
  return { engine, scene, cube, generator, map, cache, warm, dispose, observers, originalObservers, originalRender };
}

test('渲染诊断保留静态缓存，实计动态立方图的面并忽略 readiness', async t => {
  const f = fixture();
  const instrumentation = new SceneInstrumentation(f.scene);
  const draws = instrumentation.drawCallsCounter;
  const diagnostics = new SceneRenderPassDiagnostics(f.scene, () => draws.current);
  // NullEngine 不累加 draw counter，在实际调用提交入口时使用与 WebGL 相同的计数方法。
  t.mock.method(f.engine, 'drawElementsType', () => f.engine._reportDrawCall());
  try {
    const point = new PointLight('dynamic-light', new Vector3(3, 2, 1), f.scene);
    const generator = new ShadowGenerator(128, point);
    const moving = MeshBuilder.CreateBox('dynamic-caster', {}, f.scene);
    generator.addShadowCaster(moving, false);
    const cubeMap = generator.getShadowMap();
    // NullEngine 的立方 RTT 无底层纹理，补上类型标志以执行原生六面循环。
    cubeMap.isCube = true;
    const renderer = f.scene.objectRenderers.find(value => value.renderPassIds === cubeMap.renderPassIds);
    assert.ok(renderer);
    await f.warm();

    let readinessChecks = 0;
    f.scene.onBeforeRenderTargetsRenderObservable.add(() => {
      assert.equal(f.map.isReadyForRendering(), true);
      assert.equal(cubeMap.isReadyForRendering(), true);
      readinessChecks++;
    });
    f.scene.render();
    const baseline = { ...f.cache.metrics };
    assert.equal(baseline.refreshPolicy, 'render-once');

    diagnostics.setEnabled(true);
    for (let i = 0; i < 2; i++) {
      moving.position.x += 0.1;
      f.scene.render();
    }
    const snapshot = diagnostics.sample();
    assert.equal(readinessChecks, 6, 'readiness 在已采样帧内确实执行');
    assert.equal(f.cache.metrics.refreshPolicy, 'render-once');
    assert.equal(f.cache.metrics.unsupportedCacheReason, null);
    assert.equal(f.cache.metrics.nativeMapRenders, baseline.nativeMapRenders);
    assert.equal(f.cache.metrics.cacheHits, baseline.cacheHits + 2);
    assert.equal(snapshot.completedFrames, 2);
    assert.equal(snapshot.drawCallsPerFrame, 8);
    assert.equal(snapshot.shadowDrawCallsPerFrame, 6);
    assert.equal(snapshot.otherDrawCallsPerFrame, 2);
    assert.deepEqual(snapshot.shadowPasses.map(({ lightId, targetId, face, passes, drawCallsPerFrame }) =>
      ({ lightId, targetId, face, passes, drawCallsPerFrame })), Array.from({ length: 6 }, (_, face) => ({
      lightId: point.uniqueId, targetId: cubeMap.uniqueId, face, passes: 2, drawCallsPerFrame: 1,
    })));

    generator.onAfterShadowMapRenderMeshObservable.addOnce(() => {
      draws.fetchNewFrame();
      draws.addCount(20, false);
    });
    f.scene.render();
    const reset = diagnostics.sample();
    assert.equal(reset.drawCallsPerFrame, null);
    assert.equal(reset.shadowDrawCallsPerFrame, null);
    assert.equal(reset.otherDrawCallsPerFrame, null);
    assert.equal(reset.shadowPasses.length, 6);
    assert.ok(reset.shadowPasses.every(pass => pass.passes === 1 && pass.drawCallsPerFrame === null));

    renderer.onAfterRenderingManagerRenderObservable.add((_, event) => {
      event.skipNextObservers = true;
    }, -1, true, null, true);
    f.scene.render();
    const unmatched = diagnostics.sample();
    assert.equal(unmatched.drawCallsPerFrame, 8);
    assert.equal(unmatched.shadowDrawCallsPerFrame, null);
    assert.equal(unmatched.otherDrawCallsPerFrame, null);
    assert.deepEqual(unmatched.shadowPasses.map(pass => pass.face), [1, 2, 3, 4, 5]);
    f.scene.render();
    assert.equal(diagnostics.sample().shadowDrawCallsPerFrame, 6);

    instrumentation.dispose();
    f.scene.render();
    const stale = diagnostics.sample();
    assert.equal(stale.drawCallsPerFrame, null);
    assert.equal(stale.shadowDrawCallsPerFrame, null);
    assert.equal(stale.shadowPasses.length, 6);
  } finally { diagnostics.dispose(); instrumentation.dispose(); f.dispose(); }
});

test('lost 和 restore 通知清除旧整图命中，重建的原生 RTT 绘制最新姿态后才能复用', async () => {
  const f = fixture();
  try {
    await f.warm();
    const previous = f.generator.getTransformMatrix().clone();
    const before = { ...f.cache.metrics };
    f.engine.onContextLostObservable.notifyObservers(f.engine);
    assert.equal(f.cache.cachedFaces, 0);
    f.cube.position.x += 3;
    f.generator.recreateShadowMap();
    const replacement = f.generator.getShadowMap(), nativeRender = replacement.customRenderFunction;
    assert.notEqual(replacement, f.map);
    f.engine.onContextRestoredObservable.notifyObservers(f.engine);
    assert.equal(f.cache.cachedFaces, 0);
    assert.equal(replacement.customRenderFunction, nativeRender);
    await f.scene.whenReadyAsync();
    f.scene.render();
    assert.equal(f.cache.metrics.nativeMapRenders, before.nativeMapRenders + 1);
    assert.equal(f.cache.metrics.staticRenders, before.staticRenders + 1);
    assert.equal(f.cache.metrics.cacheHits, before.cacheHits);
    assert.ok(!f.generator.getTransformMatrix().equals(previous));
    f.scene.render();
    assert.equal(f.cache.metrics.nativeMapRenders, before.nativeMapRenders + 1);
    assert.equal(f.cache.metrics.cacheHits, before.cacheHits + 1);
    assert.equal(f.cache.cachedFaces, 1);
  } finally { f.dispose(); }
});

test('有无先收到 lost 通知，关闭或释放缓存均归还原生 RTT 及逐帧刷新', async t => {
  for (const notify of [true, false]) for (const action of ['disable', 'dispose']) {
    await t.test(JSON.stringify({ notify, action }), async () => {
      const f = fixture();
      try {
        await f.warm();
        const texture = f.map.getInternalTexture();
        assert.ok(texture);
        if (notify) f.engine.onContextLostObservable.notifyObservers(f.engine);
        if (action === 'disable') f.cache.setEnabled(false); else f.cache.dispose();
        f.engine.onContextRestoredObservable.notifyObservers(f.engine);
        assert.equal(f.cache.cachedFaces, 0);
        assert.equal(f.map.getInternalTexture(), texture);
        assert.equal(f.map.customRenderFunction, f.originalRender);
        assert.equal(f.map.refreshRate, 1);
        assert.ok(f.map._shouldRender());
        assert.ok(f.map._shouldRender());
      } finally { f.dispose(); }
    });
  }
});

test('单独的 restored 通知使整图失效，重复释放完整归还原生观察者与绘制函数', async () => {
  const f = fixture();
  try {
    await f.warm();
    f.engine.onContextRestoredObservable.notifyObservers(f.engine);
    assert.equal(f.cache.cachedFaces, 0);
    const before = f.cache.metrics.staticRenders;
    f.scene.render();
    assert.equal(f.cache.metrics.staticRenders, before + 1);
    f.cache.dispose();
    f.cache.dispose();
    assert.deepEqual(f.observers(), f.originalObservers);
    assert.equal(f.map.customRenderFunction, f.originalRender);
    assert.equal(f.generator.getShadowMap(), f.map);
    const renders = f.cache.metrics.nativeMapRenders;
    f.engine.onContextLostObservable.notifyObservers(f.engine);
    f.engine.onContextRestoredObservable.notifyObservers(f.engine);
    f.scene.render();
    assert.equal(f.cache.metrics.nativeMapRenders, renders);
  } finally { f.dispose(); }
});
