import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FreeCamera,
  LoadAssetContainerAsync,
  Matrix,
  NullEngine,
  Scene,
  SceneLoader,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { createServer } from 'vite';

const FIXTURE_GLB_PATH = path.join(
  process.cwd(),
  'public',
  'builtin-model-packages',
  'virtual-conveyor',
  'virtual-conveyor.glb',
);
const HOST_ENTITY_ID = 'CONVEYOR-1';
const HOST_ASSET_CODE = '001005';
const GENERATOR_ENTITY_ID = 'CARGO-GENERATOR';
const COMPOSITION_GENERATOR_ENTITY_ID = 'COMPOSITION-GENERATOR';
const COMPOSITION_LIBRARY_ID = 'lib-box-group';
const COMPOSITION_REVISION = 'rev-1';
const VIEWPORT_SIZE = 800;
const WAIT_ATTEMPTS = 1_000;
const WAIT_INTERVAL_MS = 20;

/** 宿主输送线实体：货箱承运方，点击货箱时作为承运设备随事件上报。 */
function createHostEntity() {
  return {
    id: HOST_ENTITY_ID,
    name: '宿主输送线',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelAsset: {
        sourcePath: 'F:/fixtures/virtual-conveyor/virtual-conveyor.glb',
        sourceUrl: 'smoke://Assets/Models/virtual-conveyor/virtual-conveyor.glb',
        assetRevision: 'generated-cargo-click-smoke',
        assetCode: HOST_ASSET_CODE,
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
        parameterValues: {},
      },
      telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'conveyor', expectedIntervalMs: 500, staleAfterMs: 2_000 },
    },
  };
}

/** 货箱模板生成器：自带点击绑定，作用域是它生成的货箱。 */
function createGeneratorEntity(modelAssetTemplate) {
  return {
    id: GENERATOR_ENTITY_ID,
    name: '模型生成器',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: { position: { x: 6, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelGenerator: {
        defaultTarget: { kind: 'model', assetId: 'cargo-asset', displayName: '货箱模板', modelAsset: modelAssetTemplate },
        rules: [],
      },
      clickEventBinding: {
        deviceSlots: [],
        events: [{ id: 'click-event-1', eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-cargo', name: '货物大屏' } }],
      },
    },
  };
}

/** 组合库条目：单箱成员 + 三箱阵列 + 内置方块成员，覆盖组合产物的三类网格来源。 */
function createCompositionEntry() {
  const memberTemplate = {
    sourcePath: 'F:/fixtures/virtual-conveyor/virtual-conveyor.glb',
    sourceUrl: 'editor-asset://local/virtual-conveyor/virtual-conveyor.glb',
    assetRevision: 'generated-cargo-click-smoke',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    parameterValues: {},
  };
  const transform = (x, y, z) => ({ position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
  return {
    id: COMPOSITION_LIBRARY_ID,
    name: '箱子组',
    revision: COMPOSITION_REVISION,
    memberCount: 3,
    packagePath: '',
    updatedAt: new Date().toISOString(),
    contentSha256: '',
    syncStatus: 'local',
    definition: {
      schemaVersion: 1,
      name: '箱子组',
      nodes: [
        { id: 'box-single', name: '单箱', parentId: null, childrenIds: [], components: { transform: transform(0, 0, 4), modelAsset: memberTemplate } },
        { id: 'box-source', name: '阵列源箱', parentId: null, childrenIds: [], components: { transform: transform(0, 0, 0), modelAsset: memberTemplate } },
        { id: 'box-inst-1', name: '阵列箱一', parentId: null, childrenIds: [], components: { transform: transform(1.5, 0, 0), modelArrayInstance: { sourceEntityId: 'box-source' } } },
        { id: 'box-inst-2', name: '阵列箱二', parentId: null, childrenIds: [], components: { transform: transform(3, 0, 0), modelArrayInstance: { sourceEntityId: 'box-source' } } },
        { id: 'cube-marker', name: '标记块', parentId: null, childrenIds: [], components: { transform: transform(0, 2, 0), meshRenderer: { meshKind: 'cube', materialColor: '#ff0000' } } },
      ],
    },
  };
}

/** 组合目标生成器：货箱模板换为组合库引用，验证箱子组产物的点击链路。 */
function createCompositionGeneratorEntity() {
  return {
    id: COMPOSITION_GENERATOR_ENTITY_ID,
    name: '组合生成器',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: { position: { x: 12, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelGenerator: {
        defaultTarget: { kind: 'composition', libraryId: COMPOSITION_LIBRARY_ID, revision: COMPOSITION_REVISION, displayName: '箱子组' },
        rules: [],
      },
      clickEventBinding: {
        deviceSlots: [],
        events: [{ id: 'click-event-1', eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'chart-comp', name: '组合大屏' } }],
      },
    },
  };
}

function createDocument(createEmptySceneDocument, entities) {
  return {
    ...createEmptySceneDocument('Generated Cargo Click Smoke'),
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
  };
}

/** NullEngine 没有真实 DOM 画布，用最小桩满足拾取入口的坐标换算。 */
function createSmokeCanvas() {
  return {
    getBoundingClientRect: () => ({
      left: 0, top: 0, right: VIEWPORT_SIZE, bottom: VIEWPORT_SIZE,
      width: VIEWPORT_SIZE, height: VIEWPORT_SIZE,
    }),
  };
}

/** 把世界坐标投影到画布客户端坐标，供画布拾取接口使用。 */
function projectToClient(worldPoint, scene, camera, engine) {
  const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const projected = Vector3.Project(worldPoint, Matrix.Identity(), scene.getTransformMatrix(), viewport);
  return { x: projected.x, y: projected.y };
}

async function waitFor(condition, description) {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  assert.fail(`等待超时：${description}`);
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});

const engine = new NullEngine({ renderWidth: VIEWPORT_SIZE, renderHeight: VIEWPORT_SIZE });
const scene = new Scene(engine);
const camera = new FreeCamera('smoke-camera', new Vector3(0, 8, 14), scene);
camera.setTarget(new Vector3(0, 1, 0));
scene.activeCamera = camera;
const canvas = createSmokeCanvas();
const previousLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
let runtime = null;

try {
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const { buildClickEventAssetClickedPayload, resolveGeneratedUnitClick } = await server.ssrLoadModule(
    '/src/editor/model/clickEventBinding.ts',
  );
  const glbBytes = await fs.readFile(FIXTURE_GLB_PATH);
  SceneLoader.LoadAssetContainerAsync = async () => LoadAssetContainerAsync(glbBytes, scene, {
    pluginExtension: '.glb',
    name: 'GeneratedCargoClickSmoke.glb',
  });

  const modelAssetTemplate = {
    sourcePath: 'F:/fixtures/virtual-conveyor/virtual-conveyor.glb',
    sourceUrl: 'smoke://Assets/Models/virtual-conveyor/virtual-conveyor.glb',
    assetRevision: 'generated-cargo-click-smoke',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
  };
  const document = createDocument(createEmptySceneDocument, [
    createHostEntity(),
    createGeneratorEntity(modelAssetTemplate),
    createCompositionGeneratorEntity(),
  ]);

  runtime = new SceneRuntime(scene);
  runtime.sync(document);
  runtime.beginTelemetryPreview();

  // 1. 按货箱模板生成输出，挂在承载设备的货物支撑点下
  const generatorEntry = runtime.modelGenerators.get(GENERATOR_ENTITY_ID);
  assert.ok(generatorEntry, '模型生成器必须注册运行时条目');
  const cargoRoot = new TransformNode('smoke-cargo-root', scene);
  const snapshot = {
    sourceId: 'default',
    deviceType: 'conveyor',
    assetCode: HOST_ASSET_CODE,
    fields: {},
    receivedAt: Date.now(),
  };
  const cargo = {
    root: cargoRoot,
    assetCode: HOST_ASSET_CODE,
    containerCode: '000317',
    task: 'task-1',
    outputOwner: null,
    fallback: null,
    generatorEntityId: null,
    handoff: null,
    axialLengthCache: null,
    lockedWorldRotation: null,
  };
  runtime.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, generatorEntry, HOST_ENTITY_ID);
  assert.equal(cargo.hostEntityId, HOST_ENTITY_ID, '货物条目必须记录承运宿主实体');

  const cargoModel = await waitFor(() => {
    const output = cargo.outputOwner?.output;
    return output?.kind === 'model' && output.model.meshes.length > 0 ? output.model : null;
  }, '货箱模板模型完成加载');

  // 2. 生成的货箱网格带齐生成物拾取元数据
  assert.ok(
    cargoModel.meshes.every((mesh) => mesh.metadata?.generatorEntityId === GENERATOR_ENTITY_ID),
    '货箱网格必须携带生成器实体 id',
  );
  assert.ok(
    cargoModel.meshes.every((mesh) => mesh.metadata?.hostEntityId === HOST_ENTITY_ID),
    '货箱网格必须携带宿主设备实体 id',
  );
  assert.ok(
    cargoModel.meshes.every((mesh) => mesh.metadata?.sourceAssetCode === HOST_ASSET_CODE),
    '货箱网格必须携带宿主设备资产编号',
  );
  assert.ok(
    cargoModel.meshes.every((mesh) => mesh.metadata?.generatedUnitEntityId === cargo.outputOwner.entityId),
    '货箱网格必须携带产物自身的输出宿主 id',
  );

  // 3. 点击货箱：高亮/聚焦落在货箱自身，事件载荷说明产物身份与点击瞬间的承运设备
  const cargoBounds = runtime.getEntitiesWorldBounds([HOST_ENTITY_ID]);
  assert.ok(cargoBounds, '宿主设备必须可解析包围盒');
  cargoRoot.position.set(0, cargoBounds.sizeMeters.y, 0);
  cargoRoot.computeWorldMatrix(true);
  scene.render();
  const meshPoint = cargoModel.meshes[0].getBoundingInfo().boundingBox.centerWorld;
  const clickPoint = projectToClient(meshPoint, scene, camera, engine);

  const generatedHit = runtime.pickGeneratedUnitClickTargetAtCanvasPoint(clickPoint.x, clickPoint.y, canvas);
  assert.ok(generatedHit, '货箱必须能被生成物拾取命中');
  assert.equal(generatedHit.hit.bindingEntityId, GENERATOR_ENTITY_ID, '命中必须回指模型生成器实体');
  assert.equal(generatedHit.hit.assetCode, HOST_ASSET_CODE, '货箱没有自身编号，assetCode 上报承运设备编号');
  assert.equal(generatedHit.hit.highlightEntityId, cargo.outputOwner.entityId, '货箱的高亮目标是产物自身');
  assert.equal(generatedHit.hit.unitKind, 'cargo', '命中必须标记为货箱产物');
  assert.equal(generatedHit.hit.containerCode, '000317', '命中必须携带箱号');
  assert.equal(generatedHit.hit.hostEntityId, HOST_ENTITY_ID, '命中必须携带点击瞬间的承运设备');
  assert.ok(
    runtime.getEntitiesWorldBounds([cargo.outputOwner.entityId]),
    '产物自身必须可解析包围盒（聚焦通道）',
  );

  const resolution = resolveGeneratedUnitClick(document, generatedHit.hit);
  assert.equal(resolution.kind, 'trigger');
  if (resolution.kind !== 'trigger') assert.fail('货箱点击必须产出 trigger 决议');
  assert.equal(resolution.entityId, cargo.outputOwner.entityId);
  assert.deepEqual(resolution.effects, ['highlight', 'show-chart']);
  assert.deepEqual(buildClickEventAssetClickedPayload(document, resolution), {
    assetCode: HOST_ASSET_CODE,
    chartId: 'chart-cargo',
    unit: { kind: 'cargo', containerCode: '000317' },
    host: { entityId: HOST_ENTITY_ID, assetCode: HOST_ASSET_CODE, name: '宿主输送线' },
  });

  // 4. 生成器未配置点击事件时产物拾取短路，不给普通点击增加射线
  //    shadowDocument 与同步进来的文档同一引用，清空全部生成器事件即可模拟未配置状态。
  const compGeneratorEvents = document.entities[COMPOSITION_GENERATOR_ENTITY_ID].components.clickEventBinding.events;
  document.entities[GENERATOR_ENTITY_ID].components.clickEventBinding.events = [];
  document.entities[COMPOSITION_GENERATOR_ENTITY_ID].components.clickEventBinding.events = [];
  assert.equal(
    runtime.pickGeneratedUnitClickTargetAtCanvasPoint(clickPoint.x, clickPoint.y, canvas),
    null,
    '生成器未配置点击事件时必须短路生成物拾取',
  );
  // 5. 未配点击事件时产物命中回落到常规点击，不产生绑定决议
  assert.equal(resolveGeneratedUnitClick(document, generatedHit.hit), null);

  // 6. 组合（箱子组）目标：单箱成员、内置方块与阵列批次网格都必须带产物元数据并可拾取
  document.entities[COMPOSITION_GENERATOR_ENTITY_ID].components.clickEventBinding.events = compGeneratorEvents;
  const compositionEntry = createCompositionEntry();
  globalThis.window = {
    editorApi: {
      loadComposition: async (libraryId, revision) => {
        assert.equal(libraryId, COMPOSITION_LIBRARY_ID);
        assert.equal(revision, COMPOSITION_REVISION);
        return compositionEntry;
      },
    },
  };
  const compositionGeneratorEntry = runtime.modelGenerators.get(COMPOSITION_GENERATOR_ENTITY_ID);
  assert.ok(compositionGeneratorEntry, '组合生成器必须注册运行时条目');
  const compCargoRoot = new TransformNode('smoke-comp-cargo-root', scene);
  const compCargo = {
    root: compCargoRoot,
    assetCode: HOST_ASSET_CODE,
    containerCode: '000318',
    task: 'task-2',
    outputOwner: null,
    fallback: null,
    generatorEntityId: null,
    handoff: null,
    axialLengthCache: null,
    lockedWorldRotation: null,
  };
  runtime.syncGeneratedCargoVisual(compCargo, 'conveyor', snapshot, compositionGeneratorEntry, HOST_ENTITY_ID);
  const compOutput = await waitFor(() => {
    const output = compCargo.outputOwner?.output;
    return output?.kind === 'composition' ? output : null;
  }, '组合产物完成加载');
  // 组合条目已进模块级缓存，window 桩只对 loadComposition 有意义，撤掉以免影响 Babylon  dispose。
  delete globalThis.window;
  const compOwnerId = compCargo.outputOwner.entityId;

  const singleMember = compOutput.members.find((member) => member.nodeId === 'box-single');
  const arrayMember = compOutput.members.find((member) => member.nodeId === 'box-source');
  const cubeMember = compOutput.members.find((member) => member.nodeId === 'cube-marker');
  assert.ok(singleMember?.model && arrayMember?.arrayBatch && cubeMember?.mesh, '组合成员必须按定义构建');
  const assertProductMetadata = (mesh, label) => {
    assert.equal(mesh.metadata?.generatorEntityId, COMPOSITION_GENERATOR_ENTITY_ID, `${label}必须携带生成器实体 id`);
    assert.equal(mesh.metadata?.generatedUnitEntityId, compOwnerId, `${label}必须携带产物自身的输出宿主 id`);
    assert.equal(mesh.metadata?.hostEntityId, HOST_ENTITY_ID, `${label}必须携带承运宿主实体 id`);
    assert.equal(mesh.isPickable, true, `${label}必须可拾取`);
  };
  for (const mesh of singleMember.model.meshes) assertProductMetadata(mesh, '单箱成员网格');
  assertProductMetadata(cubeMember.mesh, '内置方块成员');
  for (const mesh of arrayMember.arrayBatch.meshes) {
    assertProductMetadata(mesh, '阵列批次网格');
    assert.equal(mesh.thinInstanceEnablePicking, true, '阵列批次网格必须开放实例级拾取');
  }
  assert.ok(
    arrayMember.model.meshes.every((mesh) => !scene.meshes.includes(mesh)),
    '阵列源成员网格必须退出场景（几何由批次承载）',
  );

  // 6b. 产物包围盒必须合并全部成员，阵列实例按逐实例并集计入而非只算基座几何
  compCargoRoot.position.set(0, cargoBounds.sizeMeters.y, 6);
  compCargoRoot.computeWorldMatrix(true);
  // 组合货物贴近地面且离原相机太近会投影出画面，换一台对准组合产物的相机再拾取。
  camera.position.set(1.5, 10, 18);
  camera.setTarget(new Vector3(1.5, 0.5, 5));
  scene.render();
  const compBounds = runtime.getEntitiesWorldBounds([compOwnerId]);
  assert.ok(compBounds, '组合产物必须可解析包围盒（聚焦通道）');
  assert.ok(compBounds.sizeMeters.x > 2.9, `阵列实例必须并入包围盒，实际 x 跨度 ${compBounds.sizeMeters.x}`);

  // 6c. 点击单箱成员与阵列批次实例：命中都回指组合生成器并携带产物与承运设备
  const singleMeshCenter = singleMember.model.meshes
    .find((mesh) => mesh.getTotalVertices() > 0)
    .getBoundingInfo().boundingBox.centerWorld;
  const singleClickPoint = projectToClient(singleMeshCenter, scene, camera, engine);
  const singleHit = runtime.pickGeneratedUnitClickTargetAtCanvasPoint(singleClickPoint.x, singleClickPoint.y, canvas);
  assert.ok(singleHit, '组合单箱成员必须能被生成物拾取命中');
  assert.equal(singleHit.hit.bindingEntityId, COMPOSITION_GENERATOR_ENTITY_ID);
  assert.equal(singleHit.hit.highlightEntityId, compOwnerId);

  const batchMesh = arrayMember.arrayBatch.meshes.find((mesh) => mesh.thinInstanceCount > 0);
  assert.ok(batchMesh, '阵列批次网格必须存在实例');
  // thinInstanceGetWorldMatrices 可能返回陈旧缓存：读当前 matrixData 手动组合批次网格世界矩阵。
  batchMesh.computeWorldMatrix(true);
  const batchWorld = batchMesh.getWorldMatrix();
  const matrixData = batchMesh._thinInstanceDataStorage?.matrixData;
  const instanceMatrix = matrixData && matrixData.length >= 16
    ? Matrix.FromArray(matrixData, 0).multiply(batchWorld)
    : batchMesh.thinInstanceGetWorldMatrices()[0];
  const extend = batchMesh.geometry.extend;
  const instanceCenter = Vector3.TransformCoordinates(
    new Vector3(
      (extend.minimum.x + extend.maximum.x) / 2,
      (extend.minimum.y + extend.maximum.y) / 2,
      (extend.minimum.z + extend.maximum.z) / 2,
    ),
    instanceMatrix,
  );
  const compClickPoint = projectToClient(instanceCenter, scene, camera, engine);
  const compHit = runtime.pickGeneratedUnitClickTargetAtCanvasPoint(compClickPoint.x, compClickPoint.y, canvas);
  assert.ok(compHit, '阵列批次实例必须能被生成物拾取命中');
  assert.equal(compHit.hit.bindingEntityId, COMPOSITION_GENERATOR_ENTITY_ID, '命中必须回指组合生成器实体');
  assert.equal(compHit.hit.highlightEntityId, compOwnerId, '组合产物的高亮目标是产物自身');
  assert.equal(compHit.hit.unitKind, 'cargo');
  assert.equal(compHit.hit.containerCode, '000318');
  assert.equal(compHit.hit.hostEntityId, HOST_ENTITY_ID);
  assert.equal(
    runtime.pickRuntimeModelEntityIdAtCanvasPoint(compClickPoint.x, compClickPoint.y, canvas) === compOwnerId,
    false,
    '组合产物不得进入常规实体拾取',
  );

  const compResolution = resolveGeneratedUnitClick(document, compHit.hit);
  assert.equal(compResolution.kind, 'trigger');
  assert.deepEqual(buildClickEventAssetClickedPayload(document, compResolution), {
    assetCode: HOST_ASSET_CODE,
    chartId: 'chart-comp',
    unit: { kind: 'cargo', containerCode: '000318' },
    host: { entityId: HOST_ENTITY_ID, assetCode: HOST_ASSET_CODE, name: '宿主输送线' },
  });

  console.log('生成器货箱点击冒烟通过：元数据下发/产物高亮自身/产物与承运设备上报/未配置短路/组合目标全成员可点击');
} finally {
  SceneLoader.LoadAssetContainerAsync = previousLoadAssetContainerAsync;
  try {
    runtime?.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
    await server.close();
  }
}
