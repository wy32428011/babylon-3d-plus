import { dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { editorIpc } from './ipc/trustedEditorIpc.js';

type WindowState = { window: BrowserWindow; ready: boolean; approved: boolean; pending: string | null; onCancel: () => void };
const states = new WeakMap<Electron.WebContents, WindowState>();

export function registerWindowCloseIpc(): void {
  editorIpc.handle('editor:closeReady', (event, ready: unknown) => {
    const state = states.get(event.sender);
    if (state && typeof ready === 'boolean') state.ready = ready;
  });
  editorIpc.handle('editor:confirmClose', (event, requestId: unknown, allowed: unknown) => {
    const state = states.get(event.sender);
    if (!state || typeof requestId !== 'string' || state.pending !== requestId || typeof allowed !== 'boolean') return;
    state.pending = null;
    if (!allowed) { state.onCancel(); return; }
    state.approved = true;
    state.window.close();
  });
}

/** renderer 明确回复前不销毁窗口；失败页或尚未就绪时使用取消优先的原生确认。 */
export function guardEditorWindowClose(window: BrowserWindow, onCancel: () => void): { isApproved: () => boolean } {
  const state: WindowState = { window, ready: false, approved: false, pending: null, onCancel };
  states.set(window.webContents, state);
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { state.ready = false; state.pending = null; }
  });
  window.webContents.on('render-process-gone', () => { state.ready = false; state.pending = null; });
  window.on('unresponsive', () => { state.ready = false; state.pending = null; });
  window.on('close', event => {
    if (state.approved) return;
    event.preventDefault();
    if (state.pending) return;
    const requestId = randomUUID();
    state.pending = requestId;
    if (state.ready && !window.webContents.isDestroyed()) {
      window.webContents.send('editor:requestClose', requestId);
      return;
    }
    void dialog.showMessageBox(window, {
      type: 'warning', title: '关闭编辑器', message: '编辑器尚未就绪或已退出，无法确认场景是否已保存。',
      detail: '继续关闭可能丢失未保存修改。', buttons: ['取消', '仍然关闭'], defaultId: 0, cancelId: 0,
    }).then(result => {
      if (window.isDestroyed() || state.pending !== requestId) return;
      state.pending = null;
      if (result.response === 1) { state.approved = true; window.close(); }
      else state.onCancel();
    }).catch(error => {
      state.pending = null;
      state.onCancel();
      console.error('[electron] 关闭确认失败，窗口已保留。', error);
    });
  });
  return { isApproved: () => state.approved };
}
