import { app, BrowserWindow, protocol } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { registerAssetIpc } from './ipc/assetIpc.js';
import { decodeAssetUrl, isAuthorizedAssetFile } from './ipc/assetRegistry.js';
import { registerDataPlatformIpc } from './ipc/dataPlatformIpc.js';
import { disposeDataPlatformProjectTasks } from './ipc/dataPlatformProjectService.js';
import { disposeAllDeploymentExportTasks, registerDeploymentExportIpc } from './ipc/deploymentExportIpc.js';
import { disposeAllMqttIpcClients, registerMqttIpc } from './ipc/mqttIpc.js';
import { registerProjectIpc } from './ipc/projectIpc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HIGH_PERFORMANCE_GPU_SWITCH = 'force_high_performance_gpu';
const DISABLE_GPU_SANDBOX_SWITCH = 'disable-gpu-sandbox';
const FAILURE_PAGE_BACKGROUND = '#1e1e1e';

// 必须在 app ready 前请求高性能 GPU。保留 SwiftShader 软件回退，由渲染进程探测后降级并输出日志。
// 驱动黑名单仍由 Chromium 保留，避免强行启用不稳定驱动。
app.commandLine.appendSwitch(HIGH_PERFORMANCE_GPU_SWITCH);

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
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

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
      contextIsolation: true,
      nodeIntegration: false,
      webgl: true,
    },
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
    const filePath = decodeAssetUrl(request.url);

    if (!isAuthorizedAssetFile(filePath)) {
      return new Response('Forbidden', { status: 403 });
    }

    const stat = await fs.stat(filePath);
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Length': String(stat.size),
      },
    });
  });
}

app.whenReady().then(() => {
  registerEditorAssetProtocol();
  registerProjectIpc();
  registerDataPlatformIpc();
  registerAssetIpc();
  registerMqttIpc();
  registerDeploymentExportIpc();
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
  if (quitCleanupCompleted) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;

  disposeAllDeploymentExportTasks();
  disposeAllMqttIpcClients();
  void disposeDataPlatformProjectTasks()
    .catch((error: unknown) => {
      console.error('[electron] 数据中台任务退出清理失败。', error);
    })
    .finally(() => {
      quitCleanupCompleted = true;
      app.quit();
    });
});
