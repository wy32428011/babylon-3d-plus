import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { LocalSceneResourceSyncRequest, LocalSceneResourceSyncResult, ProjectModelAssetEntry } from '../types.js';
import { collectPublishModelReferences } from '../shared/publishModelRecovery.js';
import { captureSceneShadowBakeRelocation } from '../shared/sceneShadowBakeContract.js';
import { assertRecoveryPathInsideRoot } from '../shared/recoveryPathBoundary.js';
import { recoverLocalSceneResourcePaths, type MissingLocalSceneResource } from './localSceneResourceRecovery.js';
import { recoverPinnedLocalSceneModel } from './localSceneRemoteRecovery.js';
import { pinCachedSceneModelVersion } from './dataPlatformModelIncrementalSync.js';
import { readDataPlatformModelIndex } from './dataPlatformModelIndex.js';
import { readProjectAssetIndex } from './projectAssetStore.js';
import { createDataPlatformSourceKey, executeDataPlatformEnvironmentSync } from './dataPlatformEnvironmentSync.js';
import { listIndexedDataPlatformEnvironments, readDataPlatformEnvironmentIndex } from './dataPlatformEnvironmentIndex.js';
import { normalizeEnvironmentManifestResponse, type DataPlatformEnvironmentRecord } from './dataPlatformEnvironmentContract.js';
import { requestDataPlatformJson } from './dataPlatformTransfer.js';
import { encodeAssetUrl } from './assetRegistry.js';

type Options = {
  request: LocalSceneResourceSyncRequest; baseUrl: string; workspaceRoot: string; projectRoot: string | null;
  signal: AbortSignal; isOriginalPathAllowed: (file: string) => boolean; onProgress?: (message: string) => void;
};
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const pathKey = (file: string) => path.resolve(file).toLowerCase();
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** 本地恢复保持编辑快照；只有用户明确选择后才允许环境切换文件修订。 */
export async function recoverLocalSceneResourceTransaction(options: Options): Promise<LocalSceneResourceSyncResult & { resolvedFiles: string[] }> {
  const { request, signal } = options;
  if (typeof request.sceneContent !== 'string' || Buffer.byteLength(request.sceneContent, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('本地场景恢复内容无效或超过 64 MiB。');
  }
  const envelope: unknown = JSON.parse(request.sceneContent);
  if (!object(envelope) || ![1, 2, 3, 4, 5].includes(envelope.version) || !object(envelope.scene)) throw new Error('本地场景恢复格式无效。');
  if (request.acceptEnvironmentRevision && (!/^[1-9]\d{0,63}$/.test(request.acceptEnvironmentRevision.resourceId)
    || !/^[1-9]\d{0,63}$/.test(request.acceptEnvironmentRevision.fileRevision)
    || !/^[a-f\d]{64}$/.test(request.acceptEnvironmentRevision.sha256))) throw new Error('环境版本确认信息无效。');
  const sourceKey = options.baseUrl ? createDataPlatformSourceKey(options.baseUrl) : null;
  const restoreBake = captureSceneShadowBakeRelocation(envelope.scene);
  let environmentVersionChanged = false;
  const sharedRoot = path.join(options.workspaceRoot, 'SharedResources');
  const allowed = new Set<string>();
  const mappings = new Map<string, string>();
  const resolve = (sceneContent: string) => recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: options.workspaceRoot,
    projectRoot: options.projectRoot, sceneFilePath: request.sceneFilePath, sourceKey, signal, additionalMappings: mappings,
    isOriginalPathAllowed: file => allowed.has(pathKey(file)) || options.isOriginalPathAllowed(file), shadowBakeRelocation: 'defer' });
  options.onProgress?.('正在核对本地场景的模型、脚本、环境和天空盒路径…');
  let result = await resolve(request.sceneContent);
  signal.throwIfAborted();
  let restoredCount = result.restoredReferenceCount;
  for (const file of result.resolvedFiles) allowed.add(pathKey(file));
  const networkErrors: LocalSceneResourceSyncResult['issues'] = [];
  const missingModels = new Map<string, MissingLocalSceneResource>();
  for (const item of result.missing) if (item.required && (item.resourceKind === 'model' || item.resourceKind === 'combo') && item.resourceId) {
    missingModels.set(`${item.resourceKind}:${item.resourceId}:${item.expectedRevision ?? ''}`, item);
  }
  if (sourceKey) {
    const queue = [...missingModels.values()]; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        signal.throwIfAborted(); const item = queue[cursor++]; if (!item) return;
        try {
          options.onProgress?.(`正在取回模型 ${item.resourceId} 的原版本资源…`);
          const asset = await recoverPinnedLocalSceneModel({ baseUrl: options.baseUrl, sharedResourcesRoot: sharedRoot,
            resource: { kind: item.resourceKind === 'combo' ? 'combo' : 'model', resourceId: item.resourceId! },
            expectedRevision: item.expectedRevision, signal, onProgress: options.onProgress });
          addPackageMappings(result.missing.filter(missing => missing.resourceKind === item.resourceKind && missing.resourceId === item.resourceId
            && missing.expectedRevision === item.expectedRevision), asset, mappings);
        } catch (error) {
          signal.throwIfAborted();
          networkErrors.push({ resourceKind: item.resourceKind, resourceId: item.resourceId, sourcePath: item.sourcePath,
            message: error instanceof Error ? error.message : String(error) });
        }
      }
    }));
    if (mappings.size) {
      result = await resolve(request.sceneContent); restoredCount = result.restoredReferenceCount;
      for (const file of result.resolvedFiles) allowed.add(pathKey(file));
    }
  }
  // 将索引中验证过的可变包固定，避免后续模型库同步使已恢复场景的版本漂移。
  const frozen = await freezeSharedModelPackages(result.sceneContent, sharedRoot, sourceKey, signal, allowed);
  networkErrors.push(...frozen.issues);
  let content = frozen.content;
  let choice: LocalSceneResourceSyncResult['environmentRecoveryChoice'];
  const unresolvedEnvironment = result.missing.some(item => item.required && item.resourceKind === 'environment');
  if (unresolvedEnvironment && sourceKey) {
    const parsed = JSON.parse(content);
    const environment = parsed.scene.sceneSettings?.environment;
    const resourceId = environment?.dataPlatformResourceId;
    if (typeof resourceId === 'string' && /^[1-9]\d{0,63}$/.test(resourceId)) {
      try {
        const record = await queryEnvironment(options.baseUrl, resourceId, signal);
        const recordedFileRevision = readEnvironmentFileRevision(environment);
        const previousRevision = recordedFileRevision ?? String(environment.dataPlatformRevision ?? '未知');
        if (record.lengthUnit !== environment.lengthUnit) throw new Error('环境模型单位与原场景不同，不能直接替代。');
        const exactRevision = recordedFileRevision ? record.fileRevision === recordedFileRevision
          : record.runtimeRevision === String(environment.dataPlatformRevision);
        const acceptance = request.acceptEnvironmentRevision;
        if (acceptance && (acceptance.resourceId !== resourceId || acceptance.fileRevision !== record.fileRevision || acceptance.sha256 !== record.fileSha256)) {
          throw new Error('已确认的环境版本已变化，请重新检查后选择。');
        }
        if (!exactRevision && !acceptance) {
          choice = { resourceId, displayName: record.displayName, previousRevision, availableRevision: record.fileRevision!,
            previousSize: Number.isSafeInteger(environment.fileSizeBytes) ? environment.fileSizeBytes : null,
            availableSize: record.fileSizeBytes!, sha256: record.fileSha256! };
        } else {
          options.onProgress?.(`正在恢复环境模型「${record.displayName}」并校验内容…`);
          const asset = await downloadEnvironment(options.baseUrl, sharedRoot, sourceKey, record, signal);
          const file = asset.path;
          allowed.add(pathKey(file));
          environment.packagePath = asset.packagePath ?? path.dirname(file);
          environment.activeVariantUrl = asset.sourceUrl;
          environment.variants = [{ name: path.basename(file, path.extname(file)), sourcePath: file, sourceUrl: asset.sourceUrl }];
          environment.dataPlatformSourceKey = sourceKey;
          environment.dataPlatformRevision = record.runtimeRevision;
          environment.fileSizeBytes = record.fileSizeBytes;
          environmentVersionChanged = !exactRevision;
          content = JSON.stringify(parsed);
        }
      } catch (error) {
        signal.throwIfAborted();
        networkErrors.push({ resourceKind: 'environment', resourceId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  signal.throwIfAborted();
  result = await resolve(content);
  restoredCount += result.restoredReferenceCount;
  const issues = [...result.issues, ...networkErrors];
  if (!environmentVersionChanged && restoreBake && issues.length === 0) {
    const finalEnvelope = JSON.parse(result.sceneContent);
    if (!restoreBake(finalEnvelope.scene)) throw new Error('资源恢复后的场景与原烘焙阴影不一致，已停止提交。');
    result.sceneContent = JSON.stringify(finalEnvelope);
  }
  if (choice) issues.push({ resourceKind: 'environment', resourceId: choice.resourceId,
    message: `环境「${choice.displayName}」的原文件版本 ${choice.previousRevision} 未找到；当前中台可用版本为 ${choice.availableRevision}，需要明确选择后恢复。` });
  return { configured: !!sourceKey, sourceKey, modelAssets: [], environmentAssets: [], recoveredSceneContent: result.sceneContent,
    recoveredReferenceCount: restoredCount, issues, environmentRecoveryChoice: choice, resolvedFiles: result.resolvedFiles };
}

function addPackageMappings(missing: MissingLocalSceneResource[], asset: ProjectModelAssetEntry, mappings: Map<string, string>): void {
  if (!asset.packagePath) throw new Error('恢复的模型缺少包目录。');
  for (const item of missing) {
    const normalized = item.sourcePath.replace(/\\/g, '/');
    const match = /(?:^|\/)((?:Model|Combo)-\d+(?:-[^/]+)?)(?:\/(.*))?$/i.exec(normalized);
    if (!match) continue;
    const target = path.resolve(asset.packagePath, match[2] ?? '');
    if (!inside(asset.packagePath, target)) throw new Error('恢复模型包内路径越界。');
    mappings.set(item.sourcePath, target);
  }
}

async function freezeSharedModelPackages(content: string, sharedRoot: string, sourceKey: string | null,
  signal: AbortSignal, allowed: Set<string>): Promise<{ content: string; issues: NonNullable<LocalSceneResourceSyncResult['issues']> }> {
  const parsed = JSON.parse(content);
  const references = collectPublishModelReferences(parsed.scene);
  const sharedModelsRoot = path.join(sharedRoot, 'Assets', 'Models');
  const pathOf = (asset: Record<string, any>) => {
    if (typeof asset.sourcePath === 'string' && asset.sourcePath) return asset.sourcePath;
    if (typeof asset.sourceUrl === 'string' && asset.sourceUrl.startsWith('editor-asset://local/')) {
      try { return decodeURIComponent(new URL(asset.sourceUrl).pathname.slice(1)); }
      catch { return null; } // 磁盘预检已记录坏引用，冻结阶段不覆盖其结构化错误。
    }
    return null;
  };
  const owners = [...references.models.map(reference => ({ asset: reference.asset, target: reference.target })),
    ...references.devices.map(asset => ({ asset, target: undefined }))].filter(reference => {
    const file = pathOf(reference.asset); return file && inside(sharedModelsRoot, path.resolve(file));
  });
  if (!owners.length) return { content, issues: [] };
  const issues: NonNullable<LocalSceneResourceSyncResult['issues']> = [];
  let index, assets;
  try { [index, assets] = await Promise.all([readDataPlatformModelIndex(sharedRoot), readProjectAssetIndex(sharedRoot)]); }
  catch (error) { return { content, issues: [{ resourceKind: 'model', message: `模型版本缓存索引不可用：${error instanceof Error ? error.message : String(error)}` }] }; }
  if (!index.sourceKey || (sourceKey && index.sourceKey !== sourceKey)) return { content, issues: [] };
  const pinned = new Map<string, ProjectModelAssetEntry>();
  for (const reference of owners) {
    signal.throwIfAborted();
    const sourcePath = pathOf(reference.asset)!;
    const entry = index.entries.find(item => inside(path.resolve(sharedRoot, item.packageRelativePath), path.resolve(sourcePath)));
    if (!entry) continue;
    const sourcePackage = path.resolve(sharedRoot, entry.packageRelativePath);
    try {
      if (!inside(sharedRoot, sourcePackage)) throw new Error('模型索引的包目录越界。');
      const originalRevision = reference.asset.assetRevision;
      if (typeof originalRevision === 'string' && /^[a-f\d]{64}$/i.test(originalRevision) && originalRevision !== entry.runtimeRevision) {
        throw new Error(`模型 ${entry.resourceId} 的共享缓存与场景原版本不一致，已停止固定。`);
      }
      const asset = assets.assets.find(item => pathKey(item.packagePath ?? '') === pathKey(sourcePackage));
      if (!asset) throw new Error(`模型 ${entry.resourceId} 的本地索引不完整。`);
      let fixed = pinned.get(sourcePackage);
      if (!fixed) {
        fixed = await pinCachedSceneModelVersion({ asset, entry, cacheRoot: sharedRoot, sourceKey: index.sourceKey, signal });
        pinned.set(sourcePackage, fixed);
        for (const file of [fixed.path, fixed.metadataPath, ...(fixed.scriptPaths ?? []), fixed.thumbnailPath]) if (file) allowed.add(pathKey(file));
      }
      rewriteModelOwnerPaths(reference.asset, sourcePackage, fixed.packagePath!);
      if (reference.target) rewriteModelOwnerPaths(reference.target, sourcePackage, fixed.packagePath!);
      if (object(reference.asset.dataPlatformModel)) reference.asset.dataPlatformModel.sourceKey = index.sourceKey;
    } catch (error) {
      signal.throwIfAborted();
      if (!issues.some(issue => issue.resourceId === entry.resourceId)) issues.push({ resourceKind: entry.kind,
        resourceId: entry.resourceId, sourcePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { content: JSON.stringify(parsed), issues };
}

/** 仅资源对象自身字段和声明的脚本列表参与固定，参数/规则里的同名字符串保持原值。 */
function rewriteModelOwnerPaths(owner: Record<string, any>, from: string, to: string): void {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const url = value.startsWith('editor-asset://local/');
      let file = value, suffix = '';
      if (url) {
        try { const parsedUrl = new URL(value); file = decodeURIComponent(parsedUrl.pathname.slice(1)); suffix = parsedUrl.search + parsedUrl.hash; }
        catch { return value; }
      }
      if (inside(from, file)) {
        const next = path.join(to, path.relative(from, file)); return url ? encodeAssetUrl(next) + suffix : next;
      }
    }
    return value;
  };
  for (const field of ['sourcePath', 'sourceUrl', 'path', 'packagePath', 'metadataPath', 'thumbnailPath', 'thumbnailUrl']) {
    if (typeof owner[field] === 'string') owner[field] = rewrite(owner[field]);
  }
  if (Array.isArray(owner.scriptPaths)) owner.scriptPaths = owner.scriptPaths.map(rewrite);
  if (Array.isArray(owner.scriptAssets)) for (const script of owner.scriptAssets) if (object(script)) rewriteModelOwnerPaths(script, from, to);
}

function readEnvironmentFileRevision(environment: Record<string, any>): string | undefined {
  const location = String(environment.packagePath ?? '').replace(/\\/g, '/');
  return /\/data-platform-cache\/environments\/[a-f\d]{64}\/\d+\/(\d+)(?:\/|$)/i.exec(location)?.[1];
}
async function queryEnvironment(baseUrl: string, resourceId: string, signal: AbortSignal): Promise<DataPlatformEnvironmentRecord> {
  const response = await requestDataPlatformJson({ baseUrl, endpointPath: 'api/v1/env-models/detail', body: { id: resourceId },
    signal, timeoutMs: 20000, context: '查询待恢复环境版本' });
  if (!object(response) || response.success !== true || !object(response.data) || response.data.id !== resourceId) throw new Error('中台未返回匹配的环境身份。');
  const record = normalizeEnvironmentManifestResponse({ success: true, data: { protocolVersion: '1', manifestRevision: '0',
    records: [response.data], hasMore: false, nextCursorId: null } }).records[0];
  if (record.fileStatus !== 'GLB_READY' || !record.fileRevision || !record.fileSha256 || !record.fileSizeBytes) throw new Error(record.warning ?? '环境模型文件尚不可用。');
  return record;
}
async function downloadEnvironment(baseUrl: string, sharedRoot: string, sourceKey: string,
  record: DataPlatformEnvironmentRecord, signal: AbortSignal): Promise<ProjectModelAssetEntry> {
  await assertRecoveryPathInsideRoot(path.dirname(sharedRoot), sharedRoot);
  await fs.mkdir(sharedRoot, { recursive: true });
  await assertRecoveryPathInsideRoot(path.dirname(sharedRoot), sharedRoot);
  await executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedRoot, signal,
    contextKey: `${sourceKey}:${path.resolve(sharedRoot).toLowerCase()}`,
    localSceneEnvironment: { resourceId: record.id } });
  const current = await queryEnvironment(baseUrl, record.id, signal);
  if (current.fileRevision !== record.fileRevision || current.fileSha256 !== record.fileSha256 || current.lengthUnit !== record.lengthUnit) {
    throw new Error('环境下载期间版本发生变化，已停止恢复，请重新检查。');
  }
  const index = await readDataPlatformEnvironmentIndex(sharedRoot);
  const listed = await listIndexedDataPlatformEnvironments(sharedRoot, { ...index,
    entries: index.entries.filter(entry => entry.resourceId === record.id && entry.sourceKey === sourceKey) });
  if (listed.errors.length) throw new Error(listed.errors.join('；'));
  const asset = listed.assets.find(item => item.dataPlatformResourceId === record.id);
  if (!asset) throw new Error('环境缓存未完成登记与校验。');
  return asset;
}
