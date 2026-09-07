import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AssetContainer, MeshBuilder, NullEngine, Scene, SceneLoader, StandardMaterial } from '@babylonjs/core';
import { build } from 'vite';

const cacheRoot = path.resolve('node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const bundleRoot = await mkdtemp(path.join(cacheRoot, 'scene-load-smoke-'));
const baseline = process.argv.includes('--baseline');
try {
  // 使用一次 SSR 构建，避免加载完整编辑器依赖图时逐模块往返；不启动或污染开发服务器。
  await build({ configFile: false, logLevel: 'error',
    resolve: { alias: { '@linkiez/dxf-renew': path.join(process.cwd(), 'scripts/smoke-stubs/dxf-renew.mjs') } },
    build: { ssr: true, outDir: bundleRoot, emptyOutDir: false, minify: false,
      rollupOptions: { input: { SceneRuntime: 'src/runtime/babylon/SceneRuntime.ts', SceneDocument: 'src/editor/model/SceneDocument.ts' } } },
  });
  const { SceneRuntime } = await import(pathToFileURL(path.join(bundleRoot, 'SceneRuntime.js')).href);
  const { createEmptySceneDocument } = await import(pathToFileURL(path.join(bundleRoot, 'SceneDocument.js')).href);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  let notificationCount = 0;
  let latest;
  const logs = [];
  const runtime = new SceneRuntime(scene, (message) => logs.push(message), undefined, undefined, (progress) => {
    notificationCount += 1;
    latest = progress;
  });
  const originalLoader = SceneLoader.LoadAssetContainerAsync;
  let loadCount = 0;
  try {
    // 真实登记/更新/结算路径的数量级守卫，不能通过更快的测试机器掩盖逐事件全表汇总。
    const startedAt = performance.now();
    const ids = Array.from({ length: 5000 }, (_, index) => runtime.beginModelLoadProgressUnit(`model-${index}.glb`));
    for (const id of ids) runtime.updateModelLoadProgressUnit(id, { loaded: 50, total: 100 });
    for (const id of ids) runtime.settleModelLoadProgressUnit(id);
    await Promise.resolve();
    const progressNotifications = notificationCount;
    const progressMs = performance.now() - startedAt;
    console.log(JSON.stringify({ phase: 'progress', progressNotifications, progressMs }));
    assert.equal(latest.loading, false);
    assert.equal(latest.completedCount, 5000);
    if (!baseline) assert.ok(progressNotifications <= 3, `同一批次5000个模型只应合并通知，实际 ${progressNotifications}`);

    SceneLoader.LoadAssetContainerAsync = async () => {
      loadCount += 1;
      const container = new AssetContainer(scene);
      const mesh = MeshBuilder.CreateBox('source-box', {}, scene);
      const material = new StandardMaterial('source-material', scene);
      mesh.material = material;
      container.meshes.push(mesh);
      container.materials.push(material);
      container.rootNodes.push(mesh);
      container.removeAllFromScene();
      return container;
    };
    const entityIds = Array.from({ length: 100 }, (_, index) => `entity-${index}`);
    const entities = Object.fromEntries(entityIds.map((id, index) => [id, {
      id, name: id, parentId: null, childrenIds: [], visible: true, locked: false,
      components: {
        transform: { position: { x: index * 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        modelAsset: { sourceUrl: 'smoke://assets/static.glb', sourcePath: 'static.glb', assetRevision: 'one', assetCode: id,
          lengthUnit: 'meter', unitScaleToMeters: 1 },
      },
    }]));
    const document = { ...createEmptySceneDocument('load-test'), entities, entityIds, selectedEntityId: null };
    let outlines = 0;
    const originalOutline = runtime.rebuildModelSelectionOutline.bind(runtime);
    runtime.rebuildModelSelectionOutline = () => { outlines += 1; originalOutline(); };
    runtime.sync(document);
    const deadline = performance.now() + 15000;
    while ([...runtime.models.values()].some((model) => !model.measurementReady)) {
      assert.ok(performance.now() < deadline, `模型未就绪: ${logs.join('; ')}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(loadCount, 1);
    assert.equal(runtime.models.size, 100);
    assert.equal(runtime.isModelReady(entityIds[0]), true);
    assert.equal(runtime.isModelReady('missing-model'), false, '失败或缺失模型不能当作已加载');
    const loading = runtime.getPerformanceMetrics().loading;
    assert.equal(loading.modelCache.misses, 1);
    assert.equal(loading.modelCache.hits, 99);
    assert.equal(loading.stages.assetReadDecode.count, 1);
    if (!baseline) assert.ok(outlines < 10, `100个同批就绪模型应合并轮廓重建，实际 ${outlines}`);
    runtime.syncSelection({ ...document, selectedEntityId: entityIds[5] });
    assert.equal(runtime.models.get(entityIds[5]).highlighted, true);
    assert.equal(runtime.models.get(entityIds[6]).highlighted, false);
    const changed = structuredClone(entities[entityIds[5]]);
    changed.components.transform.position.x = 500;
    runtime.sync({ ...document, entities: { ...entities, [changed.id]: changed } });
    assert.equal(runtime.models.get(changed.id).root.position.x, 500);
    assert.equal(loadCount, 1, 'Transform变化不得重新解析');
    const refreshed = structuredClone(document);
    for (const entity of Object.values(refreshed.entities)) entity.components.modelAsset.assetRevision = 'two';
    runtime.sync(refreshed);
    const refreshDeadline = performance.now() + 15000;
    while ([...runtime.models.values()].some((model) => !model.measurementReady)) {
      assert.ok(performance.now() < refreshDeadline, '资源版本更新后未就绪');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(loadCount, 2, '新版本只解析一次，不能继续复用旧版本几何');
    assert.equal(runtime.models.size, 100);
    assert.deepEqual(logs, []);
    console.log(JSON.stringify({ progressNotifications, progressMs, outlines, loading }));
    // 实例创建失败发生在源容器成功读取之后，必须单独保留失败证据。
    SceneLoader.LoadAssetContainerAsync = async () => {
      const container = new AssetContainer(scene);
      container.instantiateModelsToScene = () => { throw new Error('intentional clone failure'); };
      return container;
    };
    await assert.rejects(runtime.loadModelRuntimeAssets(entities[entityIds[0]].components.modelAsset, 'broken-clone'), /intentional clone failure/);
    assert.equal(runtime.getPerformanceMetrics().loading.failedModelAcquisitions, 1);
    const beforeDispose = notificationCount;
    runtime.beginModelLoadProgressUnit('pending.glb');
    runtime.dispose();
    await Promise.resolve();
    if (!baseline) assert.equal(notificationCount, beforeDispose, '释放后不得推送过期进度');
  } finally {
    SceneLoader.LoadAssetContainerAsync = originalLoader;
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }
} finally {
  assert.equal(path.dirname(bundleRoot), cacheRoot);
  await rm(bundleRoot, { recursive: true, force: true });
}
