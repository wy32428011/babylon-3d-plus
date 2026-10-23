import { awaitLightingTaskStep } from './lightingBakeTask.ts';
import type { LightingBakeCaptureMetrics } from '../../../electron/shared/sceneLightingBakeContract.ts';

function readRendererHeap(): number | null {
  const value = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 计量真实视口导出；只记录最大观察值，不能作为进程 RSS 或精确峰值。 */
export async function captureLightingInputWithMetrics<T>(
  capture: (sample: () => void) => Promise<T>, signal?: AbortSignal,
  readHeap: () => number | null = readRendererHeap, now: () => number = () => performance.now(),
): Promise<{ value: T; metrics: LightingBakeCaptureMetrics }> {
  const readTime = () => {
    try { const value = now(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  };
  const started = readTime();
  let peak: number | null = null;
  const sample = () => {
    // 计量能力可能被浏览器禁用或业务脚本包装，缺失时不改变真实捕获结果。
    try {
      const value = readHeap();
      if (value !== null && Number.isFinite(value) && value >= 0) peak = Math.max(peak ?? 0, value);
    } catch { /* 非关键计量不可用，保留未测状态。 */ }
  };
  sample();
  const timer = setInterval(sample, 250);
  try {
    const value = await awaitLightingTaskStep(capture(sample), signal);
    sample();
    const finished = readTime();
    return { value, metrics: { durationMs: started !== null && finished !== null && finished >= started ? finished - started : null, rendererHeapMaxObservedBytes: peak,
      rendererHeapBasis: peak === null ? 'unavailable' : 'performance.memory.usedJSHeapSize' } };
  } finally { clearInterval(timer); }
}
