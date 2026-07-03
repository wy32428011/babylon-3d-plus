import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
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
import {
  assertRecentSceneFile,
  getRecentWorkspaces,
  listProjectAssets,
  openRecentProject,
  rememberRecentSceneFile,
  removeRecentWorkspaceItem,
  selectCurrentProjectRootWithDialog,
} from './projectAssetStore.js';

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
    return openRecentProject(openRequest.projectRoot);
  });

  ipcMain.handle('project:removeRecentWorkspaceItem', async (_event, request: RemoveRecentWorkspaceItemRequest): Promise<void> => {
    const removeRequest = validateRemoveRecentWorkspaceItemRequest(request);
    await removeRecentWorkspaceItem(removeRequest.kind, removeRequest.path);
  });

  ipcMain.handle('project:selectDirectory', async (): Promise<SelectProjectDirectoryResult> => {
    const projectRoot = await selectCurrentProjectRootWithDialog();
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
  if (!filePath.toLowerCase().endsWith('.scene.json')) {
    throw new Error('仅支持加载 .scene.json 场景文件。');
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

function authorizeModelAssetsFromSceneContent(content: string): void {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.scene)) return;
    if (!isPlainObject(parsed.scene.entities)) return;

    for (const entity of Object.values(parsed.scene.entities)) {
      if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
      const modelAsset = entity.components.modelAsset as SceneModelAssetShape | undefined;
      if (isPlainObject(modelAsset) && typeof modelAsset.sourcePath === 'string') {
        const sourcePath = normalizeFilePath(modelAsset.sourcePath);
        const extension = sourcePath.toLowerCase();
        if (extension.endsWith('.gltf') || extension.endsWith('.glb')) {
          authorizeAssetFile(sourcePath);
        }

        if (Array.isArray(modelAsset.scriptAssets)) {
          for (const scriptAsset of modelAsset.scriptAssets) {
            if (!isPlainObject(scriptAsset) || typeof scriptAsset.path !== 'string') continue;
            const scriptPath = normalizeFilePath(scriptAsset.path);
            if (scriptPath.toLowerCase().endsWith('.model.ts')) {
              authorizeAssetFile(scriptPath);
            }
          }
        }
      }

      const cadReference = entity.components.cadReference as SceneCadReferenceShape | undefined;
      if (!isPlainObject(cadReference) || typeof cadReference.sourcePath !== 'string') continue;

      const cadPath = normalizeFilePath(cadReference.sourcePath);
      if (cadPath.toLowerCase().endsWith('.dxf')) {
        authorizeAssetFile(cadPath);
      }
    }
  } catch {
    // 场景内容的完整格式校验由 renderer 的 SceneSerializer 负责；这里失败时只是不额外授权模型文件。
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
