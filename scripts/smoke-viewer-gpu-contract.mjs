import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [engineSource, playerSource] = await Promise.all([
  readFile('src/runtime/babylon/createEngine.ts', 'utf8'),
  readFile('src/player/PlayerApp.tsx', 'utf8'),
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
  '发布 Web Viewer 必须要求硬件加速，不能静默进入软件 WebGL',
);

assert.match(
  viewportFactorySource,
  /const requireHardwareAcceleration = options\.requireHardwareAcceleration \?\? false/,
  '视口必须保留明确的硬件加速要求变量',
);
assert.match(
  viewportFactorySource,
  /powerPreference:\s*['"]high-performance['"]/,
  'WebGL 必须请求 high-performance GPU',
);
assert.match(
  viewportFactorySource,
  /failIfMajorPerformanceCaveat:\s*requireHardwareAcceleration/,
  '硬件加速模式必须禁止重大性能降级和软件实现回退',
);
assert.match(
  viewportFactorySource,
  /desynchronized:\s*false/,
  'WebGL 不得请求可能产生可见撕裂的 desynchronized 合成模式',
);
assert.match(
  viewportFactorySource,
  /if \(requireHardwareAcceleration\) assertHardwareAcceleratedWebGL\(candidate, options\.onLog\)/,
  '硬件加速模式必须校验实际 renderer，而不是只依赖上下文创建成功',
);
assert.doesNotMatch(
  viewportFactorySource,
  /probeHardwareAccelerationAvailable|已降级为软件渲染/,
  'requireHardwareAcceleration 不得在探测失败后静默降级为软件渲染',
);
assert.match(
  viewportFactorySource,
  /engine\.runRenderLoop\(/,
  'Viewer 必须继续使用 Babylon 的显示帧同步渲染循环',
);

console.log(JSON.stringify({
  status: 'PASS',
  viewerRequiresHardwareAcceleration: true,
  rejectsMajorPerformanceCaveat: true,
  rejectsSoftwareRenderer: true,
  desynchronized: false,
}, null, 2));
