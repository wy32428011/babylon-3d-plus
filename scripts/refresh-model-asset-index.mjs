import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const MODEL_ROOT = path.resolve(
  process.env.BABYLON_MODEL_ROOT ?? path.join(process.cwd(), '..', '3d-models', 'models'),
);
const COPIED_MODEL_ROOT = path.join(MODEL_ROOT, 'Assets', 'Models');
const INDEX_PATH = path.join(MODEL_ROOT, '.babylon-editor', 'asset-index.json');
const SSR_MODULE_LOAD_TIMEOUT_MS = 60_000;
const MODEL_FILTER = process.env.BABYLON_MODEL_FILTER?.trim();

/** 在限定时间内加载 Electron 扫描模块，避免 Vite SSR 异常时命令无限等待。 */
async function loadScannerModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/electron/ipc/modelPackageScanner.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('模型包扫描模块加载超时。')), SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 生成新的资产版本，确保同路径脚本和元数据修改后运行时不会命中旧缓存。 */
function createAssetRevision() {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

/** 统一 Windows 路径大小写和分隔符，避免索引匹配受格式差异影响。 */
function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

let server;
try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  const { scanModelPackage } = await loadScannerModule(server);
  const index = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  assert.equal(index.version, 2, '只支持刷新 version=2 的项目资产索引。');
  assert.ok(Array.isArray(index.assets), '资产索引缺少 assets 数组。');

  const packageEntries = (await fs.readdir(COPIED_MODEL_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && (!MODEL_FILTER || entry.name === MODEL_FILTER))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  if (MODEL_FILTER) assert.equal(packageEntries.length, 1, `未找到模型资产过滤项：${MODEL_FILTER}`);
  const refreshed = [];

  for (const packageEntry of packageEntries) {
    const packagePath = path.join(COPIED_MODEL_ROOT, packageEntry.name);
    const result = await scanModelPackage(packagePath);
    assert.ok(result.asset, `${packageEntry.name} 扫描失败：${result.skipped?.reason ?? '未知原因'}`);
    const normalizedPackagePath = normalizePath(packagePath);
    const existingIndex = index.assets.findIndex((asset) =>
      asset.libraryKind === 'model' && normalizePath(asset.packagePath) === normalizedPackagePath,
    );
    const nextAsset = {
      ...result.asset,
      assetRevision: createAssetRevision(),
      libraryKind: 'model',
    };
    if (existingIndex >= 0) index.assets[existingIndex] = nextAsset;
    else index.assets.push(nextAsset);
    refreshed.push({ name: packageEntry.name, lengthUnit: nextAsset.lengthUnit, unitScaleToMeters: nextAsset.unitScaleToMeters });
  }

  await fs.writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, indexPath: INDEX_PATH, refreshed }, null, 2));
} finally {
  await server?.close();
}
