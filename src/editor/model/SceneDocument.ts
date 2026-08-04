import { createId } from '../../shared/ids';
import type { CadReferenceComponent, LightKind, MeshKind, PoiEffectKind, SkyboxComponent, SkyboxFormat, SkyboxResolution } from './components';
import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import type { ModelParameterConfig } from './modelParameters';
import { createDefaultModelGeneratorComponent } from './modelGenerator';
import { createDefaultPoiEffectComponent, getPoiEffectDefinition } from './poiEffect';
import { createDefaultModelParameterValues } from './modelParameters';
import {
  DEFAULT_MODEL_LENGTH_UNIT_INFO,
  normalizeModelLengthUnitInfo,
  type ModelLengthUnitInfo,
  type ModelSourceLengthUnit,
} from './sceneUnits';
import { vector3 } from './math';
import type { ModelScriptAsset } from './components';
import {
  createDefaultTelemetryBinding,
  normalizeModelDataDrivenConfig,
} from './telemetryBinding';
import { normalizeBuiltInSlotBindingConfig } from './builtInSlotBinding';

export const MODEL_ASSET_CODE_MAX_LENGTH = 128;

const DEFAULT_MODEL_ASSET_CODE_PREFIX = 'MODEL';
const DEFAULT_MQTT_WS_PORT = 8083;
const DEFAULT_MQTT_WS_PATH = '/mqtt';
export const DEFAULT_DEVICE_MQTT_TOPIC = 'dt/factory/logistics/+/+/twindatadriven/joint';
export const DEFAULT_STACKER_MQTT_TOPIC = DEFAULT_DEVICE_MQTT_TOPIC;
export const DEFAULT_STACKER_SIMULATOR_ASSET_CODE = 'DDJ2';
export const DEFAULT_STACKER_SIMULATOR_INTERVAL_MS = 500;
export const AUTHORIZED_LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
export const SCENE_VIEW_DISTANCE_MIN = 100;
export const SCENE_VIEW_DISTANCE_MAX = 20000;
export const SCENE_VIEW_DISTANCE_DEFAULT = 12000;
export const SCENE_SENSITIVITY_MIN = 1;
export const SCENE_SENSITIVITY_MAX = 20;
export const SCENE_SENSITIVITY_DEFAULT = 10;
export const SCENE_SKYBOX_ROTATION_MIN = 0;
export const SCENE_SKYBOX_ROTATION_MAX = 360;
export const SCENE_SKYBOX_INTENSITY_MIN = 0;
export const SCENE_SKYBOX_INTENSITY_MAX = 5;
export const SCENE_SKYBOX_INTENSITY_DEFAULT = 1;
export const SCENE_SKYBOX_RESOLUTIONS = [256, 512, 1024] as const;
export const SCENE_SKYBOX_RESOLUTION_DEFAULT = 512;
export const SCENE_SKYBOX_VIEW_DISTANCE_MIN = 12000;
export const SKYBOX_FOCUS_VIEW_DISTANCE_METERS = SCENE_VIEW_DISTANCE_MAX;
export const SKYBOX_SPHERE_DIAMETER_METERS = 10000;
export const SKYBOX_SPHERE_SCALE_MIN = 0.1;
export const SKYBOX_SPHERE_SCALE_MAX = 1;
export const SCENE_ENVIRONMENT_OPACITY_MIN = 0;
export const SCENE_ENVIRONMENT_OPACITY_MAX = 1;
export const SCENE_ENVIRONMENT_OPACITY_DEFAULT = 1;
export const SCENE_ENVIRONMENT_SCALE_MIN = 0.001;
export const SCENE_ENVIRONMENT_SCALE_MAX = 1000;
export const SCENE_ENVIRONMENT_SCALE_DEFAULT = 1;

export const STACKER_SIMULATION_SCENARIOS = ['cycle', 'target', 'movement', 'fault'] as const;

export type StackerSimulationScenario = (typeof STACKER_SIMULATION_SCENARIOS)[number];

export const STANDARD_SCENE_CAMERA_ORIENTATIONS = ['top', 'bottom', 'front', 'back', 'left', 'right'] as const;
export type StandardSceneCameraOrientation = (typeof STANDARD_SCENE_CAMERA_ORIENTATIONS)[number];
export const SCENE_CAMERA_ORIENTATIONS = ['orbit', ...STANDARD_SCENE_CAMERA_ORIENTATIONS] as const;
export type SceneCameraOrientation = (typeof SCENE_CAMERA_ORIENTATIONS)[number];
export const SCENE_CAMERA_ORIENTATION_DEFAULT: SceneCameraOrientation = 'orbit';

export const SCENE_CAMERA_PROJECTIONS = ['perspective', 'orthographic'] as const;
export type SceneCameraProjection = (typeof SCENE_CAMERA_PROJECTIONS)[number];
export const SCENE_CAMERA_PROJECTION_DEFAULT: SceneCameraProjection = 'perspective';

export type SceneCameraPose = {
  alpha: number;
  beta: number;
  radius: number;
  target: Vector3Data;
};

export type SceneCameraSettings = {
  savedPose: SceneCameraPose | null;
  savedOrientation: SceneCameraOrientation;
  savedProjection: SceneCameraProjection;
  viewDistance: number;
};

export type SceneSensitivitySettings = {
  zoom: number;
  pan: number;
  rotate: number;
};

export type SceneSkyboxFormat = SkyboxFormat;
export type SceneSkyboxResolution = SkyboxResolution;

export type SceneSkyboxSettings = {
  packagePath: string;
  sourcePath: string;
  sourceUrl: string;
  assetRevision?: string;
  format: SceneSkyboxFormat;
  rotationDegrees: number;
  intensity: number;
  resolution: SceneSkyboxResolution;
};

export type SceneEnvironmentVariant = {
  name: string;
  sourcePath: string;
  sourceUrl: string;
};

export type SceneEnvironmentPlacementMode = 'legacy-left' | 'scene-base';

/** 环境根节点使用米制位置、弧度旋转和统一无量纲缩放。 */
export type SceneEnvironmentTransform = {
  position: Vector3Data;
  rotation: Vector3Data;
  scale: number;
};

export type SceneEnvironmentSettings = {
  packagePath: string;
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
  thumbnailUrl?: string;
  displayName?: string;
  fileSizeBytes?: number;
  placementMode: SceneEnvironmentPlacementMode;
  transform: SceneEnvironmentTransform;
  visible: boolean;
  opacity: number;
  activeVariantUrl: string;
  variants: SceneEnvironmentVariant[];
};

/** 环境配置输入兼容旧场景缺失单位、摆放与显示字段，归一化后始终返回完整配置。 */
export type SceneEnvironmentSettingsInput = Omit<
  SceneEnvironmentSettings,
  | 'lengthUnit'
  | 'unitScaleToMeters'
  | 'placementMode'
  | 'transform'
  | 'visible'
  | 'opacity'
> & Partial<Pick<
  SceneEnvironmentSettings,
  | 'lengthUnit'
  | 'unitScaleToMeters'
  | 'placementMode'
  | 'transform'
  | 'visible'
  | 'opacity'
>>;

export type SceneSettings = {
  camera: SceneCameraSettings;
  sensitivity: SceneSensitivitySettings;
  environment: SceneEnvironmentSettings | null;
  skybox: SceneSkyboxSettings | null;
};

export type FetchConfig = {
  url: string;
  apiKey: string;
};

export const DEFAULT_FETCH_CONFIG: FetchConfig = {
  url: '',
  apiKey: '',
};

export type MqttAdapterConfig =
  | { kind: 'epv'; sourceId?: string; deviceType?: string }
  | {
      kind: 'json-path';
      sourceId?: string;
      deviceTypePath?: string;
      assetCodePath?: string;
      timestampPath?: string;
      sequencePath?: string;
      fields: Record<string, string>;
    };

export type MqttSubscriptionConfig = {
  topic: string;
  qos: 0 | 1;
  adapter: MqttAdapterConfig;
};

export type MqttConfig = {
  enabled: boolean;
  ip: string;
  address: string;
  topic: string;
  subscriptions: MqttSubscriptionConfig[];
  simulatorEnabled: boolean;
  simulatorAssetCode: string;
  simulatorScenario: StackerSimulationScenario;
  simulatorIntervalMs: number;
};

export const DEFAULT_MQTT_CONFIG: MqttConfig = {
  enabled: false,
  ip: '',
  address: '',
  topic: DEFAULT_STACKER_MQTT_TOPIC,
  subscriptions: [{ topic: DEFAULT_STACKER_MQTT_TOPIC, qos: 0, adapter: { kind: 'epv' } }],
  simulatorEnabled: false,
  simulatorAssetCode: DEFAULT_STACKER_SIMULATOR_ASSET_CODE,
  simulatorScenario: 'cycle',
  simulatorIntervalMs: DEFAULT_STACKER_SIMULATOR_INTERVAL_MS,
};

export const DEFAULT_SCENE_SETTINGS: SceneSettings = {
  camera: {
    savedPose: null,
    savedOrientation: SCENE_CAMERA_ORIENTATION_DEFAULT,
    savedProjection: SCENE_CAMERA_PROJECTION_DEFAULT,
    viewDistance: SCENE_VIEW_DISTANCE_DEFAULT,
  },
  sensitivity: {
    zoom: SCENE_SENSITIVITY_DEFAULT,
    pan: SCENE_SENSITIVITY_DEFAULT,
    rotate: SCENE_SENSITIVITY_DEFAULT,
  },
  environment: null,
  skybox: null,
};

/** 将数值约束在指定范围内，非法输入直接回退到默认值。 */
function clampFiniteNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 归一化 Scene View 可视距离；天空盒场景可传入更高的业务最小值。 */
export function sanitizeSceneViewDistance(
  value: number,
  minimum = SCENE_VIEW_DISTANCE_MIN,
): number {
  const safeMinimum = clampFiniteNumber(
    minimum,
    SCENE_VIEW_DISTANCE_MIN,
    SCENE_VIEW_DISTANCE_MAX,
    SCENE_VIEW_DISTANCE_MIN,
  );
  const fallback = Math.max(SCENE_VIEW_DISTANCE_DEFAULT, safeMinimum);
  return clampFiniteNumber(value, safeMinimum, SCENE_VIEW_DISTANCE_MAX, fallback);
}

/** 归一化相机操作灵敏度，滑杆值越大代表操作响应越快。 */
export function sanitizeSceneSensitivityValue(value: number): number {
  return clampFiniteNumber(value, SCENE_SENSITIVITY_MIN, SCENE_SENSITIVITY_MAX, SCENE_SENSITIVITY_DEFAULT);
}

/** 拷贝 Vector3 数据，保证场景设置不会共享可变引用。 */
function cloneVector3Data(vector: Vector3Data): Vector3Data {
  return { x: vector.x, y: vector.y, z: vector.z };
}

/** 判断相机位姿是否为可安全回放的有限数值。 */
function isValidCameraPose(pose: SceneCameraPose | null): pose is SceneCameraPose {
  return Boolean(
    pose &&
      Number.isFinite(pose.alpha) &&
      Number.isFinite(pose.beta) &&
      Number.isFinite(pose.radius) &&
      Number.isFinite(pose.target.x) &&
      Number.isFinite(pose.target.y) &&
      Number.isFinite(pose.target.z),
  );
}

/** 判断相机朝向是否属于场景文件支持的稳定枚举。 */
export function isSceneCameraOrientation(value: unknown): value is SceneCameraOrientation {
  return typeof value === 'string' && (SCENE_CAMERA_ORIENTATIONS as readonly string[]).includes(value);
}

/** 判断相机朝向是否为可由视口定向罗盘锁定的六个标准面。 */
export function isStandardSceneCameraOrientation(value: unknown): value is StandardSceneCameraOrientation {
  return typeof value === 'string' && (STANDARD_SCENE_CAMERA_ORIENTATIONS as readonly string[]).includes(value);
}

/** 判断相机投影是否属于场景文件支持的稳定枚举。 */
function isSceneCameraProjection(value: unknown): value is SceneCameraProjection {
  return value === 'perspective' || value === 'orthographic';
}

/** 从本地或部署虚拟资源路径读取天空盒扩展名。 */
function readSkyboxPathFormat(sourcePath: string): SceneSkyboxFormat | null {
  let normalizedPath = sourcePath.trim();
  if (normalizedPath.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) {
    try {
      const parsed = new URL(normalizedPath);
      if (parsed.protocol !== 'editor-asset:' || parsed.hostname !== 'local') return null;
      normalizedPath = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
      return null;
    }
  } else {
    normalizedPath = normalizedPath.split(/[?#]/, 1)[0] ?? '';
  }

  if (/\.hdr$/i.test(normalizedPath)) return 'hdr';
  if (/\.exr$/i.test(normalizedPath)) return 'exr';
  return null;
}

/** 归一化天空盒设置，拒绝非授权 URL、无效路径和格式不一致的资源。 */
export function sanitizeSceneSkybox(
  skybox: SceneSkyboxSettings | null | undefined,
): SceneSkyboxSettings | null {
  if (!skybox) return null;

  const packagePath = skybox.packagePath.trim();
  const sourcePath = skybox.sourcePath.trim();
  const sourceUrl = skybox.sourceUrl.trim();
  const format = skybox.format;
  if (!packagePath || !sourcePath || !sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) return null;
  if (
    (format !== 'hdr' && format !== 'exr')
    || readSkyboxPathFormat(sourcePath) !== format
    || readSkyboxPathFormat(sourceUrl) !== format
  ) return null;

  const assetRevision = skybox.assetRevision?.trim();
  const resolution = SCENE_SKYBOX_RESOLUTIONS.includes(skybox.resolution)
    ? skybox.resolution
    : SCENE_SKYBOX_RESOLUTION_DEFAULT;

  return {
    packagePath,
    sourcePath,
    sourceUrl,
    ...(assetRevision ? { assetRevision } : {}),
    format,
    rotationDegrees: clampFiniteNumber(
      skybox.rotationDegrees,
      SCENE_SKYBOX_ROTATION_MIN,
      SCENE_SKYBOX_ROTATION_MAX,
      SCENE_SKYBOX_ROTATION_MIN,
    ),
    intensity: clampFiniteNumber(
      skybox.intensity,
      SCENE_SKYBOX_INTENSITY_MIN,
      SCENE_SKYBOX_INTENSITY_MAX,
      SCENE_SKYBOX_INTENSITY_DEFAULT,
    ),
    resolution,
  };
}

/** 将任意旧三轴缩放迁移为安全等比倍率；取最大绝对值避免缩小既有覆盖范围。 */
export function getSkyboxSphereScaleMultiplier(scale: Vector3Data): number {
  const finiteAbsoluteValues = [scale.x, scale.y, scale.z]
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.abs(value));
  const maximum = finiteAbsoluteValues.length > 0 ? Math.max(...finiteAbsoluteValues) : 1;
  return clampFiniteNumber(maximum, SKYBOX_SPHERE_SCALE_MIN, SKYBOX_SPHERE_SCALE_MAX, 1);
}

/** 把天空盒缩放统一为 X/Y/Z 相同的安全倍率。 */
export function normalizeSkyboxSphereScale(scale: Vector3Data): Vector3Data {
  const multiplier = getSkyboxSphereScaleMultiplier(scale);
  return vector3(multiplier, multiplier, multiplier);
}

/** 根据当前等比缩放返回天空盒球体的实际直径。 */
export function getSkyboxSphereDiameterMeters(scale: Vector3Data): number {
  return SKYBOX_SPHERE_DIAMETER_METERS * getSkyboxSphereScaleMultiplier(scale);
}

/** 判断指定世界点是否位于球形天空盒内部，供 Scene 背景拾取避让使用。 */
export function isPointInsideSkyboxSphere(
  transform: Pick<Entity['components']['transform'], 'position' | 'scale'>,
  point: Vector3Data,
): boolean {
  const values = [
    transform.position.x,
    transform.position.y,
    transform.position.z,
    point.x,
    point.y,
    point.z,
  ];
  if (values.some((value) => !Number.isFinite(value))) return false;

  const radius = getSkyboxSphereDiameterMeters(transform.scale) / 2;
  const deltaX = point.x - transform.position.x;
  const deltaY = point.y - transform.position.y;
  const deltaZ = point.z - transform.position.z;
  return deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ < radius * radius;
}

/** 从场景级兼容设置提取球形天空盒实体组件。 */
export function createSkyboxComponent(skybox: SceneSkyboxSettings): SkyboxComponent {
  const normalized = sanitizeSceneSkybox(skybox);
  if (!normalized) throw new Error('天空盒资源配置无效。');
  return {
    packagePath: normalized.packagePath,
    sourcePath: normalized.sourcePath,
    sourceUrl: normalized.sourceUrl,
    ...(normalized.assetRevision ? { assetRevision: normalized.assetRevision } : {}),
    format: normalized.format,
    intensity: normalized.intensity,
    resolution: normalized.resolution,
  };
}

/** 将任意弧度旋转折算为 Inspector 使用的 0-360° 水平角。 */
function normalizeSkyboxRotationRadians(rotationY: number): number {
  if (!Number.isFinite(rotationY)) return SCENE_SKYBOX_ROTATION_MIN;
  const degrees = rotationY * 180 / Math.PI;
  const wrapped = ((degrees % 360) + 360) % 360;
  return Number(wrapped.toFixed(6));
}

/** 读取场景中第一个球形天空盒实体；正常编辑流程只会维护一个。 */
export function getSceneSkyboxEntity(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
): Entity | null {
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (entity?.components.skybox) return entity;
  }
  return null;
}

/** 从单个球形天空盒实体恢复兼容设置，供资源重关联、Inspector 与运行时共享。 */
export function createSceneSkyboxSettingsFromEntity(entity: Entity): SceneSkyboxSettings | null {
  const skybox = entity.components.skybox;
  if (!skybox) return null;
  return sanitizeSceneSkybox({
    ...skybox,
    rotationDegrees: normalizeSkyboxRotationRadians(entity.components.transform.rotation.y),
  });
}

/** 从球形实体恢复兼容的天空盒设置；没有实体时回退旧 sceneSettings.skybox。 */
export function getSceneSkyboxSettings(scene: SceneDocument): SceneSkyboxSettings | null {
  const entity = getSceneSkyboxEntity(scene);
  return entity
    ? createSceneSkyboxSettingsFromEntity(entity)
    : sanitizeSceneSkybox(scene.sceneSettings.skybox);
}

/** 创建环境模型的默认根节点 Transform；新旧摆放模式都以此作为用户调整基线。 */
export function createDefaultSceneEnvironmentTransform(): SceneEnvironmentTransform {
  return {
    position: vector3(),
    rotation: vector3(),
    scale: SCENE_ENVIRONMENT_SCALE_DEFAULT,
  };
}

/** 对环境 Transform 的每个分量独立容错，避免单个非法输入污染整个场景。 */
export function sanitizeSceneEnvironmentTransform(
  transform: SceneEnvironmentTransform | null | undefined,
): SceneEnvironmentTransform {
  const defaults = createDefaultSceneEnvironmentTransform();
  if (!transform) return defaults;

  return {
    position: {
      x: Number.isFinite(transform.position?.x) ? transform.position.x : defaults.position.x,
      y: Number.isFinite(transform.position?.y) ? transform.position.y : defaults.position.y,
      z: Number.isFinite(transform.position?.z) ? transform.position.z : defaults.position.z,
    },
    rotation: {
      x: Number.isFinite(transform.rotation?.x) ? transform.rotation.x : defaults.rotation.x,
      y: Number.isFinite(transform.rotation?.y) ? transform.rotation.y : defaults.rotation.y,
      z: Number.isFinite(transform.rotation?.z) ? transform.rotation.z : defaults.rotation.z,
    },
    scale: Number.isFinite(transform.scale) && transform.scale > 0
      ? clampFiniteNumber(
          transform.scale,
          SCENE_ENVIRONMENT_SCALE_MIN,
          SCENE_ENVIRONMENT_SCALE_MAX,
          SCENE_ENVIRONMENT_SCALE_DEFAULT,
        )
      : SCENE_ENVIRONMENT_SCALE_DEFAULT,
  };
}

/** 归一化环境模型设置，非法 URL 或空变体会回退为未启用环境模型。 */
export function sanitizeSceneEnvironment(
  environment: SceneEnvironmentSettingsInput | null | undefined,
): SceneEnvironmentSettings | null {
  if (!environment) return null;

  const packagePath = environment.packagePath.trim();
  const variants = environment.variants
    .map((variant) => ({
      name: variant.name.trim() || '环境模型',
      sourcePath: variant.sourcePath.trim(),
      sourceUrl: variant.sourceUrl.trim(),
    }))
    .filter((variant) => variant.sourcePath && variant.sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX));

  if (!packagePath || variants.length === 0) return null;

  const activeVariantUrl = environment.activeVariantUrl.trim();
  const activeVariant = variants.find((variant) => variant.sourceUrl === activeVariantUrl) ?? variants[0];
  const thumbnailUrl = environment.thumbnailUrl?.trim();
  const displayName = environment.displayName?.trim();
  const placementMode: SceneEnvironmentPlacementMode = environment.placementMode === 'scene-base'
    ? 'scene-base'
    : 'legacy-left';
  const fileSizeBytes = typeof environment.fileSizeBytes === 'number'
    && Number.isFinite(environment.fileSizeBytes)
    && environment.fileSizeBytes > 0
      ? Math.floor(environment.fileSizeBytes)
      : undefined;
  let unitInfo: ModelLengthUnitInfo;

  try {
    unitInfo = normalizeModelLengthUnitInfo(environment.lengthUnit, environment.unitScaleToMeters);
  } catch {
    return null;
  }

  return {
    packagePath,
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(displayName ? { displayName } : {}),
    ...(fileSizeBytes ? { fileSizeBytes } : {}),
    placementMode,
    transform: sanitizeSceneEnvironmentTransform(environment.transform),
    visible: environment.visible !== false,
    opacity: clampFiniteNumber(
      environment.opacity ?? SCENE_ENVIRONMENT_OPACITY_DEFAULT,
      SCENE_ENVIRONMENT_OPACITY_MIN,
      SCENE_ENVIRONMENT_OPACITY_MAX,
      SCENE_ENVIRONMENT_OPACITY_DEFAULT,
    ),
    activeVariantUrl: activeVariant.sourceUrl,
    variants,
  };
}

/** 归一化场景级编辑设置，作为 UI、运行时和序列化共同使用的边界。 */
export function sanitizeSceneSettings(settings: SceneSettings): SceneSettings {
  const savedPose = isValidCameraPose(settings.camera.savedPose)
    ? {
        alpha: settings.camera.savedPose.alpha,
        beta: settings.camera.savedPose.beta,
        radius: settings.camera.savedPose.radius,
        target: cloneVector3Data(settings.camera.savedPose.target),
      }
    : null;

  const savedOrientation = savedPose && isSceneCameraOrientation(settings.camera.savedOrientation)
    ? settings.camera.savedOrientation
    : SCENE_CAMERA_ORIENTATION_DEFAULT;
  const savedProjection = savedPose && isSceneCameraProjection(settings.camera.savedProjection)
    ? settings.camera.savedProjection
    : SCENE_CAMERA_PROJECTION_DEFAULT;

  return {
    camera: {
      savedPose,
      savedOrientation,
      savedProjection,
      viewDistance: sanitizeSceneViewDistance(settings.camera.viewDistance),
    },
    sensitivity: {
      zoom: sanitizeSceneSensitivityValue(settings.sensitivity.zoom),
      pan: sanitizeSceneSensitivityValue(settings.sensitivity.pan),
      rotate: sanitizeSceneSensitivityValue(settings.sensitivity.rotate),
    },
    environment: sanitizeSceneEnvironment(settings.environment),
    skybox: sanitizeSceneSkybox(settings.skybox),
  };
}

/** 创建一份新的默认场景设置，避免共享 DEFAULT_SCENE_SETTINGS 的嵌套引用。 */
export function createDefaultSceneSettings(): SceneSettings {
  return sanitizeSceneSettings(DEFAULT_SCENE_SETTINGS);
}

/** 按默认 MQTT over WebSocket 端口和路径，从 IP/域名生成浏览器可连接地址。 */
export function createMqttAddressFromIp(ip: string): string {
  const normalizedIp = ip.trim();
  return normalizedIp ? `ws://${normalizedIp}:${DEFAULT_MQTT_WS_PORT}${DEFAULT_MQTT_WS_PATH}` : '';
}

/** 判断 JSON Path 适配器路径是否只包含安全点号和数组索引。 */
function isSafeJsonPath(value: string): boolean {
  return /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*|\[[0-9]+\])*$/.test(value);
}

/** 清理 MQTT 适配器配置，避免保存凭据或任意表达式。 */
function sanitizeMqttAdapterConfig(adapter: unknown): MqttAdapterConfig {
  if (typeof adapter !== 'object' || adapter === null || Object.getPrototypeOf(adapter) !== Object.prototype) return { kind: 'epv' };
  const source = adapter as Record<string, unknown>;
  if (source.kind !== 'json-path') {
    const sourceId = typeof source.sourceId === 'string' ? source.sourceId.trim().slice(0, 128) : '';
    const deviceType = typeof source.deviceType === 'string' ? source.deviceType.trim().slice(0, 128) : '';
    return { kind: 'epv', ...(sourceId ? { sourceId } : {}), ...(deviceType ? { deviceType } : {}) };
  }

  const fields: Record<string, string> = {};
  if (typeof source.fields === 'object' && source.fields !== null && Object.getPrototypeOf(source.fields) === Object.prototype) {
    for (const [key, value] of Object.entries(source.fields).slice(0, 128)) {
      const field = key.trim().slice(0, 128);
      const path = typeof value === 'string' ? value.trim().slice(0, 256) : '';
      if (field && path && isSafeJsonPath(path)) fields[field] = path;
    }
  }

  const pickPath = (value: unknown) => typeof value === 'string' && isSafeJsonPath(value.trim()) ? value.trim().slice(0, 256) : undefined;
  const sourceId = typeof source.sourceId === 'string' ? source.sourceId.trim().slice(0, 128) : '';
  return {
    kind: 'json-path',
    ...(sourceId ? { sourceId } : {}),
    ...(pickPath(source.deviceTypePath) ? { deviceTypePath: pickPath(source.deviceTypePath) } : {}),
    ...(pickPath(source.assetCodePath) ? { assetCodePath: pickPath(source.assetCodePath) } : {}),
    ...(pickPath(source.timestampPath) ? { timestampPath: pickPath(source.timestampPath) } : {}),
    ...(pickPath(source.sequencePath) ? { sequencePath: pickPath(source.sequencePath) } : {}),
    fields,
  };
}

/** 清理单条 MQTT 订阅配置，非法 topic 会被过滤。 */
function sanitizeMqttSubscriptionConfig(value: unknown): MqttSubscriptionConfig | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const source = value as Record<string, unknown>;
  const topic = typeof source.topic === 'string' ? source.topic.trim() : '';
  if (!topic) return null;
  return { topic, qos: source.qos === 1 ? 1 : 0, adapter: sanitizeMqttAdapterConfig(source.adapter) };
}

/** 从 legacy topic 字符串生成 EPV 订阅，兼容逗号分隔旧场景。 */
function createSubscriptionsFromLegacyTopic(topic: string): MqttSubscriptionConfig[] {
  return topic.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 32).map((item) => ({ topic: item, qos: 0, adapter: { kind: 'epv' } }));
}

export function sanitizeFetchConfig(config: unknown): FetchConfig {
  if (typeof config !== 'object' || config === null) return { ...DEFAULT_FETCH_CONFIG };
  const obj = config as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url.trim().slice(0, 2048) : '';
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim().slice(0, 256) : '';
  return { url, apiKey };
}

/** 归一化场景 MQTT 配置，地址为空但 IP 存在时自动补齐默认 WebSocket 地址。 */
export function sanitizeMqttConfig(config: Omit<MqttConfig, 'subscriptions'> & { subscriptions?: unknown }): MqttConfig {
  const ip = config.ip.trim();
  const address = config.address.trim() || createMqttAddressFromIp(ip);
  const legacyTopic = config.topic.trim() || DEFAULT_STACKER_MQTT_TOPIC;
  const rawSubscriptions = Array.isArray(config.subscriptions) ? config.subscriptions : [];
  const subscriptions = rawSubscriptions.map(sanitizeMqttSubscriptionConfig).filter((item): item is MqttSubscriptionConfig => Boolean(item));
  const normalizedSubscriptions = subscriptions.length ? subscriptions : createSubscriptionsFromLegacyTopic(legacyTopic);
  const topic = normalizedSubscriptions.map((item) => item.topic).join(',') || DEFAULT_STACKER_MQTT_TOPIC;
  const simulatorAssetCode = config.simulatorAssetCode.trim() || DEFAULT_STACKER_SIMULATOR_ASSET_CODE;
  const simulatorIntervalMs = Number.isFinite(config.simulatorIntervalMs) ? Math.max(100, Math.trunc(config.simulatorIntervalMs)) : DEFAULT_STACKER_SIMULATOR_INTERVAL_MS;

  return {
    enabled: config.enabled,
    ip,
    address,
    topic,
    subscriptions: normalizedSubscriptions,
    simulatorEnabled: config.simulatorEnabled,
    simulatorAssetCode,
    simulatorScenario: normalizeStackerSimulationScenario(config.simulatorScenario),
    simulatorIntervalMs,
  };
}

/** 将外部输入约束到受支持的 Stacker 本地模拟场景。 */
export function normalizeStackerSimulationScenario(value: unknown): StackerSimulationScenario {
  return STACKER_SIMULATION_SCENARIOS.includes(value as StackerSimulationScenario)
    ? (value as StackerSimulationScenario)
    : DEFAULT_MQTT_CONFIG.simulatorScenario;
}

/** 将模型资产编号前缀压缩成稳定可读片段，避免导入实例编号包含路径类非法字符。 */
function normalizeModelAssetCodePrefix(prefix: string | undefined): string {
  const sanitized = (prefix ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
    .slice(0, 64);

  return sanitized || DEFAULT_MODEL_ASSET_CODE_PREFIX;
}

/** 从实体 ID 提取短编号，作为导入模型实例级资产编号的唯一后缀。 */
function createEntityShortId(entityId: string): string {
  const shortId = entityId.replace(/^entity_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return shortId || '00000000';
}

/** 生成导入模型实例资产编号，前缀来自模型包，后缀来自当前实体 ID。 */
export function createModelAssetCode(prefix: string | undefined, entityId: string): string {
  return `${normalizeModelAssetCodePrefix(prefix)}-${createEntityShortId(entityId)}`.slice(0, MODEL_ASSET_CODE_MAX_LENGTH);
}

/** 复制、粘贴和阵列时沿用原编号前缀，但必须用新实体 ID 重新生成实例编号。 */
export function extractModelAssetCodePrefix(assetCode: string | undefined): string | undefined {
  const normalizedAssetCode = assetCode?.trim();
  if (!normalizedAssetCode) return undefined;

  const separatorIndex = normalizedAssetCode.lastIndexOf('-');
  return separatorIndex > 0 ? normalizedAssetCode.slice(0, separatorIndex) : normalizedAssetCode;
}

export type SceneDocument = {
  id: string;
  name: string;
  entityIds: string[];
  entities: Record<string, Entity>;
  selectedEntityId: string | null;
  mqttConfig: MqttConfig;
  sceneSettings: SceneSettings;
  fetchConfig: FetchConfig;
};

export function createEmptySceneDocument(name = 'Untitled Scene'): SceneDocument {
  return {
    id: createId('scene'),
    name,
    entityIds: [],
    entities: {},
    selectedEntityId: null,
    mqttConfig: DEFAULT_MQTT_CONFIG,
    sceneSettings: createDefaultSceneSettings(),
    fetchConfig: DEFAULT_FETCH_CONFIG,
  };
}

/** 创建一个仅用于 Hierarchy 分组的文件夹实体，不参与 Babylon 运行时渲染。 */
export function createFolderEntity(name: string): Entity {
  const id = createId('folder');
  const trimmedName = name.trim();

  return {
    id,
    name: trimmedName.length > 0 ? trimmedName : '新建文件夹',
    isFolder: true,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
    },
  };
}

/** 创建一个内置 Mesh 实体，默认可见且未锁定。 */
export function createMeshEntity(meshKind: MeshKind, position: Vector3Data = vector3()): Entity {
  const id = createId('entity');
  const displayName = meshKind.charAt(0).toUpperCase() + meshKind.slice(1);

  return {
    id,
    name: displayName,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      meshRenderer: {
        meshKind,
        materialColor: '#8ab4f8',
      },
    },
  };
}

/** 创建可选择、可移动和可缩放的球形天空盒实体。 */
export function createSkyboxEntity(
  skybox: SceneSkyboxSettings,
  position: Vector3Data = vector3(0, 0, 0),
): Entity {
  const normalized = sanitizeSceneSkybox(skybox);
  if (!normalized) throw new Error('天空盒资源配置无效。');
  const id = createId('entity');
  const fileName = normalized.sourcePath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '天空盒';
  const displayName = fileName.replace(/\.(hdr|exr)$/i, '').trim() || '天空盒';

  return {
    id,
    name: `天空盒 ${displayName}`,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(0, normalized.rotationDegrees * Math.PI / 180, 0),
        scale: vector3(1, 1, 1),
      },
      skybox: createSkyboxComponent(normalized),
    },
  };
}

/** 创建一个内置虚拟定位线框实体，资产编号随实体 ID 自动生成。 */
export function createLocatorEntity(position: Vector3Data = vector3()): Entity {
  const id = createId('entity');
  const assetId = `LOC-${id.replace(/^entity_/, '').slice(0, 8).toUpperCase()}`;

  return {
    id,
    name: '虚拟定位线框',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      locator: {
        assetId,
        storageDepth: 'near',
        length: 1,
        width: 1,
        height: 1,
        columns: 1,
        layers: 1,
        startColumn: 1,
        columnGap: 0,
        layerGap: 0,
        deviceAssetCode: '',
        rowNumber: 1,
      },
    },
  };
}

/** 创建一个 CAD/DXF 网格参考图实体，默认锁定且只作为布局参考层使用。 */
export function createCadReferenceEntity(
  sourcePath: string,
  sourceUrl: string,
  displayName: string,
  cadReference: Omit<CadReferenceComponent, 'sourcePath' | 'sourceUrl'>,
  position: Vector3Data = vector3(),
): Entity {
  const id = createId('entity');
  const trimmedName = displayName.trim();

  return {
    id,
    name: trimmedName.length > 0 ? trimmedName : 'CAD参考图',
    visible: true,
    locked: true,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      cadReference: {
        sourcePath,
        sourceUrl,
        ...cadReference,
      },
    },
  };
}

/** 创建一个基础灯光实体，默认可见且未锁定。 */
export function createLightEntity(lightKind: LightKind, position?: Vector3Data): Entity {
  const id = createId('entity');
  const displayName = `${lightKind.charAt(0).toUpperCase()}${lightKind.slice(1)} Light`;
  const defaultPosition = lightKind === 'hemispheric' ? vector3(0, 2, 0) : vector3(0, 3, 0);
  const lightPosition = position ? vector3(position.x, position.y, position.z) : defaultPosition;

  return {
    id,
    name: displayName,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: lightPosition,
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      light: {
        lightKind,
        intensity: 0.8,
      },
    },
  };
}

/** 创建一个模型生成器实体，默认只保存空配置，不直接生成运行时模型。 */
export function createModelGeneratorEntity(position: Vector3Data = vector3()): Entity {
  const id = createId('entity');

  return {
    id,
    name: '模型生成器',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      modelGenerator: createDefaultModelGeneratorComponent(),
    },
  };
}

/** 创建一个 POI 内置 EFF 实体，默认在编辑态持续播放并支持完整 Transform。 */
export function createPoiEffectEntity(effectKind: PoiEffectKind, position: Vector3Data = vector3()): Entity {
  const id = createId('entity');
  const definition = getPoiEffectDefinition(effectKind);

  return {
    id,
    name: definition.name,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      poiEffect: createDefaultPoiEffectComponent(effectKind),
    },
  };
}

/** 创建一个导入模型实体，参数化配置会随实体一起保存到场景文档。 */
export function createModelEntity(
  sourcePath: string,
  sourceUrl: string,
  displayName: string,
  unitInfo: ModelLengthUnitInfo = DEFAULT_MODEL_LENGTH_UNIT_INFO,
  position: Vector3Data = vector3(),
  parameterConfig?: ModelParameterConfig,
  scriptAssets?: ModelScriptAsset[],
  parameterScriptMetadata?: unknown[],
  animationScriptMetadata?: unknown[],
  defaultAssetCodePrefix?: string,
  assetRevision?: string,
  dataDrivenConfig?: unknown,
  builtInSlotBindingConfig?: unknown,
): Entity {
  const id = createId('entity');
  const trimmedName = displayName.trim();
  const normalizedDataDrivenConfig = normalizeModelDataDrivenConfig(dataDrivenConfig);
  const normalizedBuiltInSlotBindingConfig = normalizeBuiltInSlotBindingConfig(builtInSlotBindingConfig);
  const assetCode = createModelAssetCode(normalizedDataDrivenConfig?.device.defaultAssetCode ?? defaultAssetCodePrefix, id);
  const telemetryBinding = normalizedDataDrivenConfig?.device.devType
    ? createDefaultTelemetryBinding(normalizedDataDrivenConfig.device.devType)
    : null;

  return {
    id,
    name: trimmedName.length > 0 ? trimmedName : 'Imported Model',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      modelAsset: {
        assetCode,
        sourcePath,
        sourceUrl,
        ...(assetRevision ? { assetRevision } : {}),
        lengthUnit: unitInfo.lengthUnit,
        unitScaleToMeters: unitInfo.unitScaleToMeters,
        ...(scriptAssets?.length ? { scriptAssets } : {}),
        ...(parameterScriptMetadata?.length ? { parameterScriptMetadata } : {}),
        ...(animationScriptMetadata?.length ? { animationScriptMetadata } : {}),
        ...(parameterConfig
          ? {
              parameterConfig,
              parameterValues: createDefaultModelParameterValues(parameterConfig),
            }
          : {}),
        ...(normalizedDataDrivenConfig ? { dataDrivenConfig: normalizedDataDrivenConfig } : {}),
        ...(normalizedBuiltInSlotBindingConfig ? { builtInSlotBindingConfig: normalizedBuiltInSlotBindingConfig } : {}),
      },
      ...(telemetryBinding ? { telemetryBinding } : {}),
    },
  };
}
