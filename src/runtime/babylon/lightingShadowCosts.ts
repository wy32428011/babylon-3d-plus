import type { HybridShadowMetrics, NativeShadowCacheDiagnostics, NativeShadowRefreshPolicy } from './HybridShadowCache.ts';
import type { HybridShadowInvalidationMetrics } from './hybridShadowInvalidation.ts';

export type LightingShadowLightCost = HybridShadowInvalidationMetrics & NativeShadowCacheDiagnostics & {
  lightId: string;
  entityId?: string;
  name: string;
  type: 'directional' | 'point' | 'spot';
  mapWidth: number;
  mapHeight: number;
  faces: number;
  cascades: number;
  cubeFaces: number;
  shadowMapBytes: number;
  /** 原生调度无额外纹理副本，恒为 0。 */
  cacheBytes: number;
  /** 原生图中当前可复用的面数，不另计显存。 */
  cachedFaces: number;
  refreshPolicy: NativeShadowRefreshPolicy;
  refreshReason: string | null;
  /** 原生 subMesh/实例批次提交次数，不是分阶段绘制次数。 */
  staticRenders: number;
  dynamicRenders: number;
  cacheHits: number;
};
export type LightingSamplerDiagnostic = {
  materialId: string;
  materialName: string;
  requiredSamplers: number;
  limit: number;
  severity: 'near-limit' | 'over-limit';
  meshNames: string[];
};
/** 按当前资源形状估算的成本；不代表驱动实际分配的显存。 */
export type LightingShadowCostMetrics = {
  shadowMapBytes: number;
  cacheBytes: number;
  lights: LightingShadowLightCost[];
  samplerDiagnostics: LightingSamplerDiagnostic[];
};
export type LightingShadowMetrics = HybridShadowMetrics & LightingShadowCostMetrics;
