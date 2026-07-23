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
const EDIT_THIN_INSTANCE_ENTITY_COUNT = STATIC_ENTITY_COUNT - 1;
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

/** 等待编辑态自动分组完成脚本/参数初始化，并一次提交全部逻辑实体矩阵。 */
async function waitForEditThinInstanceBatch(runtime, sourceEntityId, expectedEntityCount) {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const sourceModel = runtime.models.get(sourceEntityId);
    const batch = sourceModel?.modelArrayBatch;
    if (
      sourceModel?.measurementReady
      && batch?.meshes.length > 0
      && batch.meshes.every((mesh) => mesh.thinInstanceCount === expectedEntityCount)
    ) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  assert.fail(`等待编辑态 ${expectedEntityCount} 个 thinInstance 完成批量提交超时`);
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
    const [
      { SceneRuntime },
      { createEditModeModelThinInstancePlan, resolveEditModeModelThinInstanceReason },
    ] = await Promise.all([
      server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts'),
      server.ssrLoadModule('/src/editor/model/editModeModelThinInstances.ts'),
    ]);
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
    const rawDocument = createDocument(entities, entityIds);
    const editPlan = createEditModeModelThinInstancePlan(rawDocument);
    const editDocument = { ...rawDocument, entities: editPlan.entities };

    assert.equal(
      resolveEditModeModelThinInstanceReason(modelAsset),
      'no-external-script',
      '无外置脚本静态模型必须允许编辑态 thinInstance',
    );
    assert.equal(
      resolveEditModeModelThinInstanceReason({
        ...modelAsset,
        scriptAssets: [{ name: 'unsafe.model.ts', path: 'F:/unsafe.model.ts', sourceUrl: 'smoke://unsafe.model.ts' }],
      }),
      null,
      '未知外置脚本必须回退逐实体模型，避免合并 assetCode 或运行态差异',
    );
    assert.equal(
      resolveEditModeModelThinInstanceReason({
        ...modelAsset,
        scriptAssets: [{ name: 'yzj.model.ts', path: 'F:/unsafe/other.model.ts', sourceUrl: 'smoke://unsafe/other.model.ts' }],
      }),
      null,
      '仅伪装成已核对脚本文件名但模型包或真实脚本路径不匹配时必须回退',
    );
    assert.equal(
      resolveEditModeModelThinInstanceReason({
        ...modelAsset,
        sourcePath: 'F:/YZJ/YZJ.glb',
        sourceUrl: 'smoke://YZJ/YZJ.glb',
        scriptAssets: [{ name: 'yzj.model.ts', path: 'F:/YZJ/yzj.model.ts', sourceUrl: 'smoke://YZJ/yzj.model.ts' }],
      }),
      'verified-parametric-script',
      '已核对编辑态行为的参数化脚本必须允许按参数变体分组',
    );
    assert.equal(editPlan.groupCount, 1, '100 个同模板静态模型必须形成一个编辑态分组');
    assert.equal(editPlan.thinInstanceEntityCount, EDIT_THIN_INSTANCE_ENTITY_COUNT, '分组必须只保留一个真实模型源');
    assert.equal(editPlan.sourceEntityIds.length, 1, '编辑态分组必须选择一个稳定源实体');

    const movedEntityId = entityIds.at(-1);
    const movedEntity = entities[movedEntityId];
    const movedEntities = {
      ...entities,
      [movedEntityId]: {
        ...movedEntity,
        components: {
          ...movedEntity.components,
          transform: {
            ...movedEntity.components.transform,
            position: { ...movedEntity.components.transform.position, x: 999 },
          },
        },
      },
    };
    const incrementalPlan = createEditModeModelThinInstancePlan(
      createDocument(movedEntities, entityIds),
      editPlan,
    );
    assert.equal(incrementalPlan.groupCount, 1, '单实体 Transform 变化不得拆散模型模板分组');
    assert.equal(
      incrementalPlan.entities[entityIds[1]],
      editPlan.entities[entityIds[1]],
      '单实体 Transform 变化必须复用其它稳定派生实体，保持增量同步命中',
    );
    assert.notEqual(
      incrementalPlan.entities[movedEntityId],
      editPlan.entities[movedEntityId],
      '发生 Transform 变化的逻辑实体必须生成新的派生快照',
    );

    runtime.sync(editDocument);
    const editBatch = await waitForEditThinInstanceBatch(
      runtime,
      editPlan.sourceEntityIds[0],
      EDIT_THIN_INSTANCE_ENTITY_COUNT,
    );
    assert.equal(loadCount, 1, '编辑态 100 个同源模型必须只加载一次 AssetContainer');
    assert.equal(runtime.models.size, 1, '编辑态重复模型不得创建逐实体 ModelRuntimeEntry');
    assert.equal(
      runtime.modelArrayInstanceEntities.size,
      EDIT_THIN_INSTANCE_ENTITY_COUNT,
      '编辑态覆盖层必须保留每个逻辑实体的独立 ID 与 Transform',
    );
    assert.ok(
      editBatch.meshes.every((mesh) => !mesh.isAnInstance && mesh.thinInstanceCount === EDIT_THIN_INSTANCE_ENTITY_COUNT),
      '编辑态重复模型必须按源 Mesh 创建固定批次并一次提交 thinInstance 矩阵',
    );
    const editBatchMeshCount = editBatch.meshes.length;

    // 运行预览继续使用原始文档，必须恢复逐实体脚本、assetCode 和遥测隔离。
    runtime.sync(rawDocument);
    await waitForAllEntityMeshes(scene, entityIds);
    assert.equal(runtime.models.size, STATIC_ENTITY_COUNT, '原始运行文档必须恢复全部独立 ModelRuntimeEntry');
    assert.equal(runtime.modelArrayInstanceEntities.size, 0, '编辑态自动覆盖不得写回或污染运行文档');
    assert.equal(loadCount, 1, '展开运行实体仍应复用同一个共享源 AssetContainer');
    const firstMeshes = collectEntityMeshes(scene, entityIds[0]);
    const lastMeshes = collectEntityMeshes(scene, entityIds.at(-1));
    assert.ok(firstMeshes.length > 0, '首个静态实体必须包含有效渲染 Mesh');
    assert.equal(firstMeshes.length, lastMeshes.length, '同源静态实体必须保持一致 Mesh 结构');
    assert.ok(firstMeshes.every((mesh) => mesh.isAnInstance), '运行态普通静态模型必须保持 InstancedMesh 共享路径');
    assert.ok(lastMeshes.every((mesh) => mesh.isAnInstance), '最后一个运行实体也必须保持 InstancedMesh');

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
      editThinInstanceEntityCount: EDIT_THIN_INSTANCE_ENTITY_COUNT,
      editThinInstanceMeshCount: editBatchMeshCount,
      sourceLoadCount: loadCount,
      sourceDisposeCount,
      renderableMeshesPerEntity: firstMeshes.length,
      selectionSync: 'incremental',
      runtimeExpansion: 'isolated',
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
