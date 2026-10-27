/** 工作预算独立于画质/贴图预算；只限制临时分配，不静默改变输入。 */
export const LIGHTING_BAKE_CHUNK_BYTES = 4 * 1024 * 1024;
export const LIGHTING_BAKE_MAX_ASSET_BYTES = 256 * 1024 * 1024;
export const LIGHTING_BAKE_MAX_WORKING_BYTES = 1024 * 1024 * 1024;
export const LIGHTING_BAKE_MAX_INPUT_BYTES = 8 * 1024 * 1024 * 1024;
export type LightingBakeResourceBudget = {
  workingBytes: number; reserveBytes: number; availableBytes: number | null;
  backendBytes: number; maxInputBytes: number; chunkBytes: number;
};
export function lightingBakeResourceBudget(availableBytes: number | null): LightingBakeResourceBudget {
  const available = typeof availableBytes === 'number' && Number.isFinite(availableBytes) && availableBytes > 0 ? availableBytes : null;
  const reserveBytes = 512 * 1024 * 1024;
  // Viewer无系统余量接口时只提供单项解码窗口，不将此默认值当作已测可用内存。
  const headroom = available === null ? 1024 * 1024 * 1024 : Math.max(0, available - reserveBytes);
  return { workingBytes: Math.min(LIGHTING_BAKE_MAX_WORKING_BYTES, Math.floor(headroom / 4)), reserveBytes,
    availableBytes: available, backendBytes: Math.floor(headroom * .75), maxInputBytes: LIGHTING_BAKE_MAX_INPUT_BYTES,
    chunkBytes: LIGHTING_BAKE_CHUNK_BYTES };
}
export function assertLightingWorkingBytes(bytes: number, budget: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(budget) || bytes > budget) {
    throw new Error(`烘焙资源不足：${label}需要约 ${(bytes / 1048576).toFixed(1)} MiB 临时空间，当前预算 ${(budget / 1048576).toFixed(1)} MiB；未降低画质或丢弃对象。`);
  }
}
/** 浏览器不公开完整RSS；这里只约束可观察的JS堆余量，缺失不伪造零。 */
export function assertLightingRendererHeadroom(additionalBytes: number): void {
  const memory = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })?.memory;
  if (memory && Number.isFinite(memory.usedJSHeapSize) && Number.isFinite(memory.jsHeapSizeLimit)) {
    assertLightingWorkingBytes(additionalBytes, Math.max(0, memory.jsHeapSizeLimit - memory.usedJSHeapSize - 128 * 1048576), '前端准备');
  }
}
