import { resolveSceneSkyboxReference, skyboxLightingIdentity } from './sceneSkyboxContract.ts';
import { GLB_STANDARD_ENVIRONMENT_ID } from './glbStandardPreview.ts';
/** 编辑器、后台烘焙及发布共享的纯数据合同，不依赖 Electron 或 Babylon。 */
import type { SceneLightingBakeSettings } from './sceneLightingBakeData.ts';
export { DEFAULT_LIGHTING_BAKE_SETTINGS, normalizeSceneLightingBakeSettings, validateSceneLightingBakeSnapshot, type SceneLightingBakeSettings, type SceneLightingBakeSnapshot, type LightingBakeAsset, type LightingBakeSurface } from './sceneLightingBakeData.ts';
import { getSceneLightingConfig } from './sceneLightingConfig.ts';
import { isLightingLightmapRecipeCompatible } from './sceneLightingTextureCodec.ts';
export { isLightingLightmapRecipeCompatible } from './sceneLightingTextureCodec.ts';
import type {
  LightingMotionRole, LightingPolicyContext, LightingPolicyConflict, LightingPolicyField,
  LightingPolicyFieldSources, LightingPolicyMismatch,
} from './sceneLightingPolicy.ts';
import {
  createSceneLightingPolicyResolver, getLightingPolicySignatureValue, matchesLightingPolicyTarget, normalizeLightingPolicyInheritance,
  normalizeSceneLightingPolicy, type SceneLightingPolicy,
} from './sceneLightingPolicy.ts';

export type LightingMobility = 'auto' | 'static' | 'dynamic';
export type LightingNodeOverride = {
  mobility: LightingMobility;
  castShadows?: boolean;
  receiveShadows?: boolean;
  bakeIndirect?: boolean;
  /** 新编辑方式用列表明确继承；缺省时保留历史 mobility:auto 继承对象的语义。 */
  inheritPolicy?: LightingPolicyField[];
};
export type EntityLightingSettings = {
  mobility: LightingMobility;
  castShadows: boolean;
  receiveShadows: boolean;
  bakeIndirect: boolean;
  resourceIdentity?: string;
  nodeOverrides: Record<string, LightingNodeOverride>;
  /** 列出的字段继承场景策略，未列出字段仍作为原有对象例外。 */
  inheritPolicy?: LightingPolicyField[];
};
export const DEFAULT_ENTITY_LIGHTING_SETTINGS: EntityLightingSettings = {
  mobility: 'auto', castShadows: true, receiveShadows: true, bakeIndirect: true, nodeOverrides: {},
};
export type LightingClassificationEntry = {
  key: string;
  entityId: string;
  nodeKey: string;
  name: string;
  mobility: 'static' | 'dynamic';
  reason: string;
  castShadows: boolean;
  receiveShadows: boolean;
  bakeIndirect: boolean;
  parentDynamic: boolean;
  unmatchedOverride?: boolean;
  resourceIdentity?: string;
  automaticMobility?: 'static' | 'dynamic';
  automaticReason?: string;
  motionRole?: LightingMotionRole;
  deviceType?: string;
  fieldSources?: LightingPolicyFieldSources;
  sourceLabel?: string;
  matchedRuleIds?: string[];
  policyMismatches?: LightingPolicyMismatch[];
  policyConflicts?: LightingPolicyConflict[];
  /** 仅运行时诊断，不写入实体组件；用于同一纯 resolver 计算草稿影响。 */
  policyContext?: LightingPolicyContext;
};
export type LightingBakeTextureInput = {
  /** 授权 editor-asset URL 或由当前渲染纹理导出的 PNG data URL。 */
  url: string;
  /** 颜色贴图的实际解码空间；法线/金属粗糙度等数据通道始终按线性数据读取。 */
  colorSpace?: 'srgb' | 'linear';
  coordinatesIndex?: number;
  uScale?: number;
  vScale?: number;
  uOffset?: number;
  vOffset?: number;
  wAng?: number;
  level?: number;
  invertY?: boolean;
  wrapU?: number;
  wrapV?: number;
  /** shader mat3 * vec3(uv,1) 的二维仿射，优先于分散的缩放/旋转字段。 */
  uvTransform?: [number, number, number, number, number, number];
};
export type LightingBakeMaterialInput = {
  baseColor: [number, number, number];
  alpha: number;
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  doubleSided: boolean;
  /** 原生有效透明模式，不能仅凭 alphaCutoff 属性存在就启用裁剪。 */
  alphaMode?: 'opaque' | 'mask' | 'blend' | 'mask-blend';
  useTextureAlpha?: boolean;
  useVertexAlpha?: boolean;
  /** 普通网格的逐对象透明度；与材质 alpha 及环境编辑器 ghost opacity 分开。 */
  meshVisibility?: number;
  alphaCutoff?: number;
  invertNormalMapX?: boolean;
  invertNormalMapY?: boolean;
  textures?: Partial<Record<'baseColor' | 'normal' | 'metallicRoughness' | 'emissive' | 'occlusion', LightingBakeTextureInput>>;
};
export type LightingBakeMeshInput = {
  key: string;
  entityId: string;
  nodeKey: string;
  name: string;
  positions: number[];
  normals: number[];
  indices: number[];
  uvs?: number[];
  uvs2?: number[];
  colors?: number[];
  tangents?: number[];
  /** Babylon 列主序矩阵；顶点保持局部坐标，后台必须保留坐标系和手性。 */
  worldMatrix: number[];
  material: LightingBakeMaterialInput;
  /** 仅作静态遮挡/反弹贡献，不为该表面生成接收贴图。 */
  receiver?: boolean;
};
export type LightingBakeLightInput = {
  kind: 'directional' | 'point' | 'spot' | 'area';
  position: [number, number, number];
  direction: [number, number, number];
  color: [number, number, number];
  intensity: number;
  range?: number;
  angle?: number;
  width?: number;
  height?: number;
  falloff?: 'standard' | 'physical' | 'gltf';
  exponent?: number;
  innerAngle?: number;
};
export type LightingBakeCaptureMetrics = { durationMs: number | null; rendererHeapMaxObservedBytes: number | null; rendererHeapBasis: 'performance.memory.usedJSHeapSize' | 'unavailable' };
export type LightingBakeInput = {
  /** 执行诊断，不属于物理输入或场景持久化配置。 */
  captureMetrics?: LightingBakeCaptureMetrics;
  version: 1;
  jobId: string;
  signature: string;
  geometrySignature?: string;
  sceneName: string;
  settings: SceneLightingBakeSettings;
  meshes: LightingBakeMeshInput[];
  lights: LightingBakeLightInput[];
  environment: { color: [number, number, number]; intensity: number; textureUrl?: string; rotation?: number };
};
export type LightingBakeGeometry = {
  /** v1 旧角点展开；v2 完整属性精确焊接，均保留原三角顺序。 */
  version: 1 | 2;
  positions: number[] | Float32Array;
  normals: number[] | Float32Array;
  indices: number[] | Uint32Array;
  uvs: number[] | Float32Array;
  uvs2?: number[] | Float32Array;
  colors?: number[] | Float32Array;
  tangents?: number[] | Float32Array;
  /** 与原纹理 UV 分离；运行时通过自定义属性采样，不占用已有 UV2/UV3。 */
  bakeUvs: number[] | Float32Array;
};
export type LightingProbeData = {
  version: 1;
  encoding: 'ambient-cube';
  spacing: number;
  /** 每点六个朝向依次 +X/-X/+Y/-Y/+Z/-Z，每方向 RGB，表示辐照度。 */
  probes: Array<{ position: [number, number, number]; irradiance: number[] }>;
};
export type LightingBakeProgress = {
  jobId: string;
  phase: 'preparing' | 'baking' | 'applying' | 'complete' | 'cancelled' | 'error';
  progress: number;
  message: string;
};
export type LightingBakeEngineStatus = { devices?: import('./sceneLightingBakeDevices.ts').LightingBakeDevice[]; available: boolean; path?: string; version?: string; message?: string };

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
}
export function normalizeEntityLightingSettings(value: unknown): EntityLightingSettings {
  const v = object(value);
  const nodeOverrides: Record<string, LightingNodeOverride> = {};
  for (const [key, raw] of Object.entries(object(v.nodeOverrides))) {
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const item = object(raw);
    nodeOverrides[key] = {
      mobility: item.mobility === 'static' || item.mobility === 'dynamic' ? item.mobility : 'auto',
      ...(typeof item.castShadows === 'boolean' ? { castShadows: item.castShadows } : {}),
      ...(typeof item.receiveShadows === 'boolean' ? { receiveShadows: item.receiveShadows } : {}),
      ...(typeof item.bakeIndirect === 'boolean' ? { bakeIndirect: item.bakeIndirect } : {}),
      ...(Array.isArray(item.inheritPolicy) ? { inheritPolicy: normalizeLightingPolicyInheritance(item.inheritPolicy)! } : {}),
    };
  }
  return {
    mobility: v.mobility === 'static' || v.mobility === 'dynamic' ? v.mobility : 'auto',
    castShadows: typeof v.castShadows === 'boolean' ? v.castShadows : true,
    receiveShadows: typeof v.receiveShadows === 'boolean' ? v.receiveShadows : true,
    bakeIndirect: typeof v.bakeIndirect === 'boolean' ? v.bakeIndirect : true,
    ...(typeof v.resourceIdentity === 'string' && v.resourceIdentity ? { resourceIdentity: v.resourceIdentity } : {}),
    nodeOverrides,
    ...(Array.isArray(v.inheritPolicy) ? { inheritPolicy: normalizeLightingPolicyInheritance(v.inheritPolicy)! } : {}),
  };
}
/** 稳定摘要用于内容一致性，不用于认证。顺序由业务数组保留，对象键排序。 */
export function lightingContentHash(value: unknown): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) { first = Math.imul(first ^ text.charCodeAt(i), 0x01000193); second = Math.imul(second ^ text.charCodeAt(i), 0x85ebca6b); }
  };
  const walk = (item: unknown, inArray = false): void => {
    // 与场景 JSON 的持久化语义保持一致：对象省略 undefined，数组将空项写为 null。
    if (item === undefined) { feed(inArray ? 'null;' : 'undefined;'); return; }
    if (ArrayBuffer.isView(item) && !(item instanceof DataView)) {
      feed('['); const values = item as unknown as ArrayLike<number>;
      for (let i = 0; i < values.length; i++) walk(values[i], true);
      feed(']'); return;
    }
    if (Array.isArray(item)) { feed('['); for (const child of item) walk(child, true); feed(']'); return; }
    if (item && typeof item === 'object') {
      feed('{');
      for (const key of Object.keys(item).sort()) {
        const child = (item as Obj)[key];
        if (child === undefined) continue;
        feed(JSON.stringify(key)); walk(child);
      }
      feed('}'); return;
    }
    feed(JSON.stringify(item) ?? 'null'); feed(';');
  };
  walk(value);
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}
function hasPolicyInheritance(entity: Obj): boolean {
  const lighting = object(object(entity.components).lighting);
  return Array.isArray(lighting.inheritPolicy)
    || Object.values(object(lighting.nodeOverrides)).some(node => Array.isArray(object(node).inheritPolicy));
}
/** 纯合同没有实际驱动节点清单；节点规则只用于保守判断“可能仍有静态部件”，不能替代运行时匹配。 */
function possiblePolicySettings(policy: SceneLightingPolicy | undefined,
  resolve: ReturnType<typeof createSceneLightingPolicyResolver>, entityId: string, entity: Obj, entities: Obj) {
  const components = object(entity.components), lighting = object(components.lighting);
  const base: LightingPolicyContext = { entityId, entity, entities,
    automatic: { mobility: 'static', reason: '纯文档尚不能排除固定部件。' } };
  const candidates: LightingPolicyContext[] = [base];
  if (components.modelAsset || components.modelGenerator) {
    candidates.push({ ...base, nodeKey: '$possible-fixed', motionRole: 'fixed' },
      { ...base, nodeKey: '$possible-moving', motionRole: 'moving' });
  }
  for (const item of policy?.rules ?? []) {
    if (!item.enabled || !matchesLightingPolicyTarget(item.target, base)) continue;
    for (const node of item.nodeRules ?? []) if (node.enabled && node.target.kind === 'node') {
      // 修订身份只能在真实几何就绪后验证；未就绪时保守要求烘焙，不将未知节点当作“全动态”豁免。
      candidates.push({ ...base, nodeKey: node.target.nodeKey, resourceIdentity: node.target.resourceIdentity });
    }
  }
  for (const nodeKey of Object.keys(object(lighting.nodeOverrides))) {
    if (!nodeKey || ['__proto__', 'constructor', 'prototype'].includes(nodeKey)) continue;
    candidates.push({ ...base, nodeKey, ...(typeof lighting.resourceIdentity === 'string' ? { resourceIdentity: lighting.resourceIdentity } : {}) });
  }
  return candidates.map(candidate => resolve(candidate).settings);
}
/** 日夜控制会实际改灯光；同类控制器按实体顺序占用，雾及其它展示特效仍不属于 GI 输入。 */
function dayNightLightingSources(scene: Obj, entities: Obj): unknown[] {
  const ids = Array.isArray(scene.entityIds) ? scene.entityIds.filter((id): id is string => typeof id === 'string') : Object.keys(entities);
  return [...new Set(ids)].flatMap(id => {
    const entity = object(entities[id]), effect = object(object(entity.components).poiEffect);
    if (effect.effectKind !== 'day-night' || effect.enabled !== true || !effect.visual) return [];
    let current = entity;
    const visited = new Set<Obj>();
    while (!visited.has(current)) {
      if (current.visible === false) return [];
      visited.add(current);
      if (typeof current.parentId !== 'string' || !entities[current.parentId]) break;
      current = object(entities[current.parentId]);
    }
    return [{ id, effect }];
  });
}
export function getSceneLightingBakeSignature(value: unknown): string {
  const scene = object(value), settings = object(scene.sceneSettings), entities = object(scene.entities);
  const lighting = getSceneLightingConfig(scene), bake = lighting.bake;
  const policyValue = getLightingPolicySignatureValue(lighting.policy);
  const policy = policyValue !== undefined ? normalizeSceneLightingPolicy(lighting.policy) : undefined;
  const resolve = createSceneLightingPolicyResolver(policy);
  const sandboxEnvironment = lighting.environment?.source === 'sandbox';
  const entries = Object.keys(entities).sort().map(id => {
    const entity = object(entities[id]), c = object(entity.components);
    if (c.cadReference || c.poiEffect || c.chartMarker || c.dataPlatformScreen || c.manualRoamSpawn
      || (sandboxEnvironment && c.skybox)) return null;
    const lighting = normalizeEntityLightingSettings(c.lighting);
    // 动态对象的姿态不属于静态烘焙输入；分类和资源仍参与，防止改回静态时沿用旧结果。
    const fullyDynamic = policy || hasPolicyInheritance(entity)
      ? possiblePolicySettings(policy, resolve, id, entity, entities).every(result => result.mobility === 'dynamic')
      : lighting.mobility === 'dynamic';
    const components = { ...c, ...(c.skybox ? { skybox: skyboxLightingIdentity(c.skybox) } : {}),
      ...(fullyDynamic && !c.light ? { transform: undefined } : {}) };
    return { id, parentId: entity.parentId, visible: entity.visible, components };
  }).filter(Boolean);
  const main = lighting.main.source === 'scene' ? { source: 'scene' }
    : lighting.main.enabled ? { source: 'managed', enabled: true, color: lighting.main.color,
      azimuthDegrees: lighting.main.azimuthDegrees, elevationDegrees: lighting.main.elevationDegrees, intensity: lighting.main.intensity }
      : { source: 'managed', enabled: false };
  // 天空纹理与旋转仍是输入；辐照强度只从 lighting 读取，曝光/雾和实时阴影参数不进 GI 摘要。
  const skybox = lighting.environment?.source === 'sandbox' ? undefined : settings.skybox
    ? Object.fromEntries(Object.entries(object(skyboxLightingIdentity(settings.skybox))).filter(([key]) => key !== 'intensity')) : settings.skybox;
  const resolvedSkybox = sandboxEnvironment ? null : resolveSceneSkyboxReference(scene);
  return `lighting-v2-${lightingContentHash({
    entities: entries, environment: settings.environment, skybox,
    light: { main, fill: { intensity: lighting.fill.intensity, color: lighting.fill.color, groundColor: lighting.fill.groundColor },
      // 旧实体天空捕获曾退化为平均辐照度；方向性原图输入必须使该旧结果过期，而非重签成有效。
      ...(resolvedSkybox?.entityId !== null && resolvedSkybox?.visible ? { skyboxSourceCapture: 1 } : {}),
      ...(lighting.environment?.source === 'sandbox' ? { environmentLighting: { ...lighting.environment, resourceRevision: GLB_STANDARD_ENVIRONMENT_ID } } : {}),
      environmentIntensity: lighting.environmentIntensity, disabledLightIds: [...lighting.disabledLightIds].sort(), allowDayNightCycle: lighting.allowDayNightCycle,
      ...(lighting.allowDayNightCycle ? { dayNightSources: dayNightLightingSources(scene, entities) } : {}) },
    bake: { quality: bake.quality, atlasSize: bake.atlasSize, texelsPerMeter: bake.texelsPerMeter, probeSpacing: bake.probeSpacing,
      ...(bake.probeVolumes?.some(volume => volume.enabled) ? { probeVolumes: bake.probeVolumes.filter(volume => volume.enabled).map(volume => ({ min: volume.min, max: volume.max })) } : {}) },
    ...(policyValue !== undefined ? { lightingPolicy: policyValue } : {}),
  })}`;
}
/** 自动模型可能包含固定部件；只有显式全动态且没有静态覆盖时才免除静态表面烘焙。 */
export function requiresSceneLightingBake(value: unknown): boolean {
  const scene = object(value), settings = object(scene.sceneSettings), entities = object(scene.entities);
  const lighting = getSceneLightingConfig(scene);
  const policyValue = getLightingPolicySignatureValue(lighting.policy);
  const policy = policyValue !== undefined ? normalizeSceneLightingPolicy(lighting.policy) : undefined;
  const resolve = createSceneLightingPolicyResolver(policy);
  if (settings.environment && object(settings.environment).visible !== false) {
    if (!policy) return true;
    const environment = resolve({ entityId: '$environment', automatic: { mobility: 'static', reason: '场景环境结构。' } }).settings;
    if (environment.mobility === 'static' && environment.bakeIndirect) return true;
  }
  return Object.entries(entities).some(([id, raw]) => {
    const entity = object(raw), components = object(entity.components);
    if (components.cadReference || components.poiEffect || components.chartMarker || components.dataPlatformScreen || components.skybox || components.manualRoamSpawn) return false;
    if (!components.meshRenderer && !components.modelAsset && !components.modelGenerator) return false;
    const lighting = normalizeEntityLightingSettings(components.lighting);
    if (policy || hasPolicyInheritance(entity)) {
      if (!possiblePolicySettings(policy, resolve, id, entity, entities).some(result => result.mobility === 'static' && result.bakeIndirect)) return false;
    } else if (lighting.mobility === 'dynamic' && !Object.values(lighting.nodeOverrides).some(override => override.mobility === 'static')) return false;
    let current = entity;
    const visited = new Set<unknown>();
    while (!visited.has(current)) {
      if (current.visible === false) return false;
      visited.add(current);
      if (typeof current.parentId !== 'string' || !entities[current.parentId]) break;
      current = object(entities[current.parentId]);
    }
    return true;
  });
}

export function getSceneLightingBakeError(value: unknown): string | null {
  const scene = object(value), lighting = getSceneLightingConfig(scene);
  if (!lighting.bake.enabled) return null;
  if (!requiresSceneLightingBake(scene)) return null;
  const result = lighting.result;
  if (!result) return '混合光照尚未完成材质与间接光烘焙，请先开始烘焙。';
  if (result.signature !== getSceneLightingBakeSignature(scene)) return '静态对象、材质或光源已变化，光照烘焙结果已过期，请重新烘焙。';
  if (!isLightingLightmapRecipeCompatible(lighting.bake.lightmapEncoding, result.assets, lighting.bake.lightmapMipLevels)) return '光照贴图编码或mip层级与当前烘焙设置不匹配，请重新烘焙。';
  return null;
}
