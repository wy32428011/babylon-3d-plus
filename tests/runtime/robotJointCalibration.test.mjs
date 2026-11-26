import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  optimizeDeps: { noDiscovery: true },
  server: { watch: null },
});
const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
const { createEmptySceneDocument, createModelEntity } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { createDefaultTelemetryBinding } = await server.ssrLoadModule('/src/editor/model/telemetryBinding.ts');

test('SceneRuntime 文档校准更新后立即显示腰部零位，无需启动调试', async t => {
  t.after(() => server.close());
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new SceneRuntime(scene);
  let waist;
  runtime.assets.loadModelRuntimeAssets = async () => {
    const assetRoot = new TransformNode('robot-asset', scene);
    waist = new TransformNode('shentiyuandian', scene);
    waist.parent = assetRoot;
    waist.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), 0.12);
    const mesh = MeshBuilder.CreateBox('robot-body', { size: 1 }, scene);
    mesh.parent = waist;
    return {
      kind: 'owned-container',
      handle: { kind: 'owned-container', animationGroups: [], dispose: () => {} },
      meshes: [mesh],
      transformNodes: [assetRoot, waist],
    };
  };
  const entity = createModelEntity('robot.glb', 'editor-asset://local/robot.glb', 'robot');
  entity.components.modelAsset.deviceType = 'robot';
  entity.components.modelAsset.dataDrivenConfig = {
    device: { devType: 'robot' },
    specializedMotion: {
      angleUnit: 'rad',
      waist: { field: 'waistYaw', nodes: ['shentiyuandian'], axes: ['z'], signs: [1] },
    },
    fixedNodes: [],
  };
  entity.components.telemetryBinding = createDefaultTelemetryBinding('robot');
  const documentModel = createEmptySceneDocument('机器人零位编辑');
  documentModel.entities[entity.id] = entity;
  documentModel.entityIds.push(entity.id);
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });

  runtime.sync(documentModel);
  for (let index = 0; index < 100 && !runtime.isModelReady(entity.id); index++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(runtime.isModelReady(entity.id), true);
  const baseline = waist.rotationQuaternion.clone();
  const nextEntity = {
    ...entity,
    components: {
      ...entity.components,
      telemetryBinding: {
        ...entity.components.telemetryBinding,
        robotJointCalibration: { waist: { offsetsDeg: [-30], axes: ['-z'] } },
      },
    },
  };
  runtime.sync({ ...documentModel, entities: { ...documentModel.entities, [entity.id]: nextEntity } });

  const expected = baseline.multiply(Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 6));
  assert.ok(waist.rotationQuaternion.equalsWithEpsilon(expected, 1e-10));
});
