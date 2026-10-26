import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const modules = await createP4SsrTestModules(['/src/runtime/babylon/ScenePerformanceMonitor.ts']);
after(() => modules.close());
const { ScenePerformanceMonitor, summarizeScenePerformance } = await modules.ssrLoadModule('/src/runtime/babylon/ScenePerformanceMonitor.ts');

function fixture(context, options = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const monitor = new ScenePerformanceMonitor(engine, scene, {
    getRuntimeMetrics: () => ({}), getEditThinInstancePlanMetrics: () => ({}), collectDetailedGpuWorkloads: false,
    ...options,
  });
  context.after(() => { monitor.dispose(); scene.dispose(); engine.dispose(); });
  return { engine, scene, monitor };
}

test('真实不支持GPU计时的NullEngine采样不触发lastSecAverage异常，未测量值为null', context => {
  const { engine, monitor } = fixture(context);
  assert.equal(engine.getGPUFrameTimeCounter(), undefined);
  let snapshot;
  assert.doesNotThrow(() => { snapshot = monitor.sample(); });
  assert.equal(snapshot.gpuFrameTimeMs, null);
  for (const key of ['frameTimeMs', 'renderTimeMs', 'activeMeshesEvaluationMs', 'shaderCompilationMs', 'drawCalls']) {
    assert.equal(snapshot[key], null, key + ' 尚未有真实样本，不得补0');
  }
});

test('真实SceneInstrumentation取engine原生draw counter，完成空场景渲染的合法0保持', context => {
  const { engine, scene, monitor } = fixture(context);
  assert.equal(monitor.sceneInstrumentation.drawCallsCounter, engine._drawCalls);
  new FreeCamera('metrics-camera', new Vector3(0, 0, -5), scene);
  scene.render();
  const snapshot = monitor.sample();
  assert.equal(snapshot.drawCalls, 0);
  for (const key of ['frameTimeMs', 'renderTimeMs', 'activeMeshesEvaluationMs']) {
    assert.equal(typeof snapshot[key], 'number', key);
    assert.ok(Number.isFinite(snapshot[key]) && snapshot[key] >= 0, key);
  }
  assert.equal(snapshot.shaderCompilationMs, null);
  assert.equal(snapshot.gpuFrameTimeMs, null);
});

test('已经采集的真实PerfCounter零值保持，缺失或非法counter不伪造0', context => {
  const { engine, monitor } = fixture(context);
  const instrumentation = monitor.sceneInstrumentation;
  for (const counter of [instrumentation.frameTimeCounter, instrumentation.renderTimeCounter,
    instrumentation.activeMeshesEvaluationTimeCounter, monitor.engineInstrumentation.shaderCompilationTimeCounter, engine._drawCalls]) {
    counter.fetchNewFrame(); counter.addCount(0, true);
  }
  const zero = monitor.sample();
  for (const key of ['frameTimeMs', 'renderTimeMs', 'activeMeshesEvaluationMs', 'shaderCompilationMs', 'drawCalls']) assert.equal(zero[key], 0, key);
  Object.defineProperty(instrumentation, 'frameTimeCounter', { value: undefined });
  Object.defineProperty(instrumentation, 'renderTimeCounter', { value: { count: 1, current: Number.NaN, lastSecAverage: Number.NaN } });
  Object.defineProperty(instrumentation, 'activeMeshesEvaluationTimeCounter', { value: { count: 0, current: 12, lastSecAverage: 12 } });
  Object.defineProperty(instrumentation, 'drawCallsCounter', { value: undefined });
  Object.defineProperty(monitor.engineInstrumentation, 'shaderCompilationTimeCounter', { value: undefined });
  const missing = monitor.sample();
  for (const key of ['frameTimeMs', 'renderTimeMs', 'activeMeshesEvaluationMs', 'shaderCompilationMs', 'drawCalls']) assert.equal(missing[key], null, key);
});

test('摘要忽略未采样的CPU/draw而保留合法0，不把缺失样本混进分位数', context => {
  const { monitor } = fixture(context);
  const empty = summarizeScenePerformance([]);
  assert.equal(empty.p95FrameTimeMs, null);
  assert.equal(empty.maximumDrawCalls, null);
  const base = monitor.sample();
  const summary = summarizeScenePerformance([{ ...base, frameTimeMs: null, drawCalls: null }, { ...base, frameTimeMs: 0, drawCalls: 0 }, { ...base, frameTimeMs: 40, drawCalls: 7 }]);
  assert.equal(summary.p95FrameTimeMs, 40);
  assert.equal(summary.maximumDrawCalls, 7);
  const unavailable = summarizeScenePerformance([{ ...base, frameTimeMs: null, drawCalls: null }]);
  assert.equal(unavailable.p95FrameTimeMs, null);
  assert.equal(unavailable.maximumDrawCalls, null);
});

test('真实已采集PerfCounter的GPU合法零保留，关闭采集不能把残留counter当测量', context => {
  let enabled = true;
  const { monitor } = fixture(context, { captureGpuFrameTime: () => enabled });
  const counter = monitor.engineInstrumentation.shaderCompilationTimeCounter;
  counter.fetchNewFrame(); counter.addCount(0, true);
  // 仅验证counter数值合同；NullEngine本身不提供GPU测量，不能据此宣称真实GPU为0ms。
  Object.defineProperty(monitor.engineInstrumentation, 'gpuFrameTimeCounter', { value: counter });
  assert.equal(monitor.sample().gpuFrameTimeMs, 0);
  enabled = false;
  assert.equal(monitor.sample().gpuFrameTimeMs, null);
  enabled = true;
  assert.equal(monitor.sample().gpuFrameTimeMs, null, '重新启用不能复用前一代计数');
  counter.fetchNewFrame(); counter.addCount(1_500_000, true);
  assert.equal(monitor.sample().gpuFrameTimeMs, 1.5);
});

test('关闭诊断时不启用GPU查询，低频开关只在状态转换调用SDK', context => {
  const { monitor } = fixture(context, { captureGpuFrameTime: false });
  assert.equal(monitor.gpuFrameTimeCaptureEnabled, false);
  const counter = monitor.engineInstrumentation.shaderCompilationTimeCounter;
  counter.fetchNewFrame(); counter.addCount(123, true);
  Object.defineProperty(monitor.engineInstrumentation, 'gpuFrameTimeCounter', { value: counter });
  assert.equal(monitor.sample().gpuFrameTimeMs, null);
  assert.equal(monitor.engineInstrumentation.captureGPUFrameTime, false);
});

test('真实afterRender观察器按显式墙钟窗计量，停止后保留报告及旧interval口径', context => {
  const { scene, monitor } = fixture(context);
  assert.throws(() => monitor.beginWallClockFrameTimingWindow(1005), /启用逐帧计量/);
  let now = 1000;
  context.mock.method(performance, 'now', () => now);
  monitor.setFrameTimingEnabled(true);
  new FreeCamera('wall-clock-camera', new Vector3(0, 0, -5), scene);
  scene.render();
  monitor.beginWallClockFrameTimingWindow(1005);
  now = 1010; scene.render();
  now = 1020; scene.render();
  monitor.endWallClockFrameTimingWindow(1100);
  const partial = monitor.getWallClockFrameTimingReport();
  assert.equal(partial.completedFrames, 2);
  assert.equal(partial.effectiveFps, 2 * 1000 / 95);
  assert.equal(partial.measurementValid, false);
  assert.equal(partial.p99Ms, null);
  now = 1130; scene.render();
  const complete = monitor.getWallClockFrameTimingReport();
  assert.equal(complete.measurementValid, true);
  assert.deepEqual(complete.frameTimestampsMs, [1000, 1010, 1020, 1130]);
  assert.equal(complete.p99Ms, 110);
  assert.equal(monitor.getFrameTimingReport().effectiveFps, 3 * 1000 / 130);
  assert.deepEqual(JSON.parse(monitor.createReport()).wallClockFrameTiming, complete);
  monitor.setFrameTimingEnabled(false);
  assert.deepEqual(monitor.getWallClockFrameTimingReport(), complete);
});
