import { assertPublishSceneModelsReady } from './digitalTwinModelRecovery.js';
import { assertPublishResourceIdentities } from './digitalTwinPublishResourceIdentity.js';
import { isAuthorizedAssetFile } from './assetRegistry.js';
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DigitalTwinPublishContext,
  DigitalTwinPublishProgress,
  DigitalTwinPublishRequest,
  DigitalTwinPublishResult,
  DigitalTwinPublishScenePreparationRequest,
  DigitalTwinPublishScenePreparationResult,
  ProjectModelAssetEntry,
} from '../types.js';
import { capturePublishSceneSnapshots, validatePreparedPublishScenes, assertPublishSceneParameterTemplates, type PublishSceneSnapshot } from './publishSceneSnapshots.js';
import { planSceneModelUpdates, matchSceneModelUpdates, getSceneEnvironmentUpdateReference } from '../shared/sceneModelUpdatePlan.js';
import { collectPublishModelReferences } from '../shared/publishModelRecovery.js';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';
import { createDataPlatformModelSourceKey, syncSceneDataPlatformModelAssets, ModelSnapshotIntegrityError, type ModelSnapshotExpectedFile } from './dataPlatformModelIncrementalSync.js';
import { includeSceneModelPackageVariants } from './sceneModelPackageVariants.js';
import { authorizeSceneFile } from './assetRegistry.js';
import {
  clearCurrentDataPlatformBinding,
  createDataPlatformBinding,
  assertDataPlatformBindingTarget,
  getCurrentDataPlatformBinding,
  readDataPlatformBinding,
  resolveDataPlatformBindingSharedResourcesRoot,
  resolveDataPlatformBindingWorkspaceRoot,
  resolveDataPlatformSharedResourcesRoot,
  setCurrentDataPlatformBinding,
  type DataPlatformBindingMetadata,
  updateDataPlatformBinding,
} from './dataPlatformBindingStore.js';
import { buildDigitalTwinDistPackage } from './digitalTwinDistPackage.js';
import { collectDigitalTwinResourceIds } from './digitalTwinPublishProtocol.js';
import { listIndexedDataPlatformEnvironments, readDataPlatformEnvironmentIndex } from './dataPlatformEnvironmentIndex.js';
import { executeDataPlatformEnvironmentSync } from './dataPlatformEnvironmentSync.js';
import { buildDigitalTwinSourcePackage, type DigitalTwinSourcePackageResult } from './digitalTwinSourcePackage.js';
import { findSyncedImageForReference, isPlatformImageReference } from './dataPlatformImageSync.js';
import {
  DigitalTwinApiError,
  DigitalTwinUploadClient,
  type DigitalTwinPublishTask,
  type DigitalTwinProjectStatus,
  type DigitalTwinResourceSnapshot,
} from './digitalTwinUploadClient.js';
import {
  getCurrentProjectRoot,
  rememberRecentSceneFile,
  setSharedProjectAssetRoot,
  setSharedProjectEnvironmentRoot,
  setSharedProjectSkyboxRoot,
} from './projectAssetStore.js';
import { createDeploymentSkyboxValidationCache, loadDeploymentSkyboxCacheContext } from './deploymentSkyboxCache.js';
import { readDataPlatformConfig, requestDataPlatformProject, resolveDataPlatformPublishProjectContext } from './dataPlatformIpc.js';
import { prepareDataPlatformProjectForPublish } from './dataPlatformProjectService.js';
import { resolveDataPlatformProjectLocation } from './dataPlatformProjectLocation.js';
import { getScenePublishScope, setBoundScenePublishScope } from './scenePublishScope.js';
import {
  buildDigitalTwinRuntimeConfigSavePayload,
  createDefaultDigitalTwinAllowedParentOrigins,
  normalizeDigitalTwinAllowedParentOrigins,
  readDigitalTwinAllowedParentOrigins,
  resolveDataPlatformParentOrigin,
} from '../shared/digitalTwinRuntimeConfig.js';

const MAX_SCENE_CONTENT_BYTES = 64 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CONFIRMATION_CODES = new Set([
  'DIGITAL_TWIN_OVERWRITE_CONFIRM_REQUIRED',
  'DIGITAL_TWIN_RESOURCE_BINDING_CONFIRM_REQUIRED',
]);
const CONFLICT_CODES = new Set([
  'DIGITAL_TWIN_VERSION_CONFLICT',
  'DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT',
  'DIGITAL_TWIN_RESOURCE_SNAPSHOT_CONFLICT',
]);

export type DigitalTwinPublishProgressHandler = (progress: DigitalTwinPublishProgress) => void;

type PublishTarget = {
  projectRoot: string;
  metadata: DataPlatformBindingMetadata;
  target?: Awaited<ReturnType<typeof resolveDataPlatformPublishProjectContext>>;
  generation: number;
  bindingSnapshot: string;
  expiresAt: number;
};
const publishTargets = new Map<string, PublishTarget>();
type ScenePreparation = { targetToken: string; expiresAt: number; scenes: PublishSceneSnapshot[];
  resourceRevision: string; resourceSnapshotToken?: string; resourceSnapshot?: DigitalTwinResourceSnapshot };
const scenePreparations = new Map<string, ScenePreparation>();

function snapshotModelFiles(snapshot?: DigitalTwinResourceSnapshot): ModelSnapshotExpectedFile[] | undefined {
  return snapshot?.resources.flatMap(resource => resource.kind === 'environment' ? [] : resource.files.map(file => ({
    kind: resource.kind as 'model' | 'combo', resourceId: resource.resourceId, role: file.role,
    fileUrl: file.fileUrl, sha256: file.sha256, size: file.size,
  })));
}

async function synchronizeSnapshotModels(baseUrl: string, sharedResourcesRoot: string,
  resources: Array<{ kind: 'model' | 'combo'; resourceId: string }>, signal: AbortSignal, snapshot?: DigitalTwinResourceSnapshot) {
  try {
    return await syncSceneDataPlatformModelAssets({ baseUrl, sharedResourcesRoot, resources, signal, expectedFiles: snapshotModelFiles(snapshot) });
  } catch (error) {
    if (error instanceof ModelSnapshotIntegrityError) throw new DigitalTwinApiError(error.code, error.message, null, 409);
    throw error;
  }
}

/** 捕获全部 SOURCE 场景与中台资源基线，之后由 renderer 执行统一替换和实际运行时烘焙。 */
export async function prepareDigitalTwinPublishSceneSnapshots(request: DigitalTwinPublishScenePreparationRequest,
  signal: AbortSignal): Promise<DigitalTwinPublishScenePreparationResult> {
  if (!request || typeof request.targetToken !== 'string' || !REQUEST_ID_PATTERN.test(request.requestId)) throw new Error('发布场景准备请求无效。');
  const target = await resolveDigitalTwinPublishTarget(request.targetToken, request.projectId ?? null);
  const entryFile = target.metadata.entryScenePath ? path.resolve(target.projectRoot, target.metadata.entryScenePath) : null;
  const scenes = await capturePublishSceneSnapshots(target.projectRoot, entryFile, request.sceneContent, signal);
  const client = new DigitalTwinUploadClient(target.metadata.baseUrl);
  let resourceRevision: string;
  let resourceSnapshotToken: string | undefined;
  let resourceSnapshot: DigitalTwinResourceSnapshot | undefined;
  try {
    const snapshot = await client.captureResourceSnapshot(target.metadata.projectId, collectDigitalTwinResourceIds(scenes.map(s => s.sceneContent)), signal);
    resourceRevision = snapshot.resourceRevision;
    resourceSnapshotToken = snapshot.resourceSnapshotToken;
    resourceSnapshot = snapshot;
  } catch (error) {
    // 旧服务器没有快照端点时仍严格检查全局修订；业务错误不能退化为兼容路径。
    if (!(error instanceof DigitalTwinApiError) || error.httpStatus !== 404) throw error;
    resourceRevision = (await requestDataPlatformProject(target.metadata.baseUrl, target.metadata.projectId, signal)).currentResourceRevision;
  }
  if (resourceSnapshot) {
    await synchronizeSnapshotModels(target.metadata.baseUrl, resolveDataPlatformBindingSharedResourcesRoot(target.projectRoot, target.metadata),
      resourceSnapshot.resources.flatMap(resource => resource.kind === 'environment' ? []
        : [{ kind: resource.kind as 'model' | 'combo', resourceId: resource.resourceId }]), signal, resourceSnapshot);
  }
  await assertPublishTargetCurrent(target);
  signal.throwIfAborted();
  for (const [id, item] of scenePreparations) if (item.expiresAt < Date.now() || item.targetToken === request.targetToken) scenePreparations.delete(id);
  // 发布任务全局串行，只保留最近一份大型场景快照，避免闲置预检长期占用堆内存。
  scenePreparations.clear();
  const preparationId = randomUUID();
  scenePreparations.set(preparationId, { targetToken: request.targetToken, scenes, resourceRevision, resourceSnapshotToken, resourceSnapshot, expiresAt: Date.now() + 30 * 60_000 });
  return { preparationId, scenes: scenes.map(({ sceneId, name, sceneContent, isEntry }) => ({ sceneId, name, sceneContent, isEntry })) };
}

async function validatePublishScenePreparation(request: DigitalTwinPublishRequest, target: PublishTarget, signal: AbortSignal) {
  if (!request.preparationId) {
    if (request.preparedScenes !== undefined) throw new Error('发布场景准备凭据缺失。');
    return undefined;
  }
  const preparation = scenePreparations.get(request.preparationId);
  if (!preparation || preparation.expiresAt < Date.now() || preparation.targetToken !== request.targetToken) throw new Error('发布场景准备已失效，请重试。');
  const entry = preparation.scenes.find(s => s.isEntry)!;
  if (!request.preparedScenes || request.preparedScenes.find(s => s.sceneId === entry.sceneId)?.sceneContent !== request.sceneContent) throw new Error('入口场景与发布准备快照不一致。');
  const overlays = await validatePreparedPublishScenes(preparation.scenes, request.preparedScenes, target.projectRoot,
    entry.sourcePath ?? path.join(target.projectRoot, 'Scenes', '__entry_prepared__.scene.json'), signal);
  const contents = [...overlays.values()];
  if (JSON.stringify(collectDigitalTwinResourceIds(contents)) !== JSON.stringify(collectDigitalTwinResourceIds(preparation.scenes.map(s => s.sceneContent)))) throw new Error('发布准备期间模型资源身份集合发生变化，请重新准备。');
  for (const content of contents) await assertPublishSceneModelsReady(content, signal, {
    projectRoot: target.projectRoot,
    sharedResourcesRoot: resolveDataPlatformBindingSharedResourcesRoot(target.projectRoot, target.metadata),
    legacyWorkspaceRoot: resolveDataPlatformBindingWorkspaceRoot(target.projectRoot, target.metadata),
  });
  const client = new DigitalTwinUploadClient(target.metadata.baseUrl);
  // 不能只相信 renderer 回传的版本号：再次使用固定缓存完整校验确认所有模型实际已替换。
  const sourceKey = createDataPlatformModelSourceKey(target.metadata.baseUrl);
  const plans = contents.map(content => planSceneModelUpdates(JSON.parse(content).scene, sourceKey, { allowSourceRebind: true }));
  const resources = [...new Map(plans.flat().map(item => [`${item.kind}:${item.resourceId}`, item])).values()];
  const assets = await synchronizeSnapshotModels(target.metadata.baseUrl,
    resolveDataPlatformBindingSharedResourcesRoot(target.projectRoot, target.metadata), resources, signal, preparation.resourceSnapshot);
  for (let index = 0; index < contents.length; index++) {
    const sceneAssets: ProjectModelAssetEntry[] = [];
    for (const item of plans[index]) sceneAssets.push(...await includeSceneModelPackageVariants(item,
      assets.filter(asset => getClickEventModelResourceKey(asset.sourceUrl)?.startsWith(`${item.kind}:${item.resourceId}:`)), signal));
    const expected = new Map(matchSceneModelUpdates(plans[index], sceneAssets).flatMap(item => item.sourceUrls.map(url => [url, item.asset] as const)));
    const references = collectPublishModelReferences(JSON.parse(contents[index]).scene);
    for (const asset of [...references.models.map(reference => reference.asset), ...references.devices]) {
      const latest = expected.get(String(asset.sourceUrl));
      if (latest && (asset.assetRevision !== latest.assetRevision || asset.sourceUrl !== latest.sourceUrl)) {
        throw new DigitalTwinApiError('DIGITAL_TWIN_RESOURCE_SNAPSHOT_CONFLICT', '发布场景仍含旧模型版本，正在重新对齐。', null, 409);
      }
    }
    assertPublishSceneParameterTemplates(preparation.scenes[index].sceneContent, contents[index], expected);
  }
  const environments = contents.flatMap(content => {
    const scene = JSON.parse(content).scene;
    const reference = getSceneEnvironmentUpdateReference(scene);
    return reference ? [{ resourceId: reference.resourceId, environment: scene.sceneSettings.environment }] : [];
  });
  const sharedRoot = resolveDataPlatformBindingSharedResourcesRoot(target.projectRoot, target.metadata);
  for (const resourceId of new Set(environments.map(item => item.resourceId))) {
    await executeDataPlatformEnvironmentSync({ baseUrl: target.metadata.baseUrl, editorRoot: sharedRoot,
      contextKey: `publish:${target.metadata.projectId}`, localSceneEnvironment: { resourceId }, signal });
  }
  if (environments.length) {
    const index = await readDataPlatformEnvironmentIndex(sharedRoot);
    const loaded = await listIndexedDataPlatformEnvironments(sharedRoot,
      { ...index, entries: index.entries.filter(entry => entry.sourceKey === sourceKey && environments.some(item => item.resourceId === entry.resourceId)) });
    if (loaded.errors.length) throw new Error(`发布环境缓存校验失败：${loaded.errors.join('；')}`);
    for (const { resourceId, environment } of environments) {
      const latest = loaded.assets.find(asset => asset.dataPlatformSourceKey === sourceKey && asset.dataPlatformResourceId === resourceId);
      if (!latest || environment.dataPlatformRevision !== latest.dataPlatformRevision
        || !isSameFilePath(environment.packagePath, latest.packagePath ?? latest.path)) {
        throw new DigitalTwinApiError('DIGITAL_TWIN_RESOURCE_SNAPSHOT_CONFLICT', '发布场景仍含旧环境版本，正在重新对齐。', null, 409);
      }
      if (preparation.resourceSnapshot) {
        const files = preparation.resourceSnapshot.resources.find(resource => resource.kind === 'environment' && resource.resourceId === resourceId)?.files.filter(file => file.role === 'model');
        if (files?.length !== 1 || latest.fileSha256 !== files[0].sha256 || String(latest.fileSizeBytes) !== files[0].size) {
          throw new DigitalTwinApiError('DIGITAL_TWIN_RESOURCE_SNAPSHOT_CONFLICT', '环境模型实际文件与服务端快照摘要不一致，正在重新对齐。', null, 409);
        }
      }
    }
  }
  if (preparation.resourceSnapshotToken) await client.validateResourceSnapshot(target.metadata.projectId, preparation.resourceSnapshotToken, signal);
  else if ((await requestDataPlatformProject(target.metadata.baseUrl, target.metadata.projectId, signal)).currentResourceRevision !== preparation.resourceRevision) {
    throw new DigitalTwinApiError('DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT', '数据中台资源在场景准备期间发生变化，正在重新对齐。', null, 409);
  }
  await assertPublishTargetCurrent(target);
  // 仅资源修订完成验证后推进；工程版本基线必须保留原预检值。
  target.metadata = { ...target.metadata, resourceRevision: preparation.resourceRevision };
  return { preparation, overlays, entry };
}

/** 预检只读；保存主进程确认过的目标和版本，不向 renderer 接受路径或服务地址。 */
export async function getDigitalTwinPublishContext(
  selectedProjectId: string | null = null,
  signal = new AbortController().signal,
): Promise<DigitalTwinPublishContext> {
  const generation = getScenePublishScope().generation;
  const current = await resolveCurrentDataPlatformBinding();
  if (current && selectedProjectId && selectedProjectId !== current.metadata.projectId) {
    throw new Error('当前场景已绑定数据中台业务项目，不能在发布时切换项目。');
  }
  if (!current && !selectedProjectId) return emptyPublishContext();
  const target = current ? undefined : await resolveDataPlatformPublishProjectContext(selectedProjectId!);
  const baseUrl = current?.metadata.baseUrl ?? target!.baseUrl;
  const projectId = current?.metadata.projectId ?? target!.project.id;
  const remote = await new DigitalTwinUploadClient(baseUrl).projectStatus(projectId, signal);
  const projectRoot = current?.projectRoot ?? (await resolveDataPlatformProjectLocation({
    workspaceRoot: target!.workspaceRoot, baseUrl, projectId,
  })).projectRoot;
  const existingBinding = await readDataPlatformBinding(projectRoot);
  if (existingBinding) assertDataPlatformBindingTarget(existingBinding, projectId, baseUrl);
  const metadata = current?.metadata ?? existingBinding ?? createPublishMetadata(target!.project, baseUrl, target!.webBaseUrl, target!.workspaceRoot, remote);
  const ticket: PublishTarget = {
    projectRoot, metadata: structuredClone(metadata), target, generation,
    bindingSnapshot: JSON.stringify(existingBinding), expiresAt: Date.now() + 30 * 60_000,
  };
  await assertPublishTargetCurrent(ticket);
  for (const [key, value] of publishTargets) if (value.expiresAt < Date.now()) publishTargets.delete(key);
  while (publishTargets.size >= 32) publishTargets.delete(publishTargets.keys().next().value!);
  const targetToken = randomUUID();
  publishTargets.set(targetToken, ticket);
  return { ...createPublishContext(projectRoot, metadata, remote, false), targetToken };
}

async function assertPublishTargetCurrent(target: PublishTarget): Promise<void> {
  if (target.expiresAt < Date.now() || target.generation !== getScenePublishScope().generation) {
    throw new Error('场景或发布目标已变化，请重新打开发布窗口进行预检。');
  }
  if (target.target) {
    const config = await readDataPlatformConfig();
    if (config.baseUrl !== target.target.baseUrl || config.webBaseUrl !== target.target.webBaseUrl
      || !isSameFilePath(config.workspaceRoot, target.target.workspaceRoot)) {
      throw new Error('数据中台配置已变化，请重新选择发布目标。');
    }
  }
  const binding = await readDataPlatformBinding(target.projectRoot);
  if (JSON.stringify(binding) !== target.bindingSnapshot || target.generation !== getScenePublishScope().generation) {
    throw new Error('场景或本地工程绑定已变化，请重新进行发布预检。');
  }
}

export async function resolveDigitalTwinPublishTarget(targetToken: string | undefined, projectId: string | null): Promise<PublishTarget> {
  if (typeof targetToken !== 'string' || !publishTargets.has(targetToken)) {
    throw new Error('发布预检已失效，请重新打开发布窗口。');
  }
  const target = publishTargets.get(targetToken)!;
  if (projectId && target.metadata.projectId !== projectId) throw new Error('发布项目与已确认目标不一致。');
  await assertPublishTargetCurrent(target);
  return target;
}

type ResolvedDataPlatformBinding = {
  projectRoot: string;
  metadata: DataPlatformBindingMetadata;
};

/** 优先使用当前内存绑定；应用重启后可从当前项目目录恢复持久化绑定。 */
async function resolveCurrentDataPlatformBinding(): Promise<ResolvedDataPlatformBinding | null> {
  const scope = getScenePublishScope();
  if (scope.kind === 'local-file') return null;
  if (scope.kind === 'bound-project') {
    const metadata = await readDataPlatformBinding(scope.projectRoot!);
    if (getScenePublishScope().generation !== scope.generation) throw new Error('场景已切换，请重新发布。');
    if (!metadata) throw new Error('场景所属工程绑定已丢失，请重新打开工程。');
    return { projectRoot: scope.projectRoot!, metadata };
  }
  const currentProjectRoot = getCurrentProjectRoot();
  const current = getCurrentDataPlatformBinding();
  if (current && (!currentProjectRoot || isSameFilePath(current.projectRoot, currentProjectRoot))) return current;
  if (!currentProjectRoot) return current;

  const metadata = await readDataPlatformBinding(currentProjectRoot);
  // 磁盘读取期间可能已返回首页或打开另一项目，旧预检不能重新挂载原项目。
  const activeRoot = getCurrentProjectRoot();
  if (!activeRoot || !isSameFilePath(activeRoot, currentProjectRoot)) return null;
  if (!metadata) {
    if (current) clearCurrentDataPlatformBinding();
    return null;
  }
  setCurrentDataPlatformBinding(currentProjectRoot, metadata);
  mountDataPlatformBindingResources(currentProjectRoot, metadata);
  return { projectRoot: path.resolve(currentProjectRoot), metadata };
}

function mountDataPlatformBindingResources(projectRoot: string, metadata: DataPlatformBindingMetadata): void {
  const sharedResourcesRoot = resolveDataPlatformBindingSharedResourcesRoot(projectRoot, metadata);
  setSharedProjectAssetRoot(sharedResourcesRoot);
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);
  setSharedProjectSkyboxRoot(sharedResourcesRoot);
}

function createPublishMetadata(
  project: Awaited<ReturnType<typeof resolveDataPlatformPublishProjectContext>>['project'],
  baseUrl: string,
  webBaseUrl: string,
  workspaceRoot: string,
  remote: DigitalTwinProjectStatus,
): DataPlatformBindingMetadata {
  return createDataPlatformBinding({
    baseUrl,
    webBaseUrl,
    workspaceRoot,
    projectId: project.id,
    projectName: project.projectName,
    editorProjectId: remote.editorProjectId,
    latestVersionId: remote.latestVersionId,
    latestVersionNumber: remote.latestVersionNumber,
    resourceRevision: project.currentResourceRevision,
    entryScenePath: null,
    syncedAt: new Date().toISOString(),
  });
}

/** 发布活动期间只读取本地绑定，避免网络异常掩盖全局发布锁。 */
export function getLocalDigitalTwinPublishContext(publishActive: boolean, targetToken?: string): DigitalTwinPublishContext {
  const current = (targetToken ? publishTargets.get(targetToken) : null) ?? getCurrentDataPlatformBinding();
  if (!current) return emptyPublishContext(publishActive);
  const metadata = current.metadata;
  const dataPlatformOrigin = resolveDataPlatformParentOrigin(metadata.baseUrl);
  return {
    available: true,
    projectRoot: current.projectRoot,
    baseUrl: metadata.baseUrl,
    projectId: metadata.projectId,
    projectName: metadata.projectName,
    editorProjectId: metadata.editorProjectId,
    baseVersionId: metadata.latestVersionId,
    baseVersionNumber: metadata.latestVersionNumber,
    resourceRevision: metadata.resourceRevision,
    entryScenePath: metadata.entryScenePath,
    remoteLatestVersionId: metadata.latestVersionId,
    remoteLatestVersionNumber: metadata.latestVersionNumber,
    stableUrl: null,
    releaseUrl: null,
    dataPlatformOrigin,
    allowedParentOrigins: [dataPlatformOrigin],
    overwriteConfirmationRequired: metadata.editorProjectId !== null,
    versionConflict: false,
    publishActive,
  };
}

/** 完成保存、双包构建、分片上传、发布提交与本地绑定刷新。 */
export async function publishDigitalTwin(
  request: DigitalTwinPublishRequest,
  signal: AbortSignal,
  onProgress: DigitalTwinPublishProgressHandler,
): Promise<DigitalTwinPublishResult> {
  const validated = validatePublishRequest(request);
  await assertPublishSceneModelsReady(validated.sceneContent, signal);
  if (!validated.targetToken && !validated.projectId && !await resolveCurrentDataPlatformBinding()) {
    throw new Error('当前场景未绑定数据中台业务项目，请先选择发布项目。');
  }
  // 内部调用兼容旧测试；真实 IPC 始终要求预检票据。
  const token = validated.targetToken ?? (await getDigitalTwinPublishContext(validated.projectId, signal)).targetToken;
  const selected = await resolveDigitalTwinPublishTarget(token, validated.projectId);
  let prepared: Awaited<ReturnType<typeof validatePublishScenePreparation>>;
  try { prepared = await validatePublishScenePreparation(validated, selected, signal); }
  catch (error) {
    if (error instanceof DigitalTwinApiError && CONFLICT_CODES.has(error.code)) return createTerminalResult(validated.requestId, 'conflict', { errorCode: error.code, message: error.message, errorData: error.data });
    throw error;
  }
  emit(onProgress, validated.requestId, 'saving', '正在核验目标中台的模型与环境资源 ID…', 0);
  await assertPublishResourceIdentities([validated.sceneContent], selected.metadata.baseUrl, signal);
  await assertPublishSceneModelsReady(validated.sceneContent, signal, {
    projectRoot: selected.projectRoot,
    legacyWorkspaceRoot: resolveDataPlatformBindingWorkspaceRoot(selected.projectRoot, selected.metadata),
    sharedResourcesRoot: resolveDataPlatformBindingSharedResourcesRoot(selected.projectRoot, selected.metadata),
  });
  const client = new DigitalTwinUploadClient(selected.metadata.baseUrl);
  const remote = await client.projectStatus(selected.metadata.projectId, signal);
  await assertPublishTargetCurrent(selected);
  let current = { projectRoot: selected.projectRoot, metadata: selected.metadata };
  const context = createPublishContext(current.projectRoot, current.metadata, remote, true);
  if (context.overwriteConfirmationRequired && !validated.overwriteExisting) {
    return createTerminalResult(validated.requestId, 'confirmation-required', {
      errorCode: 'DIGITAL_TWIN_OVERWRITE_CONFIRM_REQUIRED',
      message: '目标业务项目已经有当前数字孪生工程，请确认覆盖后再发布。',
    });
  }
  if (selected.target) {
    const target = selected.target;
    const prepared = await prepareDataPlatformProjectForPublish({
      ...target.project,
      latestEditorProjectId: selected.metadata.editorProjectId,
      latestEditorProjectVersionId: selected.metadata.latestVersionId,
      latestEditorProjectVersionNumber: selected.metadata.latestVersionNumber,
    }, target.baseUrl, target.workspaceRoot, target.webBaseUrl, signal, undefined, selected.projectRoot);
    if (!isSameFilePath(prepared.projectRoot, selected.projectRoot)) throw new Error('发布目录已变化，请重新预检。');
    selected.bindingSnapshot = JSON.stringify(prepared.binding);
    // 保留用户预检时确认的基线，远端新增版本仍按冲突处理。
    current = { projectRoot: prepared.projectRoot, metadata: selected.metadata };
  }

  await assertPublishTargetCurrent(selected);
  if (!context.versionConflict || validated.forceOverwrite) {
    emit(onProgress, validated.requestId, 'saving', '正在保存大屏嵌入配置…', 1);
    const savedRuntimeConfig = await client.saveRuntimeConfig(
      buildDigitalTwinRuntimeConfigSavePayload(remote.runtimeConfig, validated.allowedParentOrigins),
      signal,
    );
    const savedParentOrigins = readDigitalTwinAllowedParentOrigins(savedRuntimeConfig.configJson);
    if (JSON.stringify(savedParentOrigins) !== JSON.stringify(validated.allowedParentOrigins)) {
      throw new Error('数字孪生运行配置保存后与发布请求不一致。');
    }
  }

  await assertPublishTargetCurrent(selected);
  emit(onProgress, validated.requestId, 'saving', '正在保存当前场景…', 2);
  if (prepared) await validatePreparedPublishScenes(prepared.preparation.scenes, validated.preparedScenes!, current.projectRoot,
    prepared.entry.sourcePath ?? path.join(current.projectRoot, 'Scenes', '__entry_prepared__.scene.json'), signal);
  const savedScene = await saveCurrentScene(current.projectRoot, current.metadata.entryScenePath, validated.sceneContent,
    prepared ? { diskHash: prepared.entry.diskHash } : undefined);
  const savedBinding = await updateDataPlatformBinding(current.projectRoot, current.metadata.projectId, { entryScenePath: savedScene.entryScenePath,
    ...(prepared ? { resourceRevision: current.metadata.resourceRevision } : {}) });
  selected.bindingSnapshot = JSON.stringify(savedBinding);
  if (prepared) {
    const previousEntryPath = prepared.entry.sourcePath ?? path.join(current.projectRoot, 'Scenes', '__entry_prepared__.scene.json');
    prepared.overlays.delete(previousEntryPath);
    prepared.overlays.set(savedScene.filePath, validated.sceneContent);
  }

  const workspaceRoot = resolveDataPlatformBindingWorkspaceRoot(current.projectRoot, current.metadata);
  const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  const taskRoot = path.join(app.getPath('temp'), 'zending-digital-twin-publish', encodeURIComponent(validated.requestId));
  await fs.rm(taskRoot, { recursive: true, force: true });
  await fs.mkdir(taskRoot, { recursive: true });
  let sourcePackage: DigitalTwinSourcePackageResult | null = null;
  let remoteTask: DigitalTwinPublishTask | null = null;
  let commitStarted = false;
  const warnings: string[] = [];

  try {
    const skyboxCacheContext = await loadDeploymentSkyboxCacheContext(signal);
    const skyboxValidationCache = createDeploymentSkyboxValidationCache();
    emit(onProgress, validated.requestId, 'source-package', '正在生成多场景源工程包…', 6);
    sourcePackage = await buildDigitalTwinSourcePackage({
      projectRoot: current.projectRoot,
      sharedResourcesRoot,
      legacyWorkspaceRoot: workspaceRoot,
      isAuthorizedCadFile: isAuthorizedAssetFile,
      entrySceneFilePath: savedScene.filePath,
      outputRoot: taskRoot,
      manifest: {
        projectId: current.metadata.projectId,
        projectName: current.metadata.projectName,
        editorProjectId: current.metadata.editorProjectId,
        baseVersionId: current.metadata.latestVersionId,
        resourceRevision: current.metadata.resourceRevision,
      },
      signal,
      skyboxCacheContext,
      skyboxValidationCache,
      skipCadReferences: true,
      preparedSceneContents: prepared?.overlays,
      isPlatformImageReference,
      findSyncedImageForReference,
      onProgress: (detail, completedFiles, totalFiles) => {
        const ratio = totalFiles > 0 ? completedFiles / totalFiles : 0;
        emit(onProgress, validated.requestId, 'source-package', detail, 6 + ratio * 22);
      },
    });
    appendUniqueWarnings(warnings, sourcePackage.warnings);
    const omittedSourceResources = sourcePackage.omittedResources;
    if (omittedSourceResources.length) {
      throw new Error(`源工程包含未能打包的资源，无法完整保留编辑内容。请将这些资源导入当前项目后再发布：\n${omittedSourceResources.join('\n')}`);
    }

    if (context.versionConflict && !validated.forceOverwrite) {
      const conflictCopyPath = await preserveConflictPackage(workspaceRoot, current.metadata.projectId, sourcePackage.filePath, 'version-conflict');
      return createTerminalResult(validated.requestId, 'conflict', {
        errorCode: 'DIGITAL_TWIN_VERSION_CONFLICT',
        message: '远端数字孪生工程已经产生新版本，当前源工程已另存为冲突副本，请重新打开最新工程。',
        conflictCopyPath,
        warnings,
      });
    }

    emit(onProgress, validated.requestId, 'dist-package', '正在生成自包含 Viewer dist 包…', 30);
    const distPackage = await buildDigitalTwinDistPackage({
      projectId: current.metadata.projectId,
      publishName: current.metadata.projectName,
      sceneContent: createPublicViewerSceneContent(sourcePackage.entrySceneContent),
      sourceResourceFiles: sourcePackage.resourceFiles,
      outputRoot: taskRoot,
      signal,
      skyboxCacheContext,
      skyboxValidationCache,
      onProgress: (detail, percent) => emit(
        onProgress,
        validated.requestId,
        'dist-package',
        detail,
        30 + (Math.max(0, Math.min(100, percent)) / 100) * 18,
      ),
    });
    appendUniqueWarnings(warnings, distPackage.warnings);
    await assertPublishResourceIdentities(sourcePackage.sceneContents, current.metadata.baseUrl, signal);
    const resourceIds = collectDigitalTwinResourceIds(sourcePackage.sceneContents);
    await validateDataPlatformEnvironmentPublishReferences(
      workspaceRoot,
      current.metadata.baseUrl,
      resourceIds.envModelIds,
      signal,
    );

    await assertPublishTargetCurrent(selected);
    emit(onProgress, validated.requestId, 'prepare', '正在创建数据中台发布任务…', 50);
    try {
      remoteTask = await client.prepare({
        requestId: validated.requestId,
        projectId: current.metadata.projectId,
        baseVersionId: current.metadata.latestVersionId,
        overwriteExisting: validated.overwriteExisting,
        forceOverwrite: validated.forceOverwrite,
        publishName: validated.publishName,
        remark: validated.remark || null,
        entryScenePath: sourcePackage.entryScenePath,
        entrySceneName: sourcePackage.entrySceneName,
        manifestJson: sourcePackage.manifestJson,
        resourceRevision: current.metadata.resourceRevision,
        resourceSnapshotToken: prepared?.preparation.resourceSnapshotToken,
        confirmResourceBindings: validated.confirmResourceBindings,
        ...resourceIds,
        sourcePackage: {
          fileName: sourcePackage.fileName,
          fileSize: sourcePackage.fileSize,
          sha256: sourcePackage.sha256,
        },
        distPackage: {
          fileName: distPackage.fileName,
          fileSize: distPackage.fileSize,
          sha256: distPackage.sha256,
        },
      }, signal);
    } catch (error) {
      if (error instanceof DigitalTwinApiError && CONFIRMATION_CODES.has(error.code)) {
        return createTerminalResult(validated.requestId, 'confirmation-required', {
          errorCode: error.code,
          message: error.message,
          errorData: error.data,
          warnings,
        });
      }
      if (error instanceof DigitalTwinApiError && CONFLICT_CODES.has(error.code)) {
        const conflictCopyPath = await preserveConflictPackage(workspaceRoot, current.metadata.projectId, sourcePackage.filePath, error.code.toLowerCase());
        return createTerminalResult(validated.requestId, 'conflict', {
          errorCode: error.code,
          message: error.message,
          errorData: error.data,
          conflictCopyPath,
          warnings,
        });
      }
      throw error;
    }

    if (!remoteTask.sourceUpload || !remoteTask.distUpload) throw new Error('数据中台发布任务缺少 SOURCE 或 DIST 上传会话。');
    const totalUploadBytes = sourcePackage.fileSize + distPackage.fileSize;
    let sourceUploaded = 0;
    let distUploaded = 0;
    emit(onProgress, validated.requestId, 'upload-source', '正在上传源工程包…', 52, 0, totalUploadBytes);
    await client.uploadPackage(remoteTask.sourceUpload, sourcePackage.filePath, signal, (uploaded, total) => {
      sourceUploaded = uploaded;
      const ratio = total > 0 ? uploaded / total : 1;
      emit(onProgress, validated.requestId, 'upload-source', '正在上传源工程包…', 52 + ratio * 16, sourceUploaded + distUploaded, totalUploadBytes);
    });

    emit(onProgress, validated.requestId, 'upload-dist', '正在上传 dist 包…', 69, sourceUploaded, totalUploadBytes);
    await client.uploadPackage(remoteTask.distUpload, distPackage.filePath, signal, (uploaded, total) => {
      distUploaded = uploaded;
      const ratio = total > 0 ? uploaded / total : 1;
      emit(onProgress, validated.requestId, 'upload-dist', '正在上传 dist 包…', 69 + ratio * 16, sourceUploaded + distUploaded, totalUploadBytes);
    });

    await assertPublishTargetCurrent(selected);
    emit(onProgress, validated.requestId, 'commit', '正在创建版本并切换线上发布…', 87, totalUploadBytes, totalUploadBytes);
    commitStarted = true;
    let completed: DigitalTwinPublishTask;
    try {
      completed = await client.commit(remoteTask, signal);
    } catch (error) {
      if (error instanceof DigitalTwinApiError && CONFLICT_CODES.has(error.code)) {
        const conflictCopyPath = await preserveConflictPackage(
          workspaceRoot,
          current.metadata.projectId,
          sourcePackage.filePath,
          `commit-${error.code.toLowerCase()}`,
        );
        return createTerminalResult(validated.requestId, 'conflict', {
          errorCode: error.code,
          message: error.message,
          errorData: error.data,
          conflictCopyPath,
          warnings,
        });
      }
      throw error;
    }

    let latestStatus: DigitalTwinProjectStatus | null = null;
    try {
      latestStatus = await client.projectStatus(current.metadata.projectId, signal);
    } catch (error) {
      warnings.push(`发布已完成，但刷新远端项目状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const completedVersionId = completed.editorProjectVersionId ?? latestStatus?.latestVersionId ?? current.metadata.latestVersionId;
    const completedVersionNumber = resolveCompletedVersionNumber(current.metadata, completedVersionId, latestStatus);
    const completedEditorProjectId = completed.editorProjectId ?? latestStatus?.editorProjectId ?? current.metadata.editorProjectId;
    try {
      await updateDataPlatformBinding(current.projectRoot, current.metadata.projectId, {
        editorProjectId: completedEditorProjectId,
        latestVersionId: completedVersionId,
        latestVersionNumber: completedVersionNumber,
        resourceRevision: completed.projectResourceRevision,
        entryScenePath: sourcePackage.entryScenePath,
        syncedAt: new Date().toISOString(),
      });
    } catch (error) {
      warnings.push(`发布已完成，但刷新本地项目绑定失败：${error instanceof Error ? error.message : String(error)}`);
    }

    if (getScenePublishScope().generation === selected.generation) setBoundScenePublishScope(current.projectRoot, savedScene.filePath);
    publishTargets.delete(token!);
    emit(onProgress, validated.requestId, 'completed', '数字孪生工程发布完成。', 100, totalUploadBytes, totalUploadBytes);
    return createTerminalResult(validated.requestId, 'completed', {
      message: '数字孪生工程发布完成。',
      editorProjectId: completedEditorProjectId,
      editorProjectVersionId: completedVersionId,
      editorProjectVersionNumber: completedVersionNumber,
      editorProjectPublishId: completed.editorProjectPublishId,
      projectPublishId: completed.projectPublishId,
      stableUrl: completed.stableUrl ?? latestStatus?.stableUrl ?? null,
      releaseUrl: completed.releaseUrl ?? latestStatus?.releaseUrl ?? null,
      warnings,
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      if (remoteTask) await client.cancel(remoteTask.taskId, new AbortController().signal).catch(() => undefined);
      emit(onProgress, validated.requestId, 'canceled', '数字孪生发布已取消。', 0);
      return createTerminalResult(validated.requestId, 'canceled', { message: '数字孪生发布已取消。', warnings });
    }
    if (remoteTask && !commitStarted) {
      await client.cancel(remoteTask.taskId, new AbortController().signal).catch(() => undefined);
    }
    emit(onProgress, validated.requestId, 'failed', error instanceof Error ? error.message : String(error), 0);
    throw error;
  } finally {
    if (validated.preparationId) scenePreparations.delete(validated.preparationId);
    await fs.rm(taskRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createPublishContext(
  projectRoot: string,
  metadata: DataPlatformBindingMetadata,
  remote: DigitalTwinProjectStatus,
  publishActive: boolean,
): DigitalTwinPublishContext {
  const dataPlatformOrigin = resolveDataPlatformParentOrigin(metadata.baseUrl);
  return {
    available: true,
    projectRoot,
    baseUrl: metadata.baseUrl,
    projectId: metadata.projectId,
    projectName: metadata.projectName,
    editorProjectId: metadata.editorProjectId,
    baseVersionId: metadata.latestVersionId,
    baseVersionNumber: metadata.latestVersionNumber,
    resourceRevision: metadata.resourceRevision,
    entryScenePath: metadata.entryScenePath,
    remoteLatestVersionId: remote.latestVersionId,
    remoteLatestVersionNumber: remote.latestVersionNumber,
    stableUrl: remote.stableUrl,
    releaseUrl: remote.releaseUrl,
    dataPlatformOrigin,
    allowedParentOrigins: createDefaultDigitalTwinAllowedParentOrigins(
      metadata.baseUrl,
      remote.runtimeConfig.configJson,
    ),
    overwriteConfirmationRequired: remote.editorProjectId !== null,
    versionConflict: remote.latestVersionId !== metadata.latestVersionId,
    publishActive,
  };
}

function emptyPublishContext(publishActive = false): DigitalTwinPublishContext {
  return {
    available: false,
    projectRoot: null,
    baseUrl: null,
    projectId: null,
    projectName: null,
    editorProjectId: null,
    baseVersionId: null,
    baseVersionNumber: null,
    resourceRevision: null,
    entryScenePath: null,
    remoteLatestVersionId: null,
    remoteLatestVersionNumber: null,
    stableUrl: null,
    releaseUrl: null,
    dataPlatformOrigin: null,
    allowedParentOrigins: [],
    overwriteConfirmationRequired: false,
    versionConflict: false,
    publishActive,
  };
}

async function validateDataPlatformEnvironmentPublishReferences(
  workspaceRoot: string,
  expectedBaseUrl: string,
  envModelIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (envModelIds.length === 0) return;
  if (signal.aborted) throw new Error('数字孪生发布已取消。');
  const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  const indexed = await listIndexedDataPlatformEnvironments(sharedResourcesRoot);
  if (indexed.errors.length > 0) throw new Error(`环境模型缓存校验失败：${indexed.errors.join('；')}`);
  const expectedSourceKey = createHash('sha256').update(normalizePublishBaseUrl(expectedBaseUrl), 'utf8').digest('hex');
  const byId = new Map(indexed.assets.map((asset) => [asset.dataPlatformResourceId, asset]));
  for (const id of envModelIds) {
    const asset = byId.get(id);
    if (!asset || asset.availability !== 'active') throw new Error(`环境模型 ${id} 没有可发布的最新有效缓存，请先完成在线同步。`);
    if (asset.dataPlatformSourceKey !== expectedSourceKey) throw new Error(`环境模型 ${id} 属于其他数据中台，禁止发布。`);
    if (!asset.fileSha256 || !asset.dataPlatformFileRevision || !asset.dataPlatformRevision) {
      throw new Error(`环境模型 ${id} 缺少文件摘要或修订信息，禁止发布。`);
    }
  }
}

function normalizePublishBaseUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * SOURCE 工程包仍保留编辑器配置以支持回编辑；公开可访问的 Viewer DIST 不得携带长期 API Key。
 * 发布 Viewer 只使用场景 URL 或数据中台的项目级地址覆盖，鉴权应由同源会话或服务端代理承担。
 */
function createPublicViewerSceneContent(sceneContent: string): string {
  const parsed = JSON.parse(sceneContent) as unknown;
  if (!isPlainObject(parsed) || !isPlainObject(parsed.scene) || !isPlainObject(parsed.scene.fetchConfig)) {
    return sceneContent;
  }

  return `${JSON.stringify({
    ...parsed,
    scene: {
      ...parsed.scene,
      fetchConfig: {
        ...parsed.scene.fetchConfig,
        apiKey: '',
      },
    },
  }, null, 2)}\n`;
}

async function saveCurrentScene(
  projectRoot: string,
  entryScenePath: string | null,
  sceneContent: string,
  expected?: { diskHash: string | null },
): Promise<{ filePath: string; entryScenePath: string }> {
  if (Buffer.byteLength(sceneContent, 'utf8') > MAX_SCENE_CONTENT_BYTES) throw new Error('当前场景超过 64 MiB 发布上限。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sceneContent) as unknown;
  } catch {
    throw new Error('当前场景不是有效 JSON。');
  }
  if (!isPlainObject(parsed) || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4 && parsed.version !== 5) || !isPlainObject(parsed.scene)) {
    throw new Error('当前场景格式不受支持。');
  }
  const sceneName = typeof parsed.scene.name === 'string' && parsed.scene.name.trim() ? parsed.scene.name.trim() : 'main';
  const relativePath = entryScenePath ?? `Scenes/${createSafeSceneFileName(sceneName)}.scene.json`;
  const filePath = path.resolve(projectRoot, ...relativePath.replace(/\\/g, '/').split('/'));
  if (!isPathInside(projectRoot, filePath)) throw new Error('入口场景路径超出当前项目目录。');
  await ensureSafeDirectoryWithin(projectRoot, path.dirname(filePath), '入口场景目录');
  const temporaryPath = `${filePath}.publish-save-${randomUUID()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    if (expected) {
      const current = await fs.readFile(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      const actualHash = current === null ? null : createHash('sha256').update(new TextDecoder('utf-8', { fatal: true }).decode(current)).digest('hex');
      if (actualHash !== expected.diskHash) throw new Error('入口场景在发布准备后发生变化，已保留最新保存内容，请重新发布。');
    }
    await replaceFile(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  authorizeSceneFile(filePath);
  await rememberRecentSceneFile(filePath, projectRoot);
  return { filePath, entryScenePath: path.relative(projectRoot, filePath).replace(/\\/g, '/') };
}

async function preserveConflictPackage(
  workspaceRoot: string,
  projectId: string,
  sourcePackagePath: string,
  reason: string,
): Promise<string> {
  const conflictRoot = path.join(workspaceRoot, 'Conflicts', projectId);
  await ensureSafeDirectoryWithin(workspaceRoot, conflictRoot, '冲突副本目录');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = reason.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64) || 'conflict';
  const targetPath = path.join(conflictRoot, `${timestamp}-${safeReason}-source.zip`);
  if (!isPathInside(workspaceRoot, targetPath)) throw new Error('冲突副本目标路径越界。');
  await fs.copyFile(sourcePackagePath, targetPath, fs.constants.COPYFILE_EXCL);
  return targetPath;
}

function resolveCompletedVersionNumber(
  metadata: DataPlatformBindingMetadata,
  completedVersionId: string | null,
  latestStatus: DigitalTwinProjectStatus | null,
): number | null {
  if (
    completedVersionId
    && latestStatus?.latestVersionId === completedVersionId
    && latestStatus.latestVersionNumber !== null
  ) {
    return latestStatus.latestVersionNumber;
  }
  if (completedVersionId && metadata.latestVersionId === completedVersionId) return metadata.latestVersionNumber;
  return completedVersionId ? (metadata.latestVersionNumber ?? 0) + 1 : metadata.latestVersionNumber;
}


function validatePublishRequest(request: DigitalTwinPublishRequest): DigitalTwinPublishRequest {
  if (!isPlainObject(request)) throw new Error('数字孪生发布请求格式不正确。');
  if (typeof request.requestId !== 'string' || !REQUEST_ID_PATTERN.test(request.requestId)) throw new Error('数字孪生发布 requestId 无效。');
  if (typeof request.publishName !== 'string' || !request.publishName.trim() || request.publishName.trim().length > 256) {
    throw new Error('发布名称必须是 1 到 256 个字符。');
  }
  if (typeof request.remark !== 'string' || request.remark.trim().length > 512) throw new Error('发布备注不能超过 512 个字符。');
  if (typeof request.sceneContent !== 'string' || !request.sceneContent) throw new Error('当前场景内容不能为空。');
  return {
    targetToken: request.targetToken,
    preparationId: request.preparationId,
    preparedScenes: request.preparedScenes,
    requestId: request.requestId,
    publishName: request.publishName.trim(),
    remark: request.remark.trim(),
    sceneContent: request.sceneContent,
    projectId: normalizeOptionalProjectId(request.projectId),
    overwriteExisting: request.overwriteExisting === true,
    forceOverwrite: request.forceOverwrite === true,
    confirmResourceBindings: request.confirmResourceBindings === true,
    allowedParentOrigins: normalizeDigitalTwinAllowedParentOrigins(request.allowedParentOrigins),
  };
}

function normalizeOptionalProjectId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,63}$/.test(value.trim())) {
    throw new Error('数字孪生发布 projectId 无效。');
  }
  return value.trim();
}

function createTerminalResult(
  requestId: string,
  status: DigitalTwinPublishResult['status'],
  patch: Partial<Omit<DigitalTwinPublishResult, 'requestId' | 'status'>>,
): DigitalTwinPublishResult {
  return {
    requestId,
    status,
    errorCode: null,
    message: '',
    errorData: null,
    conflictCopyPath: null,
    editorProjectId: null,
    editorProjectVersionId: null,
    editorProjectVersionNumber: null,
    editorProjectPublishId: null,
    projectPublishId: null,
    stableUrl: null,
    releaseUrl: null,
    warnings: [],
    ...patch,
  };
}

function appendUniqueWarnings(target: string[], additions: readonly string[]): void {
  for (const warning of additions) {
    if (!target.includes(warning)) target.push(warning);
  }
}

function emit(
  handler: DigitalTwinPublishProgressHandler,
  requestId: string,
  phase: DigitalTwinPublishProgress['phase'],
  detail: string,
  percent: number,
  uploadedBytes = 0,
  totalBytes = 0,
): void {
  handler({
    requestId,
    phase,
    detail,
    percent: Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)),
    uploadedBytes,
    totalBytes,
  });
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  let initialError: unknown;
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isNodeError(error) || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code ?? '')) throw error;
    initialError = error;
  }

  let targetStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    targetStat = await fs.lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') throw initialError;
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`目标路径不是安全普通文件，拒绝替换：${targetPath}`);
  }

  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  let backupMoved = false;
  try {
    await fs.rename(targetPath, backupPath);
    backupMoved = true;
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (backupMoved) {
      try {
        await fs.rename(backupPath, targetPath);
        backupMoved = false;
      } catch (rollbackError) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`替换文件失败且旧文件回滚失败：${originalMessage}；旧文件保留在 ${backupPath}；回滚错误：${rollbackMessage}`);
      }
    }
    throw error;
  }
  if (backupMoved) await fs.rm(backupPath, { force: true }).catch(() => undefined);
}

function createSafeSceneFileName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 100);
  return normalized || 'main';
}

async function ensureSafeDirectoryWithin(root: string, directory: string, label: string): Promise<void> {
  const normalizedRoot = path.resolve(root);
  const normalizedDirectory = path.resolve(directory);
  const relative = path.relative(normalizedRoot, normalizedDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label}超出允许目录。`);

  const rootRealPath = await fs.realpath(normalizedRoot);
  const rootStat = await fs.stat(rootRealPath);
  if (!rootStat.isDirectory()) throw new Error(`${label}根目录无效。`);

  let current = normalizedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`${label}不能包含符号链接或 Junction：${current}`);
      if (!stat.isDirectory()) throw new Error(`${label}包含非目录路径：${current}`);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') break;
      throw error;
    }
  }

  await fs.mkdir(normalizedDirectory, { recursive: true });
  const directoryRealPath = await fs.realpath(normalizedDirectory);
  const realRelative = path.relative(rootRealPath, directoryRealPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${label}通过符号链接或 Junction 越界。`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isSameFilePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
