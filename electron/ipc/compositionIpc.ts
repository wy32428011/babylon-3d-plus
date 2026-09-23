import { getCurrentProjectRoot, getSharedProjectAssetRoot, readProjectAssetIndex } from './projectAssetStore.js';
import { createHash } from 'node:crypto';
import { normalizeDataPlatformSourceUrl } from './dataPlatformEnvironmentContract.js';
import { importCompositionArchive, exportCompositionArchive } from './compositionArchive.js';
import { getCurrentDataPlatformBinding } from './dataPlatformBindingStore.js';
import { getScenePublishScope } from './scenePublishScope.js';
import { ipcMain, dialog } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readDataPlatformConfig, isDataPlatformProjectClosing } from './dataPlatformIpc.js';
import { authorizeAssetRoot } from './assetRegistry.js';
import { listCompositionSummaries, loadCompositionPackage, readCompositionIndex, saveCompositionPackage, restoreCompositionPackage } from './compositionPackage.js';
import { syncCompositionLibrary, cancelCompositionSync } from './compositionRemote.js';
import type { CompositionSaveRequest } from '../shared/compositionTypes.js';
import { isDigitalTwinPublishActive } from './digitalTwinPublishIpc.js';

export function registerCompositionIpc() {
  const context = async () => {
    if (isDataPlatformProjectClosing() || isDigitalTwinPublishActive()) throw new Error('项目关闭或发布期间不能修改组合库。');
    const config = await readDataPlatformConfig();
    const root = path.join(config.workspaceRoot, 'SharedResources');
    await fs.mkdir(root, { recursive: true }); authorizeAssetRoot(root);
    return { root, config };
  };
  ipcMain.handle('composition:import', async () => {
    const { root } = await context();
    const selected = await dialog.showOpenDialog({ title: '导入可编辑组合包', filters: [{ name: '组合模型包', extensions: ['zip'] }], properties: ['openFile'] });
    return selected.canceled || !selected.filePaths[0] ? null : importCompositionArchive(root, selected.filePaths[0]);
  });
  ipcMain.handle('composition:export', async (_event, id: string) => {
    const { root } = await context(); const selected = await dialog.showSaveDialog({ title: '导出可编辑组合包', defaultPath: 'composition.zip', filters: [{ name: '组合模型包', extensions: ['zip'] }] });
    if (selected.canceled || !selected.filePath) return false;
    await exportCompositionArchive(root, id, selected.filePath); return true;
  });
  ipcMain.handle('composition:cancel', () => cancelCompositionSync());
  ipcMain.handle('composition:list', async () => {
    const { root, config } = await context();
    const sourceKey = config.baseUrl ? createHash('sha256').update(normalizeDataPlatformSourceUrl(config.baseUrl)).digest('hex') : '';
    return (await listCompositionSummaries(root)).filter(e => !e.sourceKey || e.sourceKey === sourceKey);
  });
  ipcMain.handle('composition:load', async (_event, id: string, revision?: string) => loadCompositionPackage((await context()).root, id, revision));
  ipcMain.handle('composition:save', async (_event, request: CompositionSaveRequest) => {
    const { root, config } = await context();
    if (request?.targetId) {
      const target = (await readCompositionIndex(root)).find(e => e.id === request.targetId);
      const sourceKey = config.baseUrl ? createHash('sha256').update(normalizeDataPlatformSourceUrl(config.baseUrl)).digest('hex') : '';
      if (target?.sourceKey && target.sourceKey !== sourceKey) throw new Error('目标组合卡片属于其他数据中台，请刷新组合库或另存为新组合。');
    }
    const sourceKey = config.baseUrl ? createHash('sha256').update(normalizeDataPlatformSourceUrl(config.baseUrl)).digest('hex') : undefined;
    const roots = [...new Set([getCurrentProjectRoot(), getSharedProjectAssetRoot()].filter((value): value is string => !!value))];
    const packageHints = (await Promise.all(roots.map(value => readProjectAssetIndex(value)))).flatMap(index => index.assets);
    return saveCompositionPackage(root, request, sourceKey, packageHints);
  });
  ipcMain.handle('composition:restore', async (_event, id: string, revision: string) => restoreCompositionPackage((await context()).root, id, revision));
  ipcMain.handle('composition:sync', async () => { const { root, config } = await context(); const binding = getCurrentDataPlatformBinding(), scope = getScenePublishScope();
    const projectId = scope.kind === 'bound-project' && binding && scope.projectRoot === binding.projectRoot ? binding.metadata.projectId : undefined;
    return syncCompositionLibrary(root, config.baseUrl, projectId); });
}
