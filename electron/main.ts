import { configureModelScriptPersistentCache, precompileModelScriptBytes } from './ipc/modelScriptCompiler.js';
import { assertLightingBakeResourceFile } from './ipc/sceneLightingBakeResources.js';
import { registerCompositionIpc } from './ipc/compositionIpc.js';
import { app, BrowserWindow, dialog, protocol, safeStorage, shell } from 'electron';
import path from 'node:path';
import { createAssetFileByteStream } from './shared/assetFileByteStream.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTrustedEditorUrl, trustEditorWindow } from './ipc/trustedEditorIpc.js';
import { guardEditorWindowClose, registerWindowCloseIpc } from './windowCloseGuard.js';
import { registerAssetIpc } from './ipc/assetIpc.js';
import { decodeAssetUrl, openAuthorizedAssetFile } from './ipc/assetRegistry.js';
import { registerEffectDataIpc } from './ipc/effectDataIpc.js';
import { disposeLightingBakeJobs, registerLightingBakeIpc } from './ipc/lightingBakeIpc.js';
import { registerDataPlatformIpc } from './ipc/dataPlatformIpc.js';
import { disposeDataPlatformChartSync } from './ipc/dataPlatformChartSync.js';
import { findDataPlatformDeepLink, parseDataPlatformDeepLink, type DataPlatformDeepLink } from './deepLink.js';
import { disposeDataPlatformProjectTasks } from './ipc/dataPlatformProjectService.js';
import { disposeAllDeploymentExportTasks, registerDeploymentExportIpc } from './ipc/deploymentExportIpc.js';
import { disposeAllDigitalTwinPublishTasks, registerDigitalTwinPublishIpc } from './ipc/digitalTwinPublishIpc.js';
import { disposeAllMqttIpcClients, registerMqttIpc } from './ipc/mqttIpc.js';
import { registerProjectIpc } from './ipc/projectIpc.js';
import { resolveEditorAssetProtocolResponse } from './ipc/editorAssetCacheHeaders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HIGH_PERFORMANCE_GPU_SWITCH = 'force_high_performance_gpu';
const DISABLE_SOFTWARE_RASTERIZER_SWITCH = 'disable-software-rasterizer';
const ENABLE_UNSAFE_SWIFTSHADER_SWITCH = 'enable-unsafe-swiftshader';
const DISABLE_GPU_SANDBOX_SWITCH = 'disable-gpu-sandbox';
const FAILURE_PAGE_BACKGROUND = '#1e1e1e';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindowReference: BrowserWindow | null = null;
let mainWindowCloseGuard: ReturnType<typeof guardEditorWindowClose> | null = null;
let quitAfterWindowClose = false;
const devServerUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
const rendererEntryUrl = devServerUrl || pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
let pendingDataPlatformDeepLink: DataPlatformDeepLink | null = findDataPlatformDeepLink(process.argv);

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = findDataPlatformDeepLink(argv);
    if (deepLink) dispatchDataPlatformDeepLink(deepLink);
    if (mainWindowReference && !mainWindowReference.isDestroyed()) {
      if (mainWindowReference.isMinimized()) mainWindowReference.restore();
      mainWindowReference.show();
      mainWindowReference.focus();
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const deepLink = parseDataPlatformDeepLink(url);
    if (deepLink) dispatchDataPlatformDeepLink(deepLink);
  });
}

function dispatchDataPlatformDeepLink(deepLink: DataPlatformDeepLink): void {
  pendingDataPlatformDeepLink = deepLink;
  const window = mainWindowReference;
  if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
  window.webContents.send('data-platform:deepLinkOpen', deepLink);
  pendingDataPlatformDeepLink = null;
}

// 必须在 app ready 前请求高性能 GPU，并禁止 Chromium 静默退回 SwiftShader 等软件 3D rasterizer。
// 驱动黑名单仍由 Chromium 保留，避免强行启用不稳定驱动。
app.commandLine.appendSwitch(HIGH_PERFORMANCE_GPU_SWITCH);
// 开发调试逃生门：EDITOR_ALLOW_SOFTWARE_WEBGL=1 时允许软件 WebGL 回退（仅限未打包环境，如无 GPU 的虚拟机），
// 与渲染进程的 localStorage editor.allowSoftwareWebGL 配合使用；打包产物不受影响。
const allowSoftwareWebGL = !app.isPackaged && process.env.EDITOR_ALLOW_SOFTWARE_WEBGL === '1';
app.commandLine.appendSwitch(
  allowSoftwareWebGL ? ENABLE_UNSAFE_SWIFTSHADER_SWITCH : DISABLE_SOFTWARE_RASTERIZER_SWITCH,
);
if (allowSoftwareWebGL) {
  console.warn('[electron] EDITOR_ALLOW_SOFTWARE_WEBGL=1，已允许软件 WebGL 回退（仅开发环境）。');
}

// 企业 Windows 安装态需要兼容现有 GPU 子进程环境；仅关闭 GPU sandbox，不改变 renderer sandbox。
if (process.platform === 'win32' && app.isPackaged) {
  app.commandLine.appendSwitch(DISABLE_GPU_SANDBOX_SWITCH);
  console.warn('[electron] Windows 安装态已按企业部署策略关闭 GPU sandbox。');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'editor-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** 转义错误页中的动态文本，避免路径或错误信息破坏 HTML 结构。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 创建 renderer 加载失败时使用的内联错误页 URL。 */
function createFailurePageUrl(title: string, message: string, details: string): string {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
        color: #f3f3f3;
        background: ${FAILURE_PAGE_BACKGROUND};
        font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      main {
        display: grid;
        gap: 12px;
        width: min(760px, calc(100vw - 64px));
        padding: 24px;
        border: 1px solid #6f3434;
        background: #2a2020;
      }
      h1, p, pre { margin: 0; }
      pre {
        max-height: 320px;
        padding: 12px;
        overflow: auto;
        color: #ffd6d6;
        background: #171111;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main role="alert">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <pre>${escapeHtml(details)}</pre>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 为主窗口绑定加载与渲染进程诊断，避免 dev:electron 白屏时没有线索。 */
function attachRendererDiagnostics(mainWindow: BrowserWindow, rendererTarget: string): void {
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || validatedURL.startsWith('data:text/html')) return;

    const details = `target=${rendererTarget}\nurl=${validatedURL}\nerrorCode=${errorCode}\nerror=${errorDescription}`;
    console.error(`[electron] renderer 加载失败。\n${details}`);
    void mainWindow.loadURL(createFailurePageUrl('编辑器加载失败', 'Electron 未能加载前端页面。', details));
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[electron] preload 执行失败：${preloadPath}`, error);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (mainWindow.isDestroyed()) return;

    const failureDetails = `target=${rendererTarget}\nreason=${details.reason}\nexitCode=${details.exitCode}`;
    console.error(`[electron] renderer 进程退出。\n${failureDetails}`);
    void mainWindow.loadURL(createFailurePageUrl('编辑器渲染进程已退出', 'Electron renderer 进程异常退出。', failureDetails));
  });
}

/** 加载 React renderer，开发模式优先连接 Vite，生产模式加载 dist/index.html。 */
async function loadRenderer(mainWindow: BrowserWindow): Promise<void> {
  if (devServerUrl) {
    attachRendererDiagnostics(mainWindow, devServerUrl);
    await mainWindow.loadURL(devServerUrl);

    if (process.env.OPEN_DEVTOOLS !== 'false') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return;
  }

  const rendererHtmlPath = path.join(__dirname, '../dist/index.html');
  attachRendererDiagnostics(mainWindow, rendererHtmlPath);
  await mainWindow.loadFile(rendererHtmlPath);
}

/** 创建主窗口并启动 renderer 加载链路。 */
function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '../build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--editor-entry-url=${encodeURIComponent(rendererEntryUrl)}`],
      contextIsolation: true,
      nodeIntegration: false,
      webgl: true,
    },
  });
  mainWindowReference = mainWindow;
  trustEditorWindow(mainWindow, rendererEntryUrl);
  mainWindowCloseGuard = guardEditorWindowClose(mainWindow, () => { quitAfterWindowClose = false; });
  let externalPromptActive = false;
  const offerExternalLink = async (value: string) => {
    if (externalPromptActive || mainWindow.isDestroyed()) return;
    let url: URL;
    try { url = new URL(value); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096) return;
    externalPromptActive = true;
    try {
      const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: '打开外部链接',
        message: '是否在系统浏览器打开此链接？', detail: url.href,
        buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1 && !mainWindow.isDestroyed()) await shell.openExternal(url.href);
    } catch (error) { console.error('[electron] 打开外部链接失败。', error); }
    finally { externalPromptActive = false; }
  };
  mainWindow.webContents.setWindowOpenHandler(details => {
    void offerExternalLink(details.url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedEditorUrl(url, rendererEntryUrl)) return;
    event.preventDefault();
    void offerExternalLink(url);
  });
  mainWindow.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isTrustedEditorUrl(url, rendererEntryUrl)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('closed', () => {
    if (mainWindowReference === mainWindow) { mainWindowReference = null; mainWindowCloseGuard = null; }
    if (quitAfterWindowClose) { quitAfterWindowClose = false; app.quit(); }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!pendingDataPlatformDeepLink || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('data-platform:deepLinkOpen', pendingDataPlatformDeepLink);
    pendingDataPlatformDeepLink = null;
  });

  void loadRenderer(mainWindow).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[electron] renderer 启动失败。', error);
    void mainWindow.loadURL(createFailurePageUrl('编辑器启动失败', 'Electron renderer 启动失败。', message));
  });
}

/** 注册受控本地模型资源协议，只允许读取资产索引授权过的文件。 */
function registerEditorAssetProtocol(): void {
  protocol.handle('editor-asset', async (request) => {
    let filePath: string;
    try { filePath = decodeAssetUrl(request.url); }
    catch { return new Response('资产 URL 格式不正确。', { status: 400 }); }
    const lightingResource = /[\\/]Assets[\\/]LightingBakes[\\/]/i.test(filePath);
    let opened: Awaited<ReturnType<typeof openAuthorizedAssetFile>>;
    try {
      if (lightingResource) await assertLightingBakeResourceFile(filePath);
      opened = await openAuthorizedAssetFile(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return new Response('本地资源文件不存在。', { status: 404 });
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' || lightingResource) {
        return new Response('资源路径未通过授权校验。', { status: 403 });
      }
      throw error;
    }
    let transferred = false;
    try {
      const { handle, stat } = opened;
      if (new URL(request.url).searchParams.get('modelScriptCompiled') === '1') {
        if (!/\.ts$/i.test(filePath)) return new Response('仅支持模型 TypeScript 脚本。', { status: 400 });
        const artifact = await precompileModelScriptBytes(await handle.readFile(), request.signal);
        return new Response(JSON.stringify(artifact), { headers: {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        } });
      }
      const decision = resolveEditorAssetProtocolResponse({
        filePath, size: stat.size, mtimeMs: stat.mtimeMs,
        ifNoneMatch: request.headers.get('If-None-Match'),
      });
      if (decision.status === 304) return new Response(null, { status: 304, headers: decision.headers });
      const body = createAssetFileByteStream(handle, request.signal, stat.size);
      const response = new Response(body, { headers: decision.headers });
      transferred = true;
      return response;
    } finally {
      if (!transferred) await opened.handle.close();
    }
  });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  app.on('child-process-gone', (_event, details) => {
    console.error(`[electron] 子进程退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  configureModelScriptPersistentCache(path.join(app.getPath('userData'), 'model-script-cache'), safeStorage.isEncryptionAvailable() ? {
    protect: key => safeStorage.encryptString(key.toString('base64')),
    unprotect: encrypted => Buffer.from(safeStorage.decryptString(encrypted), 'base64'),
  } : undefined);
  registerWindowCloseIpc();
  registerEditorAssetProtocol();
  registerProjectIpc();
  registerCompositionIpc();
  registerEffectDataIpc();
  registerLightingBakeIpc();
  registerDataPlatformIpc();
  registerAssetIpc();
  registerMqttIpc();
  registerDeploymentExportIpc();
  registerDigitalTwinPublishIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let quitCleanupStarted = false;
let quitCleanupCompleted = false;

app.on('before-quit', (event) => {
  if (mainWindowReference && !mainWindowReference.isDestroyed() && !mainWindowCloseGuard?.isApproved()) {
    event.preventDefault();
    quitAfterWindowClose = true;
    mainWindowReference.close();
    return;
  }
  if (quitCleanupCompleted) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;

  disposeAllDeploymentExportTasks();
  disposeLightingBakeJobs();
  disposeAllMqttIpcClients();
  void Promise.allSettled([
    disposeAllDigitalTwinPublishTasks(),
    disposeDataPlatformChartSync(),
    disposeDataPlatformProjectTasks(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') console.error('[electron] 退出任务清理失败。', result.reason);
    }
  }).finally(() => {
    quitCleanupCompleted = true;
    app.quit();
  });
});
