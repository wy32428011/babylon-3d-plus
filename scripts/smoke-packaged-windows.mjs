import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
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
const DATA_PLATFORM_WORKSPACE_DIRECTORY = 'data-platform-workspace';
const PACKAGED_SMOKE_PROJECT_ID = '9000000000000000001';

/** 暂停指定毫秒数，供启动状态轮询复用。 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 向操作系统申请一个当前可用的本地调试端口。 */
function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
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

/** 启动最小数据中台服务，验证安装态默认工作区可实际打开项目并同步空模型库。 */
function startDataPlatformMockServer() {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        for await (const _chunk of request) {
          // 消费请求体，避免客户端连接在响应前保持等待。
        }

        const sendJson = (payload, status = 200) => {
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify(payload));
        };

        if (request.method === 'POST' && url.pathname === '/platform/api/v1/projects/query') {
          sendJson({
            success: true,
            data: {
              records: [{
                id: PACKAGED_SMOKE_PROJECT_ID,
                projectName: '安装态存储验证项目',
                sceneCount: 0,
                screenCount: 0,
                modelCount: 0,
                envModelCount: 0,
                comboModelCount: 0,
                poiCount: 0,
                chartCount: 0,
                themeCount: 0,
                latestEditorProjectId: null,
                latestEditorProjectVersionId: null,
                latestEditorProjectVersionNumber: null,
                latestEditorProjectName: null,
                latestEditorProjectPackageUrl: null,
                latestEditorProjectPackageFileName: null,
                updatedAt: '2026-07-23T00:00:00Z',
              }],
              total: 1,
              pageNum: 1,
              pageSize: 12,
            },
          });
          return;
        }

        if (
          request.method === 'POST'
          && [
            '/platform/api/v1/models/query',
            '/platform/api/v1/env-models/query',
            '/platform/api/v1/combo-models/query',
          ].includes(url.pathname)
        ) {
          sendJson({ success: true, data: { records: [], total: 0, pageNum: 1, pageSize: 100 } });
          return;
        }

        sendJson({ success: false, message: `未处理的安装态烟测请求：${request.method} ${url.pathname}` }, 404);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: false, message: error instanceof Error ? error.message : String(error) }));
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (!port) {
        server.close();
        reject(new Error('无法启动安装态数据中台模拟服务。'));
        return;
      }
      server.off('error', reject);
      resolve({
        baseUrl: `http://127.0.0.1:${port}/platform`,
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error) rejectClose(error);
            else resolveClose();
          });
        }),
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
function inspectRenderer(webSocketDebuggerUrl, dataPlatformBaseUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('读取 Electron renderer 状态超时。'));
    }, 45000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          awaitPromise: true,
          expression: `new Promise((resolve) => {
            const deadline = Date.now() + 25000;
            const dataPlatformBaseUrl = ${JSON.stringify(dataPlatformBaseUrl)};
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
                getDataPlatformConfigAvailable: typeof api?.getDataPlatformConfig === 'function',
                saveDataPlatformConfigAvailable: typeof api?.saveDataPlatformConfig === 'function',
                selectDataPlatformWorkspaceAvailable: typeof api?.selectDataPlatformWorkspace === 'function',
                resetDataPlatformWorkspaceAvailable: typeof api?.resetDataPlatformWorkspace === 'function',
                listDataPlatformProjectsAvailable: typeof api?.listDataPlatformProjects === 'function',
                openDataPlatformProjectAvailable: typeof api?.openDataPlatformProject === 'function',
                retryDataPlatformModelSyncAvailable: typeof api?.retryDataPlatformModelSync === 'function',
                dataPlatformModelSyncListenerAvailable: typeof api?.onDataPlatformModelSyncProgress === 'function',
                dataPlatformModelSyncListenerRoundTripAvailable: false,
                dataPlatformConfigRoundTripAvailable: false,
                dataPlatformWorkspaceRoot: null,
                dataPlatformUsesDefaultWorkspace: null,
                homeWorkspaceRoot: null,
                homeWorkspaceBadge: null,
                dataPlatformProjectListCount: 0,
                dataPlatformProjectOpened: false,
                dataPlatformProjectRoot: null,
                dataPlatformModelSyncCompleted: false,
                dataPlatformModelSyncError: null,
                ipcRoundTripAvailable: false,
                ipcError: null,
                hardwareWebGlAvailable: false,
                webGlContextType: null,
                webGlVersion: null,
                webGlVendor: null,
                webGlRenderer: null,
                webGlPowerPreference: null,
                webGlFailIfMajorPerformanceCaveat: null,
                webGlSoftwareRenderer: null,
                webGlError: null
              };
              if (result.readyState === 'complete' && result.rootChildCount > 0 && result.editorApiAvailable) {
                try {
                  const [recentWorkspaces, projectAssets, mqttStatus] = await Promise.all([
                    api.getRecentWorkspaces(),
                    api.listProjectAssets(),
                    api.mqttGetStatus()
                  ]);
                  result.ipcRoundTripAvailable = Boolean(recentWorkspaces && projectAssets && mqttStatus);
                  if (result.dataPlatformModelSyncListenerAvailable) {
                    const unsubscribe = api.onDataPlatformModelSyncProgress(() => undefined);
                    result.dataPlatformModelSyncListenerRoundTripAvailable = typeof unsubscribe === 'function';
                    unsubscribe();
                  }
                  if (result.getDataPlatformConfigAvailable && result.saveDataPlatformConfigAvailable) {
                    await api.getDataPlatformConfig();
                    const savedDataPlatformConfig = await api.saveDataPlatformConfig({
                      baseUrl: dataPlatformBaseUrl
                    });
                    const reloadedDataPlatformConfig = await api.getDataPlatformConfig();
                    result.dataPlatformConfigRoundTripAvailable = savedDataPlatformConfig?.baseUrl === dataPlatformBaseUrl
                      && reloadedDataPlatformConfig?.baseUrl === savedDataPlatformConfig.baseUrl
                      && reloadedDataPlatformConfig?.workspaceRoot === savedDataPlatformConfig.workspaceRoot
                      && reloadedDataPlatformConfig?.usesDefaultWorkspace === savedDataPlatformConfig.usesDefaultWorkspace;
                    result.dataPlatformWorkspaceRoot = reloadedDataPlatformConfig?.workspaceRoot ?? null;
                    result.dataPlatformUsesDefaultWorkspace = reloadedDataPlatformConfig?.usesDefaultWorkspace ?? null;
                    result.homeWorkspaceRoot = document.querySelector('.home-workspace-path')?.getAttribute('title') ?? null;
                    result.homeWorkspaceBadge = document.querySelector('.home-workspace-badge')?.textContent?.trim() ?? null;

                    const projectList = await api.listDataPlatformProjects({ projectName: '' });
                    result.dataPlatformProjectListCount = projectList?.records?.length ?? 0;
                    const project = projectList?.records?.[0];
                    if (project && result.openDataPlatformProjectAvailable) {
                      const openResult = await api.openDataPlatformProject({ projectId: project.id });
                      result.dataPlatformProjectOpened = Boolean(openResult?.projectRoot);
                      result.dataPlatformProjectRoot = openResult?.projectRoot ?? null;

                      if (openResult?.modelSyncStarted && result.dataPlatformModelSyncListenerAvailable) {
                        const finalProgress = await new Promise((resolveProgress, rejectProgress) => {
                          const progressTimeout = setTimeout(() => {
                            unsubscribe();
                            rejectProgress(new Error('等待安装态模型同步完成超时'));
                          }, 15000);
                          const unsubscribe = api.onDataPlatformModelSyncProgress((progress) => {
                            if (progress.phase !== 'completed' && progress.phase !== 'failed') return;
                            clearTimeout(progressTimeout);
                            unsubscribe();
                            resolveProgress(progress);
                          });
                        });
                        result.dataPlatformModelSyncCompleted = finalProgress?.phase === 'completed';
                        result.dataPlatformModelSyncError = finalProgress?.error ?? null;
                      } else {
                        result.dataPlatformModelSyncCompleted = true;
                      }
                    }
                  }
                } catch (error) {
                  result.ipcError = error instanceof Error ? error.message : String(error);
                }

                try {
                  const enterEditorButton = Array.from(document.querySelectorAll('button'))
                    .find((button) => button.textContent?.includes('进入空白编辑器'));
                  if (!enterEditorButton) throw new Error('未找到进入空白编辑器按钮');
                  enterEditorButton.click();

                  const viewportDeadline = Date.now() + 10000;
                  let canvas = null;
                  while (Date.now() < viewportDeadline) {
                    const sceneError = document.querySelector('.scene-error');
                    if (sceneError) throw new Error(sceneError.textContent?.trim() || 'Scene View 初始化失败');
                    const candidateCanvas = document.querySelector('canvas.scene-canvas');
                    const drawingBufferReady = candidateCanvas
                      && candidateCanvas.width > 0
                      && candidateCanvas.height > 0
                      && (candidateCanvas.width !== 300 || candidateCanvas.height !== 150);
                    if (drawingBufferReady) {
                      canvas = candidateCanvas;
                      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
                      const initializedError = document.querySelector('.scene-error');
                      if (initializedError) throw new Error(initializedError.textContent?.trim() || 'Scene View 初始化失败');
                      break;
                    }
                    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
                  }
                  if (!canvas) throw new Error('等待安装态 Scene View canvas 超时');

                  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
                  if (!gl) throw new Error('安装态 Scene View 未创建 WebGL 上下文');
                  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                  const renderer = debugInfo
                    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
                    : gl.getParameter(gl.RENDERER);
                  const vendor = debugInfo
                    ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
                    : gl.getParameter(gl.VENDOR);
                  const contextAttributes = gl.getContextAttributes();
                  const softwareRenderer =
                    /swiftshader|llvmpipe|lavapipe|softpipe|software (?:adapter|rasterizer|renderer)|microsoft basic render driver|(?:direct3d|d3d)\\s*warp/i
                      .test(String(renderer ?? ''));

                  result.hardwareWebGlAvailable = !softwareRenderer;
                  result.webGlContextType = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
                    ? 'webgl2'
                    : 'webgl';
                  result.webGlVersion = gl.getParameter(gl.VERSION);
                  result.webGlVendor = vendor;
                  result.webGlRenderer = renderer;
                  result.webGlPowerPreference = contextAttributes?.powerPreference ?? null;
                  result.webGlFailIfMajorPerformanceCaveat = contextAttributes?.failIfMajorPerformanceCaveat ?? null;
                  result.webGlSoftwareRenderer = softwareRenderer;
                } catch (error) {
                  result.webGlError = error instanceof Error ? error.message : String(error);
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
async function inspectRendererWithRetry(port, childState, dataPlatformBaseUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const target = await waitForRendererTarget(port, childState);
    try {
      return await inspectRenderer(target.webSocketDebuggerUrl, dataPlatformBaseUrl);
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

/** 启动已打包程序并验证生产 renderer、关键桌面 API 与硬件加速 WebGL。 */
async function runPackagedSmoke() {
  if (!existsSync(executablePath)) {
    throw new Error(`未找到待验证程序：${executablePath}`);
  }

  const debugPort = await reserveAvailablePort();
  const mock = await startDataPlatformMockServer();
  const temporaryUserData = mkdtempSync(path.join(tmpdir(), 'babylon-editor-smoke-'));
  const expectedDataPlatformRoot = path.join(temporaryUserData, DATA_PLATFORM_WORKSPACE_DIRECTORY);
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
    const renderer = await inspectRendererWithRetry(debugPort, childState, mock.baseUrl);
    const valid = renderer
      && renderer.readyState === 'complete'
      && renderer.rootChildCount > 0
      && renderer.editorApiAvailable
      && renderer.saveSceneAvailable
      && renderer.importCadFileAvailable
      && renderer.importModelFolderAvailable
      && renderer.mqttConfigureAvailable
      && renderer.getDataPlatformConfigAvailable
      && renderer.saveDataPlatformConfigAvailable
      && renderer.selectDataPlatformWorkspaceAvailable
      && renderer.resetDataPlatformWorkspaceAvailable
      && renderer.listDataPlatformProjectsAvailable
      && renderer.openDataPlatformProjectAvailable
      && renderer.retryDataPlatformModelSyncAvailable
      && renderer.dataPlatformModelSyncListenerAvailable
      && renderer.dataPlatformModelSyncListenerRoundTripAvailable
      && renderer.dataPlatformConfigRoundTripAvailable
      && path.resolve(renderer.dataPlatformWorkspaceRoot) === path.resolve(expectedDataPlatformRoot)
      && renderer.dataPlatformUsesDefaultWorkspace === true
      && path.resolve(renderer.homeWorkspaceRoot) === path.resolve(expectedDataPlatformRoot)
      && renderer.homeWorkspaceBadge === '默认'
      && renderer.dataPlatformProjectListCount === 1
      && renderer.dataPlatformProjectOpened
      && renderer.dataPlatformModelSyncCompleted
      && path.resolve(renderer.dataPlatformProjectRoot) === path.resolve(expectedDataPlatformRoot)
      && existsSync(path.join(expectedDataPlatformRoot, '.babylon-editor', 'asset-index.json'))
      && existsSync(path.join(expectedDataPlatformRoot, 'Assets', 'Models'))
      && existsSync(path.join(expectedDataPlatformRoot, 'Assets', 'Environments'))
      && renderer.ipcRoundTripAvailable
      && renderer.hardwareWebGlAvailable
      && renderer.webGlPowerPreference === 'high-performance'
      && renderer.webGlFailIfMajorPerformanceCaveat === true
      && renderer.webGlSoftwareRenderer === false
      && typeof renderer.webGlVersion === 'string'
      && renderer.webGlVersion.includes('WebGL')
      && typeof renderer.webGlRenderer === 'string'
      && renderer.webGlRenderer.length > 0
      && renderer.webGlError === null;

    if (!valid) {
      throw new Error(`安装态功能桥接未完整就绪：${JSON.stringify(renderer)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      executablePath,
      expectedDataPlatformRoot,
      renderer,
    }, null, 2));
  } catch (error) {
    const recentOutput = output.join('').slice(-6000);
    if (recentOutput) console.error(recentOutput);
    throw error;
  } finally {
    terminateProcessTree(child.pid);
    await mock.close().catch(() => undefined);
    rmSync(temporaryUserData, { recursive: true, force: true });
  }
}

runPackagedSmoke().catch((error) => {
  console.error(`[packaged-smoke] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});