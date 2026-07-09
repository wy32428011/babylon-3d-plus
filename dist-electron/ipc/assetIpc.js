import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorizeAssetFile, authorizeAssetRoot, authorizeSceneFile, encodeAssetUrl } from './assetRegistry.js';
import { listModelPackageVariants, scanModelFolder } from './modelPackageScanner.js';
import { ensureCurrentProjectRootWithDialog, getCurrentProjectRoot, importModelPackagesIntoProject } from './projectAssetStore.js';
function getAssetKind(filePath, isDirectory) {
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
export function registerAssetIpc() {
    ipcMain.handle('assets:scan', async () => {
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
    ipcMain.handle('assets:importCadFile', async () => {
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
    ipcMain.handle('assets:importModelFolder', async () => {
        const projectRoot = await ensureCurrentProjectRootWithDialog();
        if (!projectRoot) {
            return { canceled: true, rootPath: null, projectRoot: null, assets: [], skipped: [] };
        }
        const result = await dialog.showOpenDialog({
            title: '选择模型文件夹',
            properties: ['openDirectory'],
        });
        const [rootPath] = result.filePaths;
        if (result.canceled || !rootPath) {
            return { canceled: true, rootPath: null, projectRoot, assets: [], skipped: [] };
        }
        authorizeAssetRoot(rootPath);
        const { assets: scannedAssets, skipped: scanSkipped } = await scanModelFolder(rootPath);
        const { assets, skipped: copySkipped } = await importModelPackagesIntoProject(scannedAssets);
        return {
            canceled: false,
            rootPath,
            projectRoot: getCurrentProjectRoot(),
            assets,
            skipped: [...scanSkipped, ...copySkipped],
        };
    });
    ipcMain.handle('assets:listModelPackageVariants', async (_event, request) => {
        const packagePath = path.resolve(request.packagePath);
        const stat = await fs.stat(packagePath);
        if (!stat.isDirectory()) {
            throw new Error('请选择有效的模型包目录。');
        }
        authorizeAssetRoot(packagePath);
        return listModelPackageVariants(packagePath);
    });
}
