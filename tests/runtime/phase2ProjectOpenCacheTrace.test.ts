import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetContainer, MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { ProjectOpenTraceRecorder } from '../../electron/shared/projectOpenTrace.ts';
import { SceneLoadDiagnostics } from '../../src/runtime/babylon/SceneLoadDiagnostics.ts';
import { SharedModelAssetCache, type AssetCloneTiming } from '../../src/runtime/babylon/SharedModelAssetCache.ts';
import { EnvironmentAssetContainerCache } from '../../src/runtime/babylon/environmentAssetContainerCache.ts';

const openId = '12345678-1234-4123-8123-123456789abc', nextId = '22345678-1234-4123-8123-123456789abc';
function diagnostic(id = openId) {
  const recorder = new ProjectOpenTraceRecorder({ version: 1, openId: id, detail: 'assets' }, { clockDomain: 'renderer' });
  const diagnostics = new SceneLoadDiagnostics(); diagnostics.beginProjectOpenTrace(recorder);
  return { diagnostics, recorder, trace: diagnostics.createAssetTrace()! };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const source = new AssetContainer(scene), box = MeshBuilder.CreateBox('source', {}, scene);
  source.meshes.push(box); source.rootNodes.push(box); source.geometries.push(box.geometry!); source.removeAllFromScene();
  return { scene, source, dispose() { scene.dispose(); engine.dispose(); } };
}

test('installed Babylon共享模板仅实际import一次；每个消费者独立wait/link，clone任务在克隆调用前已开始', async () => {
  const f = fixture(), cache = new SharedModelAssetCache(), a = diagnostic(), b = diagnostic(nextId), gate = deferred();
  let imports = 0, clones = 0;
  const instantiate = f.source.instantiateModelsToScene.bind(f.source);
  f.source.instantiateModelsToScene = (...args) => {
    clones++;
    assert.equal([...a.recorder.snapshot().spans, ...b.recorder.snapshot().spans].filter(span => span.stage === 'modelClone' && !span.ended).length, 1);
    return instantiate(...args);
  };
  const loader = () => a.diagnostics.measureAsync('assetReadDecode', async () => { imports++; await gate.promise; return f.source; });
  let oldCallbackCount = 0;
  const timings: AssetCloneTiming[] = [];
  const onClone = (ms: number, failed: boolean, timing?: AssetCloneTiming) => {
    oldCallbackCount++; assert.equal(failed, false); assert.ok(ms >= 0); assert.ok(timing);
    assert.equal(ms, timing.endedAtMs - timing.startedAtMs); timings.push(timing);
  };
  try {
    const one = cache.instantiate('private-key-never-in-trace', loader, name => name, undefined, onClone, a.trace);
    const two = cache.instantiate('private-key-never-in-trace', loader, name => name, undefined, onClone, b.trace);
    gate.resolve(); const instances = await Promise.all([one, two]);
    assert.equal(imports, 1); assert.equal(clones, 2); assert.equal(oldCallbackCount, 2);
    const owner = a.recorder.snapshot(), consumer = b.recorder.snapshot();
    const producer = owner.spans.find(span => span.stage === 'modelAcquire')!;
    assert.equal(owner.spans.filter(span => span.stage === 'assetReadDecode').length, 1);
    assert.equal(consumer.spans.filter(span => span.stage === 'assetReadDecode' || span.stage === 'modelAcquire').length, 0);
    assert.equal(consumer.spans.find(span => span.stage === 'templateWait')!.links![0].openId, openId);
    assert.equal(consumer.spans.find(span => span.stage === 'templateWait')!.links![0].spanId, producer.spanId);
    for (const [index, snapshot] of [owner, consumer].entries()) {
      const clone = snapshot.spans.find(span => span.stage === 'modelClone')!;
      assert.ok(clone.startMs! <= timings[index].startedAtMs); assert.ok(clone.endMs! >= timings[index].endedAtMs);
      assert.equal(snapshot.spans.filter(span => !span.ended && span.kind === 'task').length, 0);
      assert.equal(JSON.stringify(snapshot).includes('private-key'), false);
    }
    instances.forEach(instance => instance.dispose());
  } finally { cache.dispose(); f.dispose(); }
});

test('取消单个共享消费者只取消其wait，不伪造clone/import；另一个open继续且原AbortError保留', async () => {
  const f = fixture(), cache = new SharedModelAssetCache(), a = diagnostic(), b = diagnostic(nextId), gate = deferred(), controller = new AbortController();
  let imports = 0;
  const loader = async () => { imports++; await gate.promise; return f.source; };
  try {
    const cancelled = cache.acquireOwnedContainer('shared', loader, controller.signal, undefined, a.trace);
    const active = cache.acquireOwnedContainer('shared', loader, undefined, undefined, b.trace);
    controller.abort();
    await assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
    gate.resolve(); const working = await active;
    assert.equal(imports, 1);
    assert.equal(a.recorder.snapshot().spans.find(span => span.stage === 'templateWait')!.status, 'cancelled');
    assert.equal(a.recorder.snapshot().spans.filter(span => span.stage === 'modelClone').length, 0);
    assert.equal(b.recorder.snapshot().spans.find(span => span.stage === 'modelClone')!.status, 'ok');
    working.dispose();
  } finally { gate.resolve(); cache.dispose(); f.dispose(); }
});

test('installed Babylon环境源去重、wait链接和真实clone边界保留旧callback；观察hook抛错不改变业务', async () => {
  const f = fixture(), cache = new EnvironmentAssetContainerCache(), a = diagnostic(), b = diagnostic(nextId), gate = deferred();
  let imports = 0, callbacks = 0;
  const loadSource = () => a.diagnostics.measureAsync('environmentReadDecode', async () => { imports++; await gate.promise; return f.source; });
  try {
    const one = cache.acquireWorkingContainer({ cacheKey: 'secret-environment', scene: f.scene, loadSource, trace: a.trace,
      onClone: (ms, failed, timing) => { callbacks++; assert.equal(failed, false); assert.equal(ms, timing!.endedAtMs - timing!.startedAtMs); } });
    const two = cache.acquireWorkingContainer({ cacheKey: 'secret-environment', scene: f.scene, loadSource, trace: b.trace });
    gate.resolve(); const working = await Promise.all([one, two]);
    assert.equal(imports, 1); assert.equal(callbacks, 1);
    assert.equal(a.recorder.snapshot().spans.filter(span => span.stage === 'environmentReadDecode').length, 1);
    assert.equal(b.recorder.snapshot().spans.filter(span => span.stage === 'environmentReadDecode').length, 0);
    assert.equal(b.recorder.snapshot().spans.find(span => span.stage === 'templateWait')!.links![0].openId, openId);
    assert.equal(b.recorder.snapshot().spans.find(span => span.stage === 'environmentClone')!.status, 'ok');
    working.forEach(container => container.dispose());
    const badStart = await cache.acquireWorkingContainer({ cacheKey: 'secret-environment', scene: f.scene, loadSource, trace: { begin() { throw new Error('observer'); } } });
    const badEnd = await cache.acquireWorkingContainer({ cacheKey: 'secret-environment', scene: f.scene, loadSource, trace: { begin() { return { ref: null, end() { throw new Error('observer end'); } }; } } });
    assert.ok(badStart.meshes.length); assert.ok(badEnd.meshes.length); badStart.dispose(); badEnd.dispose();
  } finally { cache.dispose(); f.dispose(); }
});

test('源失败结束producer和所有wait，原始Error保持且不产生虚构clone', async () => {
  const cache = new SharedModelAssetCache(), a = diagnostic(), b = diagnostic(nextId), failure = new Error('original source failure');
  const loader = async (): Promise<AssetContainer> => { throw failure; };
  const outcomes = await Promise.allSettled([
    cache.acquireOwnedContainer('bad', loader, undefined, undefined, a.trace),
    cache.acquireOwnedContainer('bad', loader, undefined, undefined, b.trace),
  ]);
  assert.ok(outcomes.every(result => result.status === 'rejected' && result.reason === failure));
  for (const snapshot of [a.recorder.snapshot(), b.recorder.snapshot()]) {
    assert.equal(snapshot.spans.filter(span => span.stage === 'modelClone').length, 0);
    assert.ok(snapshot.spans.filter(span => span.kind === 'task').every(span => span.ended && span.status === 'error'));
  }
  cache.dispose();
});
