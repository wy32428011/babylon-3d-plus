import { BUILTIN_SKYBOX_SHA256, getBuiltinSkyboxEnvironment } from './builtinSkyboxAssets.ts';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizeAssetFile, decodeAssetUrl, encodeAssetUrl, isAuthorizedAssetFile } from './assetRegistry.js';
import { getCurrentProjectRoot, getProjectSessionGeneration } from './projectAssetStore.js';
import { SkyboxDerivedAssetStore } from './skyboxDerivedAssetStore.ts';
import type { SkyboxPreparationSource } from '../shared/sceneSkyboxContract.ts';

let registered = false;
let current: { key: string; store: SkyboxDerivedAssetStore } | null = null;
const watched = new Set<number>();

function requireEditor(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('天空资源准备只能由编辑器主窗口发起。');
  }
  const actual = new URL(event.sender.getURL());
  const expected = new URL(process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href);
  actual.hash = ''; actual.search = ''; expected.hash = ''; expected.search = '';
  if (actual.href !== expected.href) throw new Error('天空资源准备来自未授权页面。');
}
function storeFor(event: IpcMainInvokeEvent): SkyboxDerivedAssetStore {
  requireEditor(event);
  const project = getCurrentProjectRoot(), generation = getProjectSessionGeneration();
  const root = project ?? app.getPath('userData');
  const key = JSON.stringify([project, generation]);
  if (current?.key !== key) {
    current?.store.dispose();
    current = { key, store: new SkyboxDerivedAssetStore({ rootDirectory: root,
      cacheRoot: path.join(root, '.babylon-editor', 'skybox-derived'),
      isAuthorizedFile: isAuthorizedAssetFile, authorizeFile: authorizeAssetFile, encodeUrl: encodeAssetUrl, decodeUrl: decodeAssetUrl,
      findBundledEnvironment: (hash, size) => hash === BUILTIN_SKYBOX_SHA256 ? getBuiltinSkyboxEnvironment(size) : Promise.resolve(null),
      isCurrent: () => getCurrentProjectRoot() === project && getProjectSessionGeneration() === generation,
    }) };
  }
  if (!watched.has(event.sender.id)) {
    const owner = event.sender.id;
    watched.add(owner);
    event.sender.once('destroyed', () => { current?.store.cancelOwner(owner); watched.delete(owner); });
  }
  return current.store;
}

/** 新协议只传有界源描述和 ENV 二进制，不允许 renderer 选择输出目录。 */
export function registerSkyboxPreparationIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('assets:prepareSkyboxEnvironment', (event, source: SkyboxPreparationSource) => storeFor(event).prepare(source, event.sender.id));
  ipcMain.handle('assets:commitSkyboxEnvironment', (event, request: { token: string; bytes: Uint8Array }) => {
    const store = storeFor(event);
    if (!request || typeof request.token !== 'string' || request.token.length > 128) throw new Error('天空提交任务标识无效。');
    return store.commit(request.token, event.sender.id, request.bytes);
  });
  ipcMain.handle('assets:cancelSkyboxEnvironment', (event, token: unknown) => {
    requireEditor(event);
    return typeof token === 'string' && Boolean(current?.store.cancel(token, event.sender.id));
  });
  app.once('before-quit', () => { current?.store.dispose(); current = null; });
}
