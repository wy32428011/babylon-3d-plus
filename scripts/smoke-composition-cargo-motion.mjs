import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FreeCamera,
  LoadAssetContainerAsync,
  NullEngine,
  Scene,
  SceneLoader,
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
const COMPOSITION_LIBRARY_ID = 'comp-smoke';
const COMPOSITION_REVISION = 'rev-smoke-1';
const WAIT_ATTEMPTS = 1_000;
const WAIT_INTERVAL_MS = 20;

/** 目标类型由 CLI 参数切换：composition（默认）/ model，用于对照。 */
const TARGET_KIND = process.argv[2] === 'model' ? 'model' : 'composition';

const MODEL_ASSET_TEMPLATE = {
  sourcePath: 'F:/fixtures/virtual-conveyor/virtual-conveyor.glb',
  sourceUrl: 'editor-asset://local/Assets/Models/virtual-conveyor/virtual-conveyor.glb',
  assetRevision: 'composition-cargo-motion-smoke',
  lengthUnit: 'meter',
  unitScaleToMeters: 1,
};

function createHostEntity() {
  return {
    id: HOST_ENTITY_ID,
    name: '宿主输送线',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 8, y: 1, z: 1 } },
      modelAsset: {
        sourcePath: 'F:/fixtures/virtual-conveyor/virtual-conveyor.glb',
        sourceUrl: 'editor-asset://local/Assets/Models/virtual-conveyor/virtual-conveyor.glb',
        assetRevision: 'composition-cargo-motion-smoke',
        assetCode: HOST_ASSET_CODE,
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
        parameterValues: {},
      },
      telemetryBinding: {
        enabled: true,
        sourceId: 'default',
        deviceType: 'conveyor',
        expectedIntervalMs: 500,
        staleAfterMs: 60_000,
        cargoOriginDevice: true,
        cargoGeneratorId: GENERATOR_ENTITY_ID,
      },
    },
  };
}

function createGeneratorEntity() {
  const defaultTarget = TARGET_KIND === 'model'
    ? { kind: 'model', assetId: 'cargo-asset', displayName: '货箱模板', modelAsset: MODEL_ASSET_TEMPLATE }
    : {
      kind: 'composition',
      libraryId: COMPOSITION_LIBRARY_ID,
      revision: COMPOSITION_REVISION,
      displayName: '组合货物',
    };
  return {
    id: GENERATOR_ENTITY_ID,
    name: '模型生成器',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: { position: { x: 6, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelGenerator: { defaultTarget, rules: [] },
    },
  };
}

/** 组合条目：一个内置立方体成员 + 一个 GLB 模型成员。 */
function createCompositionEntry() {
  const identity = () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
  return {
    id: COMPOSITION_LIBRARY_ID,
    name: '组合货物',
    revision: COMPOSITION_REVISION,
    memberCount: 2,
    packagePath: 'smoke://composition',
    updatedAt: new Date().toISOString(),
    contentSha256: 'smoke',
    syncStatus: 'local',
    definition: {
      schemaVersion: 1,
      name: '组合货物',
      nodes: [
        {
          id: 'node-cube',
          name: '立方体',
          parentId: null,
          childrenIds: [],
          components: {
            transform: identity(),
            meshRenderer: { meshKind: 'cube', materialColor: '#ff0000' },
          },
        },
        {
          id: 'node-model',
          name: '模型',
          parentId: null,
          childrenIds: [],
          components: {
            transform: { ...identity(), position: { x: 1, y: 0, z: 0 } },
            modelAsset: MODEL_ASSET_TEMPLATE,
          },
        },
        {
          id: 'node-array-1',
          name: '阵列实例1',
          parentId: null,
          childrenIds: [],
          components: {
            transform: { ...identity(), position: { x: 2, y: 0, z: 0 } },
            modelArrayInstance: { sourceEntityId: 'node-model' },
          },
        },
        {
          id: 'node-array-2',
          name: '阵列实例2',
          parentId: null,
          childrenIds: [],
          components: {
            transform: { ...identity(), position: { x: 3, y: 0, z: 0 } },
            modelArrayInstance: { sourceEntityId: 'node-model' },
          },
        },
      ],
    },
  };
}

function createDocument(createEmptySceneDocument, entities) {
  return {
    ...createEmptySceneDocument('Composition Cargo Motion Smoke'),
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
  };
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

const engine = new NullEngine({ renderWidth: 800, renderHeight: 800 });
// NullEngine 不走 runRenderLoop，getDeltaTime 恒 0，手动渲染循环必须补帧间隔
engine.getDeltaTime = () => 100 / 6;
const scene = new Scene(engine);
const camera = new FreeCamera('smoke-camera', new Vector3(0, 8, 14), scene);
camera.setTarget(new Vector3(0, 1, 0));
scene.activeCamera = camera;
const previousLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
let runtime = null;

try {
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const { deviceTelemetryStore } = await server.ssrLoadModule('/src/runtime/mqtt/deviceTelemetry.ts');
  const glbBytes = await fs.readFile(FIXTURE_GLB_PATH);
  SceneLoader.LoadAssetContainerAsync = async () => LoadAssetContainerAsync(glbBytes, scene, {
    pluginExtension: '.glb',
    name: 'CompositionCargoMotionSmoke.glb',
  });

  // 组合库走 editor-asset IPC，冒烟环境直接桩掉 window.editorApi.loadComposition
  globalThis.window = globalThis.window ?? {};
  window.addEventListener = window.addEventListener ?? (() => {});
  window.removeEventListener = window.removeEventListener ?? (() => {});
  window.editorApi = {
    ...(window.editorApi ?? {}),
    loadComposition: async (id, revision) => {
      assert.equal(id, COMPOSITION_LIBRARY_ID);
      assert.equal(revision, COMPOSITION_REVISION);
      return createCompositionEntry();
    },
  };

  const document = createDocument(createEmptySceneDocument, [createHostEntity(), createGeneratorEntity()]);
  runtime = new SceneRuntime(scene);
  runtime.sync(document);

  // 宿主输送线模型就绪后再进运行态
  await waitFor(() => {
    const model = runtime.models.get(HOST_ENTITY_ID);
    return model?.assetHandle ? model : null;
  }, '宿主输送线模型完成加载');
  runtime.beginTelemetryPreview();

  const cargoRootName = `conveyor_cargo_root_${HOST_ASSET_CODE}_cargo`;
  const pushSnapshot = (sequence) => {
    deviceTelemetryStore.upsert({
      sourceId: 'default',
      topic: 'smoke/topic',
      deviceType: 'conveyor',
      assetCode: HOST_ASSET_CODE,
      payloadDeviceCode: null,
      sourceTimestamp: null,
      sequence,
      receivedAt: Date.now(),
      fields: { task: 1, movement_x: 1, front_has_goods: 1, back_has_goods: 0, mode: 1 },
      currentLocationKey: null,
      targetLocationKey: null,
      hasTargetLocation: false,
      faulted: false,
      message: '',
    });
  };

  // 持续推流 + 渲染帧，等待货物刷出
  let cargoRoot = null;
  for (let tick = 0; tick < 400 && !cargoRoot; tick += 1) {
    pushSnapshot(tick);
    scene.render();
    await new Promise((resolve) => setTimeout(resolve, 5));
    cargoRoot = scene.getTransformNodeByName(cargoRootName);
  }
  assert.ok(cargoRoot, `货物支撑点 ${cargoRootName} 必须刷出`);

  // 等货物输出（组合或模型模板）加载完成
  await waitFor(() => {
    scene.render();
    return cargoRoot.getChildMeshes(false).length > 0 ? true : null;
  }, '货物模板输出完成加载');

  // 记录初始位置后继续驱动 200 tick，验证货物持续移动
  scene.render();
  const startX = cargoRoot.getAbsolutePosition().x;
  const startZ = cargoRoot.getAbsolutePosition().z;
  for (let tick = 400; tick < 600; tick += 1) {
    pushSnapshot(tick);
    scene.render();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  scene.render();
  const end = cargoRoot.getAbsolutePosition();
  const moved = Math.hypot(end.x - startX, end.z - startZ);
  console.log(`目标类型=${TARGET_KIND} 货物起点=(${startX.toFixed(3)}, ${startZ.toFixed(3)}) 终点=(${end.x.toFixed(3)}, ${end.z.toFixed(3)}) 位移=${moved.toFixed(3)}m`);
  assert.ok(moved > 0.05, `货物必须在输送线上移动，实际位移 ${moved.toFixed(4)}m`);

  console.log(`组合货物端到端移动冒烟通过（目标类型 ${TARGET_KIND}）`);
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
