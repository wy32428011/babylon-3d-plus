import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { FreeCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';' };
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { createEmptySceneDocument, createMeshEntity, createModelEntity } = await import('../../src/editor/model/SceneDocument.ts');
hooks.deregister();
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function setup(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -10), scene);
  const calls = { logs: [], measurements: [], environment: [], progress: [], resources: [], statistics: [], alarms: [] };
  const runtime = new SceneRuntime(scene,
    function(message) { calls.logs.push({ receiver: this, message }); },
    function(entityId) { calls.measurements.push({ receiver: this, entityId }); },
    function(snapshot) { calls.environment.push({ receiver: this, snapshot }); },
    function(progress) { calls.progress.push({ receiver: this, progress }); },
    function() { calls.resources.push(this); return null; },
  );
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, runtime, calls };
}
function document(entities) {
  return { ...createEmptySceneDocument(), entityIds: entities.map(e => e.id), entities: Object.fromEntries(entities.map(e => [e.id, e])) };
}

test('公共回调保留 SceneRuntime receiver，环境快照保留原裸调用语义', async t => {
  const { runtime, calls } = setup(t);
  runtime.getPerformanceMetrics();
  assert.equal(calls.resources.at(-1), runtime);
  runtime.syncEnvironment(null);
  assert.ok(calls.environment.length > 0);
  assert.ok(calls.environment.every(call => call.receiver === undefined));
  runtime.onAlarmActivated = function(event) { calls.alarms.push({ receiver: this, event }); assert.equal(typeof this.getPerformanceMetrics, 'function'); };
  const event = { managerId: 'manager', targetId: 'target' };
  // 驱动真实 AlarmManager 的宿主通知边界，检查可替换的公共订阅。
  runtime.effects.alarmRuntime.host.activate(event);
  assert.deepEqual(calls.alarms, [{ receiver: runtime, event }]);
  const sequence = runtime.readiness.beginModelLoadProgressUnit('fixture.glb');
  await flush();
  runtime.readiness.settleModelLoadProgressUnit(sequence);
  await flush();
  assert.ok(calls.progress.length >= 2);
  assert.ok(calls.progress.every(call => call.receiver === runtime));
  assert.equal(calls.progress.at(-1).progress.loading, false);
});

test('异步失败、测量通知和日志仍通过正式模型生命周期回调到公共实例', async t => {
  const { runtime, calls } = setup(t);
  runtime.assets.loadModelRuntimeAssets = async () => { throw new Error('fixture-load-failure'); };
  const model = createModelEntity('fixture.glb', 'fixture://model.glb', 'receiver-model');
  runtime.sync(document([model]));
  await flush();
  assert.equal(runtime.isModelReady(model.id), false);
  assert.match(runtime.getModelReadinessError(model.id), /fixture-load-failure/);
  assert.ok(calls.logs.some(call => call.message.includes('fixture-load-failure')));
  assert.ok(calls.logs.every(call => call.receiver === runtime));
  assert.ok(calls.measurements.some(call => call.entityId === model.id));
  assert.ok(calls.measurements.every(call => call.receiver === runtime));
});

test('三角统计保留按需扫描、替换与取消订阅，销毁清空公共订阅', async t => {
  const { runtime, calls } = setup(t);
  let scans = 0;
  const collect = runtime.readiness.collectModelStatistics.bind(runtime.readiness);
  runtime.readiness.collectModelStatistics = () => { scans++; return collect(); };
  const mesh = createMeshEntity('box');
  runtime.sync(document([mesh]));
  await flush();
  assert.equal(scans, 0, '没有订阅方时不主动扫描');
  runtime.onModelStatisticsChanged = function(snapshot) { calls.statistics.push({ receiver: this, snapshot }); assert.equal(typeof this.dispose, 'function'); };
  const next = { ...mesh, components: { ...mesh.components, transform: { ...mesh.components.transform, position: { x: 3, y: 0, z: 0 } } } };
  runtime.sync(document([next]));
  await flush();
  assert.ok(scans > 0);
  assert.ok(calls.statistics.length > 0);
  assert.ok(calls.statistics.every(call => call.receiver === runtime));
  runtime.onModelStatisticsChanged = undefined;
  const before = scans;
  runtime.sync(document([]));
  await flush();
  assert.equal(scans, before);
  runtime.dispose();
  assert.equal(runtime.onModelStatisticsChanged, undefined);
  assert.equal(runtime.getMotionStaticBatchDiagnostics().groups, 0);
});
