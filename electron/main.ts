import { app, BrowserWindow, protocol } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAssetIpc } from './ipc/assetIpc.js';
import { decodeAssetUrl, isAuthorizedAssetFile } from './ipc/assetRegistry.js';
import { registerProjectIpc } from './ipc/projectIpc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);

    if (process.env.OPEN_DEVTOOLS !== 'false') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return;
  }

  void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

function registerEditorAssetProtocol(): void {
  protocol.handle('editor-asset', async (request) => {
    const filePath = decodeAssetUrl(request.url);

    if (!isAuthorizedAssetFile(filePath)) {
      return new Response('Forbidden', { status: 403 });
    }

    const content = await fs.readFile(filePath);
    return new Response(content);
  });
}

app.whenReady().then(() => {
  registerEditorAssetProtocol();
  registerProjectIpc();
  registerAssetIpc();
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
