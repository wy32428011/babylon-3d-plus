import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Matrix, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial, Scene, StandardMaterial, Texture, TransformNode } from '@babylonjs/core';
import ts from 'typescript';

const sourceRoot = new URL('../../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
let ModelEntranceRuntime;
try { ({ ModelEntranceRuntime } = await import(new URL('runtime/babylon/ModelEntranceRuntime.ts', sourceRoot).href)); }
finally { hooks.deregister(); }

const settings = overrides => ({ enabled: true, effect: 'scan', durationSeconds: 2.5, delaySeconds: 0, color: '#00ccff', intensity: 1, axis: 'y', reverse: false, staggerSeconds: .15, particleCount: 600, particleSize: 3, spreadMeters: 3, assemblyDistanceMeters: 1.5, loop: false, loopIntervalSeconds: 1, scope: 'all', targetEntityIds: [], ...overrides });

test('prepare 返回 Promise 并统计源 binding，重复子材质只克隆和释放一次', async t => {
  const { scene, mesh, material, runtime, targets } = harness(t);
  const multi = new MultiMaterial('repeat', scene); multi.subMaterials = [material, material]; mesh.material = multi;
  const baseline = scene.materials.length;
  const preparation = runtime.prepare(settings(), targets);
  assert.ok(preparation instanceof Promise);
  await preparation;
  assert.equal(runtime.getSnapshot().preparedBindingCount, 1);
  assert.equal(runtime.getSnapshot().totalBindingCount, 1);
  assert.equal(mesh.material.subMaterials[0], mesh.material.subMaterials[1]);
  runtime.cancel(); assert.equal(scene.materials.length, baseline); assert.equal(mesh.material, multi);
});

test('分批让出主线程，abort 和旧 prepare 不覆盖新会话；dispose 清理等待中的资源', async t => {
  const { scene, mesh, material, runtime, targets } = harness(t);
  const other = MeshBuilder.CreateBox('other', {}, scene); other.material = material;
  targets.push({ id: 'other', node: other });
  const originalScheduler = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  const nativeClone = material.clone.bind(material);
  material.clone = name => {
    const copy = nativeClone(name), until = performance.now() + 9;
    while (performance.now() < until) { /* 确定触发 8 ms 软预算，不模拟调度时钟。 */ }
    return copy;
  };
  const pendingYields = [];
  Object.defineProperty(globalThis, 'scheduler', { configurable: true, value: { yield: () => new Promise(resolve => pendingYields.push(resolve)) } });
  t.after(() => { if (originalScheduler) Object.defineProperty(globalThis, 'scheduler', originalScheduler); else delete globalThis.scheduler; });
  const baseline = scene.materials.length;
  const controller = new AbortController();
  const old = runtime.prepare(settings(), targets, controller.signal);
  assert.equal(runtime.getSnapshot().status, 'preparing');
  assert.equal(runtime.getSnapshot().preparedBindingCount, 1);
  assert.equal(runtime.getSnapshot().totalBindingCount, 2);
  assert.notEqual(mesh.material, material); assert.equal(other.material, material);
  controller.abort(); assert.equal(mesh.material, material); assert.equal(scene.materials.length, baseline);
  await runtime.prepare(settings({ effect: 'assembly' }), [targets[1]]);
  const newMaterial = other.material;
  pendingYields.shift()(); await old;
  assert.equal(other.material, newMaterial); assert.equal(runtime.getSnapshot().status, 'prepared');
  const disposing = runtime.prepare(settings({ effect: 'particles' }), targets);
  assert.equal(runtime.getSnapshot().status, 'preparing');
  runtime.dispose(); pendingYields.shift()(); await disposing;
  assert.equal(mesh.material, material); assert.equal(other.material, material); assert.equal(scene.materials.length, baseline);
});

test('克隆异常恢复已准备绑定、租约和 dirty 开关，预先取消的信号不创建资源', async t => {
  const { scene, mesh, material, runtime, targets } = harness(t);
  const failing = MeshBuilder.CreateBox('failing', {}, scene), bad = new StandardMaterial('bad', scene);
  failing.material = bad; bad.clone = () => { throw new Error('material failed'); };
  const baseline = scene.materials.length;
  await assert.rejects(runtime.prepare(settings(), [...targets, { id: 'bad', node: failing }]), /material failed/);
  assert.equal(mesh.material, material); assert.equal(failing.material, bad);
  assert.equal(scene.materials.length, baseline); assert.equal(scene.blockMaterialDirtyMechanism, false);
  await runtime.prepare(settings(), targets); assert.equal(runtime.getSnapshot().status, 'prepared');
  const controller = new AbortController(); controller.abort();
  await runtime.prepare(settings(), targets, controller.signal);
  assert.equal(runtime.isActive, false); assert.equal(mesh.material, material); assert.equal(scene.materials.length, baseline);
});
function harness(t) {
  const engine = new NullEngine(); const scene = new Scene(engine); const root = new TransformNode('equipment', scene);
  const mesh = MeshBuilder.CreateBox('body', {}, scene); mesh.parent = root;
  const material = new StandardMaterial('paint', scene); mesh.material = material;
  const runtime = new ModelEntranceRuntime(scene);
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, root, mesh, material, runtime, targets: [{ id: 'equipment', node: root }] };
}

test('prepare 隐藏呈现但不改节点真值，等待 start 与可见时钟后按延迟完成并释放', async t => {
  const { scene, root, mesh, material, runtime, targets } = harness(t);
  mesh.visibility = .6; mesh.isPickable = false; mesh.checkCollisions = true;
  const baseline = scene.materials.length;
  await runtime.prepare(settings({ delaySeconds: .5, durationSeconds: 1 }), targets);
  assert.equal(runtime.getSnapshot().status, 'prepared'); assert.notEqual(mesh.material, material);
  runtime.tick(2); assert.equal(runtime.getSnapshot().elapsedSeconds, 0);
  runtime.start(); runtime.tick(.3, false); assert.equal(runtime.getSnapshot().elapsedSeconds, 0);
  runtime.tick(.4); assert.equal(runtime.getSnapshot().progress, 0);
  root.position.x = 17; mesh.position.y = 4;
  runtime.tick(.6); assert.ok(Math.abs(runtime.getSnapshot().progress - .5) < 1e-6);
  runtime.tick(.5); assert.equal(runtime.getSnapshot().status, 'completed'); assert.equal(mesh.material, material);
  assert.equal(root.position.x, 17); assert.equal(mesh.position.y, 4); assert.equal(mesh.visibility, .6);
  assert.equal(mesh.isPickable, false); assert.equal(mesh.checkCollisions, true); assert.equal(mesh.isEnabled(), true);
  assert.equal(scene.materials.length, baseline);
});

test('八种效果中途可取消，保留 PBR / 多材质贴图与其他模型共享原材质', async t => {
  const { scene, root, mesh, material, runtime, targets } = harness(t);
  const texture = new Texture(null, scene); material.diffuseTexture = texture;
  const pbr = new PBRMaterial('pbr', scene); pbr.albedoTexture = texture;
  const multi = new MultiMaterial('multi', scene); multi.subMaterials = [material, pbr]; mesh.material = multi;
  const sibling = MeshBuilder.CreateBox('sibling', {}, scene); sibling.material = multi;
  const baseline = [scene.meshes.length, scene.materials.length, scene.textures.length];
  for (const effect of ['fade', 'scan', 'dissolve', 'hologram', 'particles', 'assembly', 'radial', 'stagger']) {
    await runtime.prepare(settings({ effect }), targets); runtime.start(); runtime.tick(.8);
    assert.notEqual(mesh.material, multi); assert.equal(sibling.material, multi);
    assert.equal(mesh.material.subMaterials[0].diffuseTexture.name, texture.name);
    assert.equal(mesh.material.subMaterials[1].albedoTexture.name, texture.name);
    root.position.z += 1; mesh.rotation.y += .2;
    const position = root.position.clone(); const rotation = mesh.rotation.clone();
    runtime.cancel(); assert.equal(mesh.material, multi);
    assert.ok(root.position.equals(position)); assert.ok(mesh.rotation.equals(rotation));
    assert.deepEqual([scene.meshes.length, scene.materials.length, scene.textures.length], baseline);
  }
});

test('stagger 按实体延迟，循环完成保持后才重播且不重建资源', async t => {
  const { scene, root, mesh, material, runtime, targets } = harness(t);
  const otherRoot = new TransformNode('second', scene); const other = MeshBuilder.CreateBox('second-body', {}, scene); other.parent = otherRoot; other.material = material;
  await runtime.prepare(settings({ effect: 'stagger', durationSeconds: 1, staggerSeconds: .5, loop: true, loopIntervalSeconds: 1 }), [...targets, { id: 'second', node: otherRoot }]);
  const counts = [scene.meshes.length, scene.materials.length];
  runtime.start(); runtime.tick(1.5); assert.equal(runtime.getSnapshot().progress, 1);
  runtime.tick(.5); assert.equal(runtime.getSnapshot().progress, 1);
  runtime.tick(.5); assert.equal(runtime.getSnapshot().cycle, 1); assert.equal(runtime.getSnapshot().progress, 0);
  assert.deepEqual([scene.meshes.length, scene.materials.length], counts);
  runtime.cancel(); assert.equal(mesh.material, material); assert.equal(other.material, material);
});

test('实例选择只写 shader 实例缓冲，其他实例可见且 thin instances 不拆分', async t => {
  const { scene, mesh, material, runtime } = harness(t);
  const first = mesh.createInstance('selected'); const second = mesh.createInstance('unselected'); first.position.x = 5; second.position.x = 10;
  const thin = MeshBuilder.CreateBox('thin', {}, scene); thin.material = material;
  thin.thinInstanceSetBuffer('matrix', new Float32Array([...Matrix.Identity().asArray(), ...Matrix.Translation(3, 0, 0).asArray()]), 16);
  const baseline = scene.meshes.length;
  await runtime.prepare(settings({ effect: 'assembly' }), [{ id: 'selected', node: first }, { id: 'thin', node: thin }]);
  assert.equal(scene.meshes.length, baseline); assert.notEqual(mesh.material, material); assert.notEqual(thin.material, material);
  assert.equal(first.instancedBuffers.dtEntranceInstance.x, 0); assert.equal(second.instancedBuffers.dtEntranceInstance.x, 1); assert.equal(mesh.instancedBuffers.dtEntranceInstance.x, 1);
  runtime.start(); runtime.tick(1); assert.equal(first.position.x, 5); assert.equal(second.position.x, 10); assert.equal(thin.thinInstanceCount, 2);
  runtime.cancel(); assert.equal(mesh.material, material); assert.equal(thin.material, material); assert.equal(scene.meshes.length, baseline);
  assert.equal('dtEntranceInstance' in mesh.instancedBuffers, false);
  assert.ok(thin.getVertexBuffer('dtEntranceInstance') == null);
});

test('外部报警接管材质后 cancel 不覆盖报警且资源仍完整释放', async t => {
  const { scene, mesh, runtime, targets } = harness(t);
  const alarm = new PBRMaterial('alarm', scene); const baseline = scene.materials.length;
  await runtime.prepare(settings(), targets); runtime.start(); mesh.material = alarm;
  runtime.tick(.2); assert.equal(runtime.getSnapshot().interruptedMeshCount, 1);
  runtime.cancel(); assert.equal(mesh.material, alarm); assert.equal(scene.materials.length, baseline);
});

test('disabled、空目标、重复 prepare 和 dispose 均不遗留资源', async t => {
  const { scene, mesh, material, runtime, targets } = harness(t); const baseline = scene.materials.length;
  await runtime.prepare(settings({ enabled: false }), targets); assert.equal(mesh.material, material); assert.equal(runtime.isActive, false);
  await runtime.prepare(settings(), []); assert.equal(runtime.isActive, false);
  await runtime.prepare(settings({ effect: 'particles' }), targets); await runtime.prepare(settings(), targets);
  runtime.dispose(); runtime.dispose(); assert.equal(mesh.material, material); assert.equal(scene.materials.length, baseline);
});

test('整组扫描共享世界包围盒，跨部件揭示且材料强度为零仍保留原外观', async t => {
  const { scene, root, mesh, material, runtime, targets } = harness(t);
  const upper = MeshBuilder.CreateBox('upper', {}, scene); upper.parent = root; upper.position.y = 4; upper.material = material;
  await runtime.prepare(settings({ intensity: 0 }), targets); runtime.start(); runtime.tick(1);
  const values = new Map();
  for (const body of [mesh, upper]) {
    const clone = body.material; const prior = clone._uniformBuffer.updateFloat4;
    clone._uniformBuffer.updateFloat4 = (name, ...value) => values.set(`${body.name}/${name}`, value);
    try { clone._callbackPluginEventHardBindForSubMesh({ subMesh: body.subMeshes[0] }); }
    finally { clone._uniformBuffer.updateFloat4 = prior; }
  }
  assert.deepEqual(values.get('body/dtEntranceMinimum'), values.get('upper/dtEntranceMinimum'));
  assert.deepEqual(values.get('body/dtEntranceMaximum'), values.get('upper/dtEntranceMaximum'));
  assert.equal(values.get('body/dtEntranceMaximum')[1], 4.5);
  assert.equal(values.get('body/dtEntranceColor')[3], 0);
  runtime.cancel(); assert.equal(mesh.material, material); assert.equal(upper.material, material);
});
