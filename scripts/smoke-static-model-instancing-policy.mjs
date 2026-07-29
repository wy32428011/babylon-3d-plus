import assert from 'node:assert/strict';
import path from 'node:path';
import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { createServer } from 'vite';

/** Vite SSR 加载上限，避免模块解析异常时 smoke 长时间无输出。 */
const MODULE_LOAD_TIMEOUT_MS = 60_000;

/** 最小模型资产快照，只包含共享策略允许读取的 ModelAssetComponent 字段。 */
function createModelAsset(overrides = {}) {
  return {
    assetCode: 'STATIC-ASSET',
    sourcePath: 'F:/3d-models/models/Assets/Models/StaticBox/StaticBox.glb',
    sourceUrl: 'editor-asset://Assets/Models/StaticBox/StaticBox.glb',
    assetRevision: 'static-policy-smoke',
    ...overrides,
  };
}

/** 在限定时间内通过 Vite SSR 载入运行时策略模块。 */
async function loadPolicyModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/runtime/babylon/SharedModelAssetCache.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('加载 SharedModelAssetCache.ts 超时')), MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 在限定时间内载入 SceneRuntime，复用真实模型选择分流逻辑。 */
async function loadSceneRuntimeModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('加载 SceneRuntime.ts 超时')), MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 读取模型当前使用的选择效果，避免只检查颜色而漏掉高亮管线差异。 */
function readSelectionMode(runtime, mesh) {
  const usesHighlightLayer = runtime.modelHighlightLayer?.hasMesh(mesh) ?? false;
  const usesSelectionOutline = runtime.modelSelectionOutlineLayer.hasMesh(mesh);
  if (usesHighlightLayer && !usesSelectionOutline) return 'highlight-layer';
  if (!usesHighlightLayer && usesSelectionOutline) return 'selection-outline';
  if (usesHighlightLayer && usesSelectionOutline) return 'mixed';
  return 'none';
}

/** 构造只包含选择逻辑所需字段的模型运行时条目。 */
function createSelectionFixtureModel(mesh, assetKind) {
  return {
    entitySnapshot: { id: mesh.id },
    assetHandle: { kind: assetKind },
    meshes: [mesh],
    modelArrayBatch: null,
    highlighted: false,
  };
}

/** 通过 SceneRuntime 的真实选择分流返回单个场景模型的高亮模式。 */
function selectFixtureModel(runtime, entityId, model) {
  runtime.models.set(entityId, model);
  runtime.selectedEntityIds = new Set([entityId]);
  runtime.applyModelSelection(model, true);
  runtime.rebuildModelSelectionOutline();
  return readSelectionMode(runtime, model.meshes[0]);
}

/** 断言单个模型资产的共享策略模式和原因，输出失败时保留业务语义。 */
function assertPolicy(module, asset, expectedMode, expectedReason, message) {
  const policy = module.resolveModelAssetSharedInstancingPolicy(asset);
  assert.deepEqual(policy, { mode: expectedMode, reason: expectedReason }, message);
  assert.equal(
    module.shouldUseSharedModelInstantiation(asset),
    expectedMode === 'shared-instance',
    `${message}：布尔辅助函数必须与策略模式一致`,
  );
}

let server;
try {
  server = await createServer({
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
  const [module, { SceneRuntime }] = await Promise.all([
    loadPolicyModule(server),
    loadSceneRuntimeModule(server),
  ]);

  const shelfWithScript = createModelAsset({
    assetCode: 'SHELF-WITH-SCRIPT',
    sourcePath: 'F:/3d-models/models/Assets/Models/Shelf/Shelf.glb',
    sourceUrl: 'editor-asset://Assets/Models/Shelf/Shelf.glb',
    scriptAssets: [{ path: 'F:/3d-models/models/Assets/Models/Shelf/shelf.model.ts', sourceUrl: 'data:text/plain,', name: 'shelf.model.ts' }],
    parameterConfig: { parameters: [{ key: 'layerCount', defaultValue: 2 }] },
    parameterScriptMetadata: [{ scriptFilename: 'shelf.model.ts' }],
    animationScriptMetadata: [{ scriptFilename: 'shelf.model.ts' }],
  });
  assert.equal(module.isShelfInstancingCandidate(shelfWithScript), true, 'Shelf 旧导出必须继续识别带脚本资源');
  assertPolicy(module, shelfWithScript, 'shared-instance', 'shelf-resource', 'Shelf 带脚本和参数元数据仍必须允许共享');

  const plainStaticModel = createModelAsset();
  assert.equal(module.isShelfInstancingCandidate(plainStaticModel), false, '普通静态模型不得被旧 Shelf 函数误识别');
  assertPolicy(module, plainStaticModel, 'shared-instance', 'plain-static-model', '无脚本无参数的普通静态模型必须允许共享');

  assertPolicy(
    module,
    createModelAsset({ scriptAssets: [{ path: 'stacker.model.ts', sourceUrl: 'data:text/plain,', name: 'stacker.model.ts' }] }),
    'owned-container',
    'script-assets',
    '非 Shelf 带脚本模型必须独占容器',
  );

  assertPolicy(
    module,
    createModelAsset({ parameterConfig: { parameters: [{ key: 'width', defaultValue: 1 }] } }),
    'owned-container',
    'parameter-config',
    '带参数配置的普通模型必须独占容器',
  );

  assertPolicy(
    module,
    createModelAsset({ parameterScriptMetadata: [{ scriptFilename: 'static.model.ts' }] }),
    'owned-container',
    'parameter-script-metadata',
    '带参数脚本元数据的普通模型必须独占容器',
  );

  assertPolicy(
    module,
    createModelAsset({ animationScriptMetadata: [{ scriptFilename: 'static.animation.ts' }] }),
    'owned-container',
    'animation-script-metadata',
    '带动画脚本元数据的普通模型必须独占容器',
  );

  assertPolicy(
    module,
    createModelAsset({ scriptAssets: [], parameterScriptMetadata: [], animationScriptMetadata: [] }),
    'shared-instance',
    'plain-static-model',
    '空数组动态字段不得阻止普通静态模型共享',
  );

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new SceneRuntime(scene);
  try {
    const draggedMesh = MeshBuilder.CreateBox('dragged-model', {}, scene);
    const draggedModel = createSelectionFixtureModel(draggedMesh, 'owned-container');
    const draggedSelectionMode = selectFixtureModel(runtime, 'dragged-model', draggedModel);

    runtime.applyModelSelection(draggedModel, false);
    runtime.models.clear();
    runtime.selectedEntityIds = new Set();
    runtime.rebuildModelSelectionOutline();

    const copiedMesh = MeshBuilder.CreateBox('copied-model', {}, scene);
    const copiedModel = createSelectionFixtureModel(copiedMesh, 'shared-instance');
    const copiedSelectionMode = selectFixtureModel(runtime, 'copied-model', copiedModel);

    assert.equal(copiedSelectionMode, 'selection-outline', '复制/阵列实例必须继续使用实例选择描边');
    assert.equal(
      draggedSelectionMode,
      copiedSelectionMode,
      '拖入场景的普通模型必须与复制/阵列后的模型使用相同高亮模式',
    );
  } finally {
    runtime.models.clear();
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }

  console.log(JSON.stringify({
    ok: true,
    selectionHighlightMode: 'selection-outline',
    verifiedPolicies: [
      'shelf-resource',
      'plain-static-model',
      'script-assets',
      'parameter-config',
      'parameter-script-metadata',
      'animation-script-metadata',
    ],
  }, null, 2));
} finally {
  await server?.close();
}