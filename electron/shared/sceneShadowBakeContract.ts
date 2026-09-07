/** 编辑器与部署打包共用的静态阴影契约；仅处理 JSON，不加载渲染引擎。 */
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

/**
 * 静态描述的是烘焙结果，不是设备类型：脚本、遥测、动画模型均按更新时的姿态参与。
 * 保留实体关联校验；物理网格、可见性及辅助标记由运行时统一筛选。
 */
export function createShadowBakeEntityPredicateContract(value: unknown): (entityId: string) => boolean {
  const entities = object(object(value).entities);
  const states = new Map<string, boolean>();
  const visiting = new Set<string>();
  const check = (entityId: string): boolean => {
    const known = states.get(entityId);
    if (known !== undefined) return known;
    if (visiting.has(entityId) || !entities[entityId]) return false;
    visiting.add(entityId);
    const entity = object(entities[entityId]);
    const sourceId = object(object(entity.components).modelArrayInstance).sourceEntityId;
    const result = (typeof entity.parentId !== 'string' || check(entity.parentId))
      && (typeof sourceId !== 'string' || check(sourceId));
    visiting.delete(entityId);
    states.set(entityId, result);
    return result;
  };
  return check;
}

/** 兼容旧调用名称；返回当前姿态的烘焙资格，不再排除运动配置。 */
export function isStaticShadowEntityContract(document: unknown, entityId: string): boolean {
  return createShadowBakeEntityPredicateContract(document)(entityId);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 双 32 位摘要用于变更检测；完整资源路径和修订参与摘要，防止同名资源被误复用。 */
export function getSceneShadowBakeSignatureContract(value: unknown): string {
  const document = object(value);
  const settings = object(document.sceneSettings);
  const shadows = object(settings.shadows);
  const environment = object(settings.environment);
  const entities = object(document.entities);
  const canBake = createShadowBakeEntityPredicateContract(document);
  const entitySnapshots = Object.keys(entities).sort().filter(canBake).map((id) => {
    const entity = object(entities[id]);
    const components = object(entity.components);
    if (components.skybox || components.camera || components.cadReference) return null;
    const asset = object(components.modelAsset);
    return {
      id, parentId: entity.parentId ?? null, visible: entity.visible !== false,
      transform: components.transform,
      meshRenderer: components.meshRenderer,
      modelAsset: components.modelAsset ? {
        sourcePath: asset.sourcePath, sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
        lengthUnit: asset.lengthUnit, unitScaleToMeters: asset.unitScaleToMeters,
        parameterValues: asset.parameterValues,
        parameterConfig: asset.parameterConfig,
        parameterScriptMetadata: asset.parameterScriptMetadata,
        animationScriptMetadata: asset.animationScriptMetadata,
        scriptAssets: asset.scriptAssets,
        dataDrivenConfig: asset.dataDrivenConfig,
      } : undefined,
      modelArray: components.modelArray,
      modelArrayInstance: components.modelArrayInstance,
      modelGenerator: components.modelGenerator,
      telemetryBinding: components.telemetryBinding,
      autoPatrol: components.autoPatrol,
      manualRoamSpawn: components.manualRoamSpawn,
      light: components.light,
    };
  }).filter(Boolean);
  const source = stableJson({
    version: 2,
    environment: settings.environment ? {
      packagePath: environment.packagePath, activeVariantUrl: environment.activeVariantUrl,
      dataPlatformResourceId: environment.dataPlatformResourceId,
      dataPlatformRevision: environment.dataPlatformRevision,
      lengthUnit: environment.lengthUnit, unitScaleToMeters: environment.unitScaleToMeters,
      placementMode: environment.placementMode, transform: environment.transform,
      visible: environment.visible !== false,
    } : null,
    entities: entitySnapshots,
    sunAzimuthDegrees: shadows.sunAzimuthDegrees, sunElevationDegrees: shadows.sunElevationDegrees,
    darkness: shadows.darkness,
    bias: shadows.bias, normalBias: shadows.normalBias,
  });
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `shadow-v1-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** 没有环境接收面的场景无需烘焙；显式实时模式沿用现有发布路径。 */
export function getSceneShadowBakeErrorContract(value: unknown): string | null {
  const settings = object(object(value).sceneSettings);
  const shadows = object(settings.shadows);
  if (shadows.enabled === false || shadows.mode === 'realtime' || !settings.environment) return null;
  const bake = sanitizeSceneShadowBake(shadows.bake);
  if (!bake) return '静态阴影尚未烘焙或结果无效，请先在场景属性中点击“更新阴影”，再发布或导出。';
  if (bake.signature !== getSceneShadowBakeSignatureContract(value)) {
    return '静态阴影已过期，请先在场景属性中点击“更新阴影”，再发布或导出。';
  }
  return null;
}

export type SceneShadowBakeSnapshot = {
  version: 1;
  signature: string;
  createdAt: string;
  surfaces: Array<{
    key: string;
    /** 缺省为已合成颜色；shadow-mask 保留基础纹理，仅叠加静态遮罩。 */
    kind?: 'shadow-mask';
    /** 共享遮罩引用同快照内具有 PNG 的表面；引用项 dataUrl 必须为空，禁止链式引用。 */
    textureRef?: string;
    dataUrl: string;
    width: number;
    height: number;
    /** 颜色贴图为模型 UV 范围；shadow-mask 为世界坐标 XZ 范围。 */
    uvBounds: [number, number, number, number];
  }>;
};

export const SCENE_SHADOW_BAKE_MAX_PIXELS = 128 * 1024 * 1024;
export const SCENE_SHADOW_BAKE_MAX_DATA_URL_LENGTH = 32 * 1024 * 1024;

function hasMatchingPngDimensions(dataUrl: string, width: number, height: number): boolean {
  if (dataUrl.length < 'data:image/png;base64,'.length + 32) return false;
  const header = atob(dataUrl.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 32));
  if (header.length < 24 || header.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || header.slice(12, 16) !== 'IHDR') return false;
  const readUint32 = (offset: number) => ((header.charCodeAt(offset) * 0x1000000)
    + (header.charCodeAt(offset + 1) << 16) + (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3));
  return readUint32(16) === width && readUint32(20) === height;
}

/** 快照整体通过校验才保留，防止部分表面有阴影、部分表面无阴影。 */
export function sanitizeSceneShadowBake(value: unknown): SceneShadowBakeSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const bake = value as SceneShadowBakeSnapshot;
  if (bake.version !== 1 || typeof bake.signature !== 'string' || !/^shadow-v1-[0-9a-f]{16}$/.test(bake.signature)
    || typeof bake.createdAt !== 'string' || !Number.isFinite(Date.parse(bake.createdAt))
    || !Array.isArray(bake.surfaces) || bake.surfaces.length === 0) return null;
  let pixels = 0;
  let dataLength = 0;
  const surfacesByKey = new Map<string, SceneShadowBakeSnapshot['surfaces'][number]>();
  const textureUrlsByDimensions = new Map<string, Set<string>>();
  for (const surface of bake.surfaces) {
    if (!surface || typeof surface.key !== 'string' || !surface.key || surfacesByKey.has(surface.key)
      || (surface.kind !== undefined && surface.kind !== 'shadow-mask')
      || !Number.isInteger(surface.width) || surface.width < 1 || surface.width > 8192
      || !Number.isInteger(surface.height) || surface.height < 1 || surface.height > 8192
      || typeof surface.dataUrl !== 'string' || surface.dataUrl.length > SCENE_SHADOW_BAKE_MAX_DATA_URL_LENGTH
      || !Array.isArray(surface.uvBounds) || surface.uvBounds.length !== 4
      || !surface.uvBounds.every(Number.isFinite)
      || surface.uvBounds[2] <= surface.uvBounds[0] || surface.uvBounds[3] <= surface.uvBounds[1]) return null;
    surfacesByKey.set(surface.key, surface);
    if (surface.textureRef !== undefined) {
      if (surface.kind !== 'shadow-mask' || typeof surface.textureRef !== 'string'
        || !surface.textureRef || surface.textureRef === surface.key || surface.dataUrl !== '') return null;
      continue;
    }
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(surface.dataUrl)
      || !hasMatchingPngDimensions(surface.dataUrl, surface.width, surface.height)) return null;
    // 同一遮罩可被多个环境表面共用，显存预算按真实唯一纹理计；序列化体积仍逐条累计。
    const dimensions = `${surface.width}x${surface.height}`;
    const textureUrls = textureUrlsByDimensions.get(dimensions) ?? new Set<string>();
    if (!textureUrls.has(surface.dataUrl)) {
      pixels += surface.width * surface.height;
      textureUrls.add(surface.dataUrl);
      textureUrlsByDimensions.set(dimensions, textureUrls);
    }
    dataLength += surface.dataUrl.length;
    if (pixels > SCENE_SHADOW_BAKE_MAX_PIXELS || dataLength > SCENE_SHADOW_BAKE_MAX_DATA_URL_LENGTH) return null;
  }
  // 全部载荷校验后再解析引用，允许前向引用，但不展开 PNG，避免保存时重复数据。
  for (const surface of bake.surfaces) {
    if (surface.textureRef === undefined) continue;
    const target = surfacesByKey.get(surface.textureRef);
    if (!target || target.textureRef !== undefined || target.kind !== 'shadow-mask'
      || target.width !== surface.width || target.height !== surface.height) return null;
  }
  return { version: 1, signature: bake.signature, createdAt: bake.createdAt,
    surfaces: bake.surfaces.map((surface) => ({ key: surface.key,
      ...(surface.kind === 'shadow-mask' ? { kind: surface.kind } : {}),
      ...(surface.textureRef !== undefined ? { textureRef: surface.textureRef } : {}), dataUrl: surface.dataUrl,
      width: surface.width, height: surface.height, uvBounds: [...surface.uvBounds] })) };
}
