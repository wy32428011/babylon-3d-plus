import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const packageMetadata = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const defaultExecutablePath = path.join(
  projectRoot,
  'release',
  'win-unpacked',
  `${packageMetadata.productName}.exe`,
);
const executablePath = path.resolve(process.argv[2] ?? defaultExecutablePath);
const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|lavapipe|softpipe|software (?:adapter|rasterizer|renderer)|microsoft basic render driver|(?:direct3d|d3d)\s*warp/i;

/** 判断 Electron GPU feature 状态是否为硬件启用。 */
function isEnabledFeature(status) {
  return typeof status === 'string' && status.startsWith('enabled');
}

/** 为每次生产 EXE 验证创建隔离 userData，避免污染真实安装数据。 */
function createUserDataRoot() {
  return mkdtempSync(path.join(tmpdir(), 'zending-packaged-gpu-smoke-'));
}

if (!existsSync(executablePath)) {
  throw new Error(`未找到待验证的生产 EXE：${executablePath}`);
}

const userDataRoot = createUserDataRoot();
const rendererEvents = [];
let launched = null;

try {
  launched = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataRoot}`],
    cwd: path.dirname(executablePath),
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' },
    timeout: 30_000,
  });

  const mainWindow = await launched.firstWindow();
  mainWindow.on('console', (message) => rendererEvents.push(`[console:${message.type()}] ${message.text()}`));
  mainWindow.on('pageerror', (error) => rendererEvents.push(`[pageerror] ${error.message}`));

  await mainWindow.getByRole('button', { name: '进入空白编辑器' }).click();
  const canvas = mainWindow.locator('canvas.scene-canvas');
  await canvas.waitFor({ state: 'visible', timeout: 30_000 });
  await mainWindow.waitForTimeout(1_000);

  const mainProcess = await launched.evaluate(async ({ app }) => ({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
    forceHighPerformanceGpu: app.commandLine.hasSwitch('force_high_performance_gpu'),
    softwareRasterizerDisabled: app.commandLine.hasSwitch('disable-software-rasterizer'),
    featureStatus: app.getGPUFeatureStatus(),
    gpuInfo: await app.getGPUInfo('complete'),
  }));

  const renderer = await canvas.evaluate((target) => {
    const gl = target.getContext('webgl2') ?? target.getContext('webgl');
    if (!gl) return { supported: false };

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      supported: true,
      version: gl.getParameter(gl.VERSION),
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      attributes: gl.getContextAttributes(),
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      cssSize: [target.clientWidth, target.clientHeight],
    };
  });

  const gpuDevices = Array.isArray(mainProcess.gpuInfo?.gpuDevice) ? mainProcess.gpuInfo.gpuDevice : [];
  const activeGpu = gpuDevices.find((device) => device?.active === true) ?? null;

  assert.equal(mainProcess.isPackaged, true, '目标 EXE 不是 Electron packaged 应用');
  assert.equal(
    mainProcess.version,
    packageMetadata.version,
    `安装程序版本过旧：当前 ${mainProcess.version}，源码要求 ${packageMetadata.version}。请卸载旧版或使用最新安装包覆盖安装`,
  );
  assert.equal(mainProcess.hardwareAccelerationEnabled, true, '生产 EXE 未启用 Electron 硬件加速');
  assert.equal(mainProcess.forceHighPerformanceGpu, true, '生产 EXE 未请求高性能 GPU');
  assert.equal(mainProcess.softwareRasterizerDisabled, true, '生产 EXE 未禁用软件 3D rasterizer');
  assert.equal(
    isEnabledFeature(mainProcess.featureStatus.webgl),
    true,
    `生产 EXE WebGL 状态异常：${mainProcess.featureStatus.webgl}`,
  );
  assert.equal(
    isEnabledFeature(mainProcess.featureStatus.gpu_compositing),
    true,
    `生产 EXE GPU compositing 状态异常：${mainProcess.featureStatus.gpu_compositing}`,
  );
  assert.equal(renderer.supported, true, '生产 Scene View 未创建 WebGL 上下文');
  assert.equal(renderer.attributes?.powerPreference, 'high-performance', '生产 WebGL 未请求 high-performance GPU');
  assert.equal(renderer.attributes?.failIfMajorPerformanceCaveat, true, '生产 WebGL 仍允许重大性能降级');
  assert.equal(
    SOFTWARE_RENDERER_PATTERN.test(renderer.renderer ?? ''),
    false,
    `生产 EXE 检测到软件 renderer：${renderer.renderer}`,
  );
  assert.ok(activeGpu?.deviceString, 'Electron 未报告活动 GPU');
  assert.equal(
    SOFTWARE_RENDERER_PATTERN.test(activeGpu?.deviceString ?? ''),
    false,
    `Electron 激活了软件 GPU：${activeGpu?.deviceString}`,
  );

  console.log(JSON.stringify({
    status: 'PASS',
    executablePath,
    version: mainProcess.version,
    activeGpu,
    featureStatus: mainProcess.featureStatus,
    renderer,
  }, null, 2));
} catch (error) {
  if (rendererEvents.length > 0) console.error(rendererEvents.slice(-20).join('\n'));
  throw error;
} finally {
  try {
    await launched?.close();
  } finally {
    rmSync(userDataRoot, { recursive: true, force: true });
  }
}
