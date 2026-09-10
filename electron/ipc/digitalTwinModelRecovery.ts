import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DigitalTwinModelRecoveryResult, ProjectModelAssetEntry } from '../types.js';
import { collectPublishModelReferences, planPublishModelRecovery, type PublishModelRecoveryItem } from '../shared/publishModelRecovery.js';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';
import { authorizeAssetFile, decodeAssetUrl, isAuthorizedAssetFile, isPathInsideAuthorizedAssetRoot } from './assetRegistry.js';
import { isPathInsideOrEqual } from './deploymentExportFileSystem.js';
import { recoverDataPlatformModelAssets } from './dataPlatformModelIncrementalSync.js';
import { createDataPlatformModelRuntimeRevision } from './dataPlatformModelIndex.js';
import { scanModelPackage, validateGlbModelFile } from './modelPackageScanner.js';
import { assertRecoveryPathInsideRoot } from '../shared/recoveryPathBoundary.js';

export type PublishModelResourceScope = { projectRoot?: string; sharedResourcesRoot: string; legacyWorkspaceRoot?: string };
type JsonObject = Record<string, unknown>;

/** 所有网络地址和缓存目录只取主进程配置；场景只能提供稳定模型 ID。 */
export async function recoverPublishSceneModels(
  sceneContent: string,
  resolveContext: () => Promise<PublishModelResourceScope & { baseUrl: string }>,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<DigitalTwinModelRecoveryResult> {
  onProgress('正在检查场景模型和点击事件绑定…');
  const context = await resolveContext();
  signal.throwIfAborted();
  const { plan, scene } = await inspectPublishSceneModels(sceneContent, signal, context);
  if (!plan.length) return { replacements: [] };
  if (plan.length > 256) throw new Error('一次发布最多自动恢复 256 种模型，请先同步模型资源库。');
  const references = collectPublishModelReferences(scene);
  const local: DigitalTwinModelRecoveryResult['replacements'] = [];
  const remote: PublishModelRecoveryItem[] = [];
  for (const item of plan) {
    const missingUrls: string[] = [];
    for (const sourceUrl of item.sourceUrls) {
      const reference = references.models.find(reference => reference.asset.sourceUrl === sourceUrl);
      const asset = reference ? await recoverCurrentPackageReference(reference.asset, context, signal) : null;
      if (asset) local.push({ sourceUrls: [sourceUrl], asset });
      else missingUrls.push(sourceUrl);
    }
    if (missingUrls.length) remote.push({ ...item, sourceUrls: missingUrls });
  }
  // 只有可变共享包会被下载覆盖，固定版本和独立工程快照保持原资源。
  for (const item of remote) {
    const key = item.kind + ':' + item.resourceId + ':';
    for (const asset of [...references.models.map((reference) => reference.asset), ...references.devices]) {
      if (!getClickEventModelResourceKey(asset.sourceUrl)?.startsWith(key)) continue;
      const sourceUrl = String(asset.sourceUrl);
      if (isPathInsideOrEqual(path.join(context.sharedResourcesRoot, 'Assets', 'Models'), decodeAssetUrl(sourceUrl)) && !item.sourceUrls.includes(sourceUrl)) {
        item.sourceUrls.push(sourceUrl);
      }
    }
  }
  const assets = remote.length ? await recoverDataPlatformModelAssets({ ...context, resources: remote, signal, onProgress }) : [];
  signal.throwIfAborted();
  return {
    replacements: [...local.filter(item => !remote.some(remoteItem => item.sourceUrls.some(url => remoteItem.sourceUrls.includes(url)))), ...remote.map((item) => {
      const key = `${item.kind}:${item.resourceId}:`;
      const asset = assets.find((candidate) => getClickEventModelResourceKey(candidate.sourceUrl)?.startsWith(key));
      if (!asset) throw new Error(`数据中台模型「${item.displayName}」恢复后未返回有效模型，已停止发布。`);
      for (const file of [asset.path, asset.metadataPath, asset.thumbnailPath, ...(asset.scriptAssets ?? []).map((script) => script.path)]) {
        if (file) authorizeAssetFile(file);
      }
      return { sourceUrls: item.sourceUrls, asset };
    })],
  };
}

async function inspectPublishSceneModels(sceneContent: string, signal: AbortSignal, scope?: PublishModelResourceScope) {
  signal.throwIfAborted();
  if (typeof sceneContent !== 'string' || Buffer.byteLength(sceneContent, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('发布前模型恢复的场景内容无效或超过 64 MiB。');
  }
  const parsed = JSON.parse(sceneContent) as { version?: number; scene?: unknown };
  if (![1, 2, 3, 4, 5].includes(parsed.version ?? 0) || !parsed.scene) throw new Error('发布前模型恢复的场景格式无效。');
  const plan = await planPublishModelRecovery(parsed.scene, async (asset, reference) => {
    signal.throwIfAborted();
    return areModelReferencePathsAvailable(asset, reference?.target, signal, scope);
  });
  return { plan, scene: parsed.scene };
}

/** 主发布入口也必须检查，防止绕过 renderer 预处理发布无点击目标的包。 */
export async function assertPublishSceneModelsReady(sceneContent: string, signal: AbortSignal, scope?: PublishModelResourceScope): Promise<void> {
  const { plan } = await inspectPublishSceneModels(sceneContent, signal, scope);
  if (plan.length) throw new Error('场景仍有缺失模型或无目标的点击绑定，请先完成发布前模型恢复，再重新发布：' + plan.map((item) => item.displayName).join('、'));
}

function scopedRoot(file: string, scope?: PublishModelResourceScope): string | undefined {
  // SOURCE 对旧工作区仅兼容 Assets 子树，不能把整个工作区扩为可发布资源根。
  return [scope?.projectRoot, scope?.sharedResourcesRoot, scope?.legacyWorkspaceRoot ? path.join(scope.legacyWorkspaceRoot, 'Assets') : undefined]
    .find(root => root && isPathInsideOrEqual(root, file));
}

async function availablePath(file: string, signal: AbortSignal, scope?: PublishModelResourceScope,
  directory = false, requireAuthorization = true): Promise<boolean> {
  signal.throwIfAborted();
  const root = scopedRoot(file, scope);
  if (scope && !root) return false;
  if (requireAuthorization && !directory && !isAuthorizedAssetFile(file) && !isPathInsideAuthorizedAssetRoot(file)) return false;
  try {
    if (root) await assertRecoveryPathInsideRoot(root, file);
    const info = await fs.lstat(file);
    return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.size > 0);
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)) throw error;
    return false;
  }
}

async function areModelReferencePathsAvailable(asset: JsonObject, target: JsonObject | undefined,
  signal: AbortSignal, scope?: PublishModelResourceScope): Promise<boolean> {
  let mainFile: string;
  try { mainFile = decodeAssetUrl(String(asset.sourceUrl)); } catch { return false; }
  if (!await availablePath(mainFile, signal, scope)) return false;
  const owners = [asset, ...(Array.isArray(asset.scriptAssets) ? asset.scriptAssets : []), ...(target ? [target] : [])];
  for (const owner of owners) {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
    const value = owner as JsonObject;
    for (const field of ['sourcePath', 'path', 'metadataPath', 'thumbnailPath', 'packagePath', 'sourceUrl', 'thumbnailUrl']) {
      const raw = value[field]; if (typeof raw !== 'string' || !raw) continue;
      let file: string;
      try { file = field.endsWith('Url') ? decodeAssetUrl(raw) : path.resolve(raw); } catch { return false; }
      if (!await availablePath(file, signal, scope, field === 'packagePath')) return false;
      if (field === 'packagePath' && !isPathInsideOrEqual(file, mainFile)) return false;
    }
    for (const file of Array.isArray(value.scriptPaths) ? value.scriptPaths : []) {
      if (typeof file !== 'string' || !await availablePath(file, signal, scope)) return false;
    }
    if (scope && typeof value.assetId === 'string' && path.isAbsolute(value.assetId) && !scopedRoot(value.assetId, scope)) return false;
  }
  return true;
}

/** 先用当前主文件找到并校验完整同版本包，修正旧 target 外层引用，避免不必要的模型升级。 */
async function recoverCurrentPackageReference(asset: JsonObject, scope: PublishModelResourceScope,
  signal: AbortSignal): Promise<ProjectModelAssetEntry | null> {
  const key = getClickEventModelResourceKey(asset.sourceUrl);
  const expected = typeof asset.assetRevision === 'string' && /^[a-f\d]{64}$/i.test(asset.assetRevision) ? asset.assetRevision.toLowerCase() : null;
  if (!key || !expected) return null;
  const file = decodeAssetUrl(String(asset.sourceUrl));
  if (!await availablePath(file, signal, scope)) return null;
  const [kind, resourceId] = key.split(':');
  let packageRoot = path.dirname(file);
  const packageName = new RegExp(`^${kind}-${resourceId}(?:-|$)`, 'i');
  for (let depth = 0; !packageName.test(path.basename(packageRoot)); depth++) {
    const parent = path.dirname(packageRoot);
    if (depth >= 16 || parent === packageRoot) return null;
    packageRoot = parent;
  }
  if (!await availablePath(packageRoot, signal, scope, true)) return null;
  try {
    for (const entry of await fs.readdir(packageRoot, { withFileTypes: true })) if (entry.isSymbolicLink()) return null;
    const scanned = (await scanModelPackage(packageRoot)).asset;
    if (!scanned?.metadataPath || path.resolve(scanned.path) !== path.resolve(file)) return null;
    const files = [scanned.path, scanned.metadataPath, ...(scanned.scriptPaths ?? []), ...(scanned.thumbnailPath ? [scanned.thumbnailPath] : [])];
    for (const item of files) if (!isPathInsideOrEqual(packageRoot, item) || !await availablePath(item, signal, scope, false, false)) return null;
    if (path.extname(file).toLowerCase() === '.glb') await validateGlbModelFile(file);
    const revision = await createDataPlatformModelRuntimeRevision({ modelPath: scanned.path, metadataPath: scanned.metadataPath,
      scriptPaths: scanned.scriptPaths ?? [], thumbnailPath: scanned.thumbnailPath ?? null });
    if (revision.runtimeRevision !== expected) return null;
    for (const item of files) authorizeAssetFile(item);
    const originalUrl = new URL(String(asset.sourceUrl));
    return { ...scanned, kind: 'model', libraryKind: 'model', assetRevision: expected,
      sourceUrl: scanned.sourceUrl + originalUrl.search + originalUrl.hash };
  } catch (error) {
    signal.throwIfAborted();
    // 无法证明同版本完整性时由后续稳定 ID 下载接管；下载失败仍明确阻止发布。
    return null;
  }
}
