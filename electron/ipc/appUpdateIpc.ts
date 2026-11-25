import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { CheckForAppUpdateRequest } from '../shared/appUpdate.js';
import { createAppUpdateController, type AppUpdateController } from '../shared/appUpdateController.js';
import { editorIpc } from './trustedEditorIpc.js';

const STARTUP_CHECK_DELAY_MS = 4000;

let controller: AppUpdateController | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

/** 注册应用自动更新受控 IPC，并在打包态下支持启动后自动检查。 */
export function registerAppUpdateIpc(options: {
  getMainWindow: () => BrowserWindow | null;
  approveWindowClose: () => void;
}): void {
  controller = createAppUpdateController({
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    getUpdater: () => electronUpdater.autoUpdater,
    broadcast: (state) => {
      const window = options.getMainWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send('app-update:state', state);
    },
    approveWindowClose: options.approveWindowClose,
  });

  editorIpc.handle('app-update:getState', () => controller?.getState());
  editorIpc.handle('app-update:check', (_event, request?: CheckForAppUpdateRequest) =>
    controller?.checkForUpdates({ manual: Boolean(request?.manual) }),
  );
  editorIpc.handle('app-update:download', () => controller?.downloadUpdate());
  editorIpc.handle('app-update:install', () => controller?.quitAndInstall() ?? false);
}

/** 启动后延迟静默检查一次更新，避免阻塞首屏加载。 */
export function scheduleStartupAppUpdateCheck(): void {
  if (!app.isPackaged || !controller || startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void controller?.checkForUpdates({ manual: false });
  }, STARTUP_CHECK_DELAY_MS);
}

/** 退出前清理启动自动检查定时器。 */
export function disposeAppUpdateIpc(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}
