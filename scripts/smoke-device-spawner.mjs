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
const TEMPLATE_ENTITY_ID = 'SPAWN-TEMPLATE';
const SPAWNER_ENTITY_ID = 'SPAWNER-1';
const SPAWNER_CODE = 'AGV-SPAWN';
const SPAWN_TOPIC = `dt/factory/logistics/conveyor/${SPAWNER_CODE}/dataspawn/joint`;
const WAIT_ATTEMPTS = 1_000;
const WAIT_INTERVAL_MS = 20;

/** 创建模板设备实体：普通模型资产 + 遥测绑定，供产生器拷贝参数。 */
function createTemplateEntity() {
  return {
    id: TEMPLATE_ENTITY_ID,
    name: '产生器模板输送线',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: {
        position: { x: 3, y: 0, z: -2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {
        sourcePath: 'F:/fixtures/virtual-conveyor/virtual-conveyor.glb',
        sourceUrl: 'smoke://Assets/Models/virtual-conveyor/virtual-conveyor.glb',
        assetRevision: 'device-spawner-smoke',
        assetCode: 'SPAWN-TEMPLATE-CODE',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
        parameterValues: {},
      },
      telemetryBinding: {
        enabled: true,
        sourceId: 'default',
        deviceType: 'conveyor',
        expectedIntervalMs: 500,
        staleAfterMs: 2_000,
      },
    },
  };
}

/** 创建绑定模板实体的设备产生器。 */
function createSpawnerEntity(timeoutSeconds) {
  return {
    id: SPAWNER_ENTITY_ID,
    name: '设备产生器',
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      deviceSpawner: {
        spawnerCode: SPAWNER_CODE,
        templateEntityId: TEMPLATE_ENTITY_ID,
        timeoutSeconds,
      },
    },
  };
}

function createDocument(createEmptySceneDocument, entities) {
  return {
    ...createEmptySceneDocument('Device Spawner Smoke'),
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

function dispatchSpawn(dispatch, assetCode, points) {
  const handled = dispatch(
    SPAWN_TOPIC,
    JSON.stringify({
      data: points.map((point) => ({ e: assetCode, s: SPAWNER_CODE, ...point })),
      ts: new Date().toISOString(),
    }),
  );
  assert.equal(handled, true, 'dataspawn 消息必须被分发器拦截');
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});

const engine = new NullEngine();
const scene = new Scene(engine);
scene.activeCamera = new FreeCamera('smoke-camera', new Vector3(8, 6, -12), scene);
const previousLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
let runtime = null;

try {
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { dispatchDeviceSpawnMessages, deviceTelemetryStore } = await server.ssrLoadModule(
    '/src/runtime/mqtt/deviceTelemetry.ts',
  );
  const { createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const glbBytes = await fs.readFile(FIXTURE_GLB_PATH);
  SceneLoader.LoadAssetContainerAsync = async () => LoadAssetContainerAsync(glbBytes, scene, {
    pluginExtension: '.glb',
    name: 'DeviceSpawnerSmoke.glb',
  });

  runtime = new SceneRuntime(scene);
  runtime.sync(createDocument(createEmptySceneDocument, [createTemplateEntity(), createSpawnerEntity(1)]));
  await waitFor(
    () => runtime.models.get(TEMPLATE_ENTITY_ID)?.assetHandle,
    '模板模型完成加载',
  );

  runtime.beginTelemetryPreview();

  // 1. 首条消息生成动态实例，初始位置 = 模板位置，网格不可拾取
  dispatchSpawn(dispatchDeviceSpawnMessages, 'AGV-01', [
    { p: 'deviceCode', v: 'AGV-01' },
    { p: 'distance_x', v: 4.2 },
  ]);
  const spawnedModel = await waitFor(() => {
    const model = runtime.spawnedDeviceModels.values().next().value;
    return model?.meshes.length > 0 ? model : null;
  }, '动态实例完成生成与网格挂载');
  assert.equal(runtime.spawnedDeviceModels.size, 1);
  assert.equal(spawnedModel.assetCode, 'AGV-01', '实例资产编号必须来自消息 e 字段');
  const templatePosition = runtime.models.get(TEMPLATE_ENTITY_ID).root.getAbsolutePosition();
  const spawnedPosition = spawnedModel.root.getAbsolutePosition();
  assert.ok(
    Math.abs(spawnedPosition.x - templatePosition.x) < 1e-6
      && Math.abs(spawnedPosition.y - templatePosition.y) < 1e-6
      && Math.abs(spawnedPosition.z - templatePosition.z) < 1e-6,
    `实例初始位置必须等于模板位置，实际 ${spawnedPosition.toString()}，预期 ${templatePosition.toString()}`,
  );
  assert.ok(
    spawnedModel.meshes.every((mesh) => !mesh.isPickable),
    '动态实例网格必须不可拾取',
  );
  const snapshot = deviceTelemetryStore.getSnapshot('AGV-01', 'conveyor', 'default');
  assert.ok(snapshot, '实例快照必须按模板派生 deviceType 写入遥测仓库');
  assert.equal(snapshot.fields.distance_x, 4.2);

  // 2. 同资产编号再次收到消息：不重复生成
  dispatchSpawn(dispatchDeviceSpawnMessages, 'AGV-01', [{ p: 'distance_x', v: 9.9 }]);
  assert.equal(runtime.spawnedDeviceModels.size, 1, '同一资产编号不得重复生成');
  assert.equal(deviceTelemetryStore.getSnapshot('AGV-01', 'conveyor', 'default')?.fields.distance_x, 9.9);

  // 3. 显式下线消息销毁实例
  dispatchSpawn(dispatchDeviceSpawnMessages, 'AGV-01', [{ p: 'status', v: 'offline' }]);
  assert.equal(runtime.spawnedDeviceModels.size, 0, '收到 status=offline 必须销毁实例');

  // 4. 重新生成后，超时无消息由渲染帧统一销毁
  dispatchSpawn(dispatchDeviceSpawnMessages, 'AGV-02', [{ p: 'normal', v: true }]);
  await waitFor(() => runtime.spawnedDeviceModels.size === 1, 'AGV-02 实例生成');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  scene.render();
  assert.equal(runtime.spawnedDeviceModels.size, 0, '超过 timeoutSeconds 无消息必须销毁实例');

  // 5. 结束预览统一清理
  dispatchSpawn(dispatchDeviceSpawnMessages, 'AGV-03', [{ p: 'normal', v: true }]);
  await waitFor(() => runtime.spawnedDeviceModels.size === 1, 'AGV-03 实例生成');
  runtime.endTelemetryPreview();
  assert.equal(runtime.spawnedDeviceModels.size, 0, '结束预览必须销毁全部动态实例');

  console.log('设备产生器运行时冒烟通过：生成/位置/拾取/快照/去重/下线/超时/退出清理');
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
