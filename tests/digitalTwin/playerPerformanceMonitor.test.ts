import assert from 'node:assert/strict';
import test from 'node:test';
import { ArcRotateCamera, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

test('发布轻量采样保留几何指标、跳过材质明细，并完整释放采样器与观察器', async (context) => {
  const server = await createServer({
    appType: 'custom', configFile: false, root: process.cwd(),
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true },
  });
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const mesh = MeshBuilder.CreateBox('private model', {}, scene);
  const material = new StandardMaterial('private material', scene);
  mesh.material = material;
  scene.render();
  const observed = [scene.onBeforeAnimationsObservable, scene.onAfterRenderObservable,
    scene.onBeforeDrawPhaseObservable, scene.onAfterDrawPhaseObservable,
    scene.onBeforeActiveMeshesEvaluationObservable, scene.onAfterActiveMeshesEvaluationObservable,
    engine.onBeginFrameObservable, engine.onEndFrameObservable,
    engine.onBeforeShaderCompilationObservable, engine.onAfterShaderCompilationObservable];
  const observerCounts = () => observed.map((observable) => observable.observers.length);
  const initialCounts = observerCounts();
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver');
  let disconnected = 0;
  class FakePerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    observe() {}
    disconnect() { disconnected += 1; }
  }
  Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: FakePerformanceObserver });
  let monitor: { start(callback: (sample: any) => void): void; sample(): any; dispose(): void } | undefined;
  try {
    const module = await server.ssrLoadModule('/src/runtime/babylon/ScenePerformanceMonitor.ts');
    const options = { getRuntimeMetrics: () => ({}), getEditThinInstancePlanMetrics: () => ({}),
      collectDetailedGpuWorkloads: false };
    monitor = new module.ScenePerformanceMonitor(engine, scene, options);
    let materialReads = 0;
    const originalGetTextures = material.getActiveTextures.bind(material);
    material.getActiveTextures = () => { materialReads += 1; return originalGetTextures(); };
    context.mock.timers.enable({ apis: ['setInterval'] });
    let sampleCount = 0;
    monitor!.start((sample) => {
      sampleCount += 1;
      assert.equal(sample.totalMeshes, 1);
      assert.equal(sample.activeMeshes, 1);
      assert.equal(sample.estimatedActiveVertexInvocations, mesh.getTotalVertices());
      assert.equal(sample.gpuFrameTimeMs, null);
      assert.deepEqual(sample.topActiveGpuWorkloads, []);
    });
    assert.equal(sampleCount, 1);
    context.mock.timers.tick(1000);
    assert.equal(sampleCount, 2);
    assert.equal(materialReads, 0);
    monitor!.dispose();
    monitor!.dispose();
    context.mock.timers.tick(1000);
    assert.equal(sampleCount, 2);
    assert.equal(disconnected, 1);
    // Babylon Observable.remove 立即停用回调，实际数组删除在下一个任务完成。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(observerCounts(), initialCounts);
    monitor = new module.ScenePerformanceMonitor(engine, scene, {
      getRuntimeMetrics: () => ({}), getEditThinInstancePlanMetrics: () => ({}),
    });
    const detailed = monitor!.sample();
    assert.equal(detailed.topActiveGpuWorkloads[0].meshName, 'private model');
    assert.ok(materialReads > 0);
  } finally {
    monitor?.dispose();
    context.mock.timers.reset();
    if (originalObserver) Object.defineProperty(globalThis, 'PerformanceObserver', originalObserver);
    else Reflect.deleteProperty(globalThis, 'PerformanceObserver');
    scene.dispose();
    engine.dispose();
    await server.close();
  }
});
