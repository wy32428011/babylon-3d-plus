/** 光照配置与烘焙合同共用的基础数据；不反向依赖配置、编辑器或运行时。 */
export type SceneLightingBakeSettings = {
  enabled: boolean;
  quality: 'preview' | 'standard' | 'high';
  atlasSize: 1024 | 2048 | 4096;
  texelsPerMeter: number;
  probeSpacing: number;
  maxTextureMiB: number;
  cacheStaticShadows: boolean;
  dynamicShadows: boolean;
};
export const DEFAULT_LIGHTING_BAKE_SETTINGS: SceneLightingBakeSettings = {
  enabled: true, quality: 'standard', atlasSize: 2048, texelsPerMeter: 32,
  probeSpacing: 4, maxTextureMiB: 256, cacheStaticShadows: true, dynamicShadows: true,
};
export type LightingBakeAsset = {
  id: string;
  kind: 'geometry' | 'lightmap' | 'probes';
  url: string;
  byteLength: number;
  sha256?: string;
  /** RGBM 贴图在线性空间解码；alpha 不是材质透明度。 */
  rgbmRange?: number;
};
export type LightingBakeSurface = {
  key: string;
  entityId: string;
  nodeKey: string;
  geometryAssetId: string;
  lightmapAssetId: string;
};
export type SceneLightingBakeSnapshot = {
  version: 1;
  signature: string;
  geometrySignature?: string;
  createdAt: string;
  engineVersion: string;
  assets: LightingBakeAsset[];
  surfaces: LightingBakeSurface[];
  probeAssetId: string;
  statistics: { meshCount: number; triangleCount: number; atlasCount: number; probeCount: number; textureBytes: number; durationMs: number };
};
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
export function normalizeSceneLightingBakeSettings(value: unknown): SceneLightingBakeSettings {
  const v = object(value), d = DEFAULT_LIGHTING_BAKE_SETTINGS;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    quality: v.quality === 'preview' || v.quality === 'high' ? v.quality : 'standard',
    atlasSize: v.atlasSize === 1024 || v.atlasSize === 4096 ? v.atlasSize : 2048,
    texelsPerMeter: finite(v.texelsPerMeter, d.texelsPerMeter, 4, 256),
    probeSpacing: finite(v.probeSpacing, d.probeSpacing, 0.5, 100),
    maxTextureMiB: finite(v.maxTextureMiB, d.maxTextureMiB, 16, 4096),
    cacheStaticShadows: typeof v.cacheStaticShadows === 'boolean' ? v.cacheStaticShadows : true,
    dynamicShadows: typeof v.dynamicShadows === 'boolean' ? v.dynamicShadows : true,
  };
}
export function validateSceneLightingBakeSnapshot(value: unknown): SceneLightingBakeSnapshot | null {
  const v = object(value);
  if (v.version !== 1 || typeof v.signature !== 'string' || !v.signature
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))
    || typeof v.engineVersion !== 'string' || !Array.isArray(v.assets) || !Array.isArray(v.surfaces)
    || !v.surfaces.length || typeof v.probeAssetId !== 'string') return null;
  const assets: LightingBakeAsset[] = [], ids = new Map<string, LightingBakeAsset>();
  for (const raw of v.assets) {
    const a = object(raw);
    if (typeof a.id !== 'string' || !a.id || ids.has(a.id)
      || !['geometry', 'lightmap', 'probes'].includes(String(a.kind))
      || typeof a.url !== 'string' || !a.url || /^(?:javascript|data|blob):/i.test(a.url)
      || typeof a.byteLength !== 'number' || !Number.isSafeInteger(a.byteLength) || a.byteLength < 0) return null;
    if (a.rgbmRange !== undefined && (typeof a.rgbmRange !== 'number' || !Number.isFinite(a.rgbmRange) || a.rgbmRange <= 0)) return null;
    const asset: LightingBakeAsset = {
      id: a.id, kind: a.kind as LightingBakeAsset['kind'], url: a.url, byteLength: a.byteLength,
      ...(typeof a.sha256 === 'string' ? { sha256: a.sha256 } : {}),
      ...(typeof a.rgbmRange === 'number' ? { rgbmRange: a.rgbmRange } : {}),
    };
    ids.set(asset.id, asset); assets.push(asset);
  }
  const surfaces: LightingBakeSurface[] = [], keys = new Set<string>();
  for (const raw of v.surfaces) {
    const s = object(raw);
    if (typeof s.key !== 'string' || !s.key || keys.has(s.key)
      || typeof s.entityId !== 'string' || typeof s.nodeKey !== 'string'
      || typeof s.geometryAssetId !== 'string' || ids.get(s.geometryAssetId)?.kind !== 'geometry'
      || typeof s.lightmapAssetId !== 'string' || ids.get(s.lightmapAssetId)?.kind !== 'lightmap') return null;
    keys.add(s.key);
    surfaces.push({ key: s.key, entityId: s.entityId, nodeKey: s.nodeKey, geometryAssetId: s.geometryAssetId, lightmapAssetId: s.lightmapAssetId });
  }
  if (ids.get(v.probeAssetId)?.kind !== 'probes') return null;
  const stats = object(v.statistics);
  for (const key of ['meshCount', 'triangleCount', 'atlasCount', 'probeCount', 'textureBytes', 'durationMs']) {
    if (typeof stats[key] !== 'number' || !Number.isFinite(stats[key]) || stats[key] < 0) return null;
  }
  return {
    version: 1, signature: v.signature, createdAt: v.createdAt, engineVersion: v.engineVersion,
    ...(typeof v.geometrySignature === 'string' ? { geometrySignature: v.geometrySignature } : {}),
    assets, surfaces, probeAssetId: v.probeAssetId, statistics: stats as SceneLightingBakeSnapshot['statistics'],
  };
}
