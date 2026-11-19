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
  assert.equal(zero.cpuFrameMs, 0);
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

/** Node 只验证查询状态机；不把 NullEngine 冒充为真实 GPU。 */
function timerFixture(context) {
  let enabled = false;
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  const { engine, scene, monitor } = fixture(context, { captureGpuFrameTime: () => enabled });
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb, QUERY_COUNTER_BITS_EXT: 0x8864 };
  const deleted = [];
  const calls = { queries: 0, reads: 0, probes: 0, ends: 0 };
  const gl = {
    CURRENT_QUERY: 0x8865, QUERY_RESULT_AVAILABLE: 0x8867, QUERY_RESULT: 0x8866,
    active: null, ready: false, disjoint: false, lost: false, bits: 64, nanoseconds: 0,
    getExtension(name) {
      if (name !== 'EXT_disjoint_timer_query_webgl2') return null;
      calls.probes++;
      return ext;
    },
    getQuery(_target, parameter) { return parameter === gl.CURRENT_QUERY ? gl.active : gl.bits; },
    getParameter() { const value = gl.disjoint; gl.disjoint = false; return value; },
    getQueryParameter(_query, parameter) {
      if (parameter === gl.QUERY_RESULT_AVAILABLE) return gl.ready;
      calls.reads++;
      return gl.nanoseconds;
    },
    isContextLost: () => gl.lost,
    createQuery: () => ({ id: ++calls.queries }),
    beginQuery(_target, query) {
      assert.equal(gl.active, null, '不能覆盖其他计时查询');
      gl.active = query;
    },
    endQuery() { calls.ends++; gl.active = null; },
    deleteQuery: (query) => deleted.push(query.id),
  };
  Object.defineProperties(engine, { _gl: { value: gl }, webGLVersion: { value: 2 } });
  new FreeCamera('timer-camera', new Vector3(0, 0, -5), scene);
  return {
    engine, monitor, gl, calls, deleted,
    enable(value = true) { enabled = value; monitor.refreshDiagnostics(); },
    frame(at, render = true) {
      now = at;
      engine.beginFrame();
      if (render) scene.render();
      engine.endFrame();
    },
  };
}

test('按需低频 WebGL2 查询只在结果就绪时读取，合法零和 CPU 帧工作耗时保留', context => {
  const timer = timerFixture(context);
  const { monitor, gl, calls, deleted } = timer;
  timer.frame(0);
  assert.equal(monitor.sample().gpuTimingStatus, 'disabled');
  assert.deepEqual(calls, { queries: 0, reads: 0, probes: 0, ends: 0 });
  timer.enable();
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'pending');
  timer.frame(16);
  timer.frame(32);
  assert.equal(calls.reads, 0, '异步查询未就绪时不能同步读取结果');
  gl.ready = true;
  timer.frame(83);
  assert.deepEqual(deleted, [1]);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameSamples, 1);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameMs, 0);
  assert.equal(monitor.sample().gpuFrameTimeMs, 0);
  assert.ok(Number.isFinite(monitor.sample().cpuFrameMs));
  timer.frame(100);
  timer.frame(200);
  assert.equal(calls.queries, 1);
  timer.frame(216);
  gl.nanoseconds = 1_500_000;
  timer.frame(232);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameMs, 1.5);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameSamples, 2);
  assert.equal(monitor.engineInstrumentation.captureGPUFrameTime, false);
});

test('结束、切场与释放会删除本会话查询，跳过未提交的引擎帧', context => {
  const timer = timerFixture(context);
  const { monitor, engine, gl, deleted } = timer;
  timer.enable();
  timer.frame(0, false);
  assert.deepEqual(deleted, [1]);
  timer.frame(250);
  monitor.resetSceneTiming();
  assert.deepEqual(deleted, [1, 2]);
  assert.equal(monitor.getFrameWorkTiming().cpuFrameMs, null);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameSamples, 0);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameMs, null);
  engine.beginFrame();
  assert.ok(gl.active);
  timer.enable(false);
  assert.equal(gl.active, null);
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'disabled');
  assert.deepEqual(deleted, [1, 2, 3]);
  timer.enable();
  timer.frame(500);
  monitor.dispose();
  assert.deepEqual(deleted, [1, 2, 3, 4]);
  timer.frame(750);
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'disabled');
});

test('WebGL2 上下文恢复后重新探测，丢弃 disjoint 和超时结果且不终止外部查询', context => {
  const timer = timerFixture(context);
  const { monitor, engine, gl, calls, deleted } = timer;
  timer.enable();
  gl.active = { id: 'foreign' };
  timer.frame(0);
  assert.equal(calls.queries, 0);
  assert.equal(gl.active.id, 'foreign');
  assert.equal(calls.ends, 0);
  gl.active = null;
  timer.frame(250);
  gl.disjoint = true;
  timer.frame(300);
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'disjoint');
  assert.deepEqual(deleted, [1]);
  timer.frame(500);
  timer.frame(2600);
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'unavailable');
  assert.deepEqual(deleted, [1, 2]);
  timer.frame(2800);
  gl.lost = true;
  engine.onContextLostObservable.notifyObservers(engine);
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'context-lost');
  assert.equal(monitor.getFrameWorkTiming().gpuFrameMs, null);
  gl.lost = false;
  engine.onContextRestoredObservable.notifyObservers(engine);
  assert.equal(calls.probes, 2);
  assert.deepEqual(deleted, [1, 2], '恢复时不得操作失效查询句柄');
  assert.equal(monitor.getFrameWorkTiming().gpuTimingStatus, 'pending');
  gl.ready = true;
  timer.frame(3000);
  timer.frame(3016);
  assert.equal(monitor.getFrameWorkTiming().gpuFrameSamples, 1);
});

test('设备未提供可用计时位数时不创建查询或伪造结果', context => {
  const timer = timerFixture(context);
  timer.gl.bits = 0;
  timer.enable();
  timer.frame(0);
  assert.equal(timer.monitor.getFrameWorkTiming().gpuTimingStatus, 'unsupported');
  assert.equal(timer.monitor.getFrameWorkTiming().gpuFrameMs, null);
  assert.equal(timer.calls.queries, 0);
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
