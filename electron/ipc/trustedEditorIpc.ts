import { ipcMain, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';

const trustedWindows = new WeakMap<Electron.WebContents, { window: BrowserWindow; entryUrl: string }>();

/** 查询与锚点不扩大入口路径权限；开发态也不信任同源的任意页面。 */
export function isTrustedEditorUrl(value: string, entryUrl: string): boolean {
  try {
    const actual = new URL(value), expected = new URL(entryUrl);
    if (actual.username || actual.password || actual.protocol !== expected.protocol || actual.host !== expected.host) return false;
    return actual.pathname === expected.pathname
      || (expected.pathname === '/' && actual.pathname === '/index.html');
  } catch { return false; }
}

export function trustEditorWindow(window: BrowserWindow, entryUrl: string): void {
  trustedWindows.set(window.webContents, { window, entryUrl });
}

export function assertTrustedEditorSender(event: IpcMainInvokeEvent): void {
  const trusted = trustedWindows.get(event.sender);
  if (!trusted || trusted.window.isDestroyed() || event.sender.isDestroyed()
    || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
    || !isTrustedEditorUrl(event.senderFrame.url, trusted.entryUrl)
    || !isTrustedEditorUrl(event.sender.getURL(), trusted.entryUrl)) {
    throw new Error('此操作只允许由可信编辑器主页面发起。');
  }
}

/** 所有桌面调用共用来源检查，业务处理器继续负责参数和任务归属校验。 */
export const editorIpc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
  handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedEditorSender(event);
      return listener(event, ...args);
    });
  },
  removeHandler(channel) { ipcMain.removeHandler(channel); },
};
