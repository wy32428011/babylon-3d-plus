import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizeAssetFile, decodeAssetUrl, encodeAssetUrl, isAuthorizedAssetFile } from './assetRegistry.js';
import { getCurrentProjectRoot, getProjectSessionGeneration } from './projectAssetStore.js';
import { detectLightingBakeEnginePath, runLightingBakeJob, inspectLightingBakeRequest } from './lightingBakeService.js';
import { createLightingBakeEngineConfigurationService } from './lightingBakeEngineConfiguration.ts';
import { getLightingBakeTaskHistory, cleanupLightingBakeTasks, readLightingBakeTaskLog } from './lightingBakeTaskHistory.ts';
import { LightingBakeJobs, validateLightingBakeInput } from './lightingBakeValidation.js';
import type { LightingBakeBinaryInput } from '../shared/sceneLightingBakeBinary.ts';
import type { LightingBakeProgress, SceneLightingBakeSnapshot } from '../shared/sceneLightingBakeContract.js';

let registered = false;
const jobs = new LightingBakeJobs();

export function disposeLightingBakeJobs(): void { jobs.cancelAll(); }

/** IPC 任务与发起窗口和项目会话绑定，外部窗口不能取消或接收该任务进度。 */
export function registerLightingBakeIpc(): void {
  if (registered) return;
  registered = true;
  const engineConfiguration = createLightingBakeEngineConfigurationService({
    userDataDirectory: app.getPath('userData'),
    detectEnginePath: (candidate, refresh) => detectLightingBakeEnginePath(candidate, { refresh }),
  });
  const requireEditorWindow = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('本机烘焙引擎配置只能由编辑器主窗口发起。');
    try {
      const actual = new URL(event.sender.getURL()), expected = new URL(process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href);
      actual.hash = ''; actual.search = ''; expected.hash = ''; expected.search = '';
      if (actual.href !== expected.href) throw new Error('untrusted renderer');
    } catch { throw new Error('本机烘焙引擎配置来自未授权的编辑器页面。'); }
    return window;
  };
  const requireProject = () => { const root = getCurrentProjectRoot(); if (!root) throw new Error('请先打开工程。'); return root; };
  ipcMain.handle('lighting-bake:preflight', async (_event, raw: unknown) => {
    const project = requireProject(), generation = getProjectSessionGeneration();
    const report = await inspectLightingBakeRequest(validateLightingBakeInput(raw), { decodeAssetUrl, isAuthorizedAssetFile });
    if (getCurrentProjectRoot() !== project || getProjectSessionGeneration() !== generation) throw new Error('工程已切换，请重新检查。');
    return report;
  });
  ipcMain.handle('lighting-bake:history', () => getLightingBakeTaskHistory(requireProject()));
  ipcMain.handle('lighting-bake:cleanup', (_event, taskIds: string[]) => {
    const root = requireProject(), generation = getProjectSessionGeneration();
    return cleanupLightingBakeTasks(root, taskIds, () => getCurrentProjectRoot() === root && getProjectSessionGeneration() === generation);
  });
  ipcMain.handle('lighting-bake:log', (_event, taskId: string) => readLightingBakeTaskLog(requireProject(), taskId));
  ipcMain.handle('lighting-bake:engineStatus', async () => (await engineConfiguration.getConfiguration()).engine);
  ipcMain.handle('lighting-bake:engineConfiguration', event => { requireEditorWindow(event); return engineConfiguration.getConfiguration(); });
  ipcMain.handle('lighting-bake:chooseEnginePath', async event => {
    const window = requireEditorWindow(event);
    const selected = await dialog.showOpenDialog(window, {
      title: '选择 Blender 可执行文件', properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Blender 可执行文件', extensions: ['exe'] }] } : {}),
    });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  ipcMain.handle('lighting-bake:detectEnginePath', (event, candidate: unknown) => { requireEditorWindow(event); return engineConfiguration.detectPath(candidate); });
  ipcMain.handle('lighting-bake:saveEngineConfiguration', (event, candidate: unknown) => { requireEditorWindow(event); return engineConfiguration.saveConfiguration(candidate); });
  ipcMain.handle('lighting-bake:cancel', (event, id: unknown) => typeof id === 'string' && jobs.cancel(event.sender.id, id));
  ipcMain.handle('lighting-bake:start', async (event, raw: unknown): Promise<SceneLightingBakeSnapshot> => engineConfiguration.withBakeJob(async () => {
    const input = validateLightingBakeInput(raw);
    const projectRoot = getCurrentProjectRoot(), generation = getProjectSessionGeneration();
    if (!projectRoot) throw new Error('请先打开工程，再进行光照烘焙。');
    const lifetime = new AbortController();
    let controller: AbortController | undefined;
    const cancel = () => { lifetime.abort(); controller?.abort(); };
    event.sender.once('destroyed', cancel);
    const progress = (payload: LightingBakeProgress) => { if (!event.sender.isDestroyed()) event.sender.send('lighting-bake:progress', payload); };
    try {
      controller = await jobs.acquire(event.sender.id, input.jobId, lifetime.signal);
      if (event.sender.isDestroyed() || getCurrentProjectRoot() !== projectRoot || getProjectSessionGeneration() !== generation) {
        throw new Error('工程或窗口已切换，本次烘焙已取消。');
      }
      const engine = (await engineConfiguration.getConfiguration()).engine;
      if (!engine.available || !engine.path) throw new Error(engine.message ?? 'Blender 不可用。');
      const result = await runLightingBakeJob({ input, projectRoot, enginePath: engine.path, engineVersion: engine.version,
        binaryGeometry: raw && typeof raw === 'object' && 'version' in raw && raw.version === 2 ? (raw as LightingBakeBinaryInput).geometry : undefined, signal: controller.signal,
        isProjectCurrent: () => getCurrentProjectRoot() === projectRoot && getProjectSessionGeneration() === generation,
        isAuthorizedAssetFile, decodeAssetUrl, encodeAssetUrl, authorizeAssetFile, onProgress: progress });
      progress({ jobId: input.jobId, phase: 'complete', progress: 1, message: '光照资源已生成，正在交给场景验证应用。' });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '光照烘焙失败。';
      const cancelled = controller?.signal.aborted || lifetime.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      progress({ jobId: input.jobId, phase: cancelled ? 'cancelled' : 'error', progress: 0, message });
      throw error;
    } finally {
      if (controller) jobs.release(event.sender.id, input.jobId, controller);
      if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', cancel);
    }
  }));
}
