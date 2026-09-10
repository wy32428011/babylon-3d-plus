import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Animation, AnimationGroup, AssetContainer, Mesh, MeshBuilder, MultiMaterial,
  NullEngine, RawTexture, Scene, StandardMaterial, TransformNode, VertexBuffer,
} from '@babylonjs/core';
import { SharedModelAssetCache, createModelAssetTemplateKey } from '../../src/runtime/babylon/SharedModelAssetCache.ts';

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const cache = new SharedModelAssetCache({ maxIdleEntries: 2, maxIdleBytes: 16 * 1024 * 1024 });
  const sources: AssetContainer[] = [];
  const loader = async () => {
    const source = new AssetContainer(scene);
    const root = new TransformNode('root', scene);
    const mesh = MeshBuilder.CreateBox('rack', { updatable: true }, scene);
    root.id = 'root-id';
    mesh.id = 'mesh-id';
    mesh.parent = root;
    mesh.metadata = { gltf: { pointers: ['/nodes/0'] } };
    const material = new StandardMaterial('surface', scene);
    material.diffuseTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    // NullEngine 无纹理上传，本用例模拟已完成的纹理，专门验证克隆和释放引用。
    material.diffuseTexture.getInternalTexture()!.isReady = true;
    const multi = new MultiMaterial('surfaces', scene);
    multi.subMaterials = [material];
    mesh.material = multi;
    const animation = new Animation('move', 'position.x', 30, Animation.ANIMATIONTYPE_FLOAT);
    animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 1 }]);
    mesh.animations.push(animation);
    const group = new AnimationGroup('motion', scene);
    group.addTargetedAnimation(animation, mesh);
    source.transformNodes.push(root);
    source.meshes.push(mesh);
    source.geometries.push(mesh.geometry!);
    source.materials.push(material);
    source.multiMaterials.push(multi);
    source.textures.push(material.diffuseTexture);
    source.animationGroups.push(group);
    source.rootNodes.push(root);
    source.removeAllFromScene();
    sources.push(source);
    return source;
  };
  return { scene, cache, sources, loader, dispose: () => { cache.dispose(); scene.dispose(); engine.dispose(); } };
}

test('同一修订的 12 个参数模型共享一次解析，并拥有独立几何、材质、纹理对象和动画', async () => {
  const f = fixture();
  try {
    const copies = await Promise.all(Array.from({ length: 12 }, () => f.cache.acquireOwnedContainer('rack:r1', f.loader)));
    assert.equal(f.sources.length, 1, '同资源并发实例不能逐个重读和解析 GLB');
    const [a, b] = copies.map(copy => copy.meshes[0] as Mesh);
    const source = f.sources[0].meshes[0] as Mesh;
    assert.equal(a.id, 'mesh-id');
    assert.equal(a.parent!.id, 'root-id');
    assert.notEqual(a.geometry, b.geometry);
    assert.notEqual(a.geometry, source.geometry);
    const positions = a.getVerticesData(VertexBuffer.PositionKind)!;
    const baseline = b.getVerticesData(VertexBuffer.PositionKind)![0];
    positions[0] += 100;
    a.updateVerticesData(VertexBuffer.PositionKind, positions);
    assert.equal(b.getVerticesData(VertexBuffer.PositionKind)![0], baseline);
    assert.equal(source.getVerticesData(VertexBuffer.PositionKind)![0], baseline);
    const materialA = (a.material as MultiMaterial).subMaterials[0] as StandardMaterial;
    const materialB = (b.material as MultiMaterial).subMaterials[0] as StandardMaterial;
    assert.notEqual(materialA, materialB);
    assert.notEqual(materialA.diffuseTexture, materialB.diffuseTexture);
    materialA.alpha = 0.2;
    assert.equal(materialB.alpha, 1);
    a.metadata.gltf.pointers.push('instance');
    assert.deepEqual(b.metadata.gltf.pointers, ['/nodes/0']);
    assert.deepEqual(source.metadata.gltf.pointers, ['/nodes/0']);
    const groupA = copies[0].animationGroups[0];
    const groupB = copies[1].animationGroups[0];
    assert.equal(groupA.targetedAnimations[0].target, a);
    assert.equal(groupB.targetedAnimations[0].target, b);
    assert.notEqual(groupA.targetedAnimations[0].animation, groupB.targetedAnimations[0].animation);
    groupA.targetedAnimations[0].animation.getKeys()[1].value = 77;
    assert.equal(groupB.targetedAnimations[0].animation.getKeys()[1].value, 1);
    assert.equal(f.sources[0].animationGroups[0].targetedAnimations[0].animation.getKeys()[1].value, 1);
    const sourceMaterial = (source.material as MultiMaterial).subMaterials[0];
    assert.equal(sourceMaterial, f.sources[0].materials[0], '克隆 MultiMaterial 不可改写模板子材质');
    copies[0].dispose();
    assert.equal(b.isDisposed(), false);
    assert.equal(materialB.diffuseTexture!.isReady(), true);
    for (const copy of copies.slice(1)) copy.dispose();
  } finally { f.dispose(); }
});

test('已释放实例可复用有界空闲模板；修订与资源身份变化独立解析', async () => {
  const f = fixture();
  try {
    const first = await f.cache.acquireOwnedContainer('rack:r1', f.loader);
    first.dispose();
    (await f.cache.acquireOwnedContainer('rack:r1', f.loader)).dispose();
    (await f.cache.acquireOwnedContainer('rack:r2', f.loader)).dispose();
    assert.equal(f.sources.length, 2);
    (await f.cache.acquireOwnedContainer('other:r1', f.loader)).dispose();
    assert.equal(f.cache.getMetrics().idleEntries, 2);
    assert.equal(f.sources[0].meshes.length, 0, '空闲模板超过数量上限时淘汰最旧项');
    (await f.cache.acquireOwnedContainer('rack:r1', f.loader)).dispose();
    assert.equal(f.sources.length, 4);
  } finally { f.dispose(); }
});

test('单个等待者取消不会中止其它实例，且取消项不创建节点', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loader = async () => { await gate; return f.loader(); };
    const controller = new AbortController();
    const cancelled = f.cache.acquireOwnedContainer('rack', loader, controller.signal);
    const active = f.cache.acquireOwnedContainer('rack', loader);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    release();
    const copy = await active;
    assert.equal(f.sources.length, 1);
    assert.equal(f.cache.getMetrics().ownedCloneCount, 1);
    copy.dispose();
  } finally { f.dispose(); }
});

test('失败加载不污染缓存，下一次可重试', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.cache.acquireOwnedContainer('rack', async () => { throw new Error('broken GLB'); }), /broken GLB/);
    const copy = await f.cache.acquireOwnedContainer('rack', f.loader);
    assert.equal(copy.meshes.length, 1);
    copy.dispose();
  } finally { f.dispose(); }
});

test('GLB 原有自动播放保留在每个工作副本，隐藏解析模板不继续运行', async () => {
  const f = fixture();
  try {
    const loader = async () => {
      const source = await f.loader();
      source.animationGroups[0].start(true, 0.5);
      return source;
    };
    const first = await f.cache.acquireOwnedContainer('animated', loader);
    const second = await f.cache.acquireOwnedContainer('animated', loader);
    assert.equal(f.sources[0].animationGroups[0].isStarted, false);
    for (const working of [first, second]) {
      assert.equal(working.animationGroups[0].isPlaying, true);
      assert.equal(working.animationGroups[0].loopAnimation, true);
      assert.equal(working.animationGroups[0].speedRatio, 0.5);
    }
    first.animationGroups[0].pause();
    assert.equal(second.animationGroups[0].isPlaying, true);
    first.dispose(); second.dispose();
  } finally { f.dispose(); }
});

test('字节预算淘汰模板但已创建独占实例仍可编辑和渲染', async () => {
  const f = fixture();
  const cache = new SharedModelAssetCache({ maxIdleEntries: 8, maxIdleBytes: 1 });
  try {
    const copy = await cache.acquireOwnedContainer('rack', f.loader);
    assert.equal(cache.getMetrics().idleEntries, 0);
    const mesh = copy.meshes[0] as Mesh;
    assert.ok(mesh.getVerticesData(VertexBuffer.PositionKind)!.length > 0);
    assert.equal(((mesh.material as MultiMaterial).subMaterials[0] as StandardMaterial).diffuseTexture!.isReady(), true);
    copy.dispose();
  } finally { cache.dispose(); f.dispose(); }
});

test('缓存释放时拒绝在途结果且释放迟到的源容器', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = f.cache.acquireOwnedContainer('rack', async () => { await gate; return f.loader(); });
    f.cache.dispose();
    release();
    await assert.rejects(pending, /释放|失效/);
    assert.equal(f.sources[0].meshes.length, 0);
  } finally { f.dispose(); }
});

test('所有等待者取消时取消共享源排队任务；迟到结果只释放一次', async () => {
  const f = fixture();
  try {
    let resolve!: (source: AssetContainer) => void;
    let sourceSignal!: AbortSignal;
    const loader = (signal: AbortSignal) => { sourceSignal = signal; return new Promise<AssetContainer>(done => { resolve = done; }); };
    const a = new AbortController();
    const b = new AbortController();
    const first = f.cache.acquireOwnedContainer('cancel-all', loader, a.signal);
    const second = f.cache.acquireOwnedContainer('cancel-all', loader, b.signal);
    await Promise.resolve();
    a.abort(); b.abort();
    await Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    assert.equal(sourceSignal.aborted, true);
    const late = await f.loader();
    let disposals = 0;
    const originalDispose = late.dispose.bind(late);
    late.dispose = () => { disposals++; originalDispose(); };
    resolve(late);
    await new Promise(done => setImmediate(done));
    assert.equal(disposals, 1);
    assert.equal(f.cache.getMetrics().entries, 0);
  } finally { f.dispose(); }
});

test('静态共享实例仍按引用持有源，释放缓存不提前释放活动实例', async () => {
  const f = fixture();
  try {
    const loader = async () => {
      const source = await f.loader();
      for (const group of source.animationGroups) group.dispose();
      source.animationGroups = [];
      return source;
    };
    const a = await f.cache.instantiate('static', loader, name => name);
    const b = await f.cache.instantiate('static', loader, name => name);
    const source = f.sources[0];
    f.cache.dispose();
    a.dispose();
    assert.equal(source.meshes.length, 1);
    assert.equal(b.entries.rootNodes[0].isDisposed(), false);
    b.dispose(); b.dispose();
    assert.equal(source.meshes.length, 0);
  } finally { f.dispose(); }
});

test('没有组件脚本的 GLB 自带动画仍使用独立目标并遵循实例命名', async () => {
  const f = fixture();
  try {
    const first = await f.cache.instantiate('glb-animation', f.loader, name => `first:${name}`);
    const second = await f.cache.instantiate('glb-animation', f.loader, name => `second:${name}`);
    assert.equal(first.entries.rootNodes[0].name, 'first:root');
    const firstTarget = first.entries.animationGroups[0].targetedAnimations[0];
    const secondTarget = second.entries.animationGroups[0].targetedAnimations[0];
    assert.equal(firstTarget.target.name, 'first:rack');
    assert.equal(secondTarget.target.name, 'second:rack');
    assert.notEqual(firstTarget.animation, secondTarget.animation);
    assert.notEqual(firstTarget.target.geometry, secondTarget.target.geometry);
    first.dispose(); second.dispose();
  } finally { f.dispose(); }
});

test('模板身份不受参数、单位影响，但隔离修订、中台、包内模型和无版本路径', () => {
  const asset = { assetCode: 'a', sourcePath: '/old/a.glb', sourceUrl: 'editor-asset://old/a.glb', assetRevision: 'r1',
    lengthUnit: 'meter' as const, unitScaleToMeters: 1,
    dataPlatformModel: { sourceKey: 'platform-a', kind: 'model' as const, resourceId: '1', modelPath: 'a.glb' } };
  const key = createModelAssetTemplateKey(asset);
  assert.equal(createModelAssetTemplateKey({ ...asset, sourceUrl: 'editor-asset://new/a.glb', parameterValues: { width: 2 }, unitScaleToMeters: 0.001 }), key);
  assert.notEqual(createModelAssetTemplateKey({ ...asset, assetRevision: 'r2' }), key);
  assert.notEqual(createModelAssetTemplateKey({ ...asset, dataPlatformModel: { ...asset.dataPlatformModel, sourceKey: 'platform-b' } }), key);
  assert.notEqual(createModelAssetTemplateKey({ ...asset, dataPlatformModel: { ...asset.dataPlatformModel, modelPath: 'b.glb' } }), key);
  assert.notEqual(createModelAssetTemplateKey({ ...asset, assetRevision: undefined, sourceUrl: 'editor-asset://old/a.glb' }),
    createModelAssetTemplateKey({ ...asset, assetRevision: undefined, sourceUrl: 'editor-asset://new/a.glb' }));
});
