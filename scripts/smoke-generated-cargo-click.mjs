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
const VIEWPORT_SIZE = 800;
const WAIT_ATTEMPTS = 1_000;
const WAIT_INTERVAL_MS = 20;

/** 宿主输送线实体：货箱承运方，点击货箱时应上报它的编号并高亮它本身。 */
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

  // 3. 点击货箱：命中解析回落宿主设备，上报宿主编号，高亮宿主实体
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
  assert.equal(generatedHit.hit.assetCode, HOST_ASSET_CODE, '货箱没有自身编号，必须上报宿主设备编号');
  assert.equal(generatedHit.hit.highlightEntityId, HOST_ENTITY_ID, '货箱的高亮目标是宿主设备实体');

  const resolution = resolveGeneratedUnitClick(document, generatedHit.hit);
  assert.equal(resolution.kind, 'trigger');
  if (resolution.kind !== 'trigger') assert.fail('货箱点击必须产出 trigger 决议');
  assert.equal(resolution.entityId, HOST_ENTITY_ID);
  assert.deepEqual(resolution.effects, ['highlight', 'show-chart']);
  assert.deepEqual(buildClickEventAssetClickedPayload(document, resolution), {
    assetCode: HOST_ASSET_CODE,
    chartId: 'chart-cargo',
  });

  // 4. 生成器未配置点击事件时产物拾取短路，不给普通点击增加射线
  //    shadowDocument 与同步进来的文档同一引用，清空事件即可模拟未配置状态。
  document.entities[GENERATOR_ENTITY_ID].components.clickEventBinding.events = [];
  assert.equal(
    runtime.pickGeneratedUnitClickTargetAtCanvasPoint(clickPoint.x, clickPoint.y, canvas),
    null,
    '生成器未配置点击事件时必须短路生成物拾取',
  );
  // 5. 未配点击事件时产物命中回落到常规点击，不产生绑定决议
  assert.equal(resolveGeneratedUnitClick(document, generatedHit.hit), null);

  console.log('生成器货箱点击冒烟通过：元数据下发/宿主回落/上报编号/高亮目标/未配置短路');
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
