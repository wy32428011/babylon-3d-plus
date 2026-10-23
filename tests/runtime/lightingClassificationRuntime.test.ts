import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBuilder, NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { collectLightingRuntimeSources } from '../../src/runtime/babylon/lightingClassificationRuntime.ts';

test('真实节点分类复用运动目标，固定轨道可静态、移动父级下的部件不能强制静态', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const root = new TransformNode('model', scene);
    const track = MeshBuilder.CreateBox('track', {}, scene); track.parent = root;
    const carriage = new TransformNode('carriage', scene); carriage.parent = root;
    const deck = MeshBuilder.CreateBox('deck', {}, scene); deck.parent = carriage;
    const entity = {
      id: 'machine', name: 'machine', parentId: null, childrenIds: [],
      components: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        lighting: { mobility: 'auto', nodeOverrides: { 'carriage[0]/deck[0]': { mobility: 'static' } } } },
    };
    const model = {
      contentRoot: root, root, meshes: [track, deck], assetRevision: 'r1', parameterSignature: '', sourceUrl: 'editor-asset://first/location.glb',
      entitySnapshot: entity, assetHandle: null, externalScriptRuntime: null,
    };
    const context = {
      scene, document: { entities: { machine: entity }, entityIds: ['machine'], sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } },
      models: [['machine', model]], primitiveMeshes: new Map(), environment: [], batches: [],
      getMotionTargets: () => ({ moving: [carriage], fixed: [track], known: true }), readEntityId: () => null,
    };
    const result = collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
    assert.equal(result.find(item => item.mesh === track)?.entry.mobility, 'static');
    assert.equal(result.find(item => item.mesh === deck)?.entry.mobility, 'dynamic');
    assert.equal(result.find(item => item.mesh === deck)?.entry.parentDynamic, true);
    const identity = result[0].entry.resourceIdentity;
    model.sourceUrl = 'editor-asset://different/project/location.glb';
    assert.equal(collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0])[0].entry.resourceIdentity, identity);
  } finally { scene.dispose(); engine.dispose(); }
});
