import { validateSceneModelResourceReferences } from './sceneModelResourceValidation.js';
import { includeSceneModelPackageVariants } from './sceneModelPackageVariants.js';
import { resolveDataPlatformProjectLocation } from './dataPlatformProjectLocation.js';
import { setBoundScenePublishScope } from './scenePublishScope.js';
import { recoverLocalSceneResourceTransaction } from './localSceneRecoveryService.js';
import { planSceneModelUpdates, matchSceneModelUpdates, getSceneEnvironmentUpdateReference } from '../shared/sceneModelUpdatePlan.js';
import { app, BrowserWindow } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import type {
  DataPlatformEnvironmentSyncProgress,
  DataPlatformImageSyncProgress,
  DataPlatformModelSyncProgress,
  DataPlatformSkyboxSyncProgress,
  SyncedImageAssetEntry,
  DataPlatformProjectEntry,
  DataPlatformProjectOpenResult,
  ProjectAssetIndex,
  ProjectModelAssetEntry,
  LocalSceneResourceSyncRequest,
  LocalSceneResourceSyncResult,
} from '../types.js';
import { normalizeEnvironmentResourceReference } from '../shared/environmentResourceMatch.js';
import { readDataPlatformModelIndex } from './dataPlatformModelIndex.js';
import { listIndexedDataPlatformEnvironments, readDataPlatformEnvironmentIndex } from './dataPlatformEnvironmentIndex.js';
import { readUtf8File } from '../shared/strictUtf8.js';
import { getRequiredEnvironmentResourceIds } from '../shared/sceneEnvironmentReferences.js';
import { relocateDataPlatformScene } from './dataPlatformSceneRelocation.js';
import { cancelDataPlatformModelSync } from './dataPlatformModelIncrementalSync.js';
import { cancelDataPlatformEnvironmentSync } from './dataPlatformEnvironmentSync.js';
import { disposeEnvironmentFileValidation } from './environmentFileValidation.js';
import { encodeAssetUrl, authorizeAssetRoot, authorizeAssetFile, isAuthorizedAssetFile, isAuthorizedSceneFile, normalizeFilePath } from './assetRegistry.js';
import {
  activateProjectRoot,
  ensureProjectDirectories,
  getCurrentProjectRoot,
  getProjectAssetIndexPath,
  getProjectEnvironmentsRoot,
  getProjectModelsRoot,
  readProjectAssetIndex,
  rememberRecentSceneFile,
  setSharedProjectAssetRoot,
  setSharedProjectEnvironmentRoot,
  setSharedProjectSkyboxRoot,
  writeProjectAssetIndex,
} from './projectAssetStore.js';
import { scanModelPackage } from './modelPackageScanner.js';
import {
  createDataPlatformBinding,
  assertDataPlatformBindingTarget,
  type DataPlatformBindingMetadata,
  getCurrentDataPlatformBinding,
  readDataPlatformBinding,
  resolveDataPlatformBindingSharedResourcesRoot,
  resolveDataPlatformBindingWorkspaceRoot,
  resolveDataPlatformProjectRoot,
  resolveDataPlatformSharedResourcesRoot,
  setCurrentDataPlatformBinding,
  writeDataPlatformBinding,
} from './dataPlatformBindingStore.js';
import {
  clearDataPlatformModelSyncRetryContext,
  resetDataPlatformModelSyncSession,
  disposeDataPlatformModelSync,
  getLatestDataPlatformModelSyncProgress,
  retryDataPlatformModelSync,
  startDataPlatformModelSync,
  executeDataPlatformModelSync,
  syncSceneDataPlatformModelAssets,
  pinCachedSceneModelVersion,
} from './dataPlatformModelIncrementalSync.js';
import {
  clearDataPlatformEnvironmentSyncRetryContext,
  resetDataPlatformEnvironmentSyncSession,
  createDataPlatformSourceKey,
  disposeDataPlatformEnvironmentSync,
  getLatestDataPlatformEnvironmentSyncProgress,
  retryDataPlatformEnvironmentSync,
  startDataPlatformEnvironmentSync,
  executeDataPlatformEnvironmentSync,
} from './dataPlatformEnvironmentSync.js';
import {
  clearDataPlatformImageSyncRetryContext,
  resetDataPlatformImageSyncSession,
  disposeDataPlatformImageSync,
  getLatestDataPlatformImageSyncProgress,
  listSyncedImages,
  retryDataPlatformImageSync,
  startDataPlatformImageSync,
} from './dataPlatformImageSync.js';
import {
  clearDataPlatformSkyboxSyncRetryContext,
  resetDataPlatformSkyboxSyncSession,
  disposeDataPlatformSkyboxSync,
  getLatestDataPlatformSkyboxSyncProgress,
  retryDataPlatformSkyboxSync,
  startDataPlatformSkyboxSync,
} from './dataPlatformSkyboxSync.js';
import {
  assertDiskWriteCapacity,
  assertPathInside,
  DataPlatformRollbackError,
  downloadRemoteFile,
  extractZipSecurely,
  isPathInside,
} from './dataPlatformTransfer.js';

const PROJECT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DATA_PLATFORM_WORKSPACE_DIRECTORY = 'data-platform-workspace';
const TEST_STORAGE_ROOT_ENV = 'ZENDING_EDITOR_STORAGE_ROOT';
const TEST_STORAGE_OVERRIDE_GUARD_ENV = 'ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE';
const LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
const DIGITAL_TWIN_SOURCE_MANIFEST_PATH = '.babylon-editor/digital-twin-source-manifest.json';
const MAX_PROJECT_SCENE_FILES = 1_000;
const MAX_CONCURRENT_SCENE_MODEL_RESOURCES = 4;
const PROJECT_TEXT_HEAP_EXPANSION_FACTOR = 16n;
const MIN_FREE_HEAP_RESERVE_BYTES = 128n * 1024n * 1024n;

let dataPlatformProjectServiceShuttingDown = false;
let sceneResourceContextGeneration = 0;
let openingProjectCount = 0;
export function isDataPlatformProjectOpening(): boolean {
  return openingProjectCount > 0;
}
const openTaskControllers = new Set<AbortController>();
const openTasks = new Set<Promise<unknown>>();
let publishBindingPreparationQueue: Promise<void> = Promise.resolve();
let localSceneResourceTask: { requestId?: string; controller: AbortController; promise: Promise<LocalSceneResourceSyncResult> } | null = null;

type SkyboxSyncPrepareContext = {
  generation: number;
  baseUrl: string;
  workspaceRoot: string;
  sharedResourcesRoot: string;
  syncContextKey: string | null;
};

let skyboxSyncPrepareGeneration = 0;
let currentSkyboxSyncPrepareContext: SkyboxSyncPrepareContext | null = null;
const skyboxSyncPrepareControllers = new Set<AbortController>();
const skyboxSyncPrepareTasks = new Set<Promise<boolean>>();

type PackageDetection =
  | {
      kind: 'current';
      packageRoot: string;
      sceneFilePaths: string[];
      sceneFilePath: string;
      entrySceneRelativePath: string;
    }
  | { kind: 'incompatible'; reason: string };

class ProjectPackageCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPackageCapacityError';
  }
}

type PromotionItem = {
  type: 'file' | 'directory';
  target: string;
  staged: string;
  backup: string;
  previousMoved: boolean;
  stagedMoved: boolean;
};

/**
 * 返回数据中台项目工作区。测试覆盖优先于用户配置；未配置时安装态使用 userData，开发态保持仓库根目录行为。
 */
export function getDataPlatformEditorRoot(customWorkspaceRoot: string | null = null): string {
  const override = process.env[TEST_STORAGE_ROOT_ENV]?.trim();
  const overrideEnabled = process.env[TEST_STORAGE_OVERRIDE_GUARD_ENV] === '1';
  if (override && overrideEnabled) return path.resolve(override);
  if (customWorkspaceRoot) return path.resolve(customWorkspaceRoot);
  return app.isPackaged
    ? path.join(app.getPath('userData'), DATA_PLATFORM_WORKSPACE_DIRECTORY)
    : app.getAppPath();
}

/** 发布预检与实际绑定共用目标目录规则，工作区及共享缓存本身不能作为业务工程。 */
export function resolveDataPlatformPublishProjectRoot(
  workspaceRoot: string,
  projectId: string,
  currentProjectRoot: string | null = getCurrentProjectRoot(),
): string {
  const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  const normalizedCurrentRoot = currentProjectRoot ? path.resolve(currentProjectRoot) : null;
  return normalizedCurrentRoot
    && !isSameFilePath(normalizedCurrentRoot, path.resolve(workspaceRoot))
    && !isSameFilePath(normalizedCurrentRoot, sharedResourcesRoot)
    ? normalizedCurrentRoot : resolveDataPlatformProjectRoot(workspaceRoot, projectId);
}

type PublishProjectPreparation = DataPlatformProjectOpenResult & { binding: DataPlatformBindingMetadata };

/** 同项目重复发布复用已有绑定；串行处理避免并发重试竞争写入和切换当前根目录。 */
export async function prepareDataPlatformProjectForPublish(
  project: DataPlatformProjectEntry,
  baseUrl: string,
  workspaceRoot: string,
  webBaseUrl: string = baseUrl,
  signal?: AbortSignal,
  preferredProjectRoot?: string,
  expectedProjectRoot?: string,
): Promise<PublishProjectPreparation> {
  const initialRoot = getCurrentProjectRoot();
  const task = publishBindingPreparationQueue.then(async (): Promise<PublishProjectPreparation> => {
    signal?.throwIfAborted();
    const { projectRoot } = await resolveDataPlatformProjectLocation({ workspaceRoot, baseUrl, projectId: project.id, preferredProjectRoot });
    if (expectedProjectRoot && !isSameFilePath(projectRoot, expectedProjectRoot)) {
      throw new Error('发布目录已变化，请重新预检。');
    }
    const assertCurrentContext = (): void => {
      signal?.throwIfAborted();
      if (dataPlatformProjectServiceShuttingDown) throw new Error('应用正在退出，无法绑定数字孪生发布项目。');
      const activeRoot = getCurrentProjectRoot();
      const unchanged = activeRoot === initialRoot || Boolean(activeRoot && initialRoot && isSameFilePath(activeRoot, initialRoot));
      if (!unchanged && !(activeRoot && isSameFilePath(activeRoot, projectRoot))) {
        throw new Error('当前项目已变化，请重新打开发布窗口后重试。');
      }
    };
    assertCurrentContext();
    await ensureWritableEditorRoot(workspaceRoot);
    await ensureWritableEditorRoot(projectRoot);
    await ensureProjectDirectories(projectRoot);
    const existingBinding = await readDataPlatformBinding(projectRoot);
    assertCurrentContext();
    if (existingBinding) assertDataPlatformBindingTarget(existingBinding, project.id, baseUrl);
    const binding = existingBinding ?? createDataPlatformBinding({
      baseUrl, webBaseUrl, workspaceRoot, projectId: project.id, projectName: project.projectName,
      editorProjectId: project.latestEditorProjectId, latestVersionId: project.latestEditorProjectVersionId,
      latestVersionNumber: project.latestEditorProjectVersionNumber, resourceRevision: project.currentResourceRevision,
      entryScenePath: null, syncedAt: new Date().toISOString(),
    });
    const sharedResourcesRoot = resolveDataPlatformBindingSharedResourcesRoot(projectRoot, binding);
    await ensureWritableEditorRoot(sharedResourcesRoot);
    await ensureProjectDirectories(sharedResourcesRoot);
    assertCurrentContext();
    // 恢复时保留磁盘上的版本、资源修订和入口场景；不能用远端最新值抹掉版本冲突。
    if (!existingBinding) await writeDataPlatformBinding(projectRoot, binding);
    assertCurrentContext();
    const activeRoot = getCurrentProjectRoot();
    if (!activeRoot || !isSameFilePath(activeRoot, projectRoot)) await activateProjectRoot(projectRoot);
    setSharedProjectAssetRoot(sharedResourcesRoot);
    setSharedProjectEnvironmentRoot(sharedResourcesRoot);
    setSharedProjectSkyboxRoot(sharedResourcesRoot);
    setCurrentDataPlatformBinding(projectRoot, binding);
    invalidateDataPlatformSkyboxSyncPrepareContext();
    return {
      projectRoot, sceneFilePath: null, source: 'local', warning: null, conflictCopyPath: null,
      // 发布期间保持缓存稳定，由同一份场景快照构建 SOURCE/DIST。
      modelSyncStarted: false, envModelSyncStarted: false, skyboxSyncStarted: false, binding,
    };
  });
  publishBindingPreparationQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** 从可信项目缓存打开工程，renderer 只允许提交项目 ID。 */
export async function openDataPlatformProject(
  project: DataPlatformProjectEntry,
  baseUrl: string,
  workspaceRoot: string,
  webBaseUrl: string = baseUrl,
): Promise<DataPlatformProjectOpenResult> {
  if (dataPlatformProjectServiceShuttingDown) {
    throw new Error('应用正在退出，无法打开数据中台项目。');
  }

  sceneResourceContextGeneration += 1;
  openingProjectCount += 1;
  const controller = new AbortController();
  openTaskControllers.add(controller);
  const task = (async () => {
    const localTask = localSceneResourceTask;
    if (localTask) {
      localTask.controller.abort();
      await localTask.promise.catch(() => undefined);
    }
    controller.signal.throwIfAborted();
    return openDataPlatformProjectInternal(project, baseUrl, workspaceRoot, webBaseUrl, controller.signal);
  })();
  openTasks.add(task);

  try {
    return await task;
  } finally {
    openingProjectCount -= 1;
    openTaskControllers.delete(controller);
    openTasks.delete(task);
  }
}

/** 取消当前打开及其主要资源下载，保留同步器可重试状态。 */
export function cancelDataPlatformProjectLoading(): boolean {
  sceneResourceContextGeneration += 1;
  let requested = false;
  for (const controller of openTaskControllers) { controller.abort(); requested = true; }
  const environment = cancelDataPlatformEnvironmentSync();
  const models = cancelDataPlatformModelSync();
  return requested || environment || models;
}

/** 本地场景以本轮同步结果为准；等待实际事务结束，避免把旧后台进度当作本轮完成。 */
export function cancelSceneModelSync(requestId: string): boolean {
  if (!requestId || localSceneResourceTask?.requestId !== requestId) return false;
  localSceneResourceTask.controller.abort();
  return true;
}

export async function prepareLocalSceneResources(
  baseUrl: string,
  workspaceRoot: string,
  request: LocalSceneResourceSyncRequest,
): Promise<LocalSceneResourceSyncResult> {
  if (dataPlatformProjectServiceShuttingDown) throw new Error('应用正在退出，无法同步本地场景资源。');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('本地场景资源同步请求无效。');
  if (request.requestId !== undefined && (typeof request.requestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(request.requestId))) throw new Error('场景同步请求标识无效。');
  if (request.mode === 'local-recovery') return prepareRecoveredLocalScene(baseUrl, workspaceRoot, request);
  if (request.mode === 'local-latest' && !baseUrl) return prepareRecoveredLocalScene(baseUrl, workspaceRoot, request);
  const explicit = request.mode === 'scene-latest' || request.mode === 'local-latest';
  const latest = request.mode === 'data-platform-latest' || explicit;
  if (request.syncLibrary !== undefined && (!explicit || typeof request.syncLibrary !== 'boolean')) throw new Error('模型库同步选项无效。');
  const expectedProjectRoot = getCurrentProjectRoot();
  const expectedGeneration = sceneResourceContextGeneration;
  const expectedBinding = latest ? getCurrentDataPlatformBinding() : null;
  const assertSceneContext = () => {
    if (!latest) return;
    const current = getCurrentDataPlatformBinding();
    if (openingProjectCount || sceneResourceContextGeneration !== expectedGeneration || getCurrentProjectRoot() !== expectedProjectRoot
      || (!explicit && (!current || !expectedBinding))
      || current?.projectRoot !== expectedBinding?.projectRoot || current?.metadata.baseUrl !== expectedBinding?.metadata.baseUrl
      || current?.metadata.projectId !== expectedBinding?.metadata.projectId) throw new Error('当前项目会话已变化，旧场景模型同步已取消。');
  };
  assertSceneContext();
  if (request.mode !== undefined && !latest) throw new Error('场景资源同步模式无效。');
  let scene: unknown;
  const issues: NonNullable<LocalSceneResourceSyncResult['issues']> = [];
  let environment = request.environment === undefined ? undefined : normalizeEnvironmentResourceReference(request.environment);
  if (latest) {
    if (typeof request.sceneContent !== 'string' || Buffer.byteLength(request.sceneContent, 'utf8') > 64 * 1024 * 1024) {
      throw new Error('场景模型更新内容无效或超过 64 MiB。');
    }
    const parsed = JSON.parse(request.sceneContent) as { version?: number; scene?: { sceneSettings?: { environment?: { dataPlatformSourceKey?: string } } } };
    if (![1, 2, 3, 4, 5].includes(parsed.version ?? 0) || !parsed.scene) throw new Error('场景模型更新格式无效。');
    const current = expectedBinding;
    if (!current && !explicit) throw new Error('当前数据中台项目会话已关闭，请重新打开项目。');
    // 本地文件以当前配置来源为准，不能被上次打开工程残留的旧绑定地址带回旧中台。
    if (request.mode !== 'local-latest') baseUrl = current?.metadata.baseUrl ?? baseUrl;
    if (!baseUrl) throw new Error('请先配置数据中台地址。');
    scene = parsed.scene;
    // 从当前项目取得的场景按当前绑定解析资源，历史 URL 哈希不再阻止重新关联。
    try {
      environment = getSceneEnvironmentUpdateReference(parsed.scene);
      const hasBoundSource = expectedBinding && createDataPlatformSourceKey(expectedBinding.metadata.baseUrl) === createDataPlatformSourceKey(baseUrl);
      if (explicit && !hasBoundSource && environment && parsed.scene.sceneSettings?.environment?.dataPlatformSourceKey !== createDataPlatformSourceKey(baseUrl)) {
        throw new Error('场景环境模型来源缺失或与当前数据中台不一致，已保留原环境。');
      }
    }
    catch (error) {
      environment = undefined;
      issues.push({ resourceKind: 'environment', message: error instanceof Error ? error.message : String(error) });
    }
  }
  let reportLatestProgress: ((message: string, phase?: DataPlatformModelSyncProgress['phase']) => void) | undefined;
  const previousTask = localSceneResourceTask;
  previousTask?.controller.abort();
  const controller = new AbortController();
  openTaskControllers.add(controller);
  const promise = (async (): Promise<LocalSceneResourceSyncResult> => {
    if (previousTask) await previousTask.promise.catch(() => undefined);
    controller.signal.throwIfAborted();
    await Promise.all([resetDataPlatformModelSyncSession(), resetDataPlatformEnvironmentSyncSession()]);
    controller.signal.throwIfAborted();
    assertSceneContext();
    const binding = getCurrentDataPlatformBinding();
    const sharedRoot = binding
      ? resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata) : resolveDataPlatformSharedResourcesRoot(workspaceRoot);
    // 本地打开使用当前配置的数据中台；业务工程根目录和发布绑定仍保持原值。
    const sourceKey = createDataPlatformSourceKey(baseUrl);
    await ensureWritableEditorRoot(sharedRoot);
    if (!binding && !explicit) await activateProjectRoot(workspaceRoot);
    await ensureProjectDirectories(sharedRoot);
    assertSceneContext();
    setSharedProjectAssetRoot(sharedRoot);
    setSharedProjectEnvironmentRoot(sharedRoot);
    controller.signal.throwIfAborted();
    const hasBoundSource = expectedBinding && createDataPlatformSourceKey(expectedBinding.metadata.baseUrl) === sourceKey;
    const modelPlan = latest ? planSceneModelUpdates(scene, sourceKey, {
      allowSourceRebind: !!hasBoundSource, requireSourceIdentity: explicit && !hasBoundSource, onIssue: issue => issues.push(issue),
    }) : [];
    const progressRunId = 'scene-update-' + randomUUID();
    const reportModelProgress = (message: string, phase: DataPlatformModelSyncProgress['phase'] = 'downloading') => {
      if (!latest || controller.signal.aborted || expectedGeneration !== sceneResourceContextGeneration) return;
      const progress: DataPlatformModelSyncProgress = { runId: progressRunId, phase, completed: phase === 'completed' ? modelPlan.length : 0, total: modelPlan.length,
        message, error: phase === 'failed' ? message : null };
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('data-platform:modelSyncProgress', progress);
      }
    };
    reportLatestProgress = reportModelProgress;
    if (latest) {
      const modelReplacements: NonNullable<LocalSceneResourceSyncResult['modelReplacements']> = [];
      const environmentAssets: ProjectModelAssetEntry[] = [];
      const checkCurrent = () => { controller.signal.throwIfAborted(); assertSceneContext(); };
      const libraryErrors: string[] = [];
      let libraryModelsReady = false;
      if (explicit && request.syncLibrary) {
        const libraryResults = await Promise.allSettled([
          executeDataPlatformModelSync({ baseUrl, editorRoot: sharedRoot, signal: controller.signal }),
          executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedRoot,
            contextKey: createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedRoot), signal: controller.signal }),
        ]);
        checkCurrent();
        libraryModelsReady = libraryResults[0].status === 'fulfilled';
        libraryResults.forEach((result, index) => {
          if (result.status === 'rejected') libraryErrors.push(`${index === 0 ? '普通/组合模型库' : '环境模型库'}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        });
      }
      const libraryIndexes = libraryModelsReady ? await Promise.all([
        readDataPlatformModelIndex(sharedRoot), readProjectAssetIndex(sharedRoot),
      ]) : undefined;
      checkCurrent();
      const preparedModels = new Map<number, typeof modelReplacements>();
      const modelWarnings = new Map<number, string[]>();
      const modelIssues = new Map<number, (typeof issues)[number]>();
      let nextModelIndex = 0;
      // 每个稳定资源 ID 独立校验，最多同时准备四个资源；环境无需排在设备队列末尾。
      const prepareModels = async () => {
        while (nextModelIndex < modelPlan.length) {
          const itemIndex = nextModelIndex++;
          const item = modelPlan[itemIndex];
          checkCurrent();
          try {
            let assets: ProjectModelAssetEntry[];
            if (libraryIndexes && libraryIndexes[0].sourceKey === sourceKey) {
              const entry = libraryIndexes[0].entries.find(entry => entry.kind === item.kind && entry.resourceId === item.resourceId);
              const asset = entry && libraryIndexes[1].assets.find(asset => asset.packagePath
                && isSameFilePath(asset.packagePath, path.resolve(sharedRoot, entry.packageRelativePath)));
              if (!entry || !asset) throw new Error(`模型库中缺少场景资源：${item.kind}:${item.resourceId}`);
              assets = [{ ...await pinCachedSceneModelVersion({ asset, entry, cacheRoot: sharedRoot, sourceKey, signal: controller.signal }),
                dataPlatformSourceKey: sourceKey, dataPlatformResourceId: item.resourceId }];
            } else {
              assets = await syncSceneDataPlatformModelAssets({ baseUrl, sharedResourcesRoot: sharedRoot,
                resources: [item], signal: controller.signal, onProgress: reportModelProgress });
            }
            const replacements = matchSceneModelUpdates([item], await includeSceneModelPackageVariants(item, assets, controller.signal));
            const warnings = await validateSceneModelResourceReferences(scene, replacements, controller.signal);
            checkCurrent();
            for (const replacement of replacements) {
              if (replacement.asset.packagePath) authorizeAssetRoot(replacement.asset.packagePath);
            }
            preparedModels.set(itemIndex, replacements);
            modelWarnings.set(itemIndex, warnings);
          } catch (error) {
            // 取消或切换项目是整轮失效，不能伪装成可继续打开的资源警告。
            checkCurrent();
            modelIssues.set(itemIndex, { resourceKind: item.kind, resourceId: item.resourceId,
              message: error instanceof Error ? error.message : String(error) });
          }
        }
      };
      let environmentIssue: (typeof issues)[number] | undefined;
      const prepareEnvironment = async () => {
        if (!environment) return;
        checkCurrent();
        try {
          const result = await executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedRoot,
            contextKey: createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedRoot),
            localSceneEnvironment: environment, signal: controller.signal });
          checkCurrent();
          if (!result.matchedResourceId) throw new Error('当前中台未找到场景引用的环境模型。');
          const index = await readDataPlatformEnvironmentIndex(sharedRoot);
          const loaded = await listIndexedDataPlatformEnvironments(sharedRoot,
            { ...index, entries: index.entries.filter(entry => entry.sourceKey === sourceKey && entry.resourceId === result.matchedResourceId) });
          checkCurrent();
          if (loaded.errors.length) throw new Error(`环境模型缓存校验失败：${loaded.errors.join('；')}`);
          const matched = loaded.assets.filter(asset => asset.dataPlatformSourceKey === sourceKey
            && asset.dataPlatformResourceId === result.matchedResourceId);
          if (!matched.length) throw new Error('当前中台环境模型资源未完成校验。');
          for (const asset of matched) if (asset.packagePath) authorizeAssetRoot(asset.packagePath);
          environmentAssets.push(...matched);
        } catch (error) {
          checkCurrent();
          environmentIssue = { resourceKind: 'environment', resourceId: environment.resourceId,
            message: error instanceof Error ? error.message : String(error) };
        }
      };
      // 取消后也等待所有在途任务完成回滚，旧任务不能在下一场景开始后继续提交。
      const prepared = await Promise.allSettled([
        prepareEnvironment(),
        ...Array.from({ length: Math.min(MAX_CONCURRENT_SCENE_MODEL_RESOURCES, modelPlan.length) }, () => prepareModels()),
      ]);
      checkCurrent();
      const failed = prepared.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      for (let index = 0; index < modelPlan.length; index += 1) {
        modelReplacements.push(...(preparedModels.get(index) ?? []));
        const issue = modelIssues.get(index);
        if (issue) issues.push(issue);
      }
      if (environmentIssue) issues.push(environmentIssue);
      reportModelProgress(issues.length ? `场景资源同步结束，${issues.length} 项需处理，已保留原场景配置。`
        : '场景所需模型资源已校验，正在保留参数并准备渲染。', 'completed');
      return { configured: true, sourceKey, modelAssets: modelReplacements.map(item => item.asset),
        modelReplacements, environmentAssets, issues, libraryErrors,
        warnings: [...new Set(modelPlan.flatMap((_, index) => modelWarnings.get(index) ?? []))] };
    }
    const results = await Promise.allSettled([
      executeDataPlatformModelSync({ baseUrl, editorRoot: sharedRoot, signal: controller.signal }),
      environment ? executeDataPlatformEnvironmentSync({ baseUrl, editorRoot: sharedRoot,
        contextKey: createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedRoot),
        localSceneEnvironment: environment, signal: controller.signal }) : Promise.resolve({ matchedResourceId: null }),
    ]);
    controller.signal.throwIfAborted();
    const errors = results.flatMap((result, index) => result.status === 'rejected'
      ? [`${index === 0 ? '普通/组合模型' : '环境模型'}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (errors.length) throw new Error(`本地场景资源同步失败：${errors.join('；')}`);
    const environmentResult = results[1];
    const matchedResourceId = environmentResult.status === 'fulfilled' ? environmentResult.value.matchedResourceId : null;
    const [modelIndex, assetIndex, environments] = await Promise.all([
      readDataPlatformModelIndex(sharedRoot), readProjectAssetIndex(sharedRoot),
      matchedResourceId ? readDataPlatformEnvironmentIndex(sharedRoot).then(index => listIndexedDataPlatformEnvironments(sharedRoot,
        { ...index, entries: index.entries.filter(entry => entry.sourceKey === sourceKey && entry.resourceId === matchedResourceId) }))
        : Promise.resolve({ assets: [], errors: [] }),
    ]);
    controller.signal.throwIfAborted();
    if (environments.errors.length) throw new Error(`环境模型缓存校验失败：${environments.errors.join('；')}`);
    const packagePaths = new Set(modelIndex.sourceKey === sourceKey
      ? modelIndex.entries.map(entry => path.resolve(sharedRoot, entry.packageRelativePath).toLowerCase()) : []);
    const modelAssets = assetIndex.assets.filter(asset => asset.libraryKind === 'model'
      && packagePaths.has(path.resolve(asset.packagePath ?? path.dirname(asset.path)).toLowerCase()));
    controller.signal.throwIfAborted();
    assertSceneContext();
    reportModelProgress('场景所需模型资源已校验，正在保留参数并准备渲染。', 'completed');
    return { configured: true, sourceKey, modelAssets,
      environmentAssets: environments.assets.filter(asset => asset.dataPlatformSourceKey === sourceKey
        && asset.dataPlatformResourceId === matchedResourceId) };
  })();
  localSceneResourceTask = { requestId: request.requestId, controller, promise };
  openTasks.add(promise);
  try {
    return await promise;
  } catch (error) {
    reportLatestProgress?.(error instanceof Error ? error.message : String(error), 'failed');
    throw error;
  } finally {
    openTaskControllers.delete(controller);
    openTasks.delete(promise);
    if (localSceneResourceTask?.promise === promise) localSceneResourceTask = null;
  }
}

/** 本地场景无需业务发布绑定，恢复仍由当前配置的工作区及会话取消机制约束。 */
async function prepareRecoveredLocalScene(baseUrl: string, workspaceRoot: string,
  request: LocalSceneResourceSyncRequest): Promise<LocalSceneResourceSyncResult> {
  if (request.sceneFilePath !== undefined && (typeof request.sceneFilePath !== 'string'
    || !isAuthorizedSceneFile(normalizeFilePath(request.sceneFilePath)))) throw new Error('场景文件尚未通过打开入口授权。');
  const generation = sceneResourceContextGeneration;
  const previous = localSceneResourceTask;
  previous?.controller.abort();
  const controller = new AbortController();
  openTaskControllers.add(controller);
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (generation !== sceneResourceContextGeneration || dataPlatformProjectServiceShuttingDown) throw new Error('场景会话已变化，本地资源恢复已取消。');
  };
  const promise = (async (): Promise<LocalSceneResourceSyncResult> => {
    if (previous) await previous.promise.catch(() => undefined);
    await Promise.all([resetDataPlatformModelSyncSession(), resetDataPlatformEnvironmentSyncSession()]);
    assertCurrent();
    if (baseUrl) {
      const sharedRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
      await ensureWritableEditorRoot(sharedRoot);
      await ensureProjectDirectories(sharedRoot);
      if (!getCurrentProjectRoot()) await activateProjectRoot(workspaceRoot);
      setSharedProjectAssetRoot(sharedRoot); setSharedProjectEnvironmentRoot(sharedRoot); setSharedProjectSkyboxRoot(sharedRoot);
    }
    const result = await recoverLocalSceneResourceTransaction({ request, baseUrl, workspaceRoot,
      projectRoot: getCurrentProjectRoot(), signal: controller.signal, isOriginalPathAllowed: isAuthorizedAssetFile });
    assertCurrent();
    for (const file of result.resolvedFiles) authorizeAssetFile(file);
    const { resolvedFiles: _resolvedFiles, ...response } = result;
    return response;
  })();
  localSceneResourceTask = { requestId: request.requestId, controller, promise };
  openTasks.add(promise);
  try { return await promise; }
  finally {
    openTaskControllers.delete(controller); openTasks.delete(promise);
    if (localSceneResourceTask?.promise === promise) localSceneResourceTask = null;
  }
}

/** 文件系统准备期间若关闭或切换了项目，旧同步不得重新挂载资源目录。 */
function captureModelLibrarySyncContext(): () => boolean {
  const generation = sceneResourceContextGeneration;
  const projectRoot = getCurrentProjectRoot();
  const binding = getCurrentDataPlatformBinding();
  return () => {
    const current = getCurrentDataPlatformBinding();
    return !dataPlatformProjectServiceShuttingDown && !openingProjectCount && !localSceneResourceTask
      && generation === sceneResourceContextGeneration && projectRoot === getCurrentProjectRoot()
      && current?.projectRoot === binding?.projectRoot
      && current?.metadata.baseUrl === binding?.metadata.baseUrl
      && current?.metadata.projectId === binding?.metadata.projectId;
  };
}

/** 本地场景加载后只刷新共享资源缓存，不切换当前业务工程根目录。 */
export async function syncDataPlatformModelsForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
): Promise<boolean> {
  const isCurrent = captureModelLibrarySyncContext();
  if (!isCurrent()) return false;
  const binding = getCurrentDataPlatformBinding();
  if (!binding) {
    await ensureWritableEditorRoot(workspaceRoot);
    if (!isCurrent()) return false;
    const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
    await ensureWritableEditorRoot(sharedResourcesRoot);
    await ensureProjectDirectories(sharedResourcesRoot);
    if (!isCurrent()) return false;
    setSharedProjectAssetRoot(sharedResourcesRoot);
    setSharedProjectEnvironmentRoot(sharedResourcesRoot);
    return startDataPlatformModelSync(baseUrl, sharedResourcesRoot);
  }
  const sharedResourcesRoot = resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata);
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  if (!isCurrent()) return false;
  setSharedProjectAssetRoot(sharedResourcesRoot);
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);
  return startDataPlatformModelSync(binding.metadata.baseUrl, sharedResourcesRoot);
}


/** 打开任意编辑工作区时独立触发环境模型同步，不与普通/组合模型整批事务耦合。 */
export async function syncDataPlatformEnvironmentsForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
  expectedSourceKey?: string,
  requiredResourceIds?: readonly string[],
): Promise<boolean> {
  const isCurrent = captureModelLibrarySyncContext();
  if (!isCurrent()) return false;
  const binding = getCurrentDataPlatformBinding();
  const sharedResourcesRoot = binding
    ? resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata)
    : resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  const sourceBaseUrl = binding?.metadata.baseUrl ?? baseUrl;
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  if (!isCurrent()) return false;
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);
  return startDataPlatformEnvironmentSync(
    sourceBaseUrl,
    sharedResourcesRoot,
    createDataPlatformEnvironmentSyncContextKey(sourceBaseUrl, sharedResourcesRoot),
    // 已绑定的数据中台项目以当前服务器为准，旧场景来源不能阻止覆盖缓存。
    binding ? undefined : expectedSourceKey,
    requiredResourceIds,
  );
}

/** 使所有在途天空盒 prepare 失效；调用方无需等待，dispose 会统一回收任务。 */
export function invalidateDataPlatformSkyboxSyncPrepareContext(): void {
  skyboxSyncPrepareGeneration += 1;
  currentSkyboxSyncPrepareContext = null;
  for (const controller of skyboxSyncPrepareControllers) controller.abort();
}

function isCurrentSkyboxSyncPrepare(context: SkyboxSyncPrepareContext, signal: AbortSignal): boolean {
  return !dataPlatformProjectServiceShuttingDown
    && !signal.aborted
    && currentSkyboxSyncPrepareContext === context
    && context.generation === skyboxSyncPrepareGeneration;
}

async function prepareDataPlatformSkyboxSync(
  context: SkyboxSyncPrepareContext,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isCurrentSkyboxSyncPrepare(context, signal)) return false;
  await ensureWritableEditorRoot(context.sharedResourcesRoot);
  if (!isCurrentSkyboxSyncPrepare(context, signal)) return false;
  await ensureProjectDirectories(context.sharedResourcesRoot);
  if (!isCurrentSkyboxSyncPrepare(context, signal)) return false;
  setSharedProjectSkyboxRoot(context.sharedResourcesRoot);
  if (!isCurrentSkyboxSyncPrepare(context, signal)) return false;
  return startDataPlatformSkyboxSync(
    context.baseUrl,
    context.sharedResourcesRoot,
    context.syncContextKey,
  );
}

/** 手动同步始终写入工作区共享天空盒缓存，不创建或切换业务项目 binding。 */
export function syncDataPlatformSkyboxesForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
): Promise<boolean> {
  if (dataPlatformProjectServiceShuttingDown) return Promise.resolve(false);
  invalidateDataPlatformSkyboxSyncPrepareContext();
  if (dataPlatformProjectServiceShuttingDown) return Promise.resolve(false);

  const controller = new AbortController();
  const binding = getCurrentDataPlatformBinding();
  const boundWorkspaceRoot = binding
    ? resolveDataPlatformBindingWorkspaceRoot(binding.projectRoot, binding.metadata)
    : workspaceRoot;
  const sourceBaseUrl = binding?.metadata.baseUrl ?? baseUrl;
  const context: SkyboxSyncPrepareContext = {
    generation: skyboxSyncPrepareGeneration,
    baseUrl: sourceBaseUrl,
    workspaceRoot: boundWorkspaceRoot,
    sharedResourcesRoot: resolveDataPlatformSharedResourcesRoot(boundWorkspaceRoot),
    syncContextKey: binding
      ? createDataPlatformSkyboxSyncContextKey(
        binding.metadata.baseUrl,
        binding.metadata.projectId,
        binding.projectRoot,
      )
      : null,
  };
  currentSkyboxSyncPrepareContext = context;
  skyboxSyncPrepareControllers.add(controller);
  const task = prepareDataPlatformSkyboxSync(context, controller.signal);
  skyboxSyncPrepareTasks.add(task);
  const cleanup = (): void => {
    skyboxSyncPrepareControllers.delete(controller);
    skyboxSyncPrepareTasks.delete(task);
    if (currentSkyboxSyncPrepareContext === context) currentSkyboxSyncPrepareContext = null;
  };
  void task.then(cleanup, cleanup);
  return task;
}

/** 本地场景或业务工程打开后启动数据中台图标图片同步，与模型同步共用同一资源根判定。 */
export async function syncDataPlatformImagesForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
): Promise<boolean> {
  if (dataPlatformProjectServiceShuttingDown) return false;
  const binding = getCurrentDataPlatformBinding();
  if (!binding) {
    await ensureWritableEditorRoot(workspaceRoot);
    await activateProjectRoot(workspaceRoot);
    const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
    await ensureWritableEditorRoot(sharedResourcesRoot);
    await ensureProjectDirectories(sharedResourcesRoot);
    setSharedProjectAssetRoot(sharedResourcesRoot);
    return startDataPlatformImageSync(baseUrl, workspaceRoot);
  }
  const sharedResourcesRoot = resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata);
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  setSharedProjectAssetRoot(sharedResourcesRoot);
  return startDataPlatformImageSync(binding.metadata.baseUrl, sharedResourcesRoot);
}

/** 根据数据中台地址和共享缓存目录生成环境同步业务 key。 */
export function createDataPlatformEnvironmentSyncContextKey(baseUrl: string, sharedResourcesRoot: string): string {
  return `${createDataPlatformSourceKey(baseUrl)}:${path.resolve(sharedResourcesRoot).toLowerCase()}`;
}

function createDataPlatformSkyboxSyncContextKey(
  baseUrl: string,
  projectId: string,
  projectRoot: string,
): string {
  const normalizedBaseUrl = new URL(baseUrl).toString().replace(/\/$/, '');
  const normalizedProjectId = projectId.trim();
  if (!/^[1-9]\d{0,63}$/.test(normalizedProjectId)) {
    throw new Error('数据中台项目 ID 无效，无法创建天空盒同步 contextKey。');
  }
  const absoluteProjectRoot = path.resolve(projectRoot);
  const normalizedProjectRoot = process.platform === 'win32'
    ? absoluteProjectRoot.toLowerCase()
    : absoluteProjectRoot;
  return createHash('sha256')
    .update(`${normalizedBaseUrl}\n${normalizedProjectId}\n${normalizedProjectRoot}`, 'utf8')
    .digest('hex');
}

/** 当前项目用于隔离天空盒同步进度的安全业务 key。 */
export function getCurrentDataPlatformSkyboxSyncContextKey(): string | null {
  const binding = getCurrentDataPlatformBinding();
  return binding
    ? createDataPlatformSkyboxSyncContextKey(
      binding.metadata.baseUrl,
      binding.metadata.projectId,
      binding.projectRoot,
    )
    : null;
}

/** 重试最近一次数据中台天空盒同步。 */
export function retryLatestDataPlatformSkyboxSync(): boolean {
  return retryDataPlatformSkyboxSync();
}

/** 暴露最近天空盒同步进度给晚挂载的 renderer。 */
export function getCurrentDataPlatformSkyboxSyncProgress(): DataPlatformSkyboxSyncProgress | null {
  return getLatestDataPlatformSkyboxSyncProgress();
}

/** 重试最近一次数据中台图片同步。 */
export function retryLatestDataPlatformImageSync(): boolean {
  return retryDataPlatformImageSync();
}

/** 暴露最近图片同步进度给晚挂载的 renderer。 */
export function getCurrentDataPlatformImageSyncProgress(): DataPlatformImageSyncProgress | null {
  return getLatestDataPlatformImageSyncProgress();
}

/** 读取当前工作区生效的同步图片清单，供 renderer 图片库与拖拽校验使用。 */
export async function listSyncedImagesForWorkspace(workspaceRoot: string): Promise<SyncedImageAssetEntry[]> {
  const binding = getCurrentDataPlatformBinding();
  if (!binding) {
    await ensureWritableEditorRoot(workspaceRoot).catch(() => undefined);
    return listSyncedImages(workspaceRoot);
  }
  const sharedResourcesRoot = resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata);
  return listSyncedImages(sharedResourcesRoot);
}

/** 重试最近一次独立环境模型同步。 */
export function retryLatestDataPlatformEnvironmentSync(): boolean {
  return retryDataPlatformEnvironmentSync();
}

/** 暴露最近环境模型同步进度。 */
export function getCurrentDataPlatformEnvironmentSyncProgress(): DataPlatformEnvironmentSyncProgress | null {
  return getLatestDataPlatformEnvironmentSyncProgress();
}

/** 暴露模型同步重试给 IPC。 */
export function retryLatestDataPlatformModelSync(): boolean {
  return retryDataPlatformModelSync();
}

/** 暴露最近模型同步进度给晚挂载的 renderer。 */
export function getCurrentDataPlatformModelSyncProgress(): DataPlatformModelSyncProgress | null {
  return getLatestDataPlatformModelSyncProgress();
}

/** 数据中台配置变更后清除旧地址对应的重试上下文。 */
export function clearDataPlatformProjectServiceRetryContext(): void {
  clearDataPlatformModelSyncRetryContext();
  clearDataPlatformEnvironmentSyncRetryContext();
  clearDataPlatformImageSyncRetryContext();
  clearDataPlatformSkyboxSyncRetryContext();
  invalidateDataPlatformSkyboxSyncPrepareContext();
}

/** 返回首页时排空仍会写入项目状态的任务，不进入应用退出状态。 */
export async function resetDataPlatformProjectSession(): Promise<void> {
  cancelDataPlatformProjectLoading();
  invalidateDataPlatformSkyboxSyncPrepareContext();
  await Promise.allSettled([...openTasks, ...skyboxSyncPrepareTasks]);
  await Promise.all([
    resetDataPlatformModelSyncSession(),
    resetDataPlatformEnvironmentSyncSession(),
    resetDataPlatformImageSyncSession(),
    resetDataPlatformSkyboxSyncSession(),
  ]);
}

/** 应用退出时取消并等待工程打开与全部共享资源同步任务。 */
export async function disposeDataPlatformProjectTasks(): Promise<void> {
  dataPlatformProjectServiceShuttingDown = true;
  invalidateDataPlatformSkyboxSyncPrepareContext();
  for (const controller of openTaskControllers) controller.abort();
  await Promise.allSettled([...openTasks]);
  await Promise.allSettled([...skyboxSyncPrepareTasks]);
  await disposeDataPlatformModelSync();
  await disposeDataPlatformEnvironmentSync();
  await disposeDataPlatformImageSync();
  await disposeDataPlatformSkyboxSync();
  await disposeEnvironmentFileValidation();
}

async function openDataPlatformProjectInternal(
  project: DataPlatformProjectEntry,
  baseUrl: string,
  workspaceRoot: string,
  webBaseUrl: string,
  signal: AbortSignal,
): Promise<DataPlatformProjectOpenResult> {
  // 先校验用户配置的工作区本身，避免子目录创建失败时只暴露晦涩的 ENOTDIR。
  await ensureWritableEditorRoot(workspaceRoot);
  const { projectRoot } = await resolveDataPlatformProjectLocation({ workspaceRoot, baseUrl, projectId: project.id });
  signal.throwIfAborted();
  const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  await ensureWritableEditorRoot(projectRoot);
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(projectRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  setSharedProjectAssetRoot(sharedResourcesRoot);
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);

  let source: DataPlatformProjectOpenResult['source'] = 'generated';
  let warning: string | null = null;
  let conflictCopyPath: string | null = null;
  const existingBinding = await readDataPlatformBinding(projectRoot);
  let sceneFilePath: string | null = null;
  const remoteVersionId = project.latestEditorProjectVersionId;
  if (remoteVersionId && !project.latestEditorProjectPackageUrl?.trim()) {
    throw new Error('数据中台项目已有工程版本，但未返回有效工程包地址，已保留原本地场景，请重新获取项目后重试。');
  }
  const preserveLocalChanges = async (stagedRoot: string): Promise<void> => {
    if (await hasDifferentLocalProjectContent(projectRoot, stagedRoot, signal)) {
      conflictCopyPath = await createLocalConflictCopy(workspaceRoot, projectRoot, project.id, existingBinding?.latestVersionId ?? null);
      warning = `已按数据中台工程恢复；原本地内容与远端不同，已保留副本：${conflictCopyPath}`;
    }
  };
  // 工作目录是可编辑副本。发布失败也会先写入本地文件，绑定版本号不能作为内容一致的依据。
  if (project.latestEditorProjectPackageUrl) {
    const openRoot = path.join(projectRoot, '.babylon-editor', `data-platform-open-${randomUUID()}`);
    const archivePath = path.join(openRoot, 'project-package.zip');
    const extractRoot = path.join(openRoot, 'extracted');
    assertPathInside(projectRoot, openRoot, '工程包暂存目录');
    await fs.rm(openRoot, { recursive: true, force: true });

    let preserveOpenRoot = false;
    try {
      await fs.mkdir(openRoot, { recursive: true });
      await downloadRemoteFile({
        baseUrl,
        remoteUrl: project.latestEditorProjectPackageUrl,
        destinationPath: archivePath,
        signal,
        timeoutMs: PROJECT_DOWNLOAD_TIMEOUT_MS,
        context: `下载项目“${project.projectName}”工程包`,
      });
      await extractZipSecurely(archivePath, extractRoot, signal);
      const detection = await detectCurrentProjectPackage(extractRoot);

      if (detection.kind === 'current') {
        const materialized = await materializeCurrentProjectPackage({
          editorRoot: projectRoot,
          packageRoot: detection.packageRoot,
          sceneSourcePaths: detection.sceneFilePaths,
          entrySceneSourcePath: detection.sceneFilePath,
          project,
          openRoot,
          beforePromote: preserveLocalChanges,
          signal,
        });
        source = 'package';
        sceneFilePath = materialized.sceneFilePath;
        warning = [warning, materialized.warning].filter(Boolean).join('；') || null;
      } else {
        throw new Error(`数据中台工程包无法打开：${detection.reason}。未回退到本地工程。`);
      }
    } catch (error) {
      preserveOpenRoot = error instanceof DataPlatformRollbackError;
      throw error;
    } finally {
      if (!preserveOpenRoot) await fs.rm(openRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  } else {
    const openRoot = path.join(projectRoot, '.babylon-editor', `data-platform-open-${randomUUID()}`);
    const emptyPackageRoot = path.join(openRoot, 'empty');
    let preserveOpenRoot = false;
    try {
      await ensureProjectDirectories(emptyPackageRoot);
      await materializeCurrentProjectPackage({ editorRoot: projectRoot, packageRoot: emptyPackageRoot,
        sceneSourcePaths: [], entrySceneSourcePath: null, project, openRoot, beforePromote: preserveLocalChanges, signal });
      warning = [warning, '数据中台项目没有可用工程包，已打开空项目，未复用本地场景。'].filter(Boolean).join('；');
    } catch (error) {
      preserveOpenRoot = error instanceof DataPlatformRollbackError;
      throw error;
    } finally {
      if (!preserveOpenRoot) await fs.rm(openRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (signal.aborted) throw new Error('打开数据中台项目已取消。');
  if (source === 'generated') {
    await ensureGeneratedProjectMetadata(projectRoot);
    await activateProjectRoot(projectRoot);
  } else if (sceneFilePath) {
    await activateProjectRoot(projectRoot, sceneFilePath);
    await rememberRecentSceneFile(sceneFilePath, projectRoot);
  }

  const entryScenePath = sceneFilePath ? toProjectRelativePath(projectRoot, sceneFilePath) : null;
  const binding = createDataPlatformBinding({
    baseUrl,
    webBaseUrl,
    workspaceRoot,
    projectId: project.id,
    projectName: project.projectName,
    editorProjectId: project.latestEditorProjectId,
    latestVersionId: remoteVersionId,
    latestVersionNumber: project.latestEditorProjectVersionNumber,
    resourceRevision: project.currentResourceRevision,
    entryScenePath,
    syncedAt: new Date().toISOString(),
  });
  await writeDataPlatformBinding(projectRoot, binding);
  setCurrentDataPlatformBinding(projectRoot, binding);
  if (!sceneFilePath) setBoundScenePublishScope(projectRoot);
  invalidateDataPlatformSkyboxSyncPrepareContext();
  setSharedProjectSkyboxRoot(sharedResourcesRoot);

  const requiredEnvironmentIds = sceneFilePath
    ? getRequiredEnvironmentResourceIds(await readProjectPackageJson(sceneFilePath, '场景环境引用')) : [];
  if (signal.aborted) throw new Error('打开数据中台项目已取消。');
  // 有场景的项目由 renderer 收集实际引用后定向同步，避免全库刷新先覆盖旧资源。
  const modelSyncStarted = sceneFilePath ? false : startDataPlatformModelSync(baseUrl, sharedResourcesRoot);
  const envModelSyncStarted = sceneFilePath ? false : startDataPlatformEnvironmentSync(
    baseUrl,
    sharedResourcesRoot,
    createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedResourcesRoot),
    undefined,
    requiredEnvironmentIds,
    true,
  );
  const skyboxSyncStarted = startDataPlatformSkyboxSync(
    baseUrl,
    sharedResourcesRoot,
    createDataPlatformSkyboxSyncContextKey(baseUrl, project.id, projectRoot),
  );
  return {
    projectRoot,
    sceneFilePath,
    source,
    warning,
    conflictCopyPath,
    modelSyncStarted,
    envModelSyncStarted,
    skyboxSyncStarted,
    binding,
  };
}
/** 恢复远端前保留不同的本地内容，不尝试自动合并。 */
async function createLocalConflictCopy(
  workspaceRoot: string,
  projectRoot: string,
  projectId: string,
  versionId: string | null,
): Promise<string> {
  const conflictParent = path.join(path.resolve(workspaceRoot), 'Conflicts', projectId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const conflictRoot = path.join(conflictParent, `${timestamp}-version-${versionId ?? 'local'}-${randomUUID()}`);
  assertPathInside(path.resolve(workspaceRoot), conflictRoot, '本地冲突副本目录');
  await fs.mkdir(conflictParent, { recursive: true });
  await fs.cp(projectRoot, conflictRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (sourcePath) => {
      const relative = path.relative(projectRoot, sourcePath).replace(/\\/g, '/');
      return !relative.startsWith('.babylon-editor/data-platform-open-')
        && !relative.startsWith('.babylon-editor/digital-twin-publish-');
    },
  });
  return conflictRoot;
}

/** 比较刚下载并重定位的远端内容，避免以版本号或 mtime 推测本地是否有修改。空目录不构成修改。 */
async function hasDifferentLocalProjectContent(projectRoot: string, stagedRoot: string, signal: AbortSignal): Promise<boolean> {
  const collectFiles = async (root: string): Promise<Map<string, string>> => {
    const files = new Map<string, string>();
    for (const directory of ['Scenes', 'Assets']) {
      const pending = [path.join(root, directory)];
      while (pending.length) {
        signal.throwIfAborted();
        const current = pending.pop()!;
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => {
          if (isNodeError(error) && error.code === 'ENOENT' && current === path.join(root, directory)) return [];
          throw error;
        });
        for (const entry of entries) {
          const filePath = path.join(current, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(filePath);
          else files.set(path.relative(root, filePath).replace(/\\/g, '/'), filePath);
          if (files.size + pending.length > 200_000) throw new Error('本地工程文件数量过大，无法安全比较并保留副本。');
        }
      }
    }
    return files;
  };
  const local = await collectFiles(projectRoot);
  if (local.size === 0) return false;
  const remote = await collectFiles(stagedRoot);
  if (local.size !== remote.size) return true;
  const hashFile = async (filePath: string): Promise<string> => {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(filePath, { signal })) digest.update(chunk);
    return digest.digest('hex');
  };
  for (const [relative, localPath] of local) {
    signal.throwIfAborted();
    const remotePath = remote.get(relative);
    if (!remotePath) return true;
    const [localStat, remoteStat] = await Promise.all([fs.lstat(localPath), fs.lstat(remotePath)]);
    if (!localStat.isFile() || localStat.isSymbolicLink() || localStat.size !== remoteStat.size) return true;
    if (await hashFile(localPath) !== await hashFile(remotePath)) return true;
  }
  return false;
}

function toProjectRelativePath(projectRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('入口场景不在当前数据中台项目目录内。');
  }
  return relative.replace(/\\/g, '/');
}
export async function ensureWritableEditorRoot(editorRoot: string): Promise<void> {
  assertWorkspaceOutsideInstallation(editorRoot);

  let stat;
  try {
    await fs.mkdir(editorRoot, { recursive: true }).catch((error) => {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    });
    stat = await fs.stat(editorRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`数据中台工作目录无法创建或访问：${editorRoot}（${message}）`);
  }
  if (!stat.isDirectory()) throw new Error(`数据中台工作路径不是目录：${editorRoot}`);
  await assertWorkspaceRealPathOutsideInstallation(editorRoot);

  const probePath = path.join(editorRoot, `.zending-write-probe-${randomUUID()}`);
  assertPathInside(editorRoot, probePath, '写权限探测路径');
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(probePath, 'wx');
    await handle.writeFile('zending');
    await handle.sync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`数据中台工作目录不可写：${editorRoot}。请检查当前用户对该目录的读写权限后重试。（${message}）`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
}

async function detectCurrentProjectPackage(extractRoot: string): Promise<PackageDetection> {
  const rootCandidate = await inspectPackageCandidate(extractRoot);
  if (rootCandidate.kind === 'current') return rootCandidate;

  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  const wrapperDirectories = entries.filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
  const nonWrapperEntries = entries.filter((entry) => {
    if (entry.name === '__MACOSX' || entry.name === '.DS_Store') return false;
    return !entry.isDirectory();
  });

  if (wrapperDirectories.length === 1 && nonWrapperEntries.length === 0) {
    const wrappedCandidate = await inspectPackageCandidate(path.join(extractRoot, wrapperDirectories[0].name));
    if (wrappedCandidate.kind === 'current') return wrappedCandidate;
    if (await containsLegacyProjectFile(path.join(extractRoot, wrapperDirectories[0].name))) {
      return { kind: 'incompatible', reason: '工程包属于旧版 project.bjseditor 格式' };
    }
    return wrappedCandidate;
  }

  if (await containsLegacyProjectFile(extractRoot)) {
    return { kind: 'incompatible', reason: '工程包属于旧版 project.bjseditor 格式' };
  }
  return rootCandidate;
}

async function inspectPackageCandidate(packageRoot: string): Promise<PackageDetection> {
  const metadataRoot = path.join(packageRoot, '.babylon-editor');
  const modelsRoot = path.join(packageRoot, 'Assets', 'Models');
  const environmentsRoot = path.join(packageRoot, 'Assets', 'Environments');
  const missing: string[] = [];

  if (!(await isDirectory(metadataRoot))) missing.push('.babylon-editor/');
  if (!(await isDirectory(modelsRoot))) missing.push('Assets/Models/');
  if (!(await isDirectory(environmentsRoot))) missing.push('Assets/Environments/');
  if (missing.length > 0) {
    return { kind: 'incompatible', reason: `工程包缺少当前编辑器目录：${missing.join('、')}` };
  }

  const sceneFilePaths = await findSceneFiles(packageRoot);
  if (sceneFilePaths.length === 0 || sceneFilePaths.length > MAX_PROJECT_SCENE_FILES) {
    return { kind: 'incompatible', reason: `工程包场景数量必须为 1 到 ${MAX_PROJECT_SCENE_FILES} 个，当前发现 ${sceneFilePaths.length} 个` };
  }

  for (const sceneFilePath of sceneFilePaths) {
    try {
      const parsed = await readProjectPackageJson(sceneFilePath, '工程包场景');
      const sceneVersion = isPlainObject(parsed) ? parsed.version : null;
      // 与场景加载器及 SOURCE 发布入口保持一致，避免新工作区把 v4/v5 工程误判为空项目。
      if (!isPlainObject(parsed) || (sceneVersion !== 1 && sceneVersion !== 2 && sceneVersion !== 3 && sceneVersion !== 4 && sceneVersion !== 5) || !isPlainObject(parsed.scene)) {
        return { kind: 'incompatible', reason: `工程包中的场景文件不是当前编辑器场景格式：${path.basename(sceneFilePath)}` };
      }
    } catch (error) {
      if (error instanceof ProjectPackageCapacityError) throw error;
      return { kind: 'incompatible', reason: `工程包中的场景文件不是有效 JSON：${path.basename(sceneFilePath)}` };
    }
  }

  const manifestPath = path.resolve(packageRoot, ...DIGITAL_TWIN_SOURCE_MANIFEST_PATH.split('/'));
  let entryScenePath = sceneFilePaths[0];
  if (await isFile(manifestPath)) {
    try {
      const manifest = await readProjectPackageJson(manifestPath, '数字孪生源工程 manifest');
      if (!isPlainObject(manifest) || manifest.version !== 1 || typeof manifest.entryScenePath !== 'string') {
        return { kind: 'incompatible', reason: '数字孪生源工程 manifest 结构无效' };
      }
      const normalizedEntryPath = path.posix.normalize(manifest.entryScenePath.trim().replace(/\\/g, '/'));
      if (!normalizedEntryPath || normalizedEntryPath.startsWith('../') || normalizedEntryPath.startsWith('/') || !normalizedEntryPath.toLowerCase().endsWith('.scene.json')) {
        return { kind: 'incompatible', reason: '数字孪生源工程入口场景路径无效' };
      }
      const candidate = path.resolve(packageRoot, ...normalizedEntryPath.split('/'));
      if (!isPathInside(packageRoot, candidate) || !sceneFilePaths.some((item) => path.resolve(item) === candidate)) {
        return { kind: 'incompatible', reason: '数字孪生源工程入口场景不存在' };
      }
      entryScenePath = candidate;
    } catch (error) {
      if (error instanceof ProjectPackageCapacityError) throw error;
      return { kind: 'incompatible', reason: '数字孪生源工程 manifest 不是有效 JSON' };
    }
  } else if (sceneFilePaths.length !== 1) {
    return { kind: 'incompatible', reason: '包含多个场景的工程包必须提供数字孪生源工程 manifest' };
  }

  return {
    kind: 'current',
    packageRoot,
    sceneFilePaths,
    sceneFilePath: entryScenePath,
    entrySceneRelativePath: path.relative(packageRoot, entryScenePath).replace(/\\/g, '/'),
  };
}
async function materializeCurrentProjectPackage(options: {
  editorRoot: string;
  packageRoot: string;
  sceneSourcePaths: string[];
  entrySceneSourcePath: string | null;
  project: DataPlatformProjectEntry;
  openRoot: string;
  beforePromote: (stagedRoot: string) => Promise<void>;
  signal: AbortSignal;
}): Promise<{ sceneFilePath: string | null; warning: string | null }> {
  const transactionRoot = path.join(options.openRoot, 'materialize');
  const stagedRoot = path.join(transactionRoot, 'staged');
  const backupRoot = path.join(transactionRoot, 'backup');
  const promotionItems: PromotionItem[] = [];
  await fs.mkdir(stagedRoot, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });

  const sourceAssetsRoot = path.join(options.packageRoot, 'Assets');
  const stagedAssetsRoot = path.join(stagedRoot, 'Assets');
  const targetAssetsRoot = path.join(options.editorRoot, 'Assets');
  const backupAssetsRoot = path.join(backupRoot, 'Assets');
  assertPathInside(options.editorRoot, targetAssetsRoot, '工程包资产目标');

  const stagedScenesRoot = path.join(stagedRoot, 'Scenes');
  const targetScenesRoot = path.join(options.editorRoot, 'Scenes');
  const backupScenesRoot = path.join(backupRoot, 'Scenes');
  const sceneTargets = new Map<string, string>();
  const usedRelativePaths = new Set<string>();
  await fs.mkdir(stagedScenesRoot, { recursive: true });
  for (const sceneSourcePath of options.sceneSourcePaths) {
    const packageRelative = path.relative(options.packageRoot, sceneSourcePath).replace(/\\/g, '/');
    const targetRelative = packageRelative.toLowerCase().startsWith('scenes/')
      ? packageRelative.slice(7)
      : path.posix.join('DataPlatform', options.project.id, sanitizeSceneFileName(path.basename(sceneSourcePath), options.project.id));
    const normalizedRelative = path.posix.normalize(targetRelative);
    if (!normalizedRelative || normalizedRelative.startsWith('../') || usedRelativePaths.has(normalizedRelative.toLowerCase())) {
      throw new Error(`工程包场景目标路径冲突：${targetRelative}`);
    }
    usedRelativePaths.add(normalizedRelative.toLowerCase());
    const stagedScenePath = path.resolve(stagedScenesRoot, ...normalizedRelative.split('/'));
    const targetScenePath = path.resolve(targetScenesRoot, ...normalizedRelative.split('/'));
    assertPathInside(stagedRoot, stagedScenePath, '工程包场景暂存路径');
    assertPathInside(options.editorRoot, targetScenePath, '工程包场景目标');
    await fs.mkdir(path.dirname(stagedScenePath), { recursive: true });
    const rewrittenSceneContent = await rewriteSceneForEditorRoot(sceneSourcePath, options.editorRoot);
    await assertDiskWriteCapacity(
      stagedRoot,
      BigInt(Buffer.byteLength(rewrittenSceneContent, 'utf8')),
      `写入工程包场景“${path.basename(sceneSourcePath)}”`,
    );
    await fs.writeFile(stagedScenePath, rewrittenSceneContent, 'utf-8');
    sceneTargets.set(path.resolve(sceneSourcePath), targetScenePath);
  }
  await fs.rename(sourceAssetsRoot, stagedAssetsRoot);
  promotionItems.push(createPromotionItem('directory', targetAssetsRoot, stagedAssetsRoot, backupAssetsRoot));
  promotionItems.push(createPromotionItem('directory', targetScenesRoot, stagedScenesRoot, backupScenesRoot));
  const entrySceneTargetPath = options.entrySceneSourcePath ? sceneTargets.get(path.resolve(options.entrySceneSourcePath)) : null;
  if (options.entrySceneSourcePath && !entrySceneTargetPath) throw new Error('工程包入口场景未能物化。');
  options.signal.throwIfAborted();
  await options.beforePromote(stagedRoot);
  options.signal.throwIfAborted();

  try {
    for (const item of promotionItems) await promoteItem(item);

    const rebuilt = await scanCurrentModelLibrary(options.editorRoot);
    const stagedIndexPath = path.join(stagedRoot, '.babylon-editor', 'asset-index.json');
    const indexTargetPath = getProjectAssetIndexPath(options.editorRoot);
    const indexBackupPath = path.join(backupRoot, '.babylon-editor', 'asset-index.json');
    await fs.mkdir(path.dirname(stagedIndexPath), { recursive: true });
    const indexContent = `${JSON.stringify({ version: 2, assets: rebuilt.assets } satisfies ProjectAssetIndex, null, 2)}\n`;
    await assertDiskWriteCapacity(
      stagedRoot,
      BigInt(Buffer.byteLength(indexContent, 'utf8')),
      '写入工程资产索引',
    );
    await fs.writeFile(stagedIndexPath, indexContent, 'utf-8');
    const indexItem = createPromotionItem('file', indexTargetPath, stagedIndexPath, indexBackupPath);
    promotionItems.push(indexItem);
    await promoteItem(indexItem);

    return {
      sceneFilePath: entrySceneTargetPath ?? null,
      warning: rebuilt.skipped.length > 0
        ? `工程已打开，但有 ${rebuilt.skipped.length} 个本地模型包未通过扫描：${rebuilt.skipped.slice(0, 3).join('；')}`
        : null,
    };
  } catch (error) {
    const rollbackErrors = await rollbackPromotionItems(promotionItems);
    const message = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) {
      throw new DataPlatformRollbackError(
        `${message}；工程写入回滚不完整：${rollbackErrors.join('；')}；已保留恢复目录：${backupRoot}` ,
      );
    }
    throw error;
  }
}
async function rewriteSceneForEditorRoot(sceneSourcePath: string, editorRoot: string): Promise<string> {
  const parsed = await readProjectPackageJson(sceneSourcePath, '工程包场景');
  const rewritten = relocateDataPlatformScene(parsed, editorRoot);
  return `${JSON.stringify(rewritten, null, 2)}\n`;
}

async function readProjectPackageJson(filePath: string, label: string): Promise<unknown> {
  const fileSize = await readProjectPackageTextFileSize(filePath, label);
  assertProjectPackageHeapCapacity(fileSize, `${label}“${path.basename(filePath)}”`);
  return JSON.parse(await readUtf8File(filePath, '数据中台工程 JSON 文件')) as unknown;
}

async function readProjectPackageTextFileSize(filePath: string, label: string): Promise<bigint> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`${label}文件无效：${path.basename(filePath)}`);
  }
  return BigInt(stat.size);
}

function assertProjectPackageHeapCapacity(sourceBytes: bigint, label: string): void {
  const heap = getHeapStatistics();
  const availableHeapBytes = BigInt(Math.max(0, Math.floor(heap.heap_size_limit - heap.used_heap_size)));
  const estimatedRequiredBytes = sourceBytes * PROJECT_TEXT_HEAP_EXPANSION_FACTOR;
  if (estimatedRequiredBytes + MIN_FREE_HEAP_RESERVE_BYTES > availableHeapBytes) {
    throw new ProjectPackageCapacityError(`${label}超出当前可用内存。`);
  }
}


async function scanCurrentModelLibrary(editorRoot: string): Promise<{ assets: ProjectModelAssetEntry[]; skipped: string[] }> {
  const assets: ProjectModelAssetEntry[] = [];
  const skipped: string[] = [];
  const modelsRoot = getProjectModelsRoot(editorRoot);
  const environmentsRoot = getProjectEnvironmentsRoot(editorRoot);
  const candidates: Array<{ packagePath: string; libraryKind: 'model' | 'environment' }> = [];

  for (const entry of await safeReadDirectories(modelsRoot)) {
    const entryPath = path.join(modelsRoot, entry);
    if (entry.toLowerCase() !== 'combomodels') {
      candidates.push({ packagePath: entryPath, libraryKind: 'model' });
      continue;
    }
    for (const comboEntry of await safeReadDirectories(entryPath)) {
      candidates.push({ packagePath: path.join(entryPath, comboEntry), libraryKind: 'model' });
    }
  }
  for (const entry of await safeReadDirectories(environmentsRoot)) {
    candidates.push({ packagePath: path.join(environmentsRoot, entry), libraryKind: 'environment' });
  }

  for (const candidate of candidates) {
    try {
      await assertModelPackageScanCapacity(candidate.packagePath);
      const result = await scanModelPackage(candidate.packagePath);
      if (result.asset) {
        assets.push({
          ...result.asset,
          assetRevision: `${Date.now().toString(36)}-${randomUUID()}`,
          kind: 'model',
          libraryKind: candidate.libraryKind,
        });
      } else if (result.skipped) {
        skipped.push(`${path.basename(candidate.packagePath)}：${result.skipped.reason}`);
      }
    } catch (error) {
      if (error instanceof ProjectPackageCapacityError) throw error;
      skipped.push(`${path.basename(candidate.packagePath)}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { assets, skipped };
}

/** 模型扫描会同时保留 meta.json 解析结果并读取一个脚本，按实际峰值做动态堆容量检查。 */
async function assertModelPackageScanCapacity(packagePath: string): Promise<void> {
  const entries = await fs.readdir(packagePath, { withFileTypes: true });
  let metadataBytes = 0n;
  let largestScriptBytes = 0n;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const normalizedName = entry.name.toLowerCase();
    const isMetadata = process.platform === 'win32'
      ? normalizedName === 'meta.json'
      : entry.name === 'meta.json';
    const isRuntimeScript = normalizedName.endsWith('.ts') && !normalizedName.endsWith('.d.ts');
    if (!isMetadata && !isRuntimeScript) continue;

    const fileSize = await readProjectPackageTextFileSize(
      path.join(packagePath, entry.name),
      isMetadata ? '模型包元数据' : '模型包脚本',
    );
    if (isMetadata) metadataBytes = fileSize;
    else if (fileSize > largestScriptBytes) largestScriptBytes = fileSize;
  }

  const estimatedSourceBytes = metadataBytes + largestScriptBytes;
  if (estimatedSourceBytes > 0n) {
    assertProjectPackageHeapCapacity(
      estimatedSourceBytes,
      `模型包元数据或脚本“${path.basename(packagePath)}”`,
    );
  }
}

async function ensureGeneratedProjectMetadata(editorRoot: string): Promise<void> {
  const indexPath = getProjectAssetIndexPath(editorRoot);
  if (await pathExists(indexPath)) return;
  const rebuilt = await scanCurrentModelLibrary(editorRoot);
  await writeProjectAssetIndex(editorRoot, { version: 2, assets: rebuilt.assets });
}

function createPromotionItem(
  type: PromotionItem['type'],
  target: string,
  staged: string,
  backup: string,
): PromotionItem {
  return { type, target, staged, backup, previousMoved: false, stagedMoved: false };
}

async function promoteItem(item: PromotionItem): Promise<void> {
  await fs.mkdir(path.dirname(item.target), { recursive: true });
  if (await pathExists(item.target)) {
    await fs.mkdir(path.dirname(item.backup), { recursive: true });
    await fs.rename(item.target, item.backup);
    item.previousMoved = true;
  }
  await fs.rename(item.staged, item.target);
  item.stagedMoved = true;
}

async function rollbackPromotionItems(items: PromotionItem[]): Promise<string[]> {
  const errors: string[] = [];
  for (const item of [...items].reverse()) {
    try {
      if (item.stagedMoved && await pathExists(item.target)) {
        await fs.rm(item.target, { recursive: item.type === 'directory', force: true });
      }
      if (item.previousMoved && await pathExists(item.backup)) {
        await fs.mkdir(path.dirname(item.target), { recursive: true });
        await fs.rename(item.backup, item.target);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function findSceneFiles(root: string): Promise<string[]> {
  const scenes: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.scene.json')) {
        scenes.push(entryPath);
      }
    }
  }
  return scenes;
}

async function containsLegacyProjectFile(root: string): Promise<boolean> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === 'project.bjseditor' && entry.isFile()) return true;
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return false;
}

async function safeReadDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function sanitizeSceneFileName(value: string, projectId: string): string {
  let name = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  if (!name.toLowerCase().endsWith('.scene.json')) name = `data-platform-${projectId}.scene.json`;
  const stem = name.split('.', 1)[0]?.toUpperCase() ?? '';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = `_${name}`;
  return name || `data-platform-${projectId}.scene.json`;
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 安装态不允许把业务数据目录放在可执行文件目录内。 */
function assertWorkspaceOutsideInstallation(editorRoot: string): void {
  if (!app.isPackaged) return;
  if (isPathInsideOrEqual(path.dirname(app.getPath('exe')), editorRoot)) {
    throw new Error(`数据中台工作区不能位于应用安装目录中：${editorRoot}`);
  }
}

/** 对真实路径重复校验，避免通过目录符号链接绕过安装目录保护。 */
async function assertWorkspaceRealPathOutsideInstallation(editorRoot: string): Promise<void> {
  if (!app.isPackaged) return;
  const [installRoot, workspaceRoot] = await Promise.all([
    fs.realpath(path.dirname(app.getPath('exe'))),
    fs.realpath(editorRoot),
  ]);
  if (isPathInsideOrEqual(installRoot, workspaceRoot)) {
    throw new Error(`数据中台工作区不能位于应用安装目录中：${editorRoot}`);
  }
}

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSameFilePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
