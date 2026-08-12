import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DigitalTwinPublishContext,
  DigitalTwinPublishProgress,
  DigitalTwinPublishRequest,
  DigitalTwinPublishResult,
} from '../types.js';
import { authorizeSceneFile } from './assetRegistry.js';
import {
  getCurrentDataPlatformBinding,
  resolveDataPlatformSharedResourcesRoot,
  type DataPlatformBindingMetadata,
  updateDataPlatformBinding,
} from './dataPlatformBindingStore.js';
import { buildDigitalTwinDistPackage } from './digitalTwinDistPackage.js';
import { collectDigitalTwinResourceIds } from './digitalTwinPublishProtocol.js';
import { listIndexedDataPlatformEnvironments } from './dataPlatformEnvironmentIndex.js';
import { buildDigitalTwinSourcePackage, type DigitalTwinSourcePackageResult } from './digitalTwinSourcePackage.js';
import { findSyncedImageForReference, isPlatformImageReference } from './dataPlatformImageSync.js';
import {
  DigitalTwinApiError,
  DigitalTwinUploadClient,
  type DigitalTwinPublishTask,
  type DigitalTwinProjectStatus,
} from './digitalTwinUploadClient.js';
import { rememberRecentSceneFile } from './projectAssetStore.js';
import { createDeploymentSkyboxValidationCache, loadDeploymentSkyboxCacheContext } from './deploymentSkyboxCache.js';
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
]);

export type DigitalTwinPublishProgressHandler = (progress: DigitalTwinPublishProgress) => void;

/** 查询当前绑定与远端版本，renderer 不需要也不能自行提交项目 ID 或 Base URL。 */
export async function getDigitalTwinPublishContext(signal = new AbortController().signal): Promise<DigitalTwinPublishContext> {
  const current = getCurrentDataPlatformBinding();
  if (!current) return emptyPublishContext();
  const client = new DigitalTwinUploadClient(current.metadata.baseUrl);
  const remote = await client.projectStatus(current.metadata.projectId, signal);
  return createPublishContext(current.projectRoot, current.metadata, remote, false);
}

/** 发布活动期间只读取本地绑定，避免网络异常掩盖全局发布锁。 */
export function getLocalDigitalTwinPublishContext(publishActive: boolean): DigitalTwinPublishContext {
  const current = getCurrentDataPlatformBinding();
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
  const current = getCurrentDataPlatformBinding();
  if (!current) throw new Error('当前工程未绑定数据中台业务项目，无法发布。');
  const client = new DigitalTwinUploadClient(current.metadata.baseUrl);
  const remote = await client.projectStatus(current.metadata.projectId, signal);
  const context = createPublishContext(current.projectRoot, current.metadata, remote, true);
  if (context.overwriteConfirmationRequired && !validated.overwriteExisting) {
    return createTerminalResult(validated.requestId, 'confirmation-required', {
      errorCode: 'DIGITAL_TWIN_OVERWRITE_CONFIRM_REQUIRED',
      message: '目标业务项目已经有当前数字孪生工程，请确认覆盖后再发布。',
    });
  }

  if (!context.versionConflict) {
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

  emit(onProgress, validated.requestId, 'saving', '正在保存当前场景…', 2);
  const savedScene = await saveCurrentScene(current.projectRoot, current.metadata.entryScenePath, validated.sceneContent);
  await updateDataPlatformBinding(current.projectRoot, current.metadata.projectId, { entryScenePath: savedScene.entryScenePath });

  const workspaceRoot = resolveWorkspaceRoot(current.projectRoot, current.metadata.projectId);
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
      isPlatformImageReference,
      findSyncedImageForReference,
      onProgress: (detail, completedFiles, totalFiles) => {
        const ratio = totalFiles > 0 ? completedFiles / totalFiles : 0;
        emit(onProgress, validated.requestId, 'source-package', detail, 6 + ratio * 22);
      },
    });
    appendUniqueWarnings(warnings, sourcePackage.warnings);

    if (context.versionConflict) {
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
      publishName: validated.publishName,
      sceneContent: validated.sceneContent,
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
    const resourceIds = collectDigitalTwinResourceIds(sourcePackage.sceneContents);
    await validateDataPlatformEnvironmentPublishReferences(
      workspaceRoot,
      current.metadata.baseUrl,
      resourceIds.envModelIds,
      signal,
    );

    emit(onProgress, validated.requestId, 'prepare', '正在创建数据中台发布任务…', 50);
    try {
      remoteTask = await client.prepare({
        requestId: validated.requestId,
        projectId: current.metadata.projectId,
        baseVersionId: current.metadata.latestVersionId,
        overwriteExisting: validated.overwriteExisting,
        publishName: validated.publishName,
        remark: validated.remark || null,
        entryScenePath: sourcePackage.entryScenePath,
        entrySceneName: sourcePackage.entrySceneName,
        manifestJson: sourcePackage.manifestJson,
        resourceRevision: current.metadata.resourceRevision,
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

async function saveCurrentScene(
  projectRoot: string,
  entryScenePath: string | null,
  sceneContent: string,
): Promise<{ filePath: string; entryScenePath: string }> {
  if (Buffer.byteLength(sceneContent, 'utf8') > MAX_SCENE_CONTENT_BYTES) throw new Error('当前场景超过 64 MiB 发布上限。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sceneContent) as unknown;
  } catch {
    throw new Error('当前场景不是有效 JSON。');
  }
  if (!isPlainObject(parsed) || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) || !isPlainObject(parsed.scene)) {
    throw new Error('当前场景格式不受支持。');
  }
  if (isPlainObject(parsed.scene.fetchConfig) && typeof parsed.scene.fetchConfig.apiKey === 'string' && parsed.scene.fetchConfig.apiKey.trim()) {
    throw new Error('可信内网数字孪生发布不携带 API Key，请先清空场景 Fetch API Key。');
  }
  const sceneName = typeof parsed.scene.name === 'string' && parsed.scene.name.trim() ? parsed.scene.name.trim() : 'main';
  const relativePath = entryScenePath ?? `Scenes/${createSafeSceneFileName(sceneName)}.scene.json`;
  const filePath = path.resolve(projectRoot, ...relativePath.replace(/\\/g, '/').split('/'));
  if (!isPathInside(projectRoot, filePath)) throw new Error('入口场景路径超出当前项目目录。');
  await ensureSafeDirectoryWithin(projectRoot, path.dirname(filePath), '入口场景目录');
  const temporaryPath = `${filePath}.publish-save-${randomUUID()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
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

function resolveWorkspaceRoot(projectRoot: string, projectId: string): string {
  const projectsRoot = path.dirname(path.resolve(projectRoot));
  if (path.basename(projectsRoot).toLowerCase() !== 'projects' || path.basename(projectRoot) !== projectId) {
    throw new Error('当前数据中台项目工作区结构无效。');
  }
  return path.dirname(projectsRoot);
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
    requestId: request.requestId,
    publishName: request.publishName.trim(),
    remark: request.remark.trim(),
    sceneContent: request.sceneContent,
    overwriteExisting: request.overwriteExisting === true,
    confirmResourceBindings: request.confirmResourceBindings === true,
    allowedParentOrigins: normalizeDigitalTwinAllowedParentOrigins(request.allowedParentOrigins),
  };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
