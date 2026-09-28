import { dialog, ipcMain } from 'electron';
import type { OpeningAssetImportResult, OpeningPackageExportRequest, OpeningPackageExportResult, OpeningPackageImportResult, OpeningPackageListResult } from '../types.js';
import { getCurrentProjectRoot, listProjectAssets, selectCurrentProjectRootWithDialog } from './projectAssetStore.js';
import { isDigitalTwinPublishActive } from './digitalTwinPublishIpc.js';
import { exportOpeningPackageArchive, importOpeningPackageArchive, listOpeningPackagesInProject, resolveOpeningPackageDirectory } from './openingPackageStore.js';
import { importOpeningImage } from './openingAssetStore.js';

function assertReady(projectRoot?: string): void {
  if (isDigitalTwinPublishActive()) throw new Error('发布或资源恢复期间不能导入、导出开场包。');
  if (projectRoot && getCurrentProjectRoot() !== projectRoot) throw new Error('当前项目已改变，请在目标项目中重试。');
}
async function list(): Promise<OpeningPackageListResult> {
  await listProjectAssets();
  const projectRoot = getCurrentProjectRoot();
  return projectRoot ? { projectRoot, ...await listOpeningPackagesInProject(projectRoot) } : { projectRoot: null, packages: [], warnings: [] };
}
async function requireProject(): Promise<string | null> {
  assertReady(); await listProjectAssets();
  return getCurrentProjectRoot() ?? await selectCurrentProjectRootWithDialog(assertReady);
}

export function registerOpeningPackageIpc(): void {
  ipcMain.handle('opening:listPackages', list);
  ipcMain.handle('opening:importPackage', async (): Promise<OpeningPackageImportResult> => {
    const projectRoot = await requireProject();
    if (!projectRoot) return { projectRoot: null, canceled: true, package: null, packages: [], warnings: [] };
    const selected = await dialog.showOpenDialog({ title: '导入开场动画包', properties: ['openFile'], filters: [{ name: '开场动画 ZIP 包', extensions: ['zip'] }] });
    assertReady(projectRoot);
    if (selected.canceled || !selected.filePaths[0]) return { ...await list(), canceled: true, package: null };
    const imported = await importOpeningPackageArchive(projectRoot, selected.filePaths[0]);
    assertReady(projectRoot);
    return { ...await list(), canceled: false, package: imported };
  });
  ipcMain.handle('opening:exportPackage', async (_event, request: OpeningPackageExportRequest): Promise<OpeningPackageExportResult> => {
    assertReady();
    const projectRoot = getCurrentProjectRoot(); if (!projectRoot) throw new Error('请先打开所属项目。');
    resolveOpeningPackageDirectory(projectRoot, request);
    const selected = await dialog.showSaveDialog({ title: '导出原始开场包', defaultPath: `${request.id}-${request.version}.opening.zip`, filters: [{ name: '开场动画 ZIP 包', extensions: ['zip'] }] });
    assertReady(projectRoot);
    if (selected.canceled || !selected.filePath) return { canceled: true, filePath: null };
    await exportOpeningPackageArchive(projectRoot, request, selected.filePath);
    return { canceled: false, filePath: selected.filePath };
  });
  ipcMain.handle('opening:importAsset', async (): Promise<OpeningAssetImportResult> => {
    const projectRoot = await requireProject();
    const canceled = { canceled: true, assetUrl: null, filePath: null, size: 0, sha256: '' };
    if (!projectRoot) return canceled;
    const selected = await dialog.showOpenDialog({ title: '导入场景开场图片', properties: ['openFile'], filters: [{ name: '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    assertReady(projectRoot);
    if (selected.canceled || !selected.filePaths[0]) return canceled;
    const imported = await importOpeningImage(projectRoot, selected.filePaths[0]);
    assertReady(projectRoot);
    return { canceled: false, ...imported };
  });
}
