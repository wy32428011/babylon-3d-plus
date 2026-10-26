import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { PrepareDefinesForMisc } from '@babylonjs/core/Materials/materialHelper.functions.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture.js';
import { EXRCubeTexture } from '@babylonjs/core/Materials/Textures/exrCubeTexture.js';
import { GetMergedStore } from '@babylonjs/core/Misc/decorators.functions.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Skeleton } from '@babylonjs/core/Bones/skeleton.js';
import { MorphTargetManager } from '@babylonjs/core/Morph/morphTargetManager.js';
import { MorphTarget } from '@babylonjs/core/Morph/morphTarget.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import '@babylonjs/core/Shaders/default.vertex.js';
import '@babylonjs/core/Shaders/default.fragment.js';
import { subscribeLightingBufferUploads, subscribeLightingGeometryUpdates } from '../../src/runtime/babylon/lightingGeometryUpdates.ts';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import type { SceneDocument } from '../../src/editor/model/SceneDocument';

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/MotionStaticBatchRuntime.ts') || url.endsWith('/EntityArrayThinInstanceBatch.ts')) {
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    }
    return nextLoad(url, context);
  },
});
const { MotionStaticBatchRuntime, MOTION_STATIC_MUTATION_EVENT_FLAG } = await import('../../src/runtime/babylon/MotionStaticBatchRuntime.ts');
const { EntityArrayThinInstanceBatch } = await import('../../src/runtime/babylon/EntityArrayThinInstanceBatch.ts');
const { collectLightingRuntimeSources } = await import('../../src/runtime/babylon/lightingClassificationRuntime.ts');
const { SceneLightingRuntime } = await import('../../src/runtime/babylon/SceneLightingRuntime.ts');
loader.deregister();

function fixture(parts = ['rail'], beforeRuntime?: (scene: Scene) => void, enabled = true) {
  const engine = new NullEngine(), scene = new Scene(engine);
  engine.getCaps().instancedArrays = true;
  const models = new Map<string, ModelRuntimeEntry>();
  const moving = new Map<ModelRuntimeEntry, Mesh>();
  const fixed = new Map<string, Mesh[]>();
  const visible = new Map<string, boolean>(), pickable = new Map<string, boolean>();
  const mapping = new Map<number, unknown>();
  let changed = 0, batchAdds = 0, safe = true;
  let changedCallback: (() => void) | null = null;
  let batchAddedCallback: ((batch: NonNullable<ReturnType<typeof EntityArrayThinInstanceBatch.create>>) => void) | null = null;
  const controlledTargets = new Set<BaseTexture>();
  const document = { sceneSettings: { lighting: { version: 2, bake: { enabled: true }, result: null } } } as unknown as SceneDocument;
  for (const [index, id] of ['a', 'b'].entries()) {
    const root = new TransformNode(id, scene), contentRoot = new TransformNode('content', scene);
    root.position.x = index * 5; contentRoot.parent = root;
    const meshes = parts.map((name, part) => {
      const mesh = CreateBox(name, {}, scene); mesh.parent = contentRoot; mesh.position.z = part * 3;
      const material = new StandardMaterial(id + ':' + name, scene); material.diffuseColor = new Color3(.2, .4, .6);
      mesh.material = material; return mesh;
    });
    const dynamic = CreateBox('moving', {}, scene); dynamic.parent = contentRoot;
    const model = { root, contentRoot, meshes: [...meshes, dynamic], measurementReady: true,
      externalScriptStarting: false, parameterSignature: 'same', assetRevision: 'same',
      entitySnapshot: { components: { modelAsset: { assetCode: id } } },
    } as unknown as ModelRuntimeEntry;
    models.set(id, model); moving.set(model, dynamic); fixed.set(id, meshes);
  }
  beforeRuntime?.(scene);
  const sourceProvider = scene.getActiveMeshCandidates;
  const sourceFreeze = scene.freezeActiveMeshes, sourceUnfreeze = scene.unfreezeActiveMeshes;
  const runtime = new MotionStaticBatchRuntime(scene, {
    getDocument: () => document, getModels: () => models,
    getMotionTargets: model => ({ known: true, moving: [moving.get(model)!], fixed: [model.contentRoot] }),
    isEntityVisible: id => visible.get(id) !== false, isEntityPickable: id => pickable.get(id) !== false,
    isSceneSafe: () => safe,
    isRenderTargetControlled: texture => controlledTargets.has(texture),
    onBatchAdded: batch => { batchAdds++; for (const mesh of batch.meshes) mapping.set(mesh.uniqueId, batch); batchAddedCallback?.(batch); },
    onBatchRemoved: batch => { for (const [id, value] of mapping) if (value === batch) mapping.delete(id); },
    onChanged: () => { changed += 1; changedCallback?.(); },
  }, enabled);
  const frame = () => scene.onBeforeActiveMeshesEvaluationObservable.notifyObservers(scene);
  return { engine, scene, runtime, models, fixed, moving, document, visible, pickable, mapping, frame, sourceProvider, sourceFreeze, sourceUnfreeze,
    get changed() { return changed; }, unsafe() { safe = false; },
    get batchAdds() { return batchAdds; },
    controlTarget(texture: BaseTexture) { controlledTargets.add(texture); },
    onChanged(callback: (() => void) | null) { changedCallback = callback; },
    onBatchAdded(callback: typeof batchAddedCallback) { batchAddedCallback = callback; },
    dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}
function candidateMeshes(scene: Scene) { const result = scene.getActiveMeshCandidates(); return result.data.slice(0, result.length); }

function countedSharedMaterial(f: ReturnType<typeof fixture>) {
  const material = f.fixed.get('a')![0].material as StandardMaterial;
  for (const meshes of f.fixed.values()) for (const mesh of meshes) mesh.material = material;
  let reads = 0, serializes = 0, value = material.alphaCutOff;
  Object.defineProperty(material, 'alphaCutOff', { configurable: true, get: () => { reads++; return value; }, set: next => { value = next; } });
  const serialize = material.serialize.bind(material);
  material.serialize = () => { serializes++; return serialize(); };
  return { material, get reads() { return reads; }, get serializes() { return serializes; }, reset() { reads = serializes = 0; } };
}

test('共享Material的八个part每layout只serialize一次和capture一次，每个独立边界仍新读一次', () => {
  const f = fixture(['rail', 'track', 'frame', 'bracket']);
  try {
    const counted = countedSharedMaterial(f);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 4);
    assert.equal(counted.serializes, 1); assert.equal(counted.reads, 2, 'serialize getter一次，加初始watch一次；decorator/leaf不重复');
    counted.reset(); f.frame(); assert.equal(counted.reads, 1, '单次beforeActive共享同watch结果');
    candidateMeshes(f.scene); assert.equal(counted.reads, 2, 'provider边界必须重新读，不能复用之前边界');
    f.scene.onBeforeRenderTargetsRenderObservable.notifyObservers(f.scene);
    assert.equal(counted.reads, 3, 'RTT边界仍有自己的新读取');
    f.runtime.sync(); assert.equal(counted.serializes, 0, '相同layout继续使用原watch');
    f.models.get('b')!.parameterSignature = 'new-layout'; f.runtime.sync();
    assert.equal(counted.serializes, 1, '新layout必须重新serialize/capture，不能跨build缓存');
  } finally { f.dispose(); }
});

test('两校验边界之间共享材质改变仍由下一provider同帧归还所有原件', () => {
  const f = fixture(['rail', 'track', 'frame', 'bracket']);
  try {
    const counted = countedSharedMaterial(f); f.runtime.sync();
    const carriers = f.runtime.getBatchesForEntity('a').flatMap(batch => [...batch.meshes]);
    counted.reset(); f.frame(); assert.equal(counted.reads, 1);
    counted.material.alphaCutOff += .1; counted.reset();
    const candidates = candidateMeshes(f.scene);
    assert.equal(counted.reads, 1); assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.ok([...f.fixed.values()].flat().every(mesh => candidates.includes(mesh)));
    assert.ok(carriers.every(mesh => mesh.isDisposed() && !candidates.includes(mesh)));
  } finally { f.dispose(); }
});

test('mutation结束遍历只memo本次共享watch，下一mutation重新读并捕捉材质变化', () => {
  const f = fixture(['rail', 'track', 'frame', 'bracket']);
  try {
    const counted = countedSharedMaterial(f); f.runtime.sync(); const model = f.models.get('a')!;
    counted.reset(); f.runtime.beginModelMutation(model); f.runtime.endModelMutation(model);
    assert.equal(counted.reads, 1); assert.equal(f.runtime.getDiagnostics().groups, 4);
    counted.material.alphaCutOff += .1; counted.reset();
    f.runtime.beginModelMutation(model); f.runtime.endModelMutation(model);
    assert.equal(counted.reads, 1); assert.equal(f.runtime.getDiagnostics().groups, 0);
  } finally { f.dispose(); }
});

test('相同值的独立Material各自完整读取，不按序列化内容共用watch', () => {
  const f = fixture(['rail', 'track']);
  try {
    const counts: number[] = [];
    for (const mesh of [...f.fixed.values()].flat()) {
      const index = counts.length, material = mesh.material as StandardMaterial; counts.push(0);
      let value = material.alphaCutOff;
      Object.defineProperty(material, 'alphaCutOff', { configurable: true, get: () => { counts[index]++; return value; }, set: next => { value = next; } });
    }
    f.runtime.sync(); counts.fill(0); f.frame(); assert.deepEqual(counts, [1, 1, 1, 1]);
    counts.fill(0); (f.fixed.get('b')![1].material as StandardMaterial).alphaCutOff += .1; counts.fill(0);
    candidateMeshes(f.scene); assert.deepEqual(counts, [1, 1, 1, 1]); assert.equal(f.runtime.getDiagnostics().groups, 0);
  } finally { f.dispose(); }
});

test('GetMergedStore已覆盖的Cube Matrix leaf每次共享watch只读一次', t => {
  const f = fixture(['rail', 'track']);
  try {
    const internal = f.engine.createRawTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, false, false, Texture.NEAREST_SAMPLINGMODE);
    internal.isReady = true; internal.isCube = true;
    const texture = new CubeTexture('', f.scene); texture.name = 'matrix-reader'; Reflect.set(texture, '_texture', internal);
    const material = new PBRMaterial('shared-matrix-material', f.scene); material.reflectionTexture = texture;
    for (const mesh of [...f.fixed.values()].flat()) mesh.material = material;
    const matrix = texture.getReflectionTextureMatrix(), asArray = matrix.asArray; let reads = 0;
    t.mock.method(matrix, 'asArray', function (this: Matrix) { reads++; return asArray.call(this); });
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 2);
    reads = 0; f.frame(); assert.equal(reads, 1, 'decorator已监视Matrix数值时schema leaf不能重复加reader');
    candidateMeshes(f.scene); assert.equal(reads, 2, '下一边界仍须重新取Matrix数值');
  } finally { f.dispose(); }
});

test('共享Material初始化失败只serialize一次且保持原件，下次layout重新检查', () => {
  const f = fixture(['rail', 'track', 'frame', 'bracket']);
  try {
    const counted = countedSharedMaterial(f), serialize = counted.material.serialize;
    counted.material.serialize = () => ({ ...serialize(), unknownRenderField: true });
    f.runtime.sync(); assert.equal(counted.serializes, 1); assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.match(f.runtime.getDiagnostics().fallbackReason, /unknownRenderField/);
    assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
    counted.material.serialize = serialize; f.models.get('a')!.parameterSignature = 'retry-material-layout';
    f.runtime.sync(); assert.equal(counted.serializes, 2); assert.equal(f.runtime.getDiagnostics().groups, 4);
  } finally { f.dispose(); }
});

function addPendingModel(f: ReturnType<typeof fixture>, id: string) {
  const root = new TransformNode(id, f.scene), contentRoot = new TransformNode('content', f.scene); contentRoot.parent = root;
  root.position.x = f.models.size * 5;
  const mesh = CreateBox('rail', {}, f.scene); mesh.parent = contentRoot;
  const material = new StandardMaterial(id + ':rail', f.scene); material.diffuseColor = new Color3(.2, .4, .6); mesh.material = material;
  const moving = CreateBox('moving', {}, f.scene); moving.parent = contentRoot;
  const model = { root, contentRoot, meshes: [mesh, moving], measurementReady: false, externalScriptStarting: true,
    parameterSignature: 'same', assetRevision: 'same', entitySnapshot: { components: { modelAsset: { assetCode: id } } },
  } as unknown as ModelRuntimeEntry;
  f.models.set(id, model); f.fixed.set(id, [mesh]); f.moving.set(model, moving); return model;
}

test('N模型渐进ready期间不创建hybrid，allReady后一次创建并正常真实render', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    for (let index = 0; index < 6; index++) addPendingModel(f, 'pending-' + index);
    for (const model of f.models.values()) { model.measurementReady = false; model.externalScriptStarting = true; }
    for (const meshes of f.fixed.values()) for (const mesh of meshes) (mesh.material as StandardMaterial).disableLighting = true;
    (f.scene.defaultMaterial as StandardMaterial).disableLighting = true;
    const models = [...f.models.values()];
    for (let index = 0; index < models.length; index++) {
      models[index].measurementReady = true; models[index].externalScriptStarting = false;
      f.runtime.sync();
      if (index < models.length - 1) {
        assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.batchAdds, 0, 'pending阶段不能为已ready子集反复创建batch');
        assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
      }
    }
    assert.equal(f.runtime.getDiagnostics().groups, 1); assert.equal(f.batchAdds, 1);
    await prepareRender(f); f.runtime.sync(); f.runtime.sync(); assert.equal(f.batchAdds, 1);
    const rendered: Mesh[] = [], render = Mesh.prototype.render;
    t.mock.method(Mesh.prototype, 'render', function (this: Mesh, ...args: Parameters<Mesh['render']>) { rendered.push(this); return render.apply(this, args); });
    f.scene.render();
    assert.equal(f.runtime.getDiagnostics().groups, 1); assert.equal(f.batchAdds, 1);
    assert.ok(f.runtime.getBatchesForEntity('a')[0].meshes.some(mesh => rendered.includes(mesh)));
  } finally { f.dispose(); }
});

test('ready后追加pending模型先归还原件，measurementReady与script starting均结束后只重建一次', () => {
  const f = fixture();
  try {
    f.runtime.sync(); const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes]; assert.equal(f.batchAdds, 1);
    const pending = addPendingModel(f, 'late-pending');
    f.runtime.sync(); f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.batchAdds, 1);
    assert.ok(carriers.every(mesh => mesh.isDisposed()));
    assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
    pending.measurementReady = true; f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    pending.externalScriptStarting = false; f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1); assert.equal(f.batchAdds, 2);
    f.runtime.sync(); assert.equal(f.batchAdds, 2); assert.equal(f.runtime.getDiagnostics().fallbackCount, 0);
  } finally { f.dispose(); }
});

test('失败模型不冒充ready候选，也不把无错误模型永久卡在初始化门禁', () => {
  for (const error of ['readiness', 'runtime'] as const) {
    const f = fixture();
    try {
      const failed = addPendingModel(f, 'failed');
      if (error === 'readiness') failed.readinessError = 'expected initialization failure';
      else failed.externalScriptRuntime = { getInitializationError: () => new Error('expected initialization failure') } as unknown as ModelRuntimeEntry['externalScriptRuntime'];
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
      assert.equal(f.runtime.getBatchesForEntity('failed').length, 0); assert.equal(f.runtime.getDiagnostics().candidateParts, 2);
      assert.ok(f.fixed.get('failed')!.every(mesh => candidateMeshes(f.scene).includes(mesh)));
    } finally { f.dispose(); }
  }
});

test('相同完整几何和渲染语义跨设备合批，原层级、材料与运动Mesh保持', () => {
  const f = fixture();
  try {
    f.models.get('a')!.sourceUrl = 'editor-asset://library/resource-a.glb';
    f.models.get('a')!.assetRevision = 'revision-a';
    f.models.get('b')!.sourceUrl = 'editor-asset://library/resource-b.glb';
    f.models.get('b')!.assetRevision = 'revision-b';
    const parents = [...f.fixed.values()].flat().map(mesh => mesh.parent);
    const materials = [...f.fixed.values()].flat().map(mesh => mesh.material);
    const originalMeshes = [...f.scene.meshes];
    f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().groups, 1, JSON.stringify(f.runtime.getDiagnostics()));
    assert.equal(f.runtime.getDiagnostics().suspendedMeshes, 2);
    assert.deepEqual([...f.fixed.values()].flat().map(mesh => mesh.parent), parents);
    assert.deepEqual([...f.fixed.values()].flat().map(mesh => mesh.material), materials);
    assert.deepEqual(f.scene.meshes.slice(0, originalMeshes.length), originalMeshes, '原对象及原有集合顺序始终可查');
    const candidates = candidateMeshes(f.scene);
    for (const [id, model] of f.models) {
      assert.equal(model.meshes.length, 2); assert.ok(f.scene.meshes.includes(f.moving.get(model)!));
      assert.ok(f.runtime.isSuspended(f.fixed.get(id)![0]));
      assert.ok(f.fixed.get(id)![0].isEnabled());
      assert.ok(f.scene.meshes.includes(f.fixed.get(id)![0]));
      assert.ok(!candidates.includes(f.fixed.get(id)![0])); assert.ok(candidates.includes(f.moving.get(model)!));
    }
    const batch = f.runtime.getBatchesForEntity('a')[0];
    assert.deepEqual(batch.getLightingInstances().map(instance => [instance.entityId, instance.worldMatrix.m[12]]), [['a', 0], ['b', 5]]);
    assert.equal(f.mapping.size, batch.meshes.length);
    assert.equal(f.runtime.getBatchForMesh(batch.meshes[0]), batch);
    assert.equal(f.runtime.getSourceMeshForEntity(batch, 'a'), f.fixed.get('a')![0]);
    assert.equal(f.runtime.getSourceMeshForEntity(batch, 'b'), f.fixed.get('b')![0]);
  } finally { f.dispose(); }
});

for (const different of ['color', 'position', 'normal', 'uv', 'drawing'] as const) {
  test(`相同参数与assetRevision但${different}不同不能合批`, () => {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0];
      if (different === 'color') (mesh.material as StandardMaterial).diffuseColor.r = .8;
      else if (different === 'drawing') mesh.receiveShadows = !f.fixed.get('a')![0].receiveShadows;
      else {
        const kind = different === 'position' ? VertexBuffer.PositionKind : different === 'normal' ? VertexBuffer.NormalKind : VertexBuffer.UVKind;
        const values = [...mesh.getVerticesData(kind)!]; values[0] += .2; mesh.setVerticesData(kind, values);
      }
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.ok(f.scene.meshes.includes(mesh));
    } finally { f.dispose(); }
  });
}

test('同设备相同几何的左右结构分别成组，每组不重复entityId，拾取与选择完整', () => {
  const f = fixture(['left', 'right']);
  try {
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 2);
    for (const batch of f.runtime.getBatchesForEntity('a')) {
      assert.deepEqual(batch.getEntityIds(), ['a', 'b']);
      assert.equal(batch.getEntityIdForThinInstance(batch.meshes[0], 0), 'a');
      assert.equal(batch.getEntityIdForThinInstance(batch.meshes[0], 1), 'b');
    }
  } finally { f.dispose(); }
});

test('运动部件继续独立运动，根变换与显隐拾取更新权威实例矩阵', () => {
  const f = fixture();
  try {
    f.runtime.sync(); const batch = f.runtime.getBatchesForEntity('a')[0];
    const model = f.models.get('a')!; f.moving.get(model)!.position.y = 9; model.root.position.x = 11;
    f.frame();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
    assert.equal(f.moving.get(model)!.position.y, 9);
    assert.equal(batch.getLightingInstances().find(instance => instance.entityId === 'a')!.worldMatrix.m[12], 11);
    f.visible.set('a', false); f.pickable.set('b', false); f.frame();
    assert.deepEqual(batch.getLightingInstances().map(instance => instance.entityId), ['b']);
    assert.equal(batch.hasPickableEntities(), false);
    f.visible.set('a', true); f.frame();
    assert.equal(batch.hasPickableEntities(), true);
  } finally { f.dispose(); }
});

for (const mutation of ['material', 'local', 'parent', 'geometry', 'geometry-pointer', 'script'] as const) {
  test(`${mutation}变化在同帧恢复原始Mesh并退出当前model，后续sync不重新捕获`, () => {
    const f = fixture();
    try {
      const model = f.models.get('b')!, mesh = f.fixed.get('b')![0];
      let originalCalls = 0;
      const previous = () => { originalCalls += 1; };
      mesh.geometry!.onGeometryUpdated = previous;
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
      if (mutation === 'material') (mesh.material as StandardMaterial).diffuseColor.g = .9;
      if (mutation === 'local') mesh.position.y += 1;
      if (mutation === 'parent') model.contentRoot.position.z += 1;
      if (mutation === 'geometry') {
        const vertices = [...mesh.getVerticesData(VertexBuffer.PositionKind)!]; vertices[0] += 1;
        mesh.updateVerticesData(VertexBuffer.PositionKind, vertices);
        assert.ok(originalCalls > 0, '原geometry回调必须继续执行');
      }
      if (mutation === 'geometry-pointer') mesh.geometry!.copy('replaced').applyToMesh(mesh);
      if (mutation === 'script') f.runtime.markModelDirty(model);
      f.frame(); f.runtime.sync();
      assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.ok(f.scene.meshes.includes(mesh)); assert.equal(f.runtime.isSuspended(mesh), false);
      assert.equal(f.mapping.size, 0);
      assert.ok(f.runtime.getDiagnostics().fallbackCount > 0);
    } finally { f.dispose(); }
  });
}

test('GI结果和capture暂停恢复原布局，默认enabled待烘设置允许接管且不修改配置', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.document);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    f.runtime.setSuspended(true); f.runtime.setSuspended(false); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.equal(f.runtime.getDiagnostics().suspended, true);
    assert.equal(JSON.stringify(f.document), before);
    assert.ok([...f.fixed.values()].flat().every(mesh => f.scene.meshes.includes(mesh)));
  } finally { f.dispose(); }
  const baked = fixture();
  try {
    baked.document.sceneSettings.lighting.result = { version: 1 } as never;
    baked.runtime.sync(); assert.equal(baked.runtime.getDiagnostics().groups, 0);
  } finally { baked.dispose(); }
});

test('删除、未知scene回调和dispose均恢复源并释放所有载体及geometry监听', () => {
  const f = fixture();
  try {
    const mesh = f.fixed.get('a')![0], geometry = mesh.geometry!, previous = geometry.onGeometryUpdated;
    f.runtime.sync(); const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes];
    f.models.delete('b'); f.frame();
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(f.scene.meshes.includes(mesh));
    assert.ok(carriers.every(carrier => carrier.isDisposed())); assert.equal(geometry.onGeometryUpdated, previous);
    f.unsafe(); f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    f.runtime.dispose(); f.runtime.dispose(); assert.equal(f.mapping.size, 0);
  } finally { f.dispose(); }
});

test('透明、蒙皮、Morph、内部thinInstance、复杂subMesh与shear保持原始渲染路径', () => {
  for (const kind of ['alpha', 'skin', 'morph', 'submesh', 'thin', 'shear']) {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0];
      if (kind === 'alpha') mesh.material!.alpha = .5;
      if (kind === 'skin') mesh.skeleton = new Skeleton('skin', 'skin', f.scene);
      if (kind === 'morph') {
        const manager = new MorphTargetManager(f.scene), target = new MorphTarget('morph', 1, f.scene);
        target.setPositions(mesh.getVerticesData(VertexBuffer.PositionKind)!); manager.addTarget(target); mesh.morphTargetManager = manager;
      }
      if (kind === 'submesh') new SubMesh(0, 0, mesh.getTotalVertices(), 0, mesh.getTotalIndices(), mesh);
      if (kind === 'thin') mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Identity().asArray()), 16, false);
      if (kind === 'shear') { f.models.get('b')!.root.scaling.set(2, 1, 1); mesh.rotation.y = .4; }
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.ok(f.scene.meshes.includes(mesh));
    } finally { f.dispose(); }
  }
});

test('PBR内置渲染配置受精确比较和监视，不同纹理URL或纹理名不会错误合批', () => {
  for (const difference of ['same', 'url', 'name', 'pbr-roughness'] as const) {
    const f = fixture();
    try {
      const internal = f.engine.createRawTexture(new Uint8Array([255, 0, 0, 255]), 1, 1,
        Constants.TEXTUREFORMAT_RGBA, false, false, Texture.NEAREST_SAMPLINGMODE);
      internal.isReady = true;
      for (const [id, meshes] of f.fixed) {
        const material = new PBRMaterial(id, f.scene);
        const texture = new Texture(null, f.scene);
        texture.name = difference === 'name' && id === 'b' ? 'other-name' : 'same-name';
        texture.url = difference === 'url' && id === 'b' ? 'other.png' : 'same.png';
        // NullEngine 不加载 GPU 图像；此处只构造已解码纹理身份与真实序列化字段的 CPU 合同。
        Reflect.set(texture, '_texture', internal);
        material.albedoTexture = texture;
        if (difference === 'pbr-roughness' && id === 'b') material.roughness = .7;
        meshes[0].material = material;
      }
      f.runtime.sync();
      assert.equal(f.runtime.getDiagnostics().groups, difference === 'same' ? 1 : 0, JSON.stringify(f.runtime.getDiagnostics()));
      if (difference === 'same') {
        (f.fixed.get('b')![0].material as PBRMaterial).roughness = .75;
        f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 0, '原serialize省略的null字段变化也必须退出合批');
      }
    } finally { f.dispose(); }
  }
});

test('同名glTF嵌入占位纹理按真实InternalTexture身份分组，共享internal wrapper可合批且同URL换buffer立即回退', () => {
  for (const shared of [false, true]) {
    const f = fixture();
    try {
      const first = f.engine.createRawTexture(new Uint8Array([255, 0, 0, 255]), 1, 1,
        Constants.TEXTUREFORMAT_RGBA, false, false, Texture.NEAREST_SAMPLINGMODE);
      const second = shared ? first : f.engine.createRawTexture(new Uint8Array([0, 0, 255, 255]), 1, 1,
        Constants.TEXTUREFORMAT_RGBA, false, false, Texture.NEAREST_SAMPLINGMODE);
      first.isReady = second.isReady = true;
      const wrappers: Texture[] = [];
      for (const [index, id] of ['a', 'b'].entries()) {
        const texture = new Texture(null, f.scene, { internalTexture: index === 0 ? first : second });
        texture.name = texture.url = 'data:#image0'; wrappers.push(texture);
        (f.fixed.get(id)![0].material as StandardMaterial).diffuseTexture = texture;
      }
      assert.notEqual(wrappers[0], wrappers[1]);
      assert.deepEqual(wrappers[0].serialize(), wrappers[1].serialize(), '占位字段不能证明像素来源相同');
      // Babylon serialize本身会清空data URL；此回归从原GLB公开字段状态开始，controller不得留下该副作用。
      for (const texture of wrappers) texture.name = texture.url = 'data:#image0';
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, shared ? 1 : 0);
      assert.ok(wrappers.every(texture => texture.name === 'data:#image0' && texture.url === 'data:#image0'));
      if (shared) {
        const previous = wrappers[1].getInternalTexture();
        wrappers[1].updateURL('data:#image0', new Uint8Array([0, 255, 0, 255]));
        assert.equal(wrappers[1].url, wrappers[0].url); assert.notEqual(wrappers[1].getInternalTexture(), previous);
        f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 0);
        assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
      }
    } finally { f.dispose(); }
  }
});

test('真实Texture.serialize的内嵌PNG base64String只作派生导出，共享internal clone可合批且源buffer保持', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
  const otherPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  for (const shared of [true, false]) {
    const f = fixture();
    try {
      const first = new Texture('data:#image0', f.scene, { buffer: png, deleteBuffer: false });
      const second = shared ? first.clone() : new Texture('data:#different-internal', f.scene, { buffer: otherPng, deleteBuffer: false });
      Reflect.set(first.getInternalTexture()!, 'label', 'factory embedded PNG');
      Reflect.set(second.getInternalTexture()!, 'label', 'factory embedded PNG');
      assert.equal(first.getInternalTexture() === second.getInternalTexture(), shared);
      // 同一GPU纹理的clone也可携带不同导出buffer；当前渲染身份由实际InternalTexture证明。
      if (shared) Reflect.set(second, '_buffer', otherPng);
      const textures = [first, second], buffers = textures.map(texture => Reflect.get(texture, '_buffer'));
      for (const [index, id] of ['a', 'b'].entries()) {
        const texture = textures[index]; texture.name = texture.url = 'data:#image0';
        const serialized = texture.serialize(); assert.equal(serialized.base64String, buffers[index]);
        texture.name = texture.url = 'data:#image0';
        (f.fixed.get(id)![0].material as StandardMaterial).diffuseTexture = texture;
      }
      const serializeBuffers = Texture.SerializeBuffers;
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, shared ? 1 : 0, f.runtime.getDiagnostics().fallbackReason);
      assert.equal(Texture.SerializeBuffers, serializeBuffers);
      assert.deepEqual(textures.map(texture => Reflect.get(texture, '_buffer')), buffers);
      assert.ok(textures.every(texture => texture.name === 'data:#image0' && texture.url === 'data:#image0'));
      if (shared) {
        Reflect.set(first.getInternalTexture()!, 'label', 'changed debug label');
        f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 1, 'debug label变化不能伪装成GPU像素变化');
      }
    } finally { f.dispose(); }
  }
});

test('本机Texture.serialize全部手工派生字段显式枚举，内部引用ID导出不冒充render字段', () => {
  const f = fixture();
  try {
    const first = new Texture('data:#image0', f.scene, { buffer: 'data:image/png;base64,AA==', deleteBuffer: false });
    const second = first.clone(); Reflect.set(first.getInternalTexture()!, 'label', 'inspector texture label');
    const decorated = new Set(Object.entries(GetMergedStore(first)).map(([key, value]) => value.sourceName || key));
    const serialized = first.serialize();
    const derived = Object.keys(serialized).filter(key => !decorated.has(key) && !['tags', 'animations'].includes(key)).sort();
    const expected = ['base64String', 'invertY', 'samplingMode', '_creationFlags', '_useSRGBBuffer', 'internalTextureLabel', 'noMipmap'];
    if (Reflect.get(Texture, '_SerializeInternalTextureUniqueId')) expected.push('internalTextureUniqueId');
    assert.deepEqual(derived, expected.sort(), 'serializer新增派生字段必须先核对源码和live getter，再改变准入');
    for (const [index, id] of ['a', 'b'].entries()) {
      const texture = [first, second][index]; texture.name = texture.url = 'data:#image0';
      const material = f.fixed.get(id)![0].material as StandardMaterial; material.diffuseTexture = texture;
      const serialize = material.serialize.bind(material);
      material.serialize = () => {
        const result = serialize();
        // 对应primary serializer的可选内部ID分支；不修改应用全局序列化flag。
        result.diffuseTexture.internalTextureUniqueId = texture.getInternalTexture()!.uniqueId; return result;
      };
    }
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1, f.runtime.getDiagnostics().fallbackReason);
  } finally { f.dispose(); }
});

test('本机Base/Cube/HDR/EXR真实serializer字段对应live状态，HDR/EXR保持原保守准入', () => {
  const f = fixture();
  try {
    const base = new BaseTexture(f.scene), cube = new CubeTexture('', f.scene);
    for (const texture of [base, cube]) {
      texture.name = texture.getClassName(); const serialized = texture.serialize()!;
      const decorated = new Set(Object.entries(GetMergedStore(texture)).map(([key, value]) => value.sourceName || key));
      assert.deepEqual(Object.keys(serialized).filter(key => !decorated.has(key) && !['tags', 'animations'].includes(key)), []);
    }
    for (const texture of [new HDRCubeTexture('', f.scene, 1), new EXRCubeTexture('', f.scene, 1)]) {
      texture.name = texture.getClassName(); Reflect.set(texture, '_size', 1); Reflect.set(texture, '_noMipmap', false);
      const serialized = texture.serialize()!;
      assert.deepEqual(Object.keys(serialized).sort(), ['name', 'hasAlpha', 'isCube', 'level', 'size', 'coordinatesMode',
        'useInGammaSpace', 'generateHarmonics', 'noMipmap', 'isBlocking', 'rotationY', 'customType'].sort());
      assert.equal(serialized.size, Reflect.get(texture, '_size'));
      assert.equal(serialized.useInGammaSpace, texture.gammaSpace);
      assert.equal(serialized.generateHarmonics, Reflect.get(texture, '_generateHarmonics'));
      assert.equal(serialized.noMipmap, Reflect.get(texture, '_noMipmap'));
      assert.equal(serialized.isBlocking, texture.isBlocking); assert.equal(serialized.rotationY, texture.rotationY);
      assert.ok(![Texture.prototype, CubeTexture.prototype].includes(Object.getPrototypeOf(texture)), '字段映射不扩大纹理类准入');
    }
  } finally { f.dispose(); }
});

for (const field of ['invertY', 'samplingMode', 'gammaSpace', 'wrapU', 'uOffset', 'noMipmap', '_creationFlags', '_useSRGBBuffer'] as const) {
  test(`带debug label的纹理真实render getter ${field}变化仍同帧回退`, () => {
    const f = fixture();
    try {
      const first = new Texture('texture-render-watch', f.scene), second = first.clone();
      Reflect.set(first.getInternalTexture()!, 'label', 'render watch fixture');
      (f.fixed.get('a')![0].material as StandardMaterial).diffuseTexture = first;
      (f.fixed.get('b')![0].material as StandardMaterial).diffuseTexture = second;
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1, f.runtime.getDiagnostics().fallbackReason);
      if (field === 'invertY') Reflect.set(second, '_invertY', !second.invertY);
      if (field === 'samplingMode') second.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
      if (field === 'gammaSpace') second.gammaSpace = !second.gammaSpace;
      if (field === 'wrapU') second.wrapU = Texture.CLAMP_ADDRESSMODE;
      if (field === 'uOffset') second.uOffset += .25;
      if (field === 'noMipmap') Reflect.set(second, '_noMipmap', !second.noMipmap);
      if (field === '_creationFlags') Reflect.set(second, '_creationFlags', 1);
      if (field === '_useSRGBBuffer') Reflect.set(second, '_useSRGBBuffer', true);
      f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
    } finally { f.dispose(); }
  });
}

test('共享top reflection InternalTexture仍按嵌套irradiance的实际GPU身份分组与失效', () => {
  for (const sharedNested of [true, false]) {
    const f = fixture();
    try {
      const top = f.engine.createRawTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, false, false, Texture.NEAREST_SAMPLINGMODE);
      top.isReady = true; top.isCube = true;
      const nested = new Texture('nested-a', f.scene), other = sharedNested ? nested.clone() : new Texture('nested-b', f.scene);
      nested.name = nested.url = other.name = other.url = 'data:#nested-image';
      const reflections: CubeTexture[] = [];
      for (const [index, id] of ['a', 'b'].entries()) {
        const reflection = new CubeTexture('', f.scene); reflection.name = reflection.url = 'same-reflection'; Reflect.set(reflection, '_texture', top);
        Object.defineProperty(reflection, 'irradianceTexture', { configurable: true, writable: true, value: index ? other : nested });
        const material = new PBRMaterial(id, f.scene); material.reflectionTexture = reflection;
        f.fixed.get(id)![0].material = material; reflections.push(reflection);
      }
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, sharedNested ? 1 : 0, f.runtime.getDiagnostics().fallbackReason);
      assert.ok([nested, other].every(texture => texture.name === 'data:#nested-image' && texture.url === 'data:#nested-image'),
        '递归serialize后必须恢复嵌套实际纹理的原name/url');
      if (sharedNested) {
        const changed = new Texture('nested-changed', f.scene); changed.name = changed.url = 'nested-image';
        reflections[1].irradianceTexture = changed;
        f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 0);
      }
    } finally { f.dispose(); }
  }
});

test('metadata序列化快照别名实际Texture时先failclosed，不能删除任何live自定义导出字段', () => {
  const f = fixture();
  try {
    const aliased = new Texture('metadata-live-texture', f.scene);
    const fields = { base64String: 'keep live bytes', internalTextureUniqueId: 'keep live id', internalTextureLabel: 'keep live label' };
    for (const [key, value] of Object.entries(fields)) Reflect.set(aliased, key, value);
    for (const meshes of f.fixed.values()) meshes[0].material!.metadata = { aliased };
    const before = [aliased.name, aliased.url, Reflect.get(aliased, '_buffer')];
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.match(f.runtime.getDiagnostics().fallbackReason, /序列化快照.*运行时对象/);
    for (const [key, value] of Object.entries(fields)) assert.equal(Reflect.get(aliased, key), value);
    assert.deepEqual([aliased.name, aliased.url, Reflect.get(aliased, '_buffer')], before);
  } finally { f.dispose(); }
});

test('Cube序列化的typed Matrix映射实际反射矩阵，变化仍回退而不忽略数值', () => {
  const f = fixture();
  try {
    const internal = f.engine.createRawTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, false, false, Texture.NEAREST_SAMPLINGMODE);
    internal.isReady = true; internal.isCube = true;
    const cubes: CubeTexture[] = [];
    for (const id of ['a', 'b']) {
      const texture = new CubeTexture('', f.scene); texture.name = 'cube'; Reflect.set(texture, '_texture', internal);
      const material = new PBRMaterial(id, f.scene); material.reflectionTexture = texture; f.fixed.get(id)![0].material = material; cubes.push(texture);
    }
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1, f.runtime.getDiagnostics().fallbackReason);
    cubes[1].setReflectionTextureMatrix(Matrix.RotationY(.4)); f.frame();
    assert.equal(f.runtime.getDiagnostics().groups, 0);
  } finally { f.dispose(); }
});

test('仅真实BaseTexture的base64String可排除，任意未知材质或纹理渲染字段仍failclosed', () => {
  for (const unknown of ['material-field', 'material-base64String', 'material-internalTextureLabel', 'material-internalTextureUniqueId', 'texture-field'] as const) {
    const f = fixture();
    try {
      for (const [id, meshes] of f.fixed) {
        const material = meshes[0].material as StandardMaterial;
        if (unknown === 'texture-field') material.diffuseTexture = new Texture('known-' + id, f.scene);
        const serialize = material.serialize.bind(material);
        material.serialize = () => {
          const result = serialize();
          if (unknown === 'texture-field') result.diffuseTexture.unknownRenderField = 'not-observable';
          else result[unknown.startsWith('material-') && unknown !== 'material-field' ? unknown.slice('material-'.length) : 'unknownRenderField'] = 'not-observable';
          return result;
        };
      }
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.match(f.runtime.getDiagnostics().fallbackReason, /无法监视材质字段/);
      assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
    } finally { f.dispose(); }
  }
});

test('20次无外观变化的同步script更新保留批次，原Mesh始终可查且不制造add/remove事件', async () => {
  const f = fixture();
  try {
    const model = f.models.get('a')!, mesh = f.fixed.get('a')![0];
    mesh.metadata = { original: true }; const metadata = mesh.metadata;
    await new Promise(resolve => setTimeout(resolve, 0));
    const events: boolean[] = [];
    f.scene.onNewMeshAddedObservable.add(added => { if (added === mesh) events.push(f.runtime.isTemporaryMeshEvent(added)); });
    f.scene.onMeshRemovedObservable.add(removed => { if (removed === mesh) events.push(f.runtime.isTemporaryMeshEvent(removed)); });
    f.runtime.sync(); events.length = 0; const changed = f.changed;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      f.runtime.beginModelMutation(model);
      try { assert.ok(f.scene.meshes.includes(mesh)); assert.equal(mesh.metadata, metadata); }
      finally { f.runtime.endModelMutation(model); }
      assert.ok(f.scene.meshes.includes(mesh)); assert.equal(mesh.metadata, metadata);
      assert.ok(!candidateMeshes(f.scene).includes(mesh));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.runtime.getDiagnostics().groups, 1); assert.equal(f.changed, changed);
    assert.equal(events.length, 0);
    assert.equal(mesh.metadata[MOTION_STATIC_MUTATION_EVENT_FLAG], undefined);
    assert.equal(f.runtime.isTemporaryMeshEvent(mesh), false);
  } finally { f.dispose(); }
});

for (const mutation of ['color', 'vertices', 'position'] as const) {
  test(`同步script真实修改${mutation}立即回退，不影响其他设备的材质或层级`, () => {
    const f = fixture();
    try {
      const model = f.models.get('b')!, mesh = f.fixed.get('b')![0], original = f.fixed.get('a')![0];
      const color = (original.material as StandardMaterial).diffuseColor.clone(), parent = original.parent;
      f.runtime.sync(); f.runtime.beginModelMutation(model);
      try {
        if (mutation === 'color') (mesh.material as StandardMaterial).diffuseColor.r = .9;
        if (mutation === 'position') mesh.position.x += 3;
        if (mutation === 'vertices') {
          const vertices = [...mesh.getVerticesData(VertexBuffer.PositionKind)!]; vertices[0] += 1;
          mesh.updateVerticesData(VertexBuffer.PositionKind, vertices);
        }
      } finally { f.runtime.endModelMutation(model); }
      assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.ok(f.scene.meshes.includes(mesh)); assert.ok(f.scene.meshes.includes(original));
      assert.ok((original.material as StandardMaterial).diffuseColor.equals(color)); assert.equal(original.parent, parent);
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    } finally { f.dispose(); }
  });
}

test('同步script异常finally和嵌套bracket不会留下双绘制或残留metadata', () => {
  const f = fixture();
  try {
    const model = f.models.get('a')!, mesh = f.fixed.get('a')![0];
    f.runtime.sync();
    assert.throws(() => {
      f.runtime.beginModelMutation(model);
      try {
        f.runtime.beginModelMutation(model); f.runtime.endModelMutation(model);
        assert.ok(f.scene.meshes.includes(mesh)); throw new Error('script failure');
      } finally { f.runtime.endModelMutation(model); }
    }, /script failure/);
    assert.equal(f.runtime.getDiagnostics().groups, 1); assert.ok(f.scene.meshes.includes(mesh));
    assert.ok(!candidateMeshes(f.scene).includes(mesh));
    assert.equal(mesh.metadata?.[MOTION_STATIC_MUTATION_EVENT_FLAG], undefined);
    f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.dispose(); }
});

test('lighting后出现新镜像方向只恢复原几何，下一次pre-light sync才建立新载体', () => {
  const f = fixture();
  try {
    f.runtime.sync(); f.models.get('a')!.root.scaling.x = -1;
    f.frame();
    assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.ok([...f.fixed.values()].flat().every(mesh => f.scene.meshes.includes(mesh)));
    assert.equal(f.runtime.getDiagnostics().fallbackCount, 0, '仅晚到布局不永久排除合法模型');
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const batch = f.runtime.getBatchesForEntity('a')[0];
    assert.equal(batch.meshes.length, 2);
    assert.deepEqual(batch.getLightingInstances().map(instance => instance.entityId).sort(), ['a', 'b']);
  } finally { f.dispose(); }
});

test('capture挂起只在显式新sceneSession解除，同session重复同步不能恢复合批', () => {
  const f = fixture();
  try {
    f.runtime.beginSceneSession('A'); f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    f.runtime.setSuspended(true); f.runtime.beginSceneSession('A'); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.runtime.getDiagnostics().suspended, true);
    f.runtime.beginSceneSession('B'); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().groups, 1); assert.equal(f.runtime.getDiagnostics().suspended, false);
  } finally { f.dispose(); }
});

for (const mutation of ['dynamic-indices', 'vertex-update', 'vertex-directly'] as const) {
  test(`可观察动态源${mutation}先接管，公开上传前立即归还原件且不依赖Geometry通知`, () => {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0];
      if (mutation === 'dynamic-indices') mesh.setIndices([...mesh.getIndices()!], null, true);
      else mesh.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
      let notifications = 0;
      mesh.geometry!.onGeometryUpdated = () => { notifications++; };
      const vertex = mesh.getVertexBuffer(VertexBuffer.PositionKind)!, sourceBuffer = vertex.getBuffer(), indexBuffer = mesh.geometry!.getIndexBuffer();
      f.runtime.sync();
      assert.equal(f.runtime.getDiagnostics().groups, 1, '已监视公开上传入口的动态固定源可以接管');
      assert.equal(mesh.getVertexBuffer(VertexBuffer.PositionKind), vertex); assert.equal(vertex.getBuffer(), sourceBuffer);
      assert.equal(mesh.geometry!.getIndexBuffer(), indexBuffer);
      if (mutation === 'dynamic-indices') {
        const indices = [...mesh.getIndices()!]; [indices[0], indices[1]] = [indices[1], indices[0]];
        mesh.updateIndices(indices); assert.deepEqual(Array.from(mesh.getIndices()!), indices);
      } else {
        const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!]; positions[0] += 2;
        const buffer = mesh.getVertexBuffer(VertexBuffer.PositionKind)!;
        if (mutation === 'vertex-update') buffer.update(positions);
        else buffer.updateDirectly(positions, 0);
        assert.equal(mesh.getVerticesData(VertexBuffer.PositionKind)![0], positions[0]);
      }
      assert.equal(notifications, 0, '用例必须命中Babylon不发Geometry通知的公开API');
      assert.equal(f.runtime.getDiagnostics().groups, 0, '上传返回前必须归还原件');
      f.frame(); assert.ok(f.scene.meshes.includes(mesh)); assert.equal(f.runtime.isSuspended(mesh), false);
    } finally { f.dispose(); }
  });
}

for (const method of ['buffer-update', 'buffer-directly', 'engine-vertex', 'engine-index'] as const) {
  test(`${method}公开动态上传命中源DataBuffer，同步回退且保留updatable属性`, () => {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0]; mesh.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
      mesh.setIndices([...mesh.getIndices()!], null, true);
      const vertex = mesh.getVertexBuffer(VertexBuffer.PositionKind)!, buffer = vertex.getBuffer()!, indices = mesh.geometry!.getIndexBuffer()!;
      const positions = new Float32Array(mesh.getVerticesData(VertexBuffer.PositionKind)!); positions[0] += 1;
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
      if (method === 'buffer-update') vertex.getWrapperBuffer().update(positions);
      if (method === 'buffer-directly') vertex.getWrapperBuffer().updateDirectly(positions, 0);
      if (method === 'engine-vertex') f.engine.updateDynamicVertexBuffer(buffer, positions, 0, positions.byteLength);
      if (method === 'engine-index') f.engine.updateDynamicIndexBuffer(indices, mesh.getIndices()!, 0);
      assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.runtime.isSuspended(mesh), false);
      assert.equal(vertex.isUpdatable(), true); assert.equal(Reflect.get(mesh.geometry!, '_indexBufferIsUpdatable'), true);
      assert.equal(vertex.getBuffer(), buffer); assert.equal(mesh.geometry!.getIndexBuffer(), indices);
    } finally { f.dispose(); }
  });
}

test('共享GPU源buffer的不同Geometry全部退出；无关carrier/其他buffer上传不触发回退', () => {
  const f = fixture();
  try {
    const a = f.fixed.get('a')![0], b = f.fixed.get('b')![0];
    a.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
    b.setVerticesBuffer(a.getVertexBuffer(VertexBuffer.PositionKind)!);
    assert.notEqual(a.geometry, b.geometry); assert.equal(a.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer(), b.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer());
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const unrelated = f.engine.createDynamicVertexBuffer(new Float32Array([1, 2, 3]));
    f.engine.updateDynamicVertexBuffer(unrelated, new Float32Array([4, 5, 6]));
    assert.equal(f.runtime.getDiagnostics().groups, 1); assert.equal(f.runtime.getDiagnostics().fallbackCount, 0);
    a.getVertexBuffer(VertexBuffer.PositionKind)!.updateDirectly(new Float32Array(a.getVerticesData(VertexBuffer.PositionKind)!), 0);
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.runtime.getDiagnostics().fallbackCount, 2);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0, '共享buffer所有宿主都必须永久退出本对象接管');
  } finally { f.dispose(); }
});

test('公开engine上传delegate在原生调用前退出，保留this/args/返回/异常；释放及外部覆盖不抢入口', t => {
  for (const method of ['updateDynamicVertexBuffer', 'updateDynamicIndexBuffer', 'updateAndBindInstancesBuffer', 'updateUniformBuffer', 'updateArrayBuffer'] as const) {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0]; mesh.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
      const buffer = mesh.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer()!;
      const result = { method }, error = new Error(method); let fail = false;
      const original = Reflect.get(f.engine, method);
      const delegate = function (this: unknown, ...args: unknown[]) {
        const target = method === 'updateArrayBuffer' ? Reflect.get(f.engine, '_currentBoundBuffer')[34962] : args[0];
        if (target !== buffer) return original.apply(this, args);
        assert.equal(this, f.engine); assert.equal(f.runtime.getDiagnostics().groups, 0);
        assert.equal(f.runtime.isSuspended(mesh), false); assert.equal(args[0], method === 'updateArrayBuffer' ? data : buffer);
        if (fail) throw error; return result;
      };
      const data = new Float32Array([1, 2, 3]);
      t.mock.method(f.engine, method, delegate);
      const nativeEntry = Reflect.get(f.engine, method);
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
      if (method === 'updateArrayBuffer') Reflect.get(f.engine, '_currentBoundBuffer')[34962] = buffer;
      const invoke = () => Reflect.get(f.engine, method).apply(f.engine, method === 'updateArrayBuffer' ? [data] : [buffer, data, 0, 12]);
      assert.equal(invoke(), result); assert.equal(Reflect.get(f.engine, method), nativeEntry, '最后订阅释放后恢复原入口');
      fail = true; assert.throws(invoke, value => value === error);
      // 新fixture单独检验仍持有订阅时的外部覆盖，避免把同一model的永久optOut误作观测证明。
    } finally { f.dispose(); }
    const replaced = fixture();
    try {
      replaced.runtime.sync(); const external = () => undefined;
      Reflect.set(replaced.engine, method, external); replaced.frame();
      assert.equal(replaced.runtime.getDiagnostics().groups, 0);
      replaced.runtime.sync(); assert.equal(replaced.runtime.getDiagnostics().groups, 0);
      replaced.runtime.dispose(); assert.equal(Reflect.get(replaced.engine, method), external);
    } finally { replaced.dispose(); }
  }
});

test('多个订阅共享engine wrapper，单个释放不影响其他源，最后释放恢复精确入口', () => {
  const f = fixture();
  try {
    const firstBuffer = f.engine.createDynamicVertexBuffer([0, 0, 0]), secondBuffer = f.engine.createDynamicVertexBuffer([1, 1, 1]);
    const original = f.engine.updateDynamicVertexBuffer; let first = 0, second = 0;
    const a = subscribeLightingBufferUploads(f.engine, [firstBuffer], () => { first++; });
    const wrapper = f.engine.updateDynamicVertexBuffer;
    const b = subscribeLightingBufferUploads(f.engine, [secondBuffer], () => { second++; });
    assert.equal(f.engine.updateDynamicVertexBuffer, wrapper);
    f.engine.updateDynamicVertexBuffer(firstBuffer, [2, 2, 2]); assert.deepEqual([first, second], [1, 0]);
    a.release(); assert.equal(f.engine.updateDynamicVertexBuffer, wrapper); assert.equal(b.isCurrent(), true);
    f.engine.updateDynamicVertexBuffer(firstBuffer, [3, 3, 3]); f.engine.updateDynamicVertexBuffer(secondBuffer, [4, 4, 4]);
    assert.deepEqual([first, second], [1, 1]); b.release(); b.release();
    assert.equal(f.engine.updateDynamicVertexBuffer, original);
  } finally { f.dispose(); }
});

test('updateArrayBuffer回退通知改变GL绑定时，delegate前恢复原源绑定；外部替换binder则保守退出', t => {
  const f = fixture();
  try {
    const source = f.fixed.get('b')![0].getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer()!;
    const other = f.engine.createDynamicVertexBuffer([1, 2, 3]), cache = Reflect.get(f.engine, '_currentBoundBuffer');
    let binds = 0;
    t.mock.method(f.engine, 'bindArrayBuffer', function (buffer) { binds++; cache[34962] = buffer; });
    t.mock.method(f.engine, 'updateArrayBuffer', function (this: NullEngine, data) {
      assert.equal(this, f.engine); assert.equal(cache[34962], source); assert.equal(data, upload); return token;
    });
    const upload = new Float32Array([3, 2, 1]), token = { uploaded: true };
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    f.onChanged(() => { cache[34962] = other; }); cache[34962] = source;
    assert.equal(Reflect.get(f.engine, 'updateArrayBuffer').call(f.engine, upload), token);
    assert.equal(binds, 1); assert.equal(cache[34962], source); assert.equal(f.runtime.getDiagnostics().groups, 0);
  } finally { f.onChanged(null); f.dispose(); }
  const replaced = fixture();
  try {
    replaced.runtime.sync(); const external = () => undefined;
    replaced.engine.bindArrayBuffer = external; replaced.frame();
    assert.equal(replaced.runtime.getDiagnostics().groups, 0); replaced.runtime.sync();
    assert.equal(replaced.runtime.getDiagnostics().groups, 0);
    replaced.runtime.dispose(); assert.equal(replaced.engine.bindArrayBuffer, external);
  } finally { replaced.dispose(); }
});

test('WebGPU或不可包装的公开上传入口保持原动态源，不伪称完整可观测', () => {
  for (const unavailable of ['webgpu', 'readonly'] as const) {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0]; mesh.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
      if (unavailable === 'webgpu') Reflect.set(f.engine, '_isWebGPU', true);
      else Object.defineProperty(f.engine, 'updateDynamicVertexBuffer', { value: f.engine.updateDynamicVertexBuffer, configurable: false });
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.equal(f.runtime.isSuspended(mesh), false); assert.equal(mesh.getVertexBuffer(VertexBuffer.PositionKind)!.isUpdatable(), true);
    } finally { Reflect.set(f.engine, '_isWebGPU', false); f.dispose(); }
  }
});

test('已合批后Geometry通知被覆盖或静态索引转dynamic，同帧恢复源和回调所有权', () => {
  for (const mutation of ['callback', 'indices']) {
    const f = fixture();
    try {
      const mesh = f.fixed.get('b')![0];
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
      const external = () => undefined;
      if (mutation === 'callback') mesh.geometry!.onGeometryUpdated = external;
      else mesh.updateIndices([...mesh.getIndices()!]);
      f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(f.scene.meshes.includes(mesh));
      if (mutation === 'callback') assert.equal(mesh.geometry!.onGeometryUpdated, external);
    } finally { f.dispose(); }
  }
});

test('公开setIndexBuffer绕过Geometry通知时，检测GPU索引buffer替换并回退', () => {
  const f = fixture();
  try {
    const mesh = f.fixed.get('b')![0];
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const indices = [...mesh.getIndices()!]; [indices[0], indices[1]] = [indices[1], indices[0]];
    const buffer = f.engine.createIndexBuffer(indices);
    mesh.geometry!.setIndexBuffer(buffer, mesh.getTotalVertices(), indices.length);
    f.frame(); assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(f.scene.meshes.includes(mesh));
  } finally { f.dispose(); }
});

// 从固定工厂scene中摘录的登记关系；类名是Params/Runtime配对，并不是同名动画与参数类。
const factoryScriptMetadata = [
  { file: 'newchain-conveyor.model.ts', devType: 'conveyor' },
  { file: 'newgd-motor-optimized.model.ts', devType: 'conveyor' },
  { file: 'stacker.model.ts', devType: 'stacker' },
  { file: 'newrgv.model.ts', devType: 'rgv' },
];
function configureFactoryMetadata(f: ReturnType<typeof fixture>, file: string, devType: string) {
  for (const model of f.models.values()) {
    model.entitySnapshot!.components.modelAsset = { assetCode: model.root.name,
      scriptAssets: [{ name: file, path: file, sourceUrl: 'editor-asset://fixture/' + file }],
      parameterScriptMetadata: [{ scriptFilename: file, className: 'ParametricModelParamsComponent' }],
      animationScriptMetadata: [{ scriptFilename: file, className: 'ParametricModelRuntimeComponent' }],
    } as never;
    model.externalScriptRuntime = { getDataDrivenConfigs: () => [{ device: { devType } }], getInitializationError: () => null } as never;
  }
}
for (const metadata of factoryScriptMetadata) {
  test(`工厂真实${metadata.file}参数/运行类登记配对可候选，仍保留每台运动对象`, () => {
    const f = fixture();
    try {
      configureFactoryMetadata(f, metadata.file, metadata.devType);
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1, JSON.stringify(f.runtime.getDiagnostics()));
      for (const model of f.models.values()) assert.ok(f.scene.meshes.includes(f.moving.get(model)!));
    } finally { f.dispose(); }
  });
}
for (const invalid of ['unknown-class', 'wrong-file', 'missing-params', 'missing-config']) {
  test(`参数登记准入仍拒绝${invalid}，不能只移除animation长度门禁`, () => {
    const f = fixture();
    try {
      configureFactoryMetadata(f, factoryScriptMetadata[0].file, 'conveyor');
      const model = f.models.get('b')!, asset = model.entitySnapshot!.components.modelAsset!;
      if (invalid === 'unknown-class') asset.animationScriptMetadata!.push({ scriptFilename: factoryScriptMetadata[0].file, className: 'UnknownAnimationComponent' } as never);
      if (invalid === 'wrong-file') asset.animationScriptMetadata![0].scriptFilename = 'other.model.ts';
      if (invalid === 'missing-params') asset.parameterScriptMetadata = [];
      if (invalid === 'missing-config') model.externalScriptRuntime = { getDataDrivenConfigs: () => [], getInitializationError: () => null } as never;
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(f.scene.meshes.includes(f.fixed.get('b')![0]));
    } finally { f.dispose(); }
  });
}

test('真实光照分类与controller共享Geometry通知，20frame保留batch且真实几何改写仍回退', () => {
  const f = fixture();
  let lighting: InstanceType<typeof SceneLightingRuntime> | null = null;
  try {
    const entities = Object.fromEntries([...f.models].map(([id, model]) => {
      const entity = { id, name: id, parentId: null, childrenIds: [], components: { ...model.entitySnapshot!.components } };
      model.entitySnapshot = entity as never; return [id, entity];
    }));
    Object.assign(f.document, { id: 'geometry-subscriptions', entityIds: [...f.models.keys()], entities });
    lighting = new SceneLightingRuntime(f.scene, {
      getSources: () => collectLightingRuntimeSources({ scene: f.scene, document: f.document, models: f.models,
        primitiveMeshes: new Map(), environment: [], batches: new Set(f.runtime.getBatchesForEntity('a')),
        resolveBatchSource: (batch, id, source) => f.runtime.getSourceMeshForEntity(batch, id) ?? source,
        getMotionTargets: model => ({ known: true, moving: [f.moving.get(model)!], fixed: [model.contentRoot] }),
        readEntityId: () => null }),
      setShadowRoles: () => undefined, pushLog: () => undefined,
    });
    f.onChanged(() => { lighting!.markDirty(); lighting!.sync(f.document); });
    // 首次lighting分类刻意晚于controller建组，覆盖非代表B模型才新装identity监听的碰撞顺序。
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const group = f.runtime.getBatchesForEntity('a')[0];
    for (let frame = 0; frame < 20; frame++) {
      f.scene.onBeforeRenderObservable.notifyObservers(f.scene); f.frame();
      assert.equal(f.runtime.getDiagnostics().groups, 1, '已知光照订阅不能被当作外部覆盖');
      assert.equal(f.runtime.getBatchesForEntity('a')[0], group);
    }
    const source = f.fixed.get('b')![0], positions = [...source.getVerticesData(VertexBuffer.PositionKind)!];
    positions[0] += 1; source.setVerticesData(VertexBuffer.PositionKind, positions, false);
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(f.scene.meshes.includes(source));
    assert.equal(lighting.getError(), null);
  } finally { f.onChanged(null); lighting?.dispose(); f.dispose(); }
});

test('Geometry共享通知独立释放、保留原回调，外来覆盖仍fail closed', () => {
  const f = fixture();
  try {
    const mesh = f.fixed.get('a')![0], geometry = mesh.geometry!;
    let original = 0, calls = 0;
    const previous = () => { original++; }, listener = () => { calls++; };
    geometry.onGeometryUpdated = previous;
    const first = subscribeLightingGeometryUpdates(geometry, listener);
    const second = subscribeLightingGeometryUpdates(geometry, listener);
    const dispatcher = geometry.onGeometryUpdated;
    assert.ok(first.isCurrent()); assert.ok(second.isCurrent());
    mesh.updateVerticesData(VertexBuffer.PositionKind, [...mesh.getVerticesData(VertexBuffer.PositionKind)!]);
    assert.equal(original, 1); assert.equal(calls, 2);
    first.release(); first.release();
    assert.equal(geometry.onGeometryUpdated, dispatcher); assert.ok(second.isCurrent());
    const external = () => undefined; geometry.onGeometryUpdated = external;
    assert.equal(second.isCurrent(), false);
    const late = subscribeLightingGeometryUpdates(geometry, listener);
    assert.equal(late.isCurrent(), false, '现存订阅失去所有权时不能擅自抢回或接纳外部入口');
    second.release(); late.release(); assert.equal(geometry.onGeometryUpdated, external);
  } finally { f.dispose(); }
});

for (const observable of ['onBindObservable', 'onUnBindObservable', 'onEffectCreatedObservable'] as const) {
  test(`材质${observable}在准入前存在或接管后新增都保留每台原始绘制回调`, () => {
    for (const when of ['before', 'after']) {
      const f = fixture();
      try {
        const mesh = f.fixed.get('b')![0];
        if (when === 'after') { f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1); }
        mesh.material![observable].add(() => undefined);
        if (when === 'before') f.runtime.sync(); else f.frame();
        assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(f.scene.meshes.includes(mesh));
        assert.ok(mesh.material![observable].hasObservers());
      } finally { f.dispose(); }
    }
  });
}

test('候选视图保留原provider有效前缀顺序、this与调用次数，不改原SmartArray返回', () => {
  let calls = 0;
  let sourceResult: { data: Mesh[]; length: number };
  const f = fixture(['rail'], scene => {
    scene.getActiveMeshCandidates = function () {
      assert.equal(this, scene); calls++;
      const data = [...scene.meshes].reverse() as Mesh[];
      sourceResult = { data: [...data, data[0]], length: data.length }; return sourceResult;
    };
  });
  try {
    const unchanged = f.scene.getActiveMeshCandidates();
    assert.equal(unchanged, sourceResult!); assert.equal(calls, 1);
    f.runtime.sync(); calls = 0;
    const result = f.scene.getActiveMeshCandidates();
    const expected = sourceResult!.data.slice(0, sourceResult!.length).filter(mesh => !f.runtime.isSuspended(mesh));
    assert.equal(calls, 1); assert.deepEqual(result.data.slice(0, result.length), expected);
    assert.equal(sourceResult!.data.length, sourceResult!.length + 1, '不得截断或重写原provider尾部容量');
  } finally { f.dispose(); }
});

test('自定义provider不返回carrier的原始快照时保守退出，不扩展或清空其业务候选', () => {
  let original: { data: Mesh[]; length: number };
  const f = fixture(['rail'], scene => {
    const data = [...scene.meshes] as Mesh[]; original = { data, length: data.length };
    scene.getActiveMeshCandidates = () => original;
  });
  try {
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    assert.deepEqual(candidateMeshes(f.scene), original!.data);
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.runtime.getDiagnostics().candidateProviderRejected, true);
    assert.deepEqual(f.runtime.getSuppressedMeshes(), []);
  } finally { f.dispose(); }
});

test('provider内部晚改固定部件触发回退，快照不会因scene.meshes splice漏源或返回已dispose carrier', () => {
  let mutate: (() => void) | null = null, calls = 0;
  const f = fixture(['rail'], scene => {
    scene.getActiveMeshCandidates = () => {
      calls++; const action = mutate; mutate = null; action?.();
      return { data: scene.meshes, length: scene.meshes.length };
    };
  });
  try {
    const originals = [...f.scene.meshes];
    f.runtime.sync(); const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes];
    mutate = () => { f.fixed.get('b')![0].position.x += 1; }; calls = 0;
    const candidates = candidateMeshes(f.scene);
    assert.equal(calls, 1, '原provider有副作用时不能为回退再次调用');
    assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.deepEqual(candidates, originals); assert.ok(carriers.every(mesh => mesh.isDisposed()));
    assert.ok(candidates.every(mesh => !mesh.isDisposed()));
  } finally { f.dispose(); }
});

test('外部换provider时同帧解除抑制，dispose不抢回外部所有权', () => {
  const f = fixture();
  try {
    f.runtime.sync(); const originals = [...f.fixed.values()].flat();
    const external = () => ({ data: f.scene.meshes, length: f.scene.meshes.length });
    f.scene.getActiveMeshCandidates = external; f.frame();
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.runtime.getDiagnostics().candidateProviderOwned, false);
    assert.ok(originals.every(mesh => candidateMeshes(f.scene).includes(mesh)));
    f.runtime.dispose(); assert.equal(f.scene.getActiveMeshCandidates, external);
  } finally { f.dispose(); }
});

test('dispose仅恢复自身provider，原fixed集合/flags及所有权保持', () => {
  const f = fixture();
  try {
    const originals = [...f.scene.meshes];
    const flags = [...f.fixed.values()].flat().map(mesh => [mesh, mesh.parent, mesh.material, mesh.isVisible,
      mesh.visibility, mesh.layerMask, mesh.isEnabled(false), mesh.receiveShadows]);
    f.runtime.sync(); assert.notEqual(f.scene.getActiveMeshCandidates, f.sourceProvider);
    assert.deepEqual(f.runtime.getSuppressedMeshes(), [...f.fixed.values()].flat());
    f.visible.set('a', false); f.frame();
    assert.equal(f.runtime.getSuppressedMeshes().length, 2, '不可见rows也必须包含在shadow抑制集合');
    f.runtime.dispose(); assert.equal(f.scene.getActiveMeshCandidates, f.sourceProvider);
    assert.deepEqual(f.scene.meshes, originals);
    assert.deepEqual([...f.fixed.values()].flat().map(mesh => [mesh, mesh.parent, mesh.material, mesh.isVisible,
      mesh.visibility, mesh.layerMask, mesh.isEnabled(false), mesh.receiveShadows]), flags);
  } finally { f.dispose(); }
});

test('常驻未参与渲染的RTT不禁用，未知custom/camera/material RTT按实际用途保守退出', () => {
  for (const use of ['resident', 'custom', 'camera', 'material']) {
    const f = fixture();
    try {
      const target = new RenderTargetTexture('resident-test', 1, f.scene);
      if (use === 'custom') f.scene.customRenderTargets.push(target);
      if (use === 'camera') new FreeCamera('camera', new Vector3(0, 0, -10), f.scene).customRenderTargets = [target];
      if (use === 'material') {
        const movingMaterial = new StandardMaterial('moving-rtt', f.scene); movingMaterial.diffuseTexture = target;
        f.moving.get(f.models.get('a')!)!.material = movingMaterial;
      }
      f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, use === 'resident' ? 1 : 0);
      if (use !== 'resident') { f.controlTarget(target); f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1); }
    } finally { f.dispose(); }
  }
});

test('真实外部ShadowGenerator通过gather stage渲染的RTT也必须显式授权', () => {
  const f = fixture();
  try {
    const light = new DirectionalLight('external-light', new Vector3(0, -1, 0), f.scene);
    const shadow = new ShadowGenerator(64, light);
    const target = shadow.getShadowMap()!;
    assert.ok(!f.scene.customRenderTargets.includes(target));
    assert.ok([...f.fixed.values()].flat().every(mesh => !mesh.material!.getActiveTextures().includes(target)));
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    f.controlTarget(target); const rendering = shadow.getShadowMapForRendering(); if (rendering) f.controlTarget(rendering);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    shadow.dispose(); light.dispose();
  } finally { f.dispose(); }
});

test('非均匀world的独立源与carrier法线define存在差异，hybrid保守拒绝而不改旧array shader', () => {
  const f = fixture();
  try {
    const source = f.fixed.get('b')![0]; f.models.get('b')!.root.scaling.set(2, 1, 1); source.computeWorldMatrix(true);
    const direct: Record<string, unknown> = { _areMiscDirty: true };
    PrepareDefinesForMisc(source, f.scene, false, false, false, false, direct as never);
    assert.equal(source.nonUniformScaling, true); assert.equal(direct.NONUNIFORMSCALING, true);
    const batch = EntityArrayThinInstanceBatch.create('legacy-array', [source], { interactive: true,
      sourceRootWorldMatrix: source.getWorldMatrix().clone(), mergeStaticMeshesByMaterial: false })!;
    try {
      const carrier = batch.meshes[0];
      const array: Record<string, unknown> = { _areMiscDirty: true };
      PrepareDefinesForMisc(carrier, f.scene, false, false, false, false, array as never);
      assert.equal(carrier.nonUniformScaling, false); assert.equal(array.NONUNIFORMSCALING, false);
    } finally { batch.dispose(); }
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.ok(candidateMeshes(f.scene).includes(source));
  } finally { f.dispose(); }
});

test('均匀负尺度保留镜像合同，接管后父级变成非均匀时同帧退出', () => {
  const f = fixture();
  try {
    f.models.get('a')!.root.scaling.set(-2, 2, 2);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const batch = f.runtime.getBatchesForEntity('a')[0];
    assert.equal(batch.meshes.length, 2);
    assert.deepEqual(batch.getLightingInstances().map(item => item.entityId).sort(), ['a', 'b']);
    f.models.get('b')!.root.scaling.set(1, 2, 1);
    const candidates = candidateMeshes(f.scene);
    assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.ok([...f.fixed.values()].flat().every(mesh => candidates.includes(mesh)));
  } finally { f.dispose(); }
});

async function prepareRender(f: ReturnType<typeof fixture>) {
  const camera = new FreeCamera('camera', new Vector3(2.5, 4, -16), f.scene);
  camera.setTarget(new Vector3(2.5, 0, 0)); f.scene.activeCamera = camera;
  for (const meshes of f.fixed.values()) for (const mesh of meshes) (mesh.material as StandardMaterial).disableLighting = true;
  (f.scene.defaultMaterial as StandardMaterial).disableLighting = true;
  f.runtime.sync();
  const carrier = f.runtime.getBatchesForEntity('a')[0].meshes[0];
  await carrier.material!.forceCompilationAsync(carrier, { useInstances: true });
  await f.scene.defaultMaterial.forceCompilationAsync(f.moving.get(f.models.get('a')!)!);
}

test('真实Scene.render的early脚本VertexBuffer.updateDirectly在同帧只绘原件、不绘旧carrier', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    const source = f.fixed.get('b')![0]; source.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
    await prepareRender(f);
    const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes], rendered: Mesh[] = [];
    await source.material!.forceCompilationAsync(source);
    const render = Mesh.prototype.render;
    t.mock.method(Mesh.prototype, 'render', function (this: Mesh, ...args: Parameters<Mesh['render']>) {
      rendered.push(this); return render.apply(this, args);
    });
    f.scene.onBeforeRenderObservable.addOnce(() => {
      const data = new Float32Array(source.getVerticesData(VertexBuffer.PositionKind)!); data[0] += .5;
      source.getVertexBuffer(VertexBuffer.PositionKind)!.updateDirectly(data, 0);
      assert.equal(f.runtime.getDiagnostics().groups, 0);
    });
    f.scene.render(); assert.ok(rendered.includes(source));
    assert.ok(carriers.every(mesh => mesh.isDisposed() && !rendered.includes(mesh)));
  } finally { f.dispose(); }
});

test('真实Scene.render只向batch和moving提交绘制，early LED式回调始终可查询原件', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f);
    const originals = [...f.fixed.values()].flat(), rendered: Mesh[] = [], drawn: Mesh[] = [];
    const drawState = { current: null as Mesh | null };
    let queries = 0;
    const render = Mesh.prototype.render, draw = f.engine.drawElementsType;
    t.mock.method(Mesh.prototype, 'render', function (this: Mesh, ...args: Parameters<Mesh['render']>) {
      const previous = drawState.current; drawState.current = this; rendered.push(this);
      try { return render.apply(this, args); } finally { drawState.current = previous; }
    });
    t.mock.method(f.engine, 'drawElementsType', function (this: NullEngine, ...args: Parameters<NullEngine['drawElementsType']>) {
      if (drawState.current) drawn.push(drawState.current); return draw.apply(this, args);
    });
    f.scene.onBeforeRenderObservable.add(() => { assert.ok(originals.every(mesh => f.scene.meshes.includes(mesh))); queries++; });
    f.scene.render(); f.scene.render();
    assert.equal(queries, 2); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const batch = f.runtime.getBatchesForEntity('a')[0];
    assert.ok(drawn.some(mesh => batch.meshes.includes(mesh)), '必须经过真实Scene.render与CPU draw dispatch');
    assert.ok([...f.moving.values()].every(mesh => rendered.includes(mesh)));
    assert.ok(originals.every(mesh => !rendered.includes(mesh) && f.scene.meshes.includes(mesh)), '原件可查但不双绘');
    assert.equal(f.scene._activeMeshesFrozen, false);
  } finally { f.dispose(); }
});

test('真实Scene.render中early callback改变fixed时同帧回退，旧carrier不参与绘制', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f);
    const carrier = [...f.runtime.getBatchesForEntity('a')[0].meshes], rendered: Mesh[] = [];
    const render = Mesh.prototype.render;
    t.mock.method(Mesh.prototype, 'render', function (this: Mesh, ...args: Parameters<Mesh['render']>) {
      rendered.push(this); return render.apply(this, args);
    });
    const source = f.fixed.get('b')![0];
    f.scene.onBeforeCameraRenderObservable.addOnce(() => { assert.ok(f.scene.meshes.includes(source)); source.position.y += 1; });
    await source.material!.forceCompilationAsync(source);
    f.scene.render();
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.ok(rendered.includes(source));
    assert.ok(carrier.every(mesh => mesh.isDisposed() && !rendered.includes(mesh)));
    assert.equal(source.position.y, 1);
  } finally { f.dispose(); }
});

test('early beforeRender创建显式renderList RTT时，在其第一遍真实绘制前归还原件', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f);
    const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes], originals = [...f.fixed.values()].flat();
    const rendered: Mesh[] = [], render = Mesh.prototype.render;
    t.mock.method(Mesh.prototype, 'render', function (this: Mesh, ...args: Parameters<Mesh['render']>) {
      rendered.push(this); return render.apply(this, args);
    });
    for (const mesh of originals) await mesh.material!.forceCompilationAsync(mesh);
    let targetPasses = 0;
    f.scene.onBeforeRenderObservable.addOnce(() => {
      const target = new RenderTargetTexture('late-explicit-list', 16, f.scene);
      target.renderList = f.scene.meshes;
      target.onBeforeRenderObservable.add(() => {
        targetPasses++;
        assert.equal(f.runtime.getDiagnostics().groups, 0, '必须在RTT开始前解除接管');
        assert.ok(originals.every(mesh => target.renderList!.includes(mesh)));
        assert.ok(carriers.every(mesh => !target.renderList!.includes(mesh)));
      });
      f.scene.customRenderTargets.push(target);
    });
    f.scene.render();
    assert.ok(targetPasses > 0, '必须经过真实RenderTargetTexture绘制入口');
    assert.ok(originals.every(mesh => rendered.includes(mesh)));
    assert.ok(carriers.every(mesh => mesh.isDisposed() && !rendered.includes(mesh)));
  } finally { f.dispose(); }
});

for (const entry of ['environment', 'primitive-material'] as const) {
  test(`early脚本设置${entry} RTT时，真实gather pass前退出且不遗漏非model材质`, { timeout: 15000 }, async () => {
    const f = fixture();
    try {
      await prepareRender(f);
      const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes];
      const primitive = CreateBox('standalone-primitive', {}, f.scene);
      const material = new StandardMaterial('standalone-reflection', f.scene); material.disableLighting = true;
      primitive.material = material;
      let targetPasses = 0;
      f.scene.onBeforeRenderObservable.addOnce(() => {
        const target = new RenderTargetTexture(entry, 16, f.scene); target.renderList = f.scene.meshes;
        target.onBeforeRenderObservable.add(() => {
          targetPasses++; assert.equal(f.runtime.getDiagnostics().groups, 0);
          assert.ok(carriers.every(mesh => mesh.isDisposed() && !target.renderList!.includes(mesh)));
        });
        if (entry === 'environment') f.scene.environmentTexture = target;
        else material.reflectionTexture = target;
        assert.ok(!f.scene.customRenderTargets.includes(target));
        assert.ok([...f.models.values()].every(model => model.meshes.every(mesh => !mesh.material?.getActiveTextures().includes(target))));
      });
      f.scene.render(); assert.ok(targetPasses > 0, '必须经过环境/材质gather后的真实RTT绘制');
      assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
    } finally { f.dispose(); }
  });
}

test('帧间切换customRenderFunction在绕过beforeRender前解除接管', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    await prepareRender(f);
    const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes];
    let calls = 0;
    f.scene.customRenderFunction = () => {
      calls++; assert.equal(f.runtime.getDiagnostics().groups, 0);
      assert.ok([...f.fixed.values()].flat().every(mesh => candidateMeshes(f.scene).includes(mesh)));
    };
    f.scene.render();
    assert.equal(calls, 1); assert.ok(carriers.every(mesh => mesh.isDisposed()));
  } finally { f.dispose(); }
});

test('真实freeze等待ready期间sync不重建，冻结active原件，用户unfreeze后恢复候选合批', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f); f.scene.render();
    const originals = [...f.fixed.values()].flat(), carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes];
    for (const mesh of originals) await mesh.material!.forceCompilationAsync(mesh);
    let ready: (() => void) | undefined, successes = 0;
    t.mock.method(f.scene, 'executeWhenReady', (callback: () => void) => { ready = callback; });
    assert.equal(f.scene.freezeActiveMeshes(false, () => { successes++; }, undefined, false, true), f.scene);
    assert.ok(ready); assert.equal(f.scene._activeMeshesFrozen, false);
    assert.equal(f.runtime.getDiagnostics().groups, 0); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().groups, 0, '等待ready时不得重新创建carrier');
    ready!(); assert.equal(successes, 1); assert.equal(f.scene._activeMeshesFrozen, true);
    const active = f.scene.getActiveMeshes();
    assert.ok(originals.every(mesh => active.data.slice(0, active.length).includes(mesh)));
    assert.ok(carriers.every(mesh => mesh.isDisposed() && !active.data.slice(0, active.length).includes(mesh)));
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.equal(f.scene.unfreezeActiveMeshes(), f.scene); f.runtime.sync();
    assert.equal(f.scene._activeMeshesFrozen, false); assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.dispose(); }
});

test('unfreeze-before-ready保留native迟到freeze语义，等待期始终不重建carrier', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f);
    let ready: (() => void) | undefined;
    t.mock.method(f.scene, 'executeWhenReady', (callback: () => void) => { ready = callback; });
    f.scene.freezeActiveMeshes(false, undefined, undefined, false);
    f.scene.unfreezeActiveMeshes(); f.runtime.sync();
    assert.equal(f.scene._activeMeshesFrozen, false); assert.equal(f.runtime.getDiagnostics().groups, 0);
    ready!(); assert.equal(f.scene._activeMeshesFrozen, true, '不能替用户取消Babylon原本仍会发生的迟到冻结');
    const active = f.scene.getActiveMeshes();
    assert.ok([...f.fixed.values()].flat().every(mesh => active.data.slice(0, active.length).includes(mesh)));
    f.scene.unfreezeActiveMeshes(); f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.dispose(); }
});

test('并发freeze计数独立结算；native无相机失败及onChanged重入不遗留pending或carrier', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f);
    const ready: Array<() => void> = [];
    t.mock.method(f.scene, 'executeWhenReady', (callback: () => void) => { ready.push(callback); });
    f.onChanged(() => { f.runtime.sync(); });
    f.scene.freezeActiveMeshes(false, undefined, undefined, false);
    assert.equal(f.runtime.getDiagnostics().groups, 0, '入口clear的通知重入也必须受pending门禁保护');
    f.scene.freezeActiveMeshes(false, undefined, undefined, false);
    assert.equal(f.runtime.getDiagnostics().pendingFreezes, 2);
    ready.shift()!(); f.scene.unfreezeActiveMeshes(); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().pendingFreezes, 1); assert.equal(f.runtime.getDiagnostics().groups, 0);
    ready.shift()!(); f.scene.unfreezeActiveMeshes(); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().pendingFreezes, 0); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const camera = f.scene.activeCamera; f.scene.activeCamera = null;
    f.scene.freezeActiveMeshes(); ready.shift()!();
    assert.equal(f.runtime.getDiagnostics().pendingFreezes, 0, 'native缺相机错误即使未传onError也必须结算');
    f.scene.activeCamera = camera; f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.onChanged(null); f.dispose(); }
});

test('freeze/unfreeze入口保留delegate this/参数/返回与回调this/返回/异常，失败释放pending', () => {
  const callbackReceiver = { kind: 'native-callback' }, callbackResult = { value: 7 };
  const observed: unknown[] = [];
  let mode: 'success' | 'error' | 'throw' = 'success';
  const nativeError = new Error('native freeze failed'), userError = new Error('user callback failed');
  const f = fixture(['rail'], scene => {
    scene.freezeActiveMeshes = function (...args) {
      observed.push(this, args[0], args[3], args[4]);
      if (mode === 'throw') throw nativeError;
      observed.push(mode === 'success' ? args[1]!.call(callbackReceiver) : args[2]!.call(callbackReceiver, 'native error'));
      return this;
    };
    scene.unfreezeActiveMeshes = function () { observed.push(this); return this; };
  });
  try {
    f.runtime.sync();
    const success = function (this: unknown) { assert.equal(this, callbackReceiver); return callbackResult; };
    assert.equal(f.scene.freezeActiveMeshes(true, success, undefined, false, true), f.scene);
    assert.deepEqual(observed, [f.scene, true, false, true, callbackResult]);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    mode = 'error'; let errors = 0;
    f.scene.freezeActiveMeshes(false, undefined, function (this: unknown, message) {
      assert.equal(this, callbackReceiver); assert.equal(message, 'native error'); errors++; return callbackResult;
    });
    assert.equal(errors, 1); assert.equal(observed.at(-1), callbackResult);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    mode = 'throw'; assert.throws(() => f.scene.freezeActiveMeshes(), error => error === nativeError);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    mode = 'success'; assert.throws(() => f.scene.freezeActiveMeshes(false, () => { throw userError; }), error => error === userError);
    f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 1);
    const other = new Scene(f.engine);
    try {
      assert.equal(f.scene.freezeActiveMeshes.call(other, false, success), other);
      assert.equal(f.runtime.getDiagnostics().groups, 1, '借用wrapper调用别的scene不改变本scene状态');
      assert.equal(f.scene.unfreezeActiveMeshes.call(other), other);
    } finally { other.dispose(); }
    f.runtime.dispose(); assert.equal(f.scene.freezeActiveMeshes, f.sourceFreeze); assert.equal(f.scene.unfreezeActiveMeshes, f.sourceUnfreeze);
  } finally { f.dispose(); }
});

test('外部替换freeze或unfreeze入口时保守退出，dispose不抢回API所有权', () => {
  for (const method of ['freezeActiveMeshes', 'unfreezeActiveMeshes'] as const) {
    const f = fixture();
    try {
      f.runtime.sync();
      const external = function (this: Scene) { return this; };
      f.scene[method] = external; f.frame();
      assert.equal(f.runtime.getDiagnostics().groups, 0); f.runtime.sync();
      assert.equal(f.runtime.getDiagnostics().groups, 0);
      f.runtime.dispose(); assert.equal(f.scene[method], external);
    } finally { f.dispose(); }
  }
});

const activeObserverCounts = (scene: Scene) => [scene.onBeforeActiveMeshesEvaluationObservable,
  scene.onBeforeAnimationsObservable, scene.onBeforeRenderTargetsRenderObservable]
  .map(observable => observable.observers.filter(observer => !observer._willBeUnregistered).length);

test('完全旁路OFF不安装观察器或替换API，重复sync查询不扫描材质和候选数组', t => {
  let counts: number[] = [], calls = 0, copies = 0, textures = 0;
  let original: ReturnType<Scene['getActiveMeshCandidates']>;
  const f = fixture(['rail'], scene => {
    counts = activeObserverCounts(scene);
    const data = [...scene.meshes];
    Object.defineProperty(data, 'slice', { value(...args: number[]) { copies++; return Array.prototype.slice.apply(this, args); } });
    original = { data, length: data.length };
    scene.getActiveMeshCandidates = function () { assert.equal(this, scene); calls++; return original; };
    for (const mesh of scene.meshes) if (mesh.material) t.mock.method(mesh.material, 'getActiveTextures', () => { textures++; return []; });
  }, false);
  try {
    assert.deepEqual(activeObserverCounts(f.scene), counts);
    assert.equal(f.scene.getActiveMeshCandidates, f.sourceProvider);
    assert.equal(f.scene.freezeActiveMeshes, f.sourceFreeze);
    assert.equal(f.scene.unfreezeActiveMeshes, f.sourceUnfreeze);
    for (let frame = 0; frame < 4; frame++) {
      f.runtime.sync(); f.runtime.getDiagnostics(); f.runtime.getBatchesForEntity('a');
      f.runtime.markModelDirty(f.models.get('a')!);
      f.runtime.beginModelMutation(f.models.get('a')!); f.runtime.endModelMutation(f.models.get('a')!);
      f.frame(); f.scene.onBeforeAnimationsObservable.notifyObservers(f.scene);
      f.scene.onBeforeRenderTargetsRenderObservable.notifyObservers(f.scene);
      assert.equal(f.scene.getActiveMeshCandidates(), original!);
    }
    assert.equal(calls, 4); assert.equal(copies, 0); assert.equal(textures, 0);
    assert.equal(f.runtime.getDiagnostics().groups, 0);
  } finally { f.dispose(); }
});

test('完全旁路OFF到ON在下一微任务恢复接管，关闭通知重入不得建carrier，重开与dispose保持原入口', async () => {
  const f = fixture(['rail'], undefined, false);
  try {
    const counts = activeObserverCounts(f.scene);
    f.runtime.setEnabled(true); f.runtime.sync();
    assert.equal(f.runtime.getDiagnostics().groups, 0, '同步调用栈内不能误接管正在native freeze求值的源');
    await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
    const carriers = [...f.runtime.getBatchesForEntity('a')[0].meshes];
    f.onChanged(() => { f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0); });
    f.runtime.setEnabled(false);
    assert.equal(f.runtime.getDiagnostics().groups, 0);
    assert.ok(carriers.every(mesh => mesh.isDisposed()));
    assert.equal(f.mapping.size, 0); assert.deepEqual(f.runtime.getSuppressedMeshes(), []);
    assert.deepEqual(activeObserverCounts(f.scene), counts);
    assert.equal(f.scene.getActiveMeshCandidates, f.sourceProvider);
    assert.equal(f.scene.freezeActiveMeshes, f.sourceFreeze);
    assert.equal(f.scene.unfreezeActiveMeshes, f.sourceUnfreeze);
    f.onChanged(null); f.runtime.setEnabled(true); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
    f.runtime.dispose(); assert.deepEqual(activeObserverCounts(f.scene), counts);
    assert.equal(f.scene.getActiveMeshCandidates, f.sourceProvider);
  } finally { f.dispose(); }
});

test('完全旁路取消待启用微任务，不在OFF或dispose后重新安装；连续toggle以最后请求为准', async () => {
  const f = fixture(['rail'], undefined, false);
  try {
    const counts = activeObserverCounts(f.scene);
    f.runtime.setEnabled(true); f.runtime.setEnabled(false); await Promise.resolve();
    assert.deepEqual(activeObserverCounts(f.scene), counts); assert.equal(f.runtime.getDiagnostics().groups, 0);
    f.runtime.setEnabled(true); f.runtime.setEnabled(false); f.runtime.setEnabled(true); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
    f.runtime.setEnabled(false); f.runtime.setEnabled(true); f.runtime.dispose(); await Promise.resolve();
    assert.deepEqual(activeObserverCounts(f.scene), counts); assert.equal(f.scene.getActiveMeshCandidates, f.sourceProvider);
  } finally { f.dispose(); }
});

test('完全旁路已保存的旧wrapper在OFF仅委托原函数，保留this返回及调用次数', () => {
  let calls = 0, freezes = 0, unfreezes = 0;
  let original: ReturnType<Scene['getActiveMeshCandidates']>;
  const f = fixture(['rail'], scene => {
    original = { data: scene.meshes, length: scene.meshes.length };
    scene.getActiveMeshCandidates = function () { calls++; assert.equal(this, scene); return original; };
    scene.freezeActiveMeshes = function () { freezes++; return this; };
    scene.unfreezeActiveMeshes = function () { unfreezes++; return this; };
  });
  try {
    const provider = f.scene.getActiveMeshCandidates, freeze = f.scene.freezeActiveMeshes, unfreeze = f.scene.unfreezeActiveMeshes;
    f.runtime.setEnabled(false);
    assert.equal(provider.call(f.scene), original!); assert.equal(calls, 1);
    assert.equal(freeze.call(f.scene), f.scene); assert.equal(freezes, 1); assert.equal(f.runtime.getDiagnostics().pendingFreezes, 0);
    assert.equal(unfreeze.call(f.scene), f.scene); assert.equal(unfreezes, 1);
  } finally { f.dispose(); }
});

test('完全旁路第三方在OFF替换任一API，启用关闭和释放都不抢所有权', async () => {
  for (const method of ['getActiveMeshCandidates', 'freezeActiveMeshes', 'unfreezeActiveMeshes'] as const) {
    const f = fixture(['rail'], undefined, false);
    try {
      const counts = activeObserverCounts(f.scene);
      const external = method === 'getActiveMeshCandidates' ? () => ({ data: f.scene.meshes, length: f.scene.meshes.length }) : function (this: Scene) { return this; };
      Reflect.set(f.scene, method, external);
      f.runtime.setEnabled(true); await Promise.resolve(); f.runtime.sync();
      assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.scene[method], external);
      assert.deepEqual(activeObserverCounts(f.scene), counts);
      f.runtime.setEnabled(false); f.runtime.dispose(); assert.equal(f.scene[method], external);
    } finally { f.dispose(); }
  }
});

test('完全旁路ON期等待的native freeze跨OFF再ON保留pending并冻结原件', { timeout: 15000 }, async t => {
  const f = fixture();
  try {
    await prepareRender(f);
    let ready: (() => void) | undefined;
    t.mock.method(f.scene, 'executeWhenReady', (callback: () => void) => { ready = callback; });
    f.scene.freezeActiveMeshes(false, undefined, undefined, false);
    assert.equal(f.runtime.getDiagnostics().pendingFreezes, 1);
    f.runtime.setEnabled(false); f.runtime.setEnabled(true); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.runtime.getDiagnostics().pendingFreezes, 1);
    ready!(); assert.equal(f.scene._activeMeshesFrozen, true);
    assert.equal(f.runtime.getDiagnostics().pendingFreezes, 0);
    const active = f.scene.getActiveMeshes();
    assert.ok([...f.fixed.values()].flat().every(mesh => active.data.slice(0, active.length).includes(mesh)));
    f.scene.unfreezeActiveMeshes(); f.runtime.sync(); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.dispose(); }
});

test('完全旁路OFF期真实native ready队列阻止提前激活，提前unfreeze不取消迟到freeze', { timeout: 15000 }, async t => {
  const f = fixture(['rail'], undefined, false);
  try {
    f.scene.activeCamera = new FreeCamera('camera', new Vector3(2.5, 4, -16), f.scene);
    f.scene.activeCamera.setTarget(new Vector3(2.5, 0, 0));
    const counts = activeObserverCounts(f.scene);
    let ready = false;
    t.mock.method(f.scene, 'isReady', () => ready);
    const frozen = new Promise<void>(resolve => f.scene.freezeActiveMeshes(false, resolve, undefined, false));
    assert.equal(f.scene.onReadyObservable.hasObservers(), true);
    f.scene.unfreezeActiveMeshes(); f.runtime.setEnabled(true); f.runtime.sync(); await Promise.resolve();
    assert.deepEqual(activeObserverCounts(f.scene), counts); assert.equal(f.runtime.getDiagnostics().groups, 0);
    ready = true; await frozen;
    assert.equal(f.scene._activeMeshesFrozen, true); f.runtime.sync(); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 0);
    f.scene.unfreezeActiveMeshes(); f.runtime.sync(); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.dispose(); }
});

test('完全旁路native freeze候选求值栈内重入启用，只能在冻结完成后的安全边界检查', async t => {
  let enable: (() => void) | undefined;
  const f = fixture(['rail'], scene => {
    scene.getActiveMeshCandidates = function () { enable?.(); return { data: scene.meshes, length: scene.meshes.length }; };
  }, false);
  try {
    f.scene.activeCamera = new FreeCamera('camera', new Vector3(2.5, 4, -16), f.scene);
    f.scene.activeCamera.setTarget(new Vector3(2.5, 0, 0));
    t.mock.method(f.scene, 'isReady', () => true);
    enable = () => { f.runtime.setEnabled(true); f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 0); };
    f.scene.freezeActiveMeshes(false, undefined, undefined, false);
    await Promise.resolve();
    assert.equal(f.scene._activeMeshesFrozen, true); assert.equal(f.runtime.getDiagnostics().groups, 0);
    enable = undefined; f.scene.unfreezeActiveMeshes(); f.runtime.sync(); await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 1);
  } finally { f.dispose(); }
});

function assertFullyPassive(f: ReturnType<typeof fixture>) {
  assert.equal(f.runtime.getDiagnostics().groups, 0);
  assert.equal(f.runtime.getDiagnostics().batchMeshes, 0);
  assert.deepEqual(f.runtime.getSuppressedMeshes(), []);
  assert.equal(f.mapping.size, 0);
  assert.ok(f.scene.meshes.every(mesh => !mesh.name.startsWith('__motionStatic')), '当栈归还全部源，不能遗留未登记carrier');
  assert.equal(f.scene.getActiveMeshCandidates, f.sourceProvider);
  assert.equal(f.scene.freezeActiveMeshes, f.sourceFreeze);
  assert.equal(f.scene.unfreezeActiveMeshes, f.sourceUnfreeze);
}

test('完全旁路重入首个onBatchAdded同步关闭，两个候选组也不残留carrier订阅或抑制源', () => {
  const f = fixture(['rail', 'base']);
  try {
    const callbacks = [...f.fixed.values()].flat().map(mesh => mesh.geometry!.onGeometryUpdated);
    f.onBatchAdded(() => f.runtime.setEnabled(false));
    f.runtime.sync();
    assertFullyPassive(f); assert.equal(f.batchAdds, 1, '关闭后不得继续创建第二候选组');
    assert.deepEqual([...f.fixed.values()].flat().map(mesh => mesh.geometry!.onGeometryUpdated), callbacks);
  } finally { f.dispose(); }
});

test('完全旁路重入create返回前同步关闭，尚未登记的真实batch当栈释放', t => {
  const f = fixture(['rail', 'base']);
  const create = EntityArrayThinInstanceBatch.create;
  let creates = 0;
  try {
    t.mock.method(EntityArrayThinInstanceBatch, 'create', function (...args: Parameters<typeof create>) {
      const batch = create.apply(this, args); creates++; f.runtime.setEnabled(false); return batch;
    });
    f.runtime.sync();
    assertFullyPassive(f); assert.equal(creates, 1); assert.equal(f.batchAdds, 0);
  } finally { f.dispose(); }
});

test('完全旁路重入onBatchAdded同栈关闭再开启，旧generation立即停止且新代仅微任务创建两组', async () => {
  const f = fixture(['rail', 'base']);
  let first = true;
  try {
    f.onBatchAdded(() => {
      if (!first) return;
      first = false; f.runtime.setEnabled(false); f.runtime.setEnabled(true); f.runtime.sync();
    });
    f.runtime.sync();
    assertFullyPassive(f); assert.equal(f.batchAdds, 1);
    await Promise.resolve();
    assert.equal(f.runtime.getDiagnostics().groups, 2); assert.equal(f.batchAdds, 3);
    assert.equal(f.scene.meshes.filter(mesh => mesh.name.startsWith('__motionStatic')).length, 2);
  } finally { f.dispose(); }
});

for (const previouslyOwned of [false, true]) {
  test('完全旁路重入updateEntityTransforms同步关闭' + (previouslyOwned ? '已登记的组' : '未登记的组') + '均当栈释放', t => {
    const f = fixture(['rail', 'base']);
    const update = EntityArrayThinInstanceBatch.prototype.updateEntityTransforms;
    try {
      if (previouslyOwned) {
        f.runtime.sync(); assert.equal(f.runtime.getDiagnostics().groups, 2);
        f.models.get('b')!.root.position.x += 1;
      }
      t.mock.method(EntityArrayThinInstanceBatch.prototype, 'updateEntityTransforms', function (...args: Parameters<typeof update>) {
        const result = update.apply(this, args); f.runtime.setEnabled(false); return result;
      });
      f.runtime.sync(); assertFullyPassive(f);
    } finally { f.dispose(); }
  });
}

test('完全旁路重入onBatchAdded抛错仍按原失败路径归还原件并清除载体映射', () => {
  const f = fixture(['rail', 'base']);
  try {
    f.onBatchAdded(() => { throw new Error('intentional batch registration failure'); });
    assert.doesNotThrow(() => f.runtime.sync());
    assert.equal(f.runtime.getDiagnostics().groups, 0); assert.equal(f.mapping.size, 0);
    assert.deepEqual(f.runtime.getSuppressedMeshes(), []);
    assert.ok(f.scene.meshes.every(mesh => !mesh.name.startsWith('__motionStatic')));
    assert.match(f.runtime.getDiagnostics().fallbackReason, /intentional batch registration failure/);
  } finally { f.dispose(); }
});
