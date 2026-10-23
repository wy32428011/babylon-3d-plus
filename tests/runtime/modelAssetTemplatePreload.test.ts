import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Animation, AnimationGroup, AssetContainer, Mesh, MeshBuilder, NullEngine, Scene,
  StandardMaterial, TransformNode, VertexBuffer,
} from '@babylonjs/core';
import { SharedModelAssetCache, type SharedModelTemplateLease } from '../../src/runtime/babylon/SharedModelAssetCache.ts';

function fixture(options: { maxIdleEntries?: number; maxIdleBytes?: number; animated?: boolean } = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const cache = new SharedModelAssetCache(options);
  const sources: AssetContainer[] = [];
  const loader = async () => {
    const source = new AssetContainer(scene);
    const root = new TransformNode('cargoRoot', scene);
    const mesh = MeshBuilder.CreateBox('cargo', { updatable: true }, scene);
    const material = new StandardMaterial('cargoMaterial', scene);
    mesh.parent = root;
    mesh.material = material;
    mesh.metadata = { original: true };
    source.rootNodes.push(root);
    source.transformNodes.push(root);
    source.meshes.push(mesh);
    source.geometries.push(mesh.geometry!);
    source.materials.push(material);
    if (options.animated) {
      const animation = new Animation('move', 'position.x', 30, Animation.ANIMATIONTYPE_FLOAT);
      animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 1 }]);
      const group = new AnimationGroup('motion', scene);
      group.addTargetedAnimation(animation, mesh);
      source.animationGroups.push(group);
      group.start(true, 0.5);
    }
    source.removeAllFromScene();
    sources.push(source);
    return source;
  };
  return { engine, scene, cache, sources, loader, dispose: () => { cache.dispose(); scene.dispose(); engine.dispose(); } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>(done => setImmediate(done));

test('同源预取去重，只有模板驻留且不创建实例、不加入场景', async () => {
  const f = fixture({ animated: true });
  const leases: SharedModelTemplateLease[] = [];
  try {
    let instantiations = 0;
    let sceneAdds = 0;
    const loader = async () => {
      const source = await f.loader();
      source.instantiateModelsToScene = () => { instantiations++; throw new Error('preload must not instantiate'); };
      source.addAllToScene = () => { sceneAdds++; throw new Error('preload must not add nodes'); };
      return source;
    };
    leases.push(...await Promise.all([f.cache.preload('cargo:r1', loader), f.cache.preload('cargo:r1', loader)]));
    assert.equal(f.sources.length, 1);
    assert.deepEqual(Object.keys(leases[0]), ['dispose']);
    assert.equal(instantiations, 0);
    assert.equal(sceneAdds, 0);
    assert.equal(f.scene.meshes.length, 0);
    assert.equal(f.scene.transformNodes.length, 0);
    assert.equal(f.sources[0].animationGroups[0].isStarted, false, '预取模板按原机制停止隐藏动画');
    assert.equal(f.cache.getMetrics().instantiationCount, 0);
    assert.equal(f.cache.getMetrics().ownedCloneCount, 0);
  } finally { for (const lease of leases) lease.dispose(); f.dispose(); }
});

test('预取后的首次静态实例和参数工作容器命中同一模板，副本可变资源保持隔离', async () => {
  const f = fixture();
  let lease: SharedModelTemplateLease | undefined;
  try {
    lease = await f.cache.preload('cargo:r1', f.loader);
    const unexpectedLoad = async (): Promise<AssetContainer> => { throw new Error('template must already be loaded'); };
    const instance = await f.cache.instantiate('cargo:r1', unexpectedLoad, name => name);
    const a = await f.cache.acquireOwnedContainer('cargo:r1', unexpectedLoad);
    const b = await f.cache.acquireOwnedContainer('cargo:r1', unexpectedLoad);
    try {
      assert.equal(f.sources.length, 1);
      assert.equal(f.cache.getMetrics().misses, 1);
      assert.equal(f.cache.getMetrics().hits, 3);
      const source = f.sources[0].meshes[0] as Mesh;
      const meshA = a.meshes[0] as Mesh;
      const meshB = b.meshes[0] as Mesh;
      assert.notEqual(meshA.geometry, meshB.geometry);
      assert.notEqual(meshA.geometry, source.geometry);
      assert.notEqual(meshA.material, meshB.material);
      const baseline = meshB.getVerticesData(VertexBuffer.PositionKind)![0];
      const positions = meshA.getVerticesData(VertexBuffer.PositionKind)!;
      positions[0] += 100;
      meshA.updateVerticesData(VertexBuffer.PositionKind, positions);
      (meshA.material as StandardMaterial).alpha = 0.2;
      assert.equal(meshB.getVerticesData(VertexBuffer.PositionKind)![0], baseline);
      assert.equal(source.getVerticesData(VertexBuffer.PositionKind)![0], baseline);
      assert.equal((meshB.material as StandardMaterial).alpha, 1);
    } finally { instance.dispose(); a.dispose(); b.dispose(); }
  } finally { lease?.dispose(); f.dispose(); }
});

test('预取不改变 GLB 动画工作实例的独立目标与原有自动播放', async () => {
  const f = fixture({ animated: true });
  let lease: SharedModelTemplateLease | undefined;
  try {
    lease = await f.cache.preload('animated:r1', f.loader);
    const a = await f.cache.instantiate('animated:r1', f.loader, name => 'a:' + name);
    const b = await f.cache.instantiate('animated:r1', f.loader, name => 'b:' + name);
    try {
      const groupA = a.entries.animationGroups[0];
      const groupB = b.entries.animationGroups[0];
      assert.notEqual(groupA.targetedAnimations[0].target, groupB.targetedAnimations[0].target);
      assert.notEqual(groupA.targetedAnimations[0].animation, groupB.targetedAnimations[0].animation);
      assert.equal(groupA.targetedAnimations[0].target.name, 'a:cargo');
      assert.equal(groupB.targetedAnimations[0].target.name, 'b:cargo');
      assert.equal(groupA.isPlaying, true);
      assert.equal(groupB.isPlaying, true);
      assert.equal(groupA.loopAnimation, true);
      assert.equal(groupA.speedRatio, 0.5);
      groupA.pause();
      assert.equal(groupB.isPlaying, true);
      assert.equal(f.sources[0].animationGroups[0].isStarted, false);
      assert.equal(f.sources.length, 1);
    } finally { a.dispose(); b.dispose(); }
  } finally { lease?.dispose(); f.dispose(); }
});

test('取消一个预取等待者不取消同源实例消费者，也不创建取消项的 lease', async () => {
  const f = fixture();
  const gate = deferred<AssetContainer>();
  const controller = new AbortController();
  let sourceSignal!: AbortSignal;
  try {
    const loader = (signal: AbortSignal) => { sourceSignal = signal; return gate.promise; };
    const cancelled = f.cache.preload('cargo', loader, controller.signal);
    const active = f.cache.instantiate('cargo', loader, name => name);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(sourceSignal.aborted, false);
    gate.resolve(await f.loader());
    const instance = await active;
    instance.dispose();
    assert.equal(f.cache.getMetrics().instantiationCount, 1);
    assert.equal(f.cache.getMetrics().idleEntries, 1);
  } finally { f.dispose(); }
});

test('取消最后一个预取等待者会取消共享源，迟到容器仅释放一次并允许同键重试', async () => {
  const f = fixture();
  const gate = deferred<AssetContainer>();
  const controller = new AbortController();
  let sourceSignal!: AbortSignal;
  try {
    const pending = f.cache.preload('cargo', signal => { sourceSignal = signal; return gate.promise; }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(sourceSignal.aborted, true);
    const replacement = await f.cache.preload('cargo', f.loader);
    const late = await f.loader();
    let disposals = 0;
    const originalDispose = late.dispose.bind(late);
    late.dispose = () => { disposals++; originalDispose(); };
    gate.resolve(late);
    await nextTurn();
    assert.equal(disposals, 1);
    assert.equal(f.cache.getMetrics().entries, 1, '旧任务失败不得删除同键新模板');
    assert.equal(f.sources[0].meshes.length, 1);
    replacement.dispose();
  } finally { f.dispose(); }
});

test('预先取消不开始读取；已完成 lease 不再受等待 signal 取消影响', async () => {
  const f = fixture();
  let lease: SharedModelTemplateLease | undefined;
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(f.cache.preload('cancelled', f.loader, cancelled.signal), { name: 'AbortError' });
    assert.equal(f.sources.length, 0);
    const finished = new AbortController();
    lease = await f.cache.preload('cargo', f.loader, finished.signal);
    finished.abort();
    assert.equal(f.sources[0].meshes.length, 1);
    assert.equal(f.cache.getMetrics().idleEntries, 0);
  } finally { lease?.dispose(); f.dispose(); }
});

test('零空闲预算下预取 lease 保持模板驻留，最后归还幂等释放', async () => {
  const f = fixture({ maxIdleEntries: 0, maxIdleBytes: 0 });
  try {
    const a = await f.cache.preload('cargo', f.loader);
    const b = await f.cache.preload('cargo', f.loader);
    a.dispose(); a.dispose();
    assert.equal(f.sources[0].meshes.length, 1);
    assert.equal(f.cache.getMetrics().entries, 1);
    const instance = await f.cache.instantiate('cargo', f.loader, name => name);
    b.dispose(); b.dispose();
    assert.equal(f.sources.length, 1);
    assert.equal(f.sources[0].meshes.length, 1, '共享实例仍持有模板');
    instance.dispose();
    assert.equal(f.sources[0].meshes.length, 0);
    assert.equal(f.cache.getMetrics().entries, 0);
  } finally { f.dispose(); }
});

test('缓存释放拒绝在途预取及迟到结果，已取得 lease 在归还前保持模板有效', async () => {
  const f = fixture();
  const gate = deferred<AssetContainer>();
  try {
    const lease = await f.cache.preload('resident', f.loader);
    let residentDisposals = 0;
    const resident = f.sources[0];
    const originalDispose = resident.dispose.bind(resident);
    resident.dispose = () => { residentDisposals++; originalDispose(); };
    const pending = f.cache.preload('pending', () => gate.promise);
    f.cache.dispose();
    assert.equal(resident.meshes.length, 1);
    gate.resolve(await f.loader());
    await assert.rejects(pending, /释放|失效/);
    assert.equal(f.sources[1].meshes.length, 0);
    await assert.rejects(f.cache.preload('new', f.loader), /释放/);
    lease.dispose(); lease.dispose();
    assert.equal(residentDisposals, 1);
    assert.equal(resident.meshes.length, 0);
  } finally { f.dispose(); }
});

test('预取读取失败不污染缓存，下次同键可重试且能复用空闲模板', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.cache.preload('cargo', async () => { throw new Error('broken GLB'); }), /broken GLB/);
    assert.equal(f.cache.getMetrics().entries, 0);
    const a = await f.cache.preload('cargo', f.loader);
    a.dispose();
    const b = await f.cache.preload('cargo', async () => { throw new Error('idle template should be reused'); });
    assert.equal(f.sources.length, 1);
    b.dispose();
    assert.equal(f.cache.getMetrics().idleEntries, 1);
  } finally { f.dispose(); }
});
