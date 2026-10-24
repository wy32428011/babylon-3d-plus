import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';
const entries = ['/src/runtime/babylon/ScenePerformanceMonitor.ts', '/src/runtime/babylon/gpuCapabilityProfile.ts'];
const modules = await createP4SsrTestModules(entries); test.after(() => modules.close());
const { ScenePerformanceMonitor } = await modules.ssrLoadModule(entries[0]);
const { prepareGpuCapabilityProfile } = await modules.ssrLoadModule(entries[1]);
test('真实Monitor JSON包含已准备profile，只读报告不自行启动probe或伪造GPU结果', async t => {
  const engine = new NullEngine(), scene = new Scene(engine), monitor = new ScenePerformanceMonitor(engine, scene, {
    getRuntimeMetrics: () => ({}), getEditThinInstancePlanMetrics: () => ({}), collectDetailedGpuWorkloads: false,
  });
  t.after(() => { monitor.dispose(); scene.dispose(); engine.dispose(); });
  assert.equal(JSON.parse(monitor.createReport()).gpuCapabilityProfile, null);
  const profile = await prepareGpuCapabilityProfile(engine, undefined, { createCanvas: () => null, storage: null });
  assert.equal(profile.status, 'unavailable'); assert.equal(profile.tier, null);
  assert.deepEqual(JSON.parse(monitor.createReport()).gpuCapabilityProfile, profile);
});
