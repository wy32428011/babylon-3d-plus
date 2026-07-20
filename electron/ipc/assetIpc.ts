import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AssetEntry,
  ImportCadFileResult,
  ImportEnvironmentModelFileResult,
  ImportModelFolderRequest,
  ImportModelFolderResult,
  ListModelPackageVariantsRequest,
  ModelPackageVariant,
} from '../types.js';
import { authorizeAssetFile, authorizeAssetRoot, authorizeSceneFile, encodeAssetUrl, isPathInsideAuthorizedAssetRoot } from './assetRegistry.js';
import { listModelPackageVariants, scanModelFolder } from './modelPackageScanner.js';
import {
  ensureCurrentProjectRootWithDialog,
  getCurrentProjectRoot,
  importEnvironmentModelFileIntoProject,
  importModelPackagesIntoProject,
} from './projectAssetStore.js';

function getAssetKind(filePath: string, isDirectory: boolean): AssetEntry['kind'] {
  if (isDirectory) {
    return 'folder';
  }

  const normalizedPath = filePath.toLowerCase();

  if (normalizedPath.endsWith('.scene.json')) {
    return 'scene';
  }

  const extension = path.extname(normalizedPath);

  if (extension === '.glb' || extension === '.gltf') {
    return 'model';
  }

  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.webp') {
    return 'texture';
  }

  return 'unknown';
}

/** 普通模型文件夹入口只允许写入模型库，环境模型必须改走单 GLB 文件入口。 */
function normalizeImportModelLibraryKind(request: ImportModelFolderRequest | undefined): 'model' {
  const libraryKind = (request as { libraryKind?: unknown } | undefined)?.libraryKind;

  if (libraryKind === 'model') return libraryKind;
  if (libraryKind === 'environment') throw new Error('环境模型请直接选择 GLB 文件导入。');

  throw new Error('请选择有效的模型资产库分类。');
}

export function registerAssetIpc(): void {
  ipcMain.handle('assets:scan', async (): Promise<AssetEntry[]> => {
    const result = await dialog.showOpenDialog({
      title: '选择 Assets 目录',
      properties: ['openDirectory'],
    });

    const [root] = result.filePaths;

    if (result.canceled || !root) {
      return [];
    }

    authorizeAssetRoot(root);
    const entries = await fs.readdir(root, { withFileTypes: true });

    return entries.map((entry) => {
      const fullPath = path.join(root, entry.name);
      const kind = getAssetKind(fullPath, entry.isDirectory());

      if (kind === 'scene') {
        authorizeSceneFile(fullPath);
      }

      return {
        id: fullPath,
        name: entry.name,
        path: fullPath,
        sourceUrl: kind === 'model' ? encodeAssetUrl(fullPath) : '',
        kind,
      };
    });
  });

  ipcMain.handle('assets:importCadFile', async (): Promise<ImportCadFileResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择 CAD DXF 图纸',
      properties: ['openFile'],
      filters: [{ name: 'CAD DXF', extensions: ['dxf'] }],
    });

    const [filePath] = result.filePaths;

    if (result.canceled || !filePath) {
      return { canceled: true, filePath: null, sourceUrl: null, fileSizeBytes: 0 };
    }

    if (path.extname(filePath).toLowerCase() !== '.dxf') {
      throw new Error('仅支持导入 .dxf CAD 图纸。');
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('请选择有效的 DXF 文件。');
    }

    authorizeAssetFile(filePath);

    return {
      canceled: false,
      filePath,
      sourceUrl: encodeAssetUrl(filePath),
      fileSizeBytes: stat.size,
    };
  });

  /** 导入单个环境 GLB：用户选择文件，项目内仍保存为独立单文件环境包。 */
  ipcMain.handle('assets:importEnvironmentModelFile', async (): Promise<ImportEnvironmentModelFileResult> => {
    const projectRoot = await ensureCurrentProjectRootWithDialog();

    if (!projectRoot) {
      return { canceled: true, filePath: null, projectRoot: null, importedAsset: null, projectAssets: [] };
    }

    const result = await dialog.showOpenDialog({
      title: '选择环境 GLB 模型',
      properties: ['openFile'],
      filters: [{ name: 'GLB 环境模型', extensions: ['glb'] }],
    });
    const [filePath] = result.filePaths;

    if (result.canceled || !filePath) {
      return { canceled: true, filePath: null, projectRoot, importedAsset: null, projectAssets: [] };
    }

    if (path.extname(filePath).toLowerCase() !== '.glb') {
      throw new Error('环境模型仅支持直接导入 .glb 文件。');
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('请选择有效的环境 GLB 文件。');
    }

    const { importedAsset, projectAssets } = await importEnvironmentModelFileIntoProject(filePath);
    return {
      canceled: false,
      filePath,
      projectRoot: getCurrentProjectRoot(),
      importedAsset,
      projectAssets,
    };
  });

  /** 导入普通模型文件夹；环境模型文件夹请求会在边界处被拒绝。 */
  ipcMain.handle('assets:importModelFolder', async (_event, request?: ImportModelFolderRequest): Promise<ImportModelFolderResult> => {
    const libraryKind = normalizeImportModelLibraryKind(request);
    const projectRoot = await ensureCurrentProjectRootWithDialog();

    if (!projectRoot) {
      return { canceled: true, rootPath: null, projectRoot: null, importedAssets: [], projectAssets: [], skipped: [] };
    }

    const result = await dialog.showOpenDialog({
      title: '选择模型文件夹',
      properties: ['openDirectory'],
    });

    const [rootPath] = result.filePaths;

    if (result.canceled || !rootPath) {
      return { canceled: true, rootPath: null, projectRoot, importedAssets: [], projectAssets: [], skipped: [] };
    }

    authorizeAssetRoot(rootPath);
    const { assets: scannedAssets, skipped: scanSkipped } = await scanModelFolder(rootPath);
    const { importedAssets, projectAssets, skipped: copySkipped } = await importModelPackagesIntoProject(scannedAssets, libraryKind);

    return {
      canceled: false,
      rootPath,
      projectRoot: getCurrentProjectRoot(),
      importedAssets,
      projectAssets,
      skipped: [...scanSkipped, ...copySkipped],
    };
  });

  /** 只允许枚举已由用户选择或项目加载授权过的模型包目录。 */
  ipcMain.handle(
    'assets:listModelPackageVariants',
    async (_event, request: ListModelPackageVariantsRequest): Promise<ModelPackageVariant[]> => {
      const packagePath = path.resolve(request.packagePath);
      if (!isPathInsideAuthorizedAssetRoot(packagePath)) {
        throw new Error('模型包目录未经过当前会话授权，拒绝枚举。');
      }
      const stat = await fs.stat(packagePath);

      if (!stat.isDirectory()) {
        throw new Error('请选择有效的模型包目录。');
      }

      return listModelPackageVariants(packagePath);
    },
  );
}
