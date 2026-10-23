import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Scene, TransformNode, VertexBuffer } from '@babylonjs/core';
import { collectLightingRuntimeSources } from '../../src/runtime/babylon/lightingClassificationRuntime.ts';

type Context = Parameters<typeof collectLightingRuntimeSources>[0];

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const root = new TransformNode('model', scene);
  const track = MeshBuilder.CreateBox('track', { updatable: true }, scene); track.parent = root;
  const moving = MeshBuilder.CreateBox('moving', {}, scene); moving.parent = root;
  const entity = { id: 'source', parentId: null, components: { modelAsset: {} } };
  const model = {
    contentRoot: root, root, meshes: [track, moving], assetRevision: 'r1', parameterSignature: '',
    entitySnapshot: entity, assetHandle: null, externalScriptRuntime: null,
  };
  const context = {
    scene, document: { entities: { source: entity }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } },
    models: [['source', model]], primitiveMeshes: new Map(), environment: [], batches: [],
    getMotionTargets: () => ({ moving: [moving], fixed: [track], known: true }), readEntityId: () => null,
  };
  return { engine, scene, root, track, moving, entity, model, context };
}

test('已知专用驱动不能证明额外未知动画脚本不会移动其他部件', () => {
  const f = fixture();
  try {
    Object.assign(f.entity.components.modelAsset, { animationScriptMetadata: [{ id: 'custom-animation' }] });
    Object.assign(f.model, { externalScriptRuntime: { getDataDrivenConfigs: () => [] } });
    const sources = collectLightingRuntimeSources(f.context as unknown as Context);
    assert.equal(sources.find(source => source.mesh === f.track)?.entry.mobility, 'dynamic');
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('参数化固定阵列实例继承源模型的脚本证据，不把无动作参数脚本当未知动画', () => {
  const f = fixture();
  try {
    Object.assign(f.entity.components.modelAsset, { parameterScriptMetadata: [{ id: 'geometry-only' }] });
    Object.assign(f.model, { externalScriptRuntime: { getDataDrivenConfigs: () => [] }, modelArrayBatch: {} });
    const carrier = MeshBuilder.CreateBox('carrier', {}, f.scene);
    const child = { id: 'instance', parentId: null, components: { modelArrayInstance: { sourceEntityId: 'source' } } };
    const batch = {
      getLightingInstances: () => [{ mesh: carrier, sourceMesh: f.track, entityId: 'instance', sourceIndex: 0 }],
      getLightingInstanceWorldMatrix: () => Matrix.Identity(),
    };
    const context = {
      ...f.context, document: { entities: { source: f.entity, instance: child }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } }, batches: [batch],
      getMotionTargets: () => ({ moving: [], fixed: [], known: false }),
    };
    const sources = collectLightingRuntimeSources(context as unknown as Context);
    assert.equal(sources.find(source => source.entry.entityId === 'instance')?.entry.mobility, 'static');
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('原地更新静态顶点后资源身份也必须变化，即使顶点/索引数量没有改变', () => {
  const f = fixture();
  try {
    const before = collectLightingRuntimeSources(f.context as unknown as Context)[0].entry.resourceIdentity;
    const positions = f.track.getVerticesData(VertexBuffer.PositionKind)!;
    positions[0] += 0.75;
    f.track.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    const after = collectLightingRuntimeSources(f.context as unknown as Context)[0].entry.resourceIdentity;
    assert.notEqual(after, before);
  } finally { f.scene.dispose(); f.engine.dispose(); }
});
