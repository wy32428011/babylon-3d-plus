import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  InspectionModelListItem,
  InspectionModelVersionListItem,
  InspectionModelVersionsRequest,
  InspectionModelVersionRequest,
  InspectionModelVersionPreparationResult,
} from '../types.js';
import { isValidModelUnitScaleToMeters } from '../modelUnits.js';
import { authorizeAssetRoot, encodeAssetUrl } from './assetRegistry.js';
import { getCurrentDataPlatformBinding, resolveDataPlatformBindingSharedResourcesRoot } from './dataPlatformBindingStore.js';
import { createDataPlatformModelSourceKey, listRemoteInspectionModels, listRemoteInspectionModelVersions, syncInspectionModelVersion } from './dataPlatformModelIncrementalSync.js';
import { assertSnapshotModelVersions } from './digitalTwinPublishProtocol.js';
import { DigitalTwinUploadClient } from './digitalTwinUploadClient.js';
import { createSourceResourcePlan } from './digitalTwinSourceResourcePlan.js';
import { parseInspectionMetadata } from './inspectionModelResource.js';
import { getCurrentProjectRoot, getProjectSessionGeneration } from './projectAssetStore.js';
import { getScenePublishScope } from './scenePublishScope.js';

const ID_PATTERN = /^[1-9]\d{0,63}$/;
const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

/** 主进程自行读取工程身份；renderer 不提供路径、平台地址或资源摘要。 */
function currentContext() {
  const binding = getCurrentDataPlatformBinding();
  const projectRoot = getCurrentProjectRoot();
  const scope = getScenePublishScope();
  if (!binding || !projectRoot || pathKey(binding.projectRoot) !== pathKey(projectRoot)
    || scope.kind === 'local-file' || (scope.kind === 'bound-project' && (!scope.projectRoot || pathKey(scope.projectRoot) !== pathKey(projectRoot)))) {
    throw new Error('请先打开已绑定数据中台的工程，再选择巡检高模。');
  }
  return { binding, projectRoot, projectGeneration: getProjectSessionGeneration(), scopeGeneration: scope.generation };
}

type Context = ReturnType<typeof currentContext>;
function assertCurrentContext(expected: Context): void {
  const current = currentContext();
  if (current.projectGeneration !== expected.projectGeneration || current.scopeGeneration !== expected.scopeGeneration
    || pathKey(current.projectRoot) !== pathKey(expected.projectRoot)
    || current.binding.metadata.projectId !== expected.binding.metadata.projectId
    || current.binding.metadata.baseUrl !== expected.binding.metadata.baseUrl
    || current.binding.metadata.workspaceRoot !== expected.binding.metadata.workspaceRoot) {
    throw new Error('当前工程或数据中台绑定已变化，请重新选择巡检高模。');
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label}必须是正十进制字符串。`);
  return value;
}

export async function listInspectionModels(): Promise<InspectionModelListItem[]> {
  const context = currentContext();
  const items = await listRemoteInspectionModels({ baseUrl: context.binding.metadata.baseUrl });
  assertCurrentContext(context);
  return items;
}

export async function listInspectionModelVersions(request: InspectionModelVersionsRequest): Promise<InspectionModelVersionListItem[]> {
  const resourceId = requireId(request?.resourceId, '模型 ID');
  const context = currentContext();
  const items = await listRemoteInspectionModelVersions({ baseUrl: context.binding.metadata.baseUrl, modelId: resourceId });
  assertCurrentContext(context);
  return items;
}

export async function prepareInspectionModelVersion(request: InspectionModelVersionRequest): Promise<InspectionModelVersionPreparationResult> {
  const resourceId = requireId(request?.resourceId, '模型 ID');
  const versionId = requireId(request?.versionId, '版本 ID');
  const context = currentContext();
  const { metadata } = context.binding;
  const sourceKey = createDataPlatformModelSourceKey(metadata.baseUrl);
  const signal = new AbortController().signal;
  const client = new DigitalTwinUploadClient(metadata.baseUrl);
  const versions = [{ modelId: resourceId, versionId }];
  const snapshot = await client.captureResourceSnapshot(metadata.projectId,
    { modelIds: [], comboModelIds: [], envModelIds: [], modelVersions: versions }, signal);
  assertSnapshotModelVersions(versions, snapshot);
  assertCurrentContext(context);
  const captured = snapshot.resources.find(item => item.kind === 'modelVersion' && item.resourceId === resourceId && item.versionId === versionId);
  if (!captured) throw new Error('数据中台快照缺少所选巡检高模版本。');
  const asset = await syncInspectionModelVersion({ baseUrl: metadata.baseUrl,
    sharedResourcesRoot: resolveDataPlatformBindingSharedResourcesRoot(context.projectRoot, metadata), sourceKey,
    modelId: resourceId, versionId, signal, expectedFiles: captured.files.map(file => ({ kind: 'model', resourceId,
      role: file.role, fileUrl: file.fileUrl, sha256: file.sha256, size: file.size })) });
  assertCurrentContext(context);
  const validated = await client.validateResourceSnapshot(metadata.projectId, snapshot.resourceSnapshotToken, signal);
  assertSnapshotModelVersions(versions, validated, snapshot);
  assertCurrentContext(context);
  if (!asset.packagePath || !asset.metadataPath || !isValidModelUnitScaleToMeters(asset.unitScaleToMeters)) {
    throw new Error('巡检高模资源包、元数据或单位无效。');
  }
  const modelPath = path.relative(asset.packagePath, asset.path).replace(/\\/g, '/');
  if (!modelPath || modelPath.startsWith('../') || path.isAbsolute(modelPath)) throw new Error('巡检高模路径不在固定资源包内。');
  const metadataPath = path.relative(asset.packagePath, asset.metadataPath);
  if (!metadataPath || metadataPath.startsWith('..') || path.isAbsolute(metadataPath)) throw new Error('巡检高模元数据不在固定资源包内。');
  const stat = await fs.lstat(asset.metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error('巡检高模元数据文件无效或过大。');
  const metadataBytes = await fs.readFile(asset.metadataPath);
  if (metadataBytes.length > 10 * 1024 * 1024) throw new Error('巡检高模元数据文件过大。');
  const plan = await createSourceResourcePlan([{ sourcePath: asset.packagePath, destinationRelativePath: 'Assets/Models/inspection' }],
    asset.packagePath, signal);
  const metadataFile = plan.files.find(file => pathKey(file.sourcePath) === pathKey(asset.metadataPath!));
  if (plan.bundles[0].contentSha256 !== asset.contentSha256 || !metadataFile || metadataFile.expectedSize !== metadataBytes.length
    || metadataFile.expectedSha256 !== createHash('sha256').update(metadataBytes).digest('hex')) {
    throw new Error('巡检高模元数据或完整资源包在准备期间发生变化。');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)) as unknown; }
  catch (error) { throw new Error('巡检高模元数据不是有效的 UTF-8 JSON。', { cause: error }); }
  const manifest = parseInspectionMetadata(parsed);
  assertCurrentContext(context);
  authorizeAssetRoot(asset.packagePath);
  return { model: { dataPlatformModel: { sourceKey, kind: 'model', resourceId, modelPath }, versionId,
    contentSha256: asset.contentSha256, sourcePath: asset.path, sourceUrl: encodeAssetUrl(asset.path),
    metaPath: asset.metadataPath, metaUrl: encodeAssetUrl(asset.metadataPath), unitScaleToMeters: asset.unitScaleToMeters }, ...manifest };
}
