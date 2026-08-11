import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  LoadSceneFileRequest,
  LoadSceneResult,
  OpenRecentProjectRequest,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  ReadTextFileResult,
  RecentWorkspacesResult,
  RemoveRecentWorkspaceItemRequest,
  SaveSceneRequest,
  SaveSceneResult,
  SelectProjectDirectoryResult,
} from '../types.js';
import { authorizeAssetFile, authorizeSceneFile, isAuthorizedSceneFile, normalizeFilePath } from './assetRegistry.js';
import { isSupportedSceneFilePath } from './sceneFilePath.js';
import {
  assertRecentSceneFile,
  commitRecentProjectActivation,
  getProjectAssetStoreStateSnapshot,
  getRecentWorkspaces,
  listProjectAssets,
  rememberRecentSceneFile,
  restoreProjectAssetStoreState,
  removeRecentWorkspaceItem,
  selectCurrentProjectRootWithDialog,
  setSharedProjectAssetRoot,
  setSharedProjectSkyboxRoot,
  validateRecentProjectRoot,
} from './projectAssetStore.js';
import {
  clearCurrentDataPlatformBinding,
  getCurrentDataPlatformBinding,
  readDataPlatformBinding,
  resolveDataPlatformSharedResourcesRoot,
  setCurrentDataPlatformBinding,
} from './dataPlatformBindingStore.js';
import {
  invalidateDataPlatformSkyboxSyncPrepareContext,
  syncDataPlatformSkyboxesForWorkspace,
} from './dataPlatformProjectService.js';

type SaveSceneRequestShape = {
  suggestedName?: unknown;
  content?: unknown;
};

type ReadTextFileRequestShape = {
  filePath?: unknown;
};

type OpenRecentProjectRequestShape = {
  projectRoot?: unknown;
};

type RemoveRecentWorkspaceItemRequestShape = {
  kind?: unknown;
  path?: unknown;
};

type SceneModelAssetShape = {
  sourcePath?: unknown;
  scriptAssets?: unknown;
};

type SceneCadReferenceShape = {
  sourcePath?: unknown;
};

export function registerProjectIpc(): void {
  ipcMain.handle('project:getRecentWorkspaces', async (): Promise<RecentWorkspacesResult> => {
    return getRecentWorkspaces();
  });

  ipcMain.handle('project:listAssets', async (): Promise<ProjectListAssetsResult> => {
    return listProjectAssets();
  });

  ipcMain.handle('project:openRecent', async (_event, request: OpenRecentProjectRequest): Promise<ProjectListAssetsResult> => {
    const openRequest = validateOpenRecentProjectRequest(request);
    const projectRoot = await validateRecentProjectRoot(openRequest.projectRoot);
    const projectStateSnapshot = getProjectAssetStoreStateSnapshot();
    const bindingSnapshot = getCurrentDataPlatformBinding();
    invalidateDataPlatformSkyboxSyncPrepareContext();
    setSharedProjectAssetRoot(null);
    setSharedProjectSkyboxRoot(null);
    clearCurrentDataPlatformBinding();

    try {
      await commitRecentProjectActivation(projectRoot);
      const binding = await readDataPlatformBinding(projectRoot);
      let workspaceRoot: string | null = null;
      if (binding) {
        workspaceRoot = resolveWorkspaceRootFromDataPlatformProject(projectRoot, binding.projectId);
        const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
        setSharedProjectAssetRoot(sharedResourcesRoot);
        setSharedProjectSkyboxRoot(sharedResourcesRoot);
      }

      const result = await listProjectAssets();
      if (binding && workspaceRoot) {
        setCurrentDataPlatformBinding(projectRoot, binding);
        void syncDataPlatformSkyboxesForWorkspace(binding.baseUrl, workspaceRoot).catch((error) => {
          console.error('[electron] 最近数据中台项目天空盒同步启动失败。', error);
        });
      }
      return result;
    } catch (error) {
      try {
        await restoreProjectAssetStoreState(projectStateSnapshot);
      } finally {
        if (bindingSnapshot) {
          setCurrentDataPlatformBinding(bindingSnapshot.projectRoot, bindingSnapshot.metadata);
        } else {
          clearCurrentDataPlatformBinding();
        }
      }
      throw error;
    }
  });

  ipcMain.handle('project:removeRecentWorkspaceItem', async (_event, request: RemoveRecentWorkspaceItemRequest): Promise<void> => {
    const removeRequest = validateRemoveRecentWorkspaceItemRequest(request);
    await removeRecentWorkspaceItem(removeRequest.kind, removeRequest.path);
  });

  ipcMain.handle('project:selectDirectory', async (): Promise<SelectProjectDirectoryResult> => {
    const projectRoot = await selectCurrentProjectRootWithDialog();
    if (projectRoot) {
      invalidateDataPlatformSkyboxSyncPrepareContext();
      setSharedProjectAssetRoot(null);
      setSharedProjectSkyboxRoot(null);
      clearCurrentDataPlatformBinding();
    }
    return { canceled: projectRoot === null, projectRoot };
  });

  ipcMain.handle('scene:save', async (_event, request: SaveSceneRequest): Promise<SaveSceneResult> => {
    const saveRequest = validateSaveSceneRequest(request);
    const result = await dialog.showSaveDialog({
      defaultPath: saveRequest.suggestedName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true, filePath: null };
    }

    await fs.writeFile(result.filePath, saveRequest.content, 'utf-8');
    authorizeSceneFile(result.filePath);
    authorizeModelAssetsFromSceneContent(saveRequest.content);
    await rememberRecentSceneFile(result.filePath);

    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('scene:load', async (): Promise<LoadSceneResult> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    const [filePath] = result.filePaths;

    if (result.canceled || !filePath) {
      return { canceled: true, filePath: null, content: null };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    authorizeSceneFile(filePath);
    authorizeModelAssetsFromSceneContent(content);
    await rememberRecentSceneFile(filePath);

    return { canceled: false, filePath, content };
  });

  ipcMain.handle('scene:loadFile', async (_event, request: LoadSceneFileRequest): Promise<LoadSceneResult> => {
    const loadRequest = validateLoadSceneFileRequest(request);
    const filePath = await assertRecentSceneFile(loadRequest.filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    authorizeSceneFile(filePath);
    authorizeModelAssetsFromSceneContent(content);
    await rememberRecentSceneFile(filePath);

    return { canceled: false, filePath, content };
  });

  ipcMain.handle('file:readText', async (_event, request: ReadTextFileRequest): Promise<ReadTextFileResult> => {
    const readRequest = validateReadTextFileRequest(request);
    const content = await fs.readFile(readRequest.filePath, 'utf-8');
    authorizeModelAssetsFromSceneContent(content);
    await rememberRecentSceneFile(readRequest.filePath);

    return { filePath: readRequest.filePath, content };
  });
}

function resolveWorkspaceRootFromDataPlatformProject(projectRoot: string, projectId: string): string {
  const normalizedProjectRoot = normalizeFilePath(projectRoot);
  const projectsRoot = path.dirname(normalizedProjectRoot);
  if (path.basename(projectsRoot).toLowerCase() !== 'projects' || path.basename(normalizedProjectRoot) !== projectId) {
    throw new Error('本地数据中台项目工作区结构无效。');
  }
  return path.dirname(projectsRoot);
}

function validateSaveSceneRequest(request: SaveSceneRequest): SaveSceneRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('保存场景请求格式不正确。');
  }

  const candidate = request as SaveSceneRequestShape;

  if (typeof candidate.suggestedName !== 'string' || typeof candidate.content !== 'string') {
    throw new Error('保存场景请求格式不正确。');
  }

  return {
    suggestedName: candidate.suggestedName,
    content: candidate.content,
  };
}

function validateLoadSceneFileRequest(request: LoadSceneFileRequest): LoadSceneFileRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('加载场景文件请求格式不正确。');
  }

  const candidate = request as ReadTextFileRequestShape;

  if (typeof candidate.filePath !== 'string') {
    throw new Error('加载场景文件请求格式不正确。');
  }

  const filePath = normalizeFilePath(candidate.filePath);
  if (!isSupportedSceneFilePath(filePath)) {
    throw new Error('仅支持加载 .json 场景文件。');
  }

  return { filePath };
}

function validateReadTextFileRequest(request: ReadTextFileRequest): ReadTextFileRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('读取文件请求格式不正确。');
  }

  const candidate = request as ReadTextFileRequestShape;

  if (typeof candidate.filePath !== 'string') {
    throw new Error('读取文件请求格式不正确。');
  }

  const filePath = normalizeFilePath(candidate.filePath);
  if (!filePath.toLowerCase().endsWith('.scene.json') || !isAuthorizedSceneFile(filePath)) {
    throw new Error('仅支持读取已授权的 .scene.json 场景文件。');
  }

  return { filePath };
}

function validateOpenRecentProjectRequest(request: OpenRecentProjectRequest): OpenRecentProjectRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('打开最近项目请求格式不正确。');
  }

  const candidate = request as OpenRecentProjectRequestShape;
  if (typeof candidate.projectRoot !== 'string' || !candidate.projectRoot.trim()) {
    throw new Error('打开最近项目请求格式不正确。');
  }

  return { projectRoot: normalizeFilePath(candidate.projectRoot) };
}

function validateRemoveRecentWorkspaceItemRequest(
  request: RemoveRecentWorkspaceItemRequest,
): RemoveRecentWorkspaceItemRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('移除最近记录请求格式不正确。');
  }

  const candidate = request as RemoveRecentWorkspaceItemRequestShape;
  if ((candidate.kind !== 'project' && candidate.kind !== 'scene') || typeof candidate.path !== 'string') {
    throw new Error('移除最近记录请求格式不正确。');
  }

  return {
    kind: candidate.kind,
    path: normalizeFilePath(candidate.path),
  };
}

/** 从用户明确保存或打开的场景中登记模型、生成器、环境、天空盒、脚本和 CAD 文件授权。 */
function authorizeModelAssetsFromSceneContent(content: string): void {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed) || !isSupportedSceneFileVersion(parsed.version) || !isPlainObject(parsed.scene)) return;

    if (isPlainObject(parsed.scene.entities)) {
      for (const entity of Object.values(parsed.scene.entities)) {
        if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
        authorizeSceneModelAsset(entity.components.modelAsset);
        authorizeSceneModelGenerator(entity.components.modelGenerator);
        authorizeSceneSkyboxFile(entity.components.skybox);

        const cadReference = entity.components.cadReference as SceneCadReferenceShape | undefined;
        if (!isPlainObject(cadReference) || typeof cadReference.sourcePath !== 'string') continue;
        const cadPath = normalizeFilePath(cadReference.sourcePath);
        if (cadPath.toLowerCase().endsWith('.dxf')) authorizeAssetFile(cadPath);
      }
    }

    if (isPlainObject(parsed.scene.sceneSettings)) {
      if (isPlainObject(parsed.scene.sceneSettings.environment)) {
        const variants = parsed.scene.sceneSettings.environment.variants;
        if (Array.isArray(variants)) {
          for (const variant of variants) {
            if (!isPlainObject(variant) || typeof variant.sourcePath !== 'string') continue;
            authorizeSceneModelFile(variant.sourcePath);
          }
        }
      }

      authorizeSceneSkyboxFile(parsed.scene.sceneSettings.skybox);
    }
  } catch {
    // 场景内容的完整格式校验由 renderer 的 SceneSerializer 负责；这里失败时只是不额外授权资源文件。
  }
}

/** 判断文件路径是否为可执行 TypeScript 模型脚本，声明文件不会获得运行时读取授权。 */
function isRuntimeModelScriptPath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return normalizedPath.endsWith('.ts') && !normalizedPath.endsWith('.d.ts');
}

/** 登记普通模型资产及其外置 TypeScript 脚本。 */
function authorizeSceneModelAsset(value: unknown): void {
  const modelAsset = value as SceneModelAssetShape | undefined;
  if (!isPlainObject(modelAsset)) return;
  if (typeof modelAsset.sourcePath === 'string') authorizeSceneModelFile(modelAsset.sourcePath);
  if (!Array.isArray(modelAsset.scriptAssets)) return;

  for (const scriptAsset of modelAsset.scriptAssets) {
    if (!isPlainObject(scriptAsset) || typeof scriptAsset.path !== 'string') continue;
    const scriptPath = normalizeFilePath(scriptAsset.path);
    if (isRuntimeModelScriptPath(scriptPath)) authorizeAssetFile(scriptPath);
  }
}

/** 登记模型生成器默认目标和全部规则目标中的模型资产。 */
function authorizeSceneModelGenerator(value: unknown): void {
  if (!isPlainObject(value)) return;
  authorizeSceneModelGeneratorTarget(value.defaultTarget);
  if (!Array.isArray(value.rules)) return;
  for (const rule of value.rules) {
    if (isPlainObject(rule)) authorizeSceneModelGeneratorTarget(rule.target);
  }
}

/** 登记单个模型生成器 model 目标；基础 mesh 目标无需本地文件授权。 */
function authorizeSceneModelGeneratorTarget(value: unknown): void {
  if (!isPlainObject(value) || value.kind !== 'model') return;
  authorizeSceneModelAsset(value.modelAsset);
}

/** 按模型/环境允许的扩展名登记单个本地文件。 */
function authorizeSceneModelFile(value: string): void {
  const sourcePath = normalizeFilePath(value);
  const extension = sourcePath.toLowerCase();
  if (extension.endsWith('.gltf') || extension.endsWith('.glb')) authorizeAssetFile(sourcePath);
}

/** 只授权格式声明与扩展名一致的本地 HDR/EXR 天空盒文件。 */
function authorizeSceneSkyboxFile(value: unknown): void {
  if (!isPlainObject(value) || typeof value.sourcePath !== 'string') return;
  if (value.format !== 'hdr' && value.format !== 'exr') return;
  const sourcePath = normalizeFilePath(value.sourcePath);
  const expectedExtension = value.format === 'hdr' ? '.hdr' : '.exr';
  if (sourcePath.toLowerCase().endsWith(expectedExtension)) authorizeAssetFile(sourcePath);
}

/** 与 renderer SceneSerializer 支持的版本保持一致（v1 原始版、v2 绑定反转、v3 fetchDrive）；版本不符时不做资源授权。 */
function isSupportedSceneFileVersion(version: unknown): boolean {
  return version === 1 || version === 2 || version === 3;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
