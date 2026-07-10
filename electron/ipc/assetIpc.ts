import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AssetEntry,
  ImportCadFileResult,
  ImportModelFolderRequest,
  ImportModelFolderResult,
  ListModelPackageVariantsRequest,
  ModelAssetLibraryKind,
  ModelPackageVariant,
} from '../types.js';
import { authorizeAssetFile, authorizeAssetRoot, authorizeSceneFile, encodeAssetUrl } from './assetRegistry.js';
import { listModelPackageVariants, scanModelFolder } from './modelPackageScanner.js';
import { ensureCurrentProjectRootWithDialog, getCurrentProjectRoot, importModelPackagesIntoProject } from './projectAssetStore.js';

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

/** 校验导入请求中的目标资产库分类，避免未知分类落错目录。 */
function normalizeImportModelLibraryKind(request: ImportModelFolderRequest | undefined): ModelAssetLibraryKind {
  const libraryKind = request?.libraryKind;

  if (libraryKind === 'model' || libraryKind === 'environment') {
    return libraryKind;
  }

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

  /** 导入模型文件夹：根据请求分类选择普通模型或环境模型资产库。 */
  ipcMain.handle('assets:importModelFolder', async (_event, request?: ImportModelFolderRequest): Promise<ImportModelFolderResult> => {
    const libraryKind = normalizeImportModelLibraryKind(request);
    const projectRoot = await ensureCurrentProjectRootWithDialog();

    if (!projectRoot) {
      return { canceled: true, rootPath: null, projectRoot: null, importedAssets: [], projectAssets: [], skipped: [] };
    }

    const result = await dialog.showOpenDialog({
      title: libraryKind === 'environment' ? '选择环境模型文件夹' : '选择模型文件夹',
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

  ipcMain.handle(
    'assets:listModelPackageVariants',
    async (_event, request: ListModelPackageVariantsRequest): Promise<ModelPackageVariant[]> => {
      const packagePath = path.resolve(request.packagePath);
      const stat = await fs.stat(packagePath);

      if (!stat.isDirectory()) {
        throw new Error('请选择有效的模型包目录。');
      }

      authorizeAssetRoot(packagePath);
      return listModelPackageVariants(packagePath);
    },
  );
}
