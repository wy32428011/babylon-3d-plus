import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const WORKSPACE_ROOT = process.cwd();
const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|lavapipe|softpipe|software (?:adapter|rasterizer|renderer)|microsoft basic render driver|(?:direct3d|d3d)\s*warp/i;

function isEnabledFeature(status) {
  return typeof status === 'string' && status.startsWith('enabled');
}

function createUserDataRoot() {
  return mkdtempSync(path.join(tmpdir(), 'zending-gpu-smoke-'));
}

function launchEditor(userDataRoot, extraArgs = []) {
  return electron.launch({
    args: [WORKSPACE_ROOT, `--user-data-dir=${userDataRoot}`, ...extraArgs],
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' },
  });
}

async function withEditor(extraArgs, run) {
  const userDataRoot = createUserDataRoot();
  let launched = null;
  try {
    launched = await launchEditor(userDataRoot, extraArgs);
    return await run(launched);
  } finally {
    try {
      await launched?.close();
    } finally {
      rmSync(userDataRoot, { recursive: true, force: true });
    }
  }
}

await withEditor([], async (launched) => {
  const rendererEvents = [];
  try {
    const mainWindow = await launched.firstWindow();
    mainWindow.on('console', (message) => rendererEvents.push('[console:' + message.type() + '] ' + message.text()));
    mainWindow.on('pageerror', (error) => rendererEvents.push('[pageerror] ' + error.message));

    await mainWindow.getByRole('button', { name: '进入空白编辑器' }).click();
    const canvas = mainWindow.locator('canvas.scene-canvas');
    await canvas.waitFor({ state: 'visible', timeout: 30_000 });
    const performanceSummary = mainWindow.locator('.scene-performance-summary');
    await performanceSummary.waitFor({ state: 'visible', timeout: 30_000 });
    await mainWindow.waitForTimeout(1_000);
    const performanceSummaryText = (await performanceSummary.innerText()).trim();
    await performanceSummary.click();
    const performanceDetails = mainWindow.locator('.scene-performance-details');
    await performanceDetails.waitFor({ state: 'visible', timeout: 10_000 });
    const performanceDetailsText = (await performanceDetails.innerText()).trim();

    const performanceToggle = mainWindow.getByRole('checkbox', { name: '性能监控' });
    await performanceToggle.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await performanceToggle.isChecked(), true, 'Toolbar 性能监控开关默认应开启');
    await performanceToggle.uncheck();
    await performanceSummary.waitFor({ state: 'hidden', timeout: 10_000 });
    await performanceDetails.waitFor({ state: 'hidden', timeout: 10_000 });
    assert.equal(await performanceToggle.isChecked(), false, 'Toolbar 未切换到隐藏状态');
    await mainWindow.waitForTimeout(1_200);
    await performanceToggle.check();
    await performanceSummary.waitFor({ state: 'visible', timeout: 10_000 });
    await performanceDetails.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await performanceToggle.isChecked(), true, 'Toolbar 未恢复性能监控显示状态');
    const restoredPerformanceSummaryText = (await performanceSummary.innerText()).trim();

    const mainProcess = await launched.evaluate(async ({ app }) => ({
      hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
      forceHighPerformanceGpu: app.commandLine.hasSwitch('force_high_performance_gpu'),
      softwareRasterizerDisabled: app.commandLine.hasSwitch('disable-software-rasterizer'),
      gpuSandboxDisabled: app.commandLine.hasSwitch('disable-gpu-sandbox'),
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

    assert.equal(mainProcess.hardwareAccelerationEnabled, true, 'Electron 硬件加速未启用');
    assert.equal(mainProcess.forceHighPerformanceGpu, true, 'Electron 未请求高性能 GPU');
    assert.equal(mainProcess.softwareRasterizerDisabled, true, 'Electron 未禁用软件 3D rasterizer');
    assert.equal(mainProcess.gpuSandboxDisabled, false, '开发态不应关闭 GPU sandbox');
    assert.equal(
      isEnabledFeature(mainProcess.featureStatus.webgl),
      true,
      'Electron WebGL 状态异常：' + mainProcess.featureStatus.webgl,
    );
    assert.equal(
      isEnabledFeature(mainProcess.featureStatus.gpu_compositing),
      true,
      'Electron GPU compositing 状态异常：' + mainProcess.featureStatus.gpu_compositing,
    );
    assert.equal(renderer.supported, true, 'Scene View 未创建 WebGL 上下文');
    assert.match(performanceSummaryText, /FPS[\s\S]*ms[\s\S]*DC/, 'Scene View 性能摘要未显示 FPS/frame/DC');
    assert.match(performanceDetailsText, /GPU frame/, 'Scene View 性能详情未显示 GPU frame 指标');
    assert.match(performanceDetailsText, /完整同步/, 'Scene View 性能详情未显示运行时同步指标');
    assert.match(performanceDetailsText, /复制最近一分钟报告/, 'Scene View 性能详情未提供报告入口');
    assert.match(restoredPerformanceSummaryText, /FPS[\s\S]*ms[\s\S]*DC/, '性能监控重新显示后摘要未恢复');
    assert.equal(await performanceDetails.isVisible(), true, 'Toolbar 恢复显示后应恢复原有详情展开状态');
    assert.equal(renderer.attributes?.powerPreference, 'high-performance', 'WebGL 未请求 high-performance GPU');
    assert.equal(renderer.attributes?.failIfMajorPerformanceCaveat, true, 'WebGL 仍允许重大性能降级');
    assert.equal(
      SOFTWARE_RENDERER_PATTERN.test(renderer.renderer ?? ''),
      false,
      '检测到软件 renderer：' + renderer.renderer,
    );
    if (activeGpu?.deviceString) {
      assert.equal(
        SOFTWARE_RENDERER_PATTERN.test(activeGpu.deviceString),
        false,
        'Electron 激活了软件 GPU：' + activeGpu.deviceString,
      );
    }

    console.log(JSON.stringify({
      status: 'PASS',
      activeGpu,
      featureStatus: mainProcess.featureStatus,
      renderer,
      performanceHud: {
        summary: performanceSummaryText,
        details: performanceDetailsText,
        restoredSummary: restoredPerformanceSummaryText,
        toolbarHideShow: 'passed',
      },
    }, null, 2));
  } catch (error) {
    if (rendererEvents.length > 0) console.error(rendererEvents.slice(-20).join('\n'));
    throw error;
  }
});

await withEditor(['--disable-gpu'], async (softwareFallback) => {
  const mainWindow = await softwareFallback.firstWindow();
  await mainWindow.getByRole('button', { name: '进入空白编辑器' }).click();
  const errorPanel = mainWindow.locator('.scene-error');
  await errorPanel.waitFor({ state: 'visible', timeout: 30_000 });

  const message = (await errorPanel.innerText()).trim();
  const mainProcess = await softwareFallback.evaluate(({ app }) => ({
    disableGpu: app.commandLine.hasSwitch('disable-gpu'),
    featureStatus: app.getGPUFeatureStatus(),
  }));

  assert.equal(mainProcess.disableGpu, true, '软件回退夹具未成功传入 --disable-gpu');
  assert.equal(isEnabledFeature(mainProcess.featureStatus.webgl), false, '禁用 GPU 后 WebGL 不应继续报告硬件启用');
  assert.match(message, /硬件加速 WebGL 创建失败|不支持 WebGL/, 'Scene View 未显示硬件 WebGL 阻断信息');

  console.log(JSON.stringify({
    status: 'PASS',
    softwareFallback: 'blocked',
    message,
    featureStatus: mainProcess.featureStatus,
  }, null, 2));
});
