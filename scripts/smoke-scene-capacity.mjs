import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LoadAssetContainerAsync,
  NullEngine,
  Scene,
  SceneLoader,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { createServer } from 'vite';

const FIXTURE_GLB_PATH = path.join(process.cwd(), 'output', 'playwright', 'shelf-assets', 'Shelf.glb');
const STATIC_ENTITY_COUNT = 100;
const WAIT_ATTEMPTS = 1_000;
const WAIT_INTERVAL_MS = 20;

/** 创建不带脚本和参数配置的普通静态模型资产，资源标识故意不包含 Shelf。 */
function createStaticModelAsset() {
  return {
    sourcePath: 'F:/fixtures/StaticRack/StaticRack.glb',
    sourceUrl: 'smoke://Assets/Models/StaticRack/StaticRack.glb',
    assetRevision: 'scene-capacity-smoke',
    assetCode: 'STATIC-RACK',
    lengthUnit: 'millimeter',
    unitScaleToMeters: 0.001,
  };
}

/** 创建一个可独立编辑 Transform 的静态模型实体。 */
function createStaticEntity(index, modelAsset) {
  const id = `STATIC-RACK-${String(index + 1).padStart(3, '0')}`;
  return {
    id,
    name: id,
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: false,
    components: {
      transform: {
        position: { x: index * 2, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: { ...modelAsset, assetCode: id },
    },
  };
}

/** 使用稳定 entities/entityIds 引用创建最小 SceneRuntime 文档，便于验证选择专用增量路径。 */
function createDocument(entities, entityIds, selectedEntityId = null) {
  return {
    id: 'scene_capacity_smoke',
    name: 'Scene Capacity Smoke',
    entityIds,
    entities,
    selectedEntityId,
    mqttConfig: {},
    sceneSettings: {},
  };
}

/** 等待每个静态实体都出现至少一个带真实顶点的实例 Mesh。 */
async function waitForAllEntityMeshes(scene, entityIds) {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const readyIds = new Set(
      scene.meshes
        .filter((mesh) => !mesh.isDisposed() && mesh.getTotalVertices() > 0)
        .map((mesh) => mesh.metadata?.editorEntityId)
        .filter((entityId) => typeof entityId === 'string'),
    );
    if (entityIds.every((entityId) => readyIds.has(entityId))) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  assert.fail(`等待 ${entityIds.length} 个静态共享实体完成实例化超时`);
}

/** 收集指定实体的有效渲染 Mesh。 */
function collectEntityMeshes(scene, entityId) {
  return scene.meshes.filter((mesh) => (
    !mesh.isDisposed()
    && mesh.getTotalVertices() > 0
    && mesh.metadata?.editorEntityId === entityId
  ));
}

/** 运行静态共享实例、增量选择和引用计数的 SceneRuntime 集成 smoke。 */
async function run() {
  const glbBytes = new Uint8Array(await fs.readFile(FIXTURE_GLB_PATH));
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: {
        '@linkiez/dxf-renew': path.join(process.cwd(), 'scripts', 'smoke-stubs', 'dxf-renew.mjs'),
      },
    },
  });
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const originalLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
  let runtime;
  let loadCount = 0;
  let sourceDisposeCount = 0;

  try {
    const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
    SceneLoader.LoadAssetContainerAsync = async () => {
      loadCount += 1;
      const container = await LoadAssetContainerAsync(glbBytes, scene, {
        pluginExtension: '.glb',
        name: FIXTURE_GLB_PATH,
      });
      const originalDispose = container.dispose.bind(container);
      let disposed = false;
      container.dispose = () => {
        if (!disposed) {
          disposed = true;
          sourceDisposeCount += 1;
        }
        originalDispose();
      };
      return container;
    };

    runtime = new SceneRuntime(scene);
    const modelAsset = createStaticModelAsset();
    const entityList = Array.from({ length: STATIC_ENTITY_COUNT }, (_, index) => createStaticEntity(index, modelAsset));
    const entities = Object.fromEntries(entityList.map((entity) => [entity.id, entity]));
    const entityIds = entityList.map((entity) => entity.id);
    runtime.sync(createDocument(entities, entityIds));
    await waitForAllEntityMeshes(scene, entityIds);

    assert.equal(loadCount, 1, '100 个同源静态模型必须只加载一次源 AssetContainer');
    const firstMeshes = collectEntityMeshes(scene, entityIds[0]);
    const lastMeshes = collectEntityMeshes(scene, entityIds.at(-1));
    assert.ok(firstMeshes.length > 0, '首个静态实体必须包含有效渲染 Mesh');
    assert.equal(firstMeshes.length, lastMeshes.length, '同源静态实体必须保持一致 Mesh 结构');
    assert.ok(firstMeshes.every((mesh) => mesh.isAnInstance), '普通静态模型必须进入 InstancedMesh 共享路径');
    assert.ok(lastMeshes.every((mesh) => mesh.isAnInstance), '最后一个静态模型也必须保持 InstancedMesh');

    const firstContentRoot = scene.transformNodes.find((node) => node.name === `${entityIds[0]}_modelContentRoot`);
    assert.ok(firstContentRoot, '必须找到首个静态实体 contentRoot');
    const originalGetChildMeshes = firstContentRoot.getChildMeshes.bind(firstContentRoot);
    firstContentRoot.getChildMeshes = () => {
      throw new Error('选择变化不应重新收集未修改模型的全部子 Mesh');
    };
    assert.doesNotThrow(
      () => runtime.sync(createDocument(entities, entityIds, entityIds[0])),
      '仅改变选择时必须走展示层增量同步',
    );
    firstContentRoot.getChildMeshes = originalGetChildMeshes;

    const remainingIds = entityIds.slice(1);
    const remainingEntities = Object.fromEntries(remainingIds.map((entityId) => [entityId, entities[entityId]]));
    runtime.sync(createDocument(remainingEntities, remainingIds));
    assert.ok(firstMeshes.every((mesh) => mesh.isDisposed()), '删除单个静态实体必须释放其全部实例 Mesh');
    assert.equal(sourceDisposeCount, 0, '仍有共享实例时不得释放源 AssetContainer');

    runtime.sync(createDocument({}, []));
    assert.equal(sourceDisposeCount, 1, '删除最后一个共享实例时必须只释放一次源 AssetContainer');

    console.log(JSON.stringify({
      ok: true,
      entityCount: STATIC_ENTITY_COUNT,
      sourceLoadCount: loadCount,
      sourceDisposeCount,
      renderableMeshesPerEntity: firstMeshes.length,
      selectionSync: 'incremental',
    }, null, 2));
  } finally {
    runtime?.dispose();
    SceneLoader.LoadAssetContainerAsync = originalLoadAssetContainerAsync;
    scene.dispose();
    engine.dispose();
    await server.close();
  }
}

await run();
