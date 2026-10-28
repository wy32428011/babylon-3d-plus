import type { HybridShadowMetrics } from './HybridShadowCache.ts';
import type { HybridShadowInvalidationMetrics } from './hybridShadowInvalidation.ts';

export type LightingShadowLightCost = HybridShadowInvalidationMetrics & {
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
  cacheBytes: number;
  cachedFaces: number;
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
