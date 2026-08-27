import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [engineSource, playerSource, sceneViewSource, backgroundRequesterSource, backgroundWorkerSource] = await Promise.all([
  readFile('src/runtime/babylon/createEngine.ts', 'utf8'),
  readFile('src/player/PlayerApp.tsx', 'utf8'),
  readFile('src/editor/panels/SceneViewPanel.tsx', 'utf8'),
  readFile('src/runtime/babylon/backgroundFrameRequester.ts', 'utf8'),
  readFile('src/runtime/babylon/backgroundFrameWorker.ts', 'utf8'),
]);

const viewportFactoryStart = engineSource.indexOf('export function createBabylonViewport');
assert.notEqual(viewportFactoryStart, -1, '未找到 Babylon 视口创建入口');
const viewportFactorySource = engineSource.slice(viewportFactoryStart);

const playerViewportCall = playerSource.match(
  /createBabylonViewport\(canvas, handleRuntimeStatus, \{([\s\S]*?)\n\s*\}\);/,
)?.[1] ?? '';
assert.match(
  playerViewportCall,
  /requireHardwareAcceleration:\s*true/,
  '发布 Web Viewer 必须声明硬件加速诉求（探测成功时强制 GPU）',
);
assert.match(
  playerViewportCall,
  /keepRenderingInBackground:\s*true/,
  '发布 Web Viewer 必须显式启用后台帧调度',
);
assert.match(
  sceneViewSource,
  /requireHardwareAcceleration:\s*true/,
  '编辑器 Scene View 必须声明硬件加速诉求（探测成功时强制 GPU）',
);

assert.match(
  viewportFactorySource,
  /probeHardwareAccelerationAvailable/,
  '视口必须保留离屏画布硬件加速探测',
);
assert.match(
  viewportFactorySource,
  /const useHardwareAcceleration = requestedHardwareAcceleration && probeHardwareAccelerationAvailable\(\)/,
  '硬件加速必须经离屏探测确认后才强制启用',
);
assert.match(
  viewportFactorySource,
  /failIfMajorPerformanceCaveat:\s*useHardwareAcceleration/,
  '仅探测到硬件可用时才禁止重大性能降级和软件实现回退',
);
assert.doesNotMatch(
  viewportFactorySource,
  /failIfMajorPerformanceCaveat:\s*requireHardwareAcceleration/,
  '不得未经探测直接禁止软件渲染回退',
);
assert.match(
  viewportFactorySource,
  /已降级为软件渲染/,
  '硬件加速不可用时必须降级软件渲染并输出日志，不得直接报错',
);
assert.match(
  viewportFactorySource,
  /powerPreference:\s*['"]high-performance['"]/,
  'WebGL 必须请求 high-performance GPU',
);
assert.match(
  viewportFactorySource,
  /desynchronized:\s*false/,
  'WebGL 不得请求可能产生可见撕裂的 desynchronized 合成模式',
);
assert.match(
  viewportFactorySource,
  /if \(useHardwareAcceleration\) assertHardwareAcceleratedWebGL\(engine, options\.onLog\)/,
  '硬件加速模式必须校验实际 renderer，而不是只依赖上下文创建成功',
);
assert.match(
  viewportFactorySource,
  /engine\.runRenderLoop\(/,
  'Viewer 必须继续使用 Babylon 的显示帧同步渲染循环',
);
assert.match(
  viewportFactorySource,
  /createBackgroundFrameRequester/,
  '发布 Viewer 必须为隐藏标签安装后台帧请求器',
);
assert.match(
  viewportFactorySource,
  /engine\.renderEvenInBackground\s*=\s*true/,
  'Babylon Engine 必须显式允许后台渲染',
);
assert.match(
  backgroundRequesterSource,
  /new Worker\(new URL\(['"]\.\/backgroundFrameWorker\.ts['"], import\.meta\.url\)/,
  '后台帧 Worker 必须使用 Vite 打包后的同源脚本，兼容仅允许 worker-src self 的 CSP',
);
assert.match(
  backgroundRequesterSource,
  /type:\s*['"]module['"]/,
  '后台帧 Worker 必须以模块 Worker 加载',
);
assert.doesNotMatch(
  backgroundRequesterSource,
  /createObjectURL|new Blob/,
  '后台帧 Worker 不得依赖 CSP 可能禁止的 blob URL',
);
assert.match(
  backgroundWorkerSource,
  /message\.type === ['"]schedule['"]/,
  '后台 Worker 必须处理帧调度消息',
);
assert.match(
  backgroundWorkerSource,
  /message\.type === ['"]cancel['"]/,
  '后台 Worker 必须处理帧取消消息',
);

console.log(JSON.stringify({
  status: 'PASS',
  viewerPrefersHardwareAcceleration: true,
  probesHardwareBeforeEnforcing: true,
  degradesToSoftwareRendererWithLog: true,
  desynchronized: false,
}, null, 2));
