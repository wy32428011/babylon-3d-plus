import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
} from '../types.js';
import { encodeAssetUrl } from './assetRegistry.js';
import {
  activateProjectRoot,
  ensureProjectDirectories,
  getCurrentProjectRoot,
  getProjectAssetIndexPath,
  getProjectEnvironmentsRoot,
  getProjectModelsRoot,
  rememberRecentSceneFile,
  setSharedProjectAssetRoot,
  setSharedProjectEnvironmentRoot,
  setSharedProjectSkyboxRoot,
  writeProjectAssetIndex,
} from './projectAssetStore.js';
import { scanModelPackage } from './modelPackageScanner.js';
import {
  createDataPlatformBinding,
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
  disposeDataPlatformModelSync,
  getLatestDataPlatformModelSyncProgress,
  retryDataPlatformModelSync,
  startDataPlatformModelSync,
} from './dataPlatformModelIncrementalSync.js';
import {
  clearDataPlatformEnvironmentSyncRetryContext,
  createDataPlatformSourceKey,
  disposeDataPlatformEnvironmentSync,
  getLatestDataPlatformEnvironmentSyncProgress,
  retryDataPlatformEnvironmentSync,
  startDataPlatformEnvironmentSync,
} from './dataPlatformEnvironmentSync.js';
import {
  clearDataPlatformImageSyncRetryContext,
  disposeDataPlatformImageSync,
  getLatestDataPlatformImageSyncProgress,
  listSyncedImages,
  retryDataPlatformImageSync,
  startDataPlatformImageSync,
} from './dataPlatformImageSync.js';
import {
  clearDataPlatformSkyboxSyncRetryContext,
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
const SCENE_PATH_KEYS = new Set(['sourcePath', 'packagePath', 'metadataPath', 'thumbnailPath', 'path']);
const SCENE_URL_KEYS = new Set(['sourceUrl', 'thumbnailUrl', 'activeVariantUrl']);
const SCENE_PATH_ARRAY_KEYS = new Set(['scriptPaths']);
const DIGITAL_TWIN_SOURCE_MANIFEST_PATH = '.babylon-editor/digital-twin-source-manifest.json';
const MAX_PROJECT_SCENE_FILES = 1_000;
const PROJECT_TEXT_HEAP_EXPANSION_FACTOR = 16n;
const MIN_FREE_HEAP_RESERVE_BYTES = 128n * 1024n * 1024n;

let dataPlatformProjectServiceShuttingDown = false;
const openTaskControllers = new Set<AbortController>();
const openTasks = new Set<Promise<unknown>>();

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

/** 把当前本地项目绑定到选定业务项目，不下载或覆盖远端 Editor 工程包。 */
export async function prepareDataPlatformProjectForPublish(
  project: DataPlatformProjectEntry,
  baseUrl: string,
  workspaceRoot: string,
): Promise<DataPlatformProjectOpenResult> {
  if (dataPlatformProjectServiceShuttingDown) {
    throw new Error('应用正在退出，无法绑定数字孪生发布项目。');
  }

  await ensureWritableEditorRoot(workspaceRoot);
  const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  const currentProjectRoot = getCurrentProjectRoot();
  const normalizedCurrentRoot = currentProjectRoot ? path.resolve(currentProjectRoot) : null;
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const projectRoot = normalizedCurrentRoot
    && !isSameFilePath(normalizedCurrentRoot, normalizedWorkspaceRoot)
    && !isSameFilePath(normalizedCurrentRoot, sharedResourcesRoot)
    ? normalizedCurrentRoot
    : resolveDataPlatformProjectRoot(workspaceRoot, project.id);
  await ensureWritableEditorRoot(projectRoot);
  await ensureProjectDirectories(projectRoot);
  if (!normalizedCurrentRoot || !isSameFilePath(normalizedCurrentRoot, projectRoot)) await activateProjectRoot(projectRoot);
  const existingBinding = await readDataPlatformBinding(projectRoot);
  if (existingBinding) throw new Error('当前场景已经绑定数据中台业务项目。');

  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  setSharedProjectAssetRoot(sharedResourcesRoot);
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);
  setSharedProjectSkyboxRoot(sharedResourcesRoot);

  const binding = createDataPlatformBinding({
    baseUrl,
    workspaceRoot,
    projectId: project.id,
    projectName: project.projectName,
    editorProjectId: project.latestEditorProjectId,
    latestVersionId: project.latestEditorProjectVersionId,
    latestVersionNumber: project.latestEditorProjectVersionNumber,
    resourceRevision: project.currentResourceRevision,
    entryScenePath: null,
    syncedAt: new Date().toISOString(),
  });
  await writeDataPlatformBinding(projectRoot, binding);
  setCurrentDataPlatformBinding(projectRoot, binding);
  invalidateDataPlatformSkyboxSyncPrepareContext();

  return {
    projectRoot,
    sceneFilePath: null,
    source: 'local',
    warning: null,
    conflictCopyPath: null,
    // 发布开始前不启动资源同步，避免缓存更新与 SOURCE/DIST 打包并发修改同一资源。
    modelSyncStarted: false,
    envModelSyncStarted: false,
    skyboxSyncStarted: false,
    binding,
  };
}

/** 从可信项目缓存打开工程，renderer 只允许提交项目 ID。 */
export async function openDataPlatformProject(
  project: DataPlatformProjectEntry,
  baseUrl: string,
  workspaceRoot: string,
): Promise<DataPlatformProjectOpenResult> {
  if (dataPlatformProjectServiceShuttingDown) {
    throw new Error('应用正在退出，无法打开数据中台项目。');
  }

  const controller = new AbortController();
  openTaskControllers.add(controller);
  const task = openDataPlatformProjectInternal(project, baseUrl, workspaceRoot, controller.signal);
  openTasks.add(task);

  try {
    return await task;
  } finally {
    openTaskControllers.delete(controller);
    openTasks.delete(task);
  }
}

/** 本地场景加载后只刷新共享资源缓存，不切换当前业务工程根目录。 */
export async function syncDataPlatformModelsForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
): Promise<boolean> {
  if (dataPlatformProjectServiceShuttingDown) return false;
  const binding = getCurrentDataPlatformBinding();
  if (!binding) {
    await ensureWritableEditorRoot(workspaceRoot);
    await activateProjectRoot(workspaceRoot);
    setSharedProjectAssetRoot(null);
    setSharedProjectEnvironmentRoot(workspaceRoot);
    return startDataPlatformModelSync(baseUrl, workspaceRoot);
  }
  const sharedResourcesRoot = resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata);
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  setSharedProjectAssetRoot(sharedResourcesRoot);
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);
  return startDataPlatformModelSync(binding.metadata.baseUrl, sharedResourcesRoot);
}


/** 打开任意编辑工作区时独立触发环境模型同步，不与普通/组合模型整批事务耦合。 */
export async function syncDataPlatformEnvironmentsForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
  expectedSourceKey?: string,
): Promise<boolean> {
  if (dataPlatformProjectServiceShuttingDown) return false;
  const binding = getCurrentDataPlatformBinding();
  const sharedResourcesRoot = binding
    ? resolveDataPlatformBindingSharedResourcesRoot(binding.projectRoot, binding.metadata)
    : workspaceRoot;
  const sourceBaseUrl = binding?.metadata.baseUrl ?? baseUrl;
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  setSharedProjectEnvironmentRoot(sharedResourcesRoot);
  return startDataPlatformEnvironmentSync(
    sourceBaseUrl,
    sharedResourcesRoot,
    createDataPlatformEnvironmentSyncContextKey(sourceBaseUrl, sharedResourcesRoot),
    expectedSourceKey,
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
    setSharedProjectAssetRoot(null);
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
}

async function openDataPlatformProjectInternal(
  project: DataPlatformProjectEntry,
  baseUrl: string,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<DataPlatformProjectOpenResult> {
  // 先校验用户配置的工作区本身，避免子目录创建失败时只暴露晦涩的 ENOTDIR。
  await ensureWritableEditorRoot(workspaceRoot);
  const projectRoot = resolveDataPlatformProjectRoot(workspaceRoot, project.id);
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
  let sceneFilePath = await resolveLocalEntryScenePath(projectRoot, existingBinding?.entryScenePath ?? null);
  const remoteVersionId = project.latestEditorProjectVersionId;
  const canReuseLocalProject = Boolean(
    sceneFilePath
    && existingBinding
    && existingBinding.projectId === project.id
    && existingBinding.baseUrl === baseUrl
    && existingBinding.latestVersionId === remoteVersionId,
  );

  if (canReuseLocalProject || (!project.latestEditorProjectPackageUrl && sceneFilePath)) {
    source = 'local';
  } else if (project.latestEditorProjectPackageUrl) {
    if (sceneFilePath) {
      conflictCopyPath = await createLocalConflictCopy(workspaceRoot, projectRoot, project.id, existingBinding?.latestVersionId ?? null);
      warning = '检测到远端工程版本变化，已保留当前本地工程冲突副本，未执行自动合并。';
    }

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
        });
        source = 'package';
        sceneFilePath = materialized.sceneFilePath;
        warning = [warning, materialized.warning].filter(Boolean).join('；') || null;
      } else {
        warning = [warning, `${detection.reason}，已在本地创建当前格式空项目。`].filter(Boolean).join('；');
      }
    } catch (error) {
      preserveOpenRoot = error instanceof DataPlatformRollbackError;
      throw error;
    } finally {
      if (!preserveOpenRoot) await fs.rm(openRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  } else {
    warning = '该项目没有可用工程包，已在本地创建当前格式空项目。';
  }

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
  invalidateDataPlatformSkyboxSyncPrepareContext();
  setSharedProjectSkyboxRoot(sharedResourcesRoot);

  const modelSyncStarted = startDataPlatformModelSync(baseUrl, sharedResourcesRoot);
  const envModelSyncStarted = startDataPlatformEnvironmentSync(
    baseUrl,
    sharedResourcesRoot,
    createDataPlatformEnvironmentSyncContextKey(baseUrl, sharedResourcesRoot),
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
/** 优先读取绑定入口场景，缺失时回退到项目中的第一份场景。 */
async function resolveLocalEntryScenePath(projectRoot: string, entryScenePath: string | null): Promise<string | null> {
  if (entryScenePath) {
    const candidate = path.resolve(projectRoot, ...entryScenePath.split('/'));
    if (isPathInside(projectRoot, candidate) && await isFile(candidate)) return candidate;
  }
  const sceneFiles = await findSceneFiles(projectRoot);
  return sceneFiles.sort((left, right) => left.localeCompare(right, 'en'))[0] ?? null;
}

/** 远端版本变化时保留完整本地源工程副本，不尝试自动合并。 */
async function createLocalConflictCopy(
  workspaceRoot: string,
  projectRoot: string,
  projectId: string,
  versionId: string | null,
): Promise<string> {
  const conflictParent = path.join(path.resolve(workspaceRoot), 'Conflicts', projectId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const conflictRoot = path.join(conflictParent, `${timestamp}-version-${versionId ?? 'local'}`);
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
      if (!isPlainObject(parsed) || (sceneVersion !== 1 && sceneVersion !== 2 && sceneVersion !== 3) || !isPlainObject(parsed.scene)) {
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
  entrySceneSourcePath: string;
  project: DataPlatformProjectEntry;
  openRoot: string;
}): Promise<{ sceneFilePath: string; warning: string | null }> {
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
  const entrySceneTargetPath = sceneTargets.get(path.resolve(options.entrySceneSourcePath));
  if (!entrySceneTargetPath) throw new Error('工程包入口场景未能物化。');

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
      sceneFilePath: entrySceneTargetPath,
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
  const rewritten = rewriteSceneValue(parsed, null, editorRoot);
  return `${JSON.stringify(rewritten, null, 2)}\n`;
}

async function readProjectPackageJson(filePath: string, label: string): Promise<unknown> {
  const fileSize = await readProjectPackageTextFileSize(filePath, label);
  assertProjectPackageHeapCapacity(fileSize, `${label}“${path.basename(filePath)}”`);
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
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

function rewriteSceneValue(value: unknown, key: string | null, editorRoot: string): unknown {
  if (typeof value === 'string') {
    if (key && SCENE_URL_KEYS.has(key)) return rewriteSceneAssetUrl(value, editorRoot);
    if (key && SCENE_PATH_KEYS.has(key)) return rewriteSceneAssetPath(value, editorRoot) ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    if (key && SCENE_PATH_ARRAY_KEYS.has(key)) {
      return value.map((item) => typeof item === 'string' ? rewriteSceneAssetPath(item, editorRoot) ?? item : item);
    }
    return value.map((item) => rewriteSceneValue(item, key, editorRoot));
  }
  if (!isPlainObject(value)) return value;

  const rewritten: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    rewritten[childKey] = rewriteSceneValue(childValue, childKey, editorRoot);
  }
  return rewritten;
}

function rewriteSceneAssetUrl(value: string, editorRoot: string): string {
  if (!value.startsWith(LOCAL_ASSET_URL_PREFIX)) return value;
  try {
    const decoded = decodeURIComponent(value.slice(LOCAL_ASSET_URL_PREFIX.length));
    const rewrittenPath = rewriteSceneAssetPath(decoded, editorRoot);
    return rewrittenPath ? encodeAssetUrl(rewrittenPath) : value;
  } catch {
    return value;
  }
}

function rewriteSceneAssetPath(value: string, editorRoot: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(Assets\/(?:Models|Environments|Skyboxes)(?:\/.*|$))/i);
  if (!match) return null;
  const relativeAssetPath = path.posix.normalize(match[1]);
  if (!/^Assets\/(?:Models|Environments|Skyboxes)(?:\/|$)/i.test(relativeAssetPath)) return null;
  const targetPath = path.resolve(editorRoot, ...relativeAssetPath.split('/'));
  return isPathInside(editorRoot, targetPath) ? targetPath : null;
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
