import assert from 'node:assert/strict';
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
  });
  const module = await loadPolicyModule(server);

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

  console.log(JSON.stringify({
    ok: true,
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