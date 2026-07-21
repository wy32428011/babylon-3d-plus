import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const defaultExecutablePath = path.join(projectRoot, 'release', 'win-unpacked', 'ZENDING 3D EDITOR.exe');
const executablePath = path.resolve(process.argv[2] ?? defaultExecutablePath);
const STARTUP_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 300;

/** 暂停指定毫秒数，供启动状态轮询复用。 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 向操作系统申请一个当前可用的本地调试端口。 */
function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error('无法分配 Chromium 调试端口。'));
      });
    });
  });
}

/** 从 Chromium DevTools HTTP 接口等待 Electron renderer 页面出现。 */
async function waitForRendererTarget(port, childState) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    if (childState.exitCode !== null) {
      throw new Error(`应用在 renderer 就绪前退出，exitCode=${childState.exitCode}。`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const pageTarget = targets.find((target) => target.type === 'page'
          && typeof target.url === 'string'
          && target.url.startsWith('file://')
          && target.webSocketDebuggerUrl);
        if (pageTarget) return pageTarget;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(POLL_INTERVAL_MS);
  }

  const suffix = lastError instanceof Error ? ` 最后错误：${lastError.message}` : '';
  throw new Error(`等待 Electron renderer 超时。${suffix}`);
}

/** 通过 DevTools 协议检查页面、React 根节点与 preload API 均已就绪。 */
function inspectRenderer(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('读取 Electron renderer 状态超时。'));
    }, 10000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          awaitPromise: true,
          expression: `new Promise((resolve) => {
            const deadline = Date.now() + 15000;
            // 检查页面渲染、preload 方法与不弹窗 IPC 往返是否全部可用。
            const inspect = async () => {
              const root = document.getElementById('root');
              const api = window.editorApi;
              const result = {
                title: document.title,
                url: location.href,
                readyState: document.readyState,
                rootChildCount: root?.childElementCount ?? 0,
                editorApiAvailable: Boolean(api),
                saveSceneAvailable: typeof api?.saveScene === 'function',
                importCadFileAvailable: typeof api?.importCadFile === 'function',
                importModelFolderAvailable: typeof api?.importModelFolder === 'function',
                mqttConfigureAvailable: typeof api?.mqttConfigure === 'function',
                ipcRoundTripAvailable: false,
                ipcError: null
              };
              if (result.readyState === 'complete' && result.rootChildCount > 0 && result.editorApiAvailable) {
                try {
                  const [recentWorkspaces, projectAssets, mqttStatus] = await Promise.all([
                    api.getRecentWorkspaces(),
                    api.listProjectAssets(),
                    api.mqttGetStatus()
                  ]);
                  result.ipcRoundTripAvailable = Boolean(recentWorkspaces && projectAssets && mqttStatus);
                } catch (error) {
                  result.ipcError = error instanceof Error ? error.message : String(error);
                }
                resolve(result);
              } else if (Date.now() >= deadline) {
                resolve(result);
              } else {
                setTimeout(inspect, 200);
              }
            };
            void inspect();
          })`,
        },
      }));
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();

      if (message.error) {
        reject(new Error(`DevTools Runtime.evaluate 失败：${JSON.stringify(message.error)}`));
        return;
      }

      resolve(message.result?.result?.value ?? null);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('无法连接 Electron renderer 的 DevTools WebSocket。'));
    });
  });
}

/** 在 Electron 初始导航切换执行上下文时自动重连 DevTools。 */
async function inspectRendererWithRetry(port, childState) {
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const target = await waitForRendererTarget(port, childState);
    try {
      return await inspectRenderer(target.webSocketDebuggerUrl);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Execution context was destroyed') && !message.includes('WebSocket')) {
        throw error;
      }
      await delay(POLL_INTERVAL_MS * attempt);
    }
  }

  throw lastError ?? new Error('多次连接 Electron renderer 均失败。');
}
/** 仅终止本次冒烟启动的应用进程树。 */
function terminateProcessTree(processId) {
  if (!processId) return;
  spawnSync('taskkill', ['/PID', String(processId), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** 启动已打包程序并验证生产 renderer 与关键桌面 API。 */
async function runPackagedSmoke() {
  if (!existsSync(executablePath)) {
    throw new Error(`未找到待验证程序：${executablePath}`);
  }

  const debugPort = await reserveAvailablePort();
  const temporaryUserData = mkdtempSync(path.join(tmpdir(), 'babylon-editor-smoke-'));
  const output = [];
  const child = spawn(executablePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${temporaryUserData}`,
  ], {
    cwd: path.dirname(executablePath),
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_ENABLE_STACK_DUMPING: '1',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const childState = { exitCode: null };
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  child.once('exit', (code) => {
    childState.exitCode = code;
  });

  try {
    const renderer = await inspectRendererWithRetry(debugPort, childState);
    const valid = renderer
      && renderer.readyState === 'complete'
      && renderer.rootChildCount > 0
      && renderer.editorApiAvailable
      && renderer.saveSceneAvailable
      && renderer.importCadFileAvailable
      && renderer.importModelFolderAvailable
      && renderer.mqttConfigureAvailable
      && renderer.ipcRoundTripAvailable;

    if (!valid) {
      throw new Error(`安装态功能桥接未完整就绪：${JSON.stringify(renderer)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      executablePath,
      renderer,
    }, null, 2));
  } catch (error) {
    const recentOutput = output.join('').slice(-6000);
    if (recentOutput) console.error(recentOutput);
    throw error;
  } finally {
    terminateProcessTree(child.pid);
    rmSync(temporaryUserData, { recursive: true, force: true });
  }
}

runPackagedSmoke().catch((error) => {
  console.error(`[packaged-smoke] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});