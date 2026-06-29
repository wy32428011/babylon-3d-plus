import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import type {
  LoadSceneResult,
  ProjectListAssetsResult,
  ReadTextFileRequest,
  ReadTextFileResult,
  SaveSceneRequest,
  SaveSceneResult,
  SelectProjectDirectoryResult,
} from '../types.js';
import { authorizeAssetFile, authorizeSceneFile, isAuthorizedSceneFile, normalizeFilePath } from './assetRegistry.js';
import { ensureCurrentProjectRootWithDialog, listProjectAssets } from './projectAssetStore.js';

type SaveSceneRequestShape = {
  suggestedName?: unknown;
  content?: unknown;
};

type ReadTextFileRequestShape = {
  filePath?: unknown;
};

type SceneModelAssetShape = {
  sourcePath?: unknown;
};

export function registerProjectIpc(): void {
  ipcMain.handle('project:listAssets', async (): Promise<ProjectListAssetsResult> => {
    return listProjectAssets();
  });

  ipcMain.handle('project:selectDirectory', async (): Promise<SelectProjectDirectoryResult> => {
    const projectRoot = await ensureCurrentProjectRootWithDialog();
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

    return { canceled: false, filePath, content };
  });

  ipcMain.handle('file:readText', async (_event, request: ReadTextFileRequest): Promise<ReadTextFileResult> => {
    const readRequest = validateReadTextFileRequest(request);
    const content = await fs.readFile(readRequest.filePath, 'utf-8');
    authorizeModelAssetsFromSceneContent(content);

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

function authorizeModelAssetsFromSceneContent(content: string): void {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.scene)) return;
    if (!isPlainObject(parsed.scene.entities)) return;

    for (const entity of Object.values(parsed.scene.entities)) {
      if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
      const modelAsset = entity.components.modelAsset as SceneModelAssetShape | undefined;
      if (!isPlainObject(modelAsset) || typeof modelAsset.sourcePath !== 'string') continue;

      const sourcePath = normalizeFilePath(modelAsset.sourcePath);
      const extension = sourcePath.toLowerCase();
      if (extension.endsWith('.gltf') || extension.endsWith('.glb')) {
        authorizeAssetFile(sourcePath);
      }
    }
  } catch {
    // 场景内容的完整格式校验由 renderer 的 SceneSerializer 负责；这里失败时只是不额外授权模型文件。
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
