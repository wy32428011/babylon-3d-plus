
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { NullEngine, Scene, TransformNode, MeshBuilder, StandardMaterial } from '@babylonjs/core';

function createSourceEntity(visible = true) {
  return {
    id: 'B',
    name: 'B',
    visible,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: { position: { x: 10, y: 2, z: -5 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, scale: { x: 2, y: 3, z: 4 } },
      modelAsset: {
        sourcePath: 'formal.glb',
        sourceUrl: 'formal.glb',
        assetCode: 'FORMAL0000',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
    },
  };
}

function createInstanceEntity(id, visible) {
  return {
    id,
    name: id,
    visible,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: { position: { x: 11, y: 2, z: -5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelAsset: {
        sourcePath: 'formal.glb',
        sourceUrl: 'formal.glb',
        assetCode: 'FORMAL0001',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
      modelArrayInstance: { sourceEntityId: 'B' },
    },
  };
}

function makeDocument(entities) {
  const entityIds = entities.map((e) => e.id);
  return {
    id: 'scene-visibility',
    name: 'Visibility Round Trip',
    entityIds,
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    selectedEntityId: null,
    mqttConfig: { enabled: false, ip: '', address: '', topic: 'zending/stacker/action', subscriptions: [], simulatorEnabled: false, simulatorAssetCode: '', simulatorScenario: '', simulatorIntervalMs: 500 },
    fetchConfig: { url: '', apiKey: '' },
    sceneSettings: { camera: { savedPose: null, savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 }, sensitivity: { zoom: 1, pan: 1, rotate: 1 }, environment: null, skybox: null },
  };
}

test('完整 sync 路径下隐藏实例重新显示必须回到合批矩阵', async (context) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  context.after(async () => server.close());

  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { createConveyorTelemetryState, createRgvTelemetryState, createStackerTelemetryState } = await server.ssrLoadModule(
    '/src/runtime/babylon/telemetry/specialized/specializedModelAssets.ts',
  );
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new SceneRuntime(scene);

  const root = new TransformNode('B-root', scene);
  const contentRoot = new TransformNode('B-content', scene);
  contentRoot.parent = root;
  const mesh = MeshBuilder.CreateBox('B-box', { size: 1 }, scene);
  mesh.parent = contentRoot;
  mesh.isPickable = true;
  const material = new StandardMaterial('B-material', scene);
  mesh.material = material;
  root.computeWorldMatrix(true);
  contentRoot.computeWorldMatrix(true);
  mesh.computeWorldMatrix(true);

  const sourceEntry = {
    sourceUrl: 'formal.glb',
    assetRevision: null,
    assetSignature: JSON.stringify({ sourceUrl: 'formal.glb', assetRevision: null, lengthUnit: 'meter', unitScaleToMeters: 1, instancingMode: 'shared-instance' }),
    entitySnapshot: createSourceEntity(),
    assetCode: 'FORMAL0000',
    telemetryBinding: null,
    stackerCapable: false,
    conveyorCapable: false,
    rgvCapable: false,
    root,
    contentRoot,
    assetHandle: { kind: 'shared-instance', animationGroups: [], dispose: () => undefined },
    meshes: [mesh],
    modelArraySuspendedMeshes: new Set(),
    modelArrayBatch: null,
    modelArraySourceSignature: '',
    modelArrayFailureSignature: '',
    highlighted: false,
    loadToken: 0,
    cancelLoad: null,
    parameterSignature: '',
    parameterBaseline: new Map(),
    textureCache: new Map(),
    externalScriptRuntime: null,
    externalScriptSignature: '',
    externalScriptStarting: false,
    measurementReady: true,
    stackerTelemetry: createStackerTelemetryState(root),
    conveyorTelemetry: createConveyorTelemetryState(),
    rgvTelemetry: createRgvTelemetryState(root),
    stackerTelemetryReady: false,
    telemetryPreviewBaseline: null,
  };
  runtime.models.set('B', sourceEntry);

  // 重开场景：A 是持久化 modelArrayInstance 且隐藏
  const bEntity = createSourceEntity(true);
  const aEntity = createInstanceEntity('A', false);
  const doc1 = makeDocument([bEntity, aEntity]);
  runtime.sync(doc1, [], { modelArrayIdentityMode: 'visual' });
  let batch = sourceEntry.modelArrayBatch;
  assert.ok(batch, '重开后必须创建批次');
  console.log('reopen (A hidden), batch ids:', JSON.stringify([...batch.getEntityIds()].sort()));
  assert.deepEqual([...batch.getEntityIds()].sort(), ['B'], '隐藏实例不得进入批次');

  // 点击显示 A
  const aShown = { ...aEntity, visible: true };
  const doc2 = makeDocument([bEntity, aShown]);
  runtime.sync(doc2, [], { modelArrayIdentityMode: 'visual' });
  batch = sourceEntry.modelArrayBatch;
  console.log('after show A, batch ids:', JSON.stringify([...batch.getEntityIds()].sort()));
  assert.deepEqual([...batch.getEntityIds()].sort(), ['A', 'B'], '重新显示的实例必须回到批次');
  const total = batch.meshes.reduce((sum, m) => sum + m.thinInstanceCount, 0);
  console.log('after show A, thinInstanceCount total:', total);
  assert.equal(total, 2, '批次矩阵数量必须包含源和重新显示的实例');
});

test('参数脚本隐藏阵列部件后，批次与聚焦 bounds 都只能保留可见几何', async (context) => {
  const { runtime, sourceEntry, contentRoot, mesh } = await setupRuntime(context);
  const optionalMesh = MeshBuilder.CreateBox('B-optional-parameter-part', { size: 2 }, contentRoot.getScene());
  optionalMesh.parent = contentRoot;
  // 源实体绕 Y 轴旋转 90°；放在局部 Z 轴才能让错误的旧批次扩张到世界 X 轴。
  optionalMesh.position.z = 100;
  optionalMesh.material = mesh.material;
  optionalMesh.computeWorldMatrix(true);
  sourceEntry.meshes.push(optionalMesh);

  const source = createSourceEntity(true);
  const instance = createInstanceEntity('A', true);
  const document = makeDocument([source, instance]);
  runtime.sync(document, [], { modelArrayIdentityMode: 'visual' });
  const originalBatch = sourceEntry.modelArrayBatch;
  assert.ok(originalBatch, '初始阵列必须建立批次');

  // 模拟链条机参数脚本关闭显示腿/挡板/电机后禁用对应 Mesh。
  optionalMesh.setEnabled(false);
  runtime.syncModelParameters(document, source.id, [], { modelArrayIdentityMode: 'visual' });

  const batch = sourceEntry.modelArrayBatch;
  assert.ok(batch, '隐藏参数部件后阵列仍应保留主体批次');
  assert.notEqual(batch, originalBatch, '隐藏部件必须触发批次重建，不能复用含旧几何的批次');

  const focusBounds = runtime.getEntitiesWorldBounds([source.id]);
  assert.ok(focusBounds, '隐藏部件后仍应能计算聚焦 bounds');
  assert.ok(Math.abs(focusBounds.center.x - 10) < 1e-6, '聚焦中心必须只来自可见主体');

  const instanceFocusBounds = runtime.getEntitiesWorldBounds([instance.id]);
  assert.ok(instanceFocusBounds, '阵列副本隐藏部件后仍应能计算聚焦 bounds');
  assert.ok(Math.abs(instanceFocusBounds.center.x - 11) < 1e-6, '阵列副本聚焦中心必须只来自可见主体');

  const renderedBatchMeshes = batch.meshes
    .filter((batchMesh) => batchMesh.isEnabled(false) && batchMesh.isVisible && batchMesh.visibility > 0);
  assert.ok(renderedBatchMeshes.length > 0, '隐藏可选部件后主体批次仍必须可渲染');
  const renderedMaximumX = Math.max(...renderedBatchMeshes
    .map((batchMesh) => {
      batchMesh.computeWorldMatrix(true);
      return batchMesh.getBoundingInfo().boundingBox.maximumWorld.x;
    }));
  assert.ok(
    renderedMaximumX <= 12 + 1e-6,
    `隐藏部件不得继续出现在阵列批次中，当前最大 X=${renderedMaximumX}`,
  );
});

test('参数脚本隐藏阵列全部几何后，不得继续保留旧批次画面', async (context) => {
  const { runtime, sourceEntry, mesh } = await setupRuntime(context);
  const source = createSourceEntity(true);
  const instance = createInstanceEntity('A', true);
  const document = makeDocument([source, instance]);
  runtime.sync(document, [], { modelArrayIdentityMode: 'visual' });
  assert.ok(sourceEntry.modelArrayBatch, '初始阵列必须建立批次');

  mesh.setEnabled(false);
  runtime.syncModelParameters(document, source.id, [], { modelArrayIdentityMode: 'visual' });

  assert.equal(sourceEntry.modelArrayBatch, null, '全部源几何隐藏后不得继续显示上一份阵列批次');
});

function makeFolderEntity(id, visible) {
  return {
    id, name: id, visible, locked: false, parentId: null, childrenIds: [], isFolder: true,
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    },
  };
}

async function setupRuntime(context) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  context.after(async () => server.close());
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { createConveyorTelemetryState, createRgvTelemetryState, createStackerTelemetryState } = await server.ssrLoadModule(
    '/src/runtime/babylon/telemetry/specialized/specializedModelAssets.ts',
  );
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new SceneRuntime(scene);
  const root = new TransformNode('B-root', scene);
  const contentRoot = new TransformNode('B-content', scene);
  contentRoot.parent = root;
  const mesh = MeshBuilder.CreateBox('B-box', { size: 1 }, scene);
  mesh.parent = contentRoot;
  mesh.isPickable = true;
  mesh.material = new StandardMaterial('B-material', scene);
  root.computeWorldMatrix(true);
  contentRoot.computeWorldMatrix(true);
  mesh.computeWorldMatrix(true);
  const sourceEntry = {
    sourceUrl: 'formal.glb',
    assetRevision: null,
    assetSignature: JSON.stringify({ sourceUrl: 'formal.glb', assetRevision: null, lengthUnit: 'meter', unitScaleToMeters: 1, instancingMode: 'shared-instance' }),
    entitySnapshot: null,
    assetCode: 'FORMAL0000',
    telemetryBinding: null,
    stackerCapable: false,
    conveyorCapable: false,
    rgvCapable: false,
    root, contentRoot,
    assetHandle: { kind: 'shared-instance', animationGroups: [], dispose: () => undefined },
    meshes: [mesh],
    modelArraySuspendedMeshes: new Set(),
    modelArrayBatch: null,
    modelArraySourceSignature: '',
    modelArrayFailureSignature: '',
    highlighted: false,
    loadToken: 0,
    cancelLoad: null,
    parameterSignature: '',
    parameterBaseline: new Map(),
    textureCache: new Map(),
    externalScriptRuntime: null,
    externalScriptSignature: '',
    externalScriptStarting: false,
    measurementReady: true,
    stackerTelemetry: createStackerTelemetryState(root),
    conveyorTelemetry: createConveyorTelemetryState(),
    rgvTelemetry: createRgvTelemetryState(root),
    stackerTelemetryReady: false,
    telemetryPreviewBaseline: null,
  };
  runtime.models.set('B', sourceEntry);
  return { server, runtime, sourceEntry, root, contentRoot, mesh };
}

test('文件夹隐藏重开后显示文件夹必须恢复合批矩阵', async (context) => {
  const { runtime, sourceEntry } = await setupRuntime(context);
  const folder = makeFolderEntity('F', false);
  const bEntity = { ...createSourceEntity(true), parentId: 'F' };
  const aEntity = { ...createInstanceEntity('A', true), parentId: 'F' };
  const doc1 = makeDocument([folder, bEntity, aEntity]);
  runtime.sync(doc1, [], { modelArrayIdentityMode: 'visual' });
  let batch = sourceEntry.modelArrayBatch;
  console.log('folder hidden: batch ids:', batch ? JSON.stringify([...batch.getEntityIds()].sort()) : 'NO BATCH');
  if (batch) {
    const total = batch.meshes.reduce((sum, m) => sum + m.thinInstanceCount, 0);
    console.log('folder hidden: thinInstanceCount total:', total);
  }

  const folderShown = { ...folder, visible: true };
  const doc2 = makeDocument([folderShown, bEntity, aEntity]);
  runtime.sync(doc2, [], { modelArrayIdentityMode: 'visual' });
  batch = sourceEntry.modelArrayBatch;
  console.log('folder shown: batch ids:', batch ? JSON.stringify([...batch.getEntityIds()].sort()) : 'NO BATCH');
  if (batch) {
    const total = batch.meshes.reduce((sum, m) => sum + m.thinInstanceCount, 0);
    console.log('folder shown: thinInstanceCount total:', total);
  }
  assert.ok(batch, '显示文件夹后必须存在批次');
  assert.deepEqual([...batch.getEntityIds()].sort(), ['A', 'B'], '显示文件夹后源与实例都必须回到批次');
});

test('隐藏源模型重开后显示源必须回到合批矩阵', async (context) => {
  const { runtime, sourceEntry } = await setupRuntime(context);
  const bHidden = createSourceEntity(false);
  const aEntity = createInstanceEntity('A', true);
  const doc1 = makeDocument([bHidden, aEntity]);
  runtime.sync(doc1, [], { modelArrayIdentityMode: 'visual' });
  let batch = sourceEntry.modelArrayBatch;
  console.log('source hidden: batch ids:', batch ? JSON.stringify([...batch.getEntityIds()].sort()) : 'NO BATCH');
  assert.ok(batch, '隐藏源时批次必须存在（可见实例仍渲染）');
  assert.deepEqual([...batch.getEntityIds()].sort(), ['A'], '隐藏源不得进入批次');

  const bShown = { ...bHidden, visible: true };
  const doc2 = makeDocument([bShown, aEntity]);
  runtime.sync(doc2, [], { modelArrayIdentityMode: 'visual' });
  batch = sourceEntry.modelArrayBatch;
  console.log('source shown: batch ids:', batch ? JSON.stringify([...batch.getEntityIds()].sort()) : 'NO BATCH');
  assert.deepEqual([...batch.getEntityIds()].sort(), ['A', 'B'], '显示源后源必须回到批次');
});

test('单个模型隐藏后重开点击显示必须恢复根节点', async (context) => {
  const { runtime, sourceEntry, root } = await setupRuntime(context);
  const bHidden = createSourceEntity(false);
  const doc1 = makeDocument([bHidden]);
  runtime.sync(doc1, [], { modelArrayIdentityMode: 'visual' });
  console.log('single model hidden: root enabled =', root.isEnabled());
  assert.equal(root.isEnabled(), false, '隐藏模型根节点必须禁用');

  const bShown = { ...bHidden, visible: true };
  const doc2 = makeDocument([bShown]);
  runtime.sync(doc2, [], { modelArrayIdentityMode: 'visual' });
  console.log('single model shown: root enabled =', root.isEnabled());
  assert.equal(root.isEnabled(), true, '点击显示后模型根节点必须恢复启用');
});
