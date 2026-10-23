import { app, ipcMain } from 'electron';
import { authorizeAssetFile, decodeAssetUrl, encodeAssetUrl, isAuthorizedAssetFile } from './assetRegistry.js';
import { getCurrentProjectRoot, getProjectSessionGeneration } from './projectAssetStore.js';
import { findLightingBakeEngine, runLightingBakeJob } from './lightingBakeService.js';
import { LightingBakeJobs, validateLightingBakeInput } from './lightingBakeValidation.js';
import type { LightingBakeProgress, SceneLightingBakeSnapshot } from '../shared/sceneLightingBakeContract.js';

let registered = false;
const jobs = new LightingBakeJobs();

export function disposeLightingBakeJobs(): void { jobs.cancelAll(); }

/** IPC 任务与发起窗口和项目会话绑定，外部窗口不能取消或接收该任务进度。 */
export function registerLightingBakeIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('lighting-bake:engineStatus', () => findLightingBakeEngine(app.getPath('userData')));
  ipcMain.handle('lighting-bake:cancel', (event, id: unknown) => typeof id === 'string' && jobs.cancel(event.sender.id, id));
  ipcMain.handle('lighting-bake:start', async (event, raw: unknown): Promise<SceneLightingBakeSnapshot> => {
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
      const engine = await findLightingBakeEngine(app.getPath('userData'));
      if (!engine.available || !engine.path) throw new Error(engine.message ?? 'Blender 不可用。');
      const result = await runLightingBakeJob({ input, projectRoot, enginePath: engine.path, signal: controller.signal,
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
  });
}
