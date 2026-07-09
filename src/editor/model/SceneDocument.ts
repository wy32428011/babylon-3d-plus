import { createId } from '../../shared/ids';
import type { CadReferenceComponent, LightKind, MeshKind } from './components';
import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import type { ModelParameterConfig } from './modelParameters';
import { createDefaultModelParameterValues } from './modelParameters';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, type ModelLengthUnitInfo } from './sceneUnits';
import { vector3 } from './math';
import type { ModelScriptAsset } from './components';

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
export const SCENE_VIEW_DISTANCE_DEFAULT = 5000;
export const SCENE_SENSITIVITY_MIN = 1;
export const SCENE_SENSITIVITY_MAX = 20;
export const SCENE_SENSITIVITY_DEFAULT = 10;

export const STACKER_SIMULATION_SCENARIOS = ['cycle', 'target', 'movement', 'fault'] as const;

export type StackerSimulationScenario = (typeof STACKER_SIMULATION_SCENARIOS)[number];

export type SceneCameraPose = {
  alpha: number;
  beta: number;
  radius: number;
  target: Vector3Data;
};

export type SceneCameraSettings = {
  savedPose: SceneCameraPose | null;
  viewDistance: number;
};

export type SceneSensitivitySettings = {
  zoom: number;
  pan: number;
  rotate: number;
};

export type SceneEnvironmentVariant = {
  name: string;
  sourcePath: string;
  sourceUrl: string;
};

export type SceneEnvironmentSettings = {
  packagePath: string;
  thumbnailUrl?: string;
  activeVariantUrl: string;
  variants: SceneEnvironmentVariant[];
};

export type SceneSettings = {
  camera: SceneCameraSettings;
  sensitivity: SceneSensitivitySettings;
  environment: SceneEnvironmentSettings | null;
};

export type MqttConfig = {
  enabled: boolean;
  ip: string;
  address: string;
  topic: string;
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
  simulatorEnabled: false,
  simulatorAssetCode: DEFAULT_STACKER_SIMULATOR_ASSET_CODE,
  simulatorScenario: 'cycle',
  simulatorIntervalMs: DEFAULT_STACKER_SIMULATOR_INTERVAL_MS,
};

export const DEFAULT_SCENE_SETTINGS: SceneSettings = {
  camera: {
    savedPose: null,
    viewDistance: SCENE_VIEW_DISTANCE_DEFAULT,
  },
  sensitivity: {
    zoom: SCENE_SENSITIVITY_DEFAULT,
    pan: SCENE_SENSITIVITY_DEFAULT,
    rotate: SCENE_SENSITIVITY_DEFAULT,
  },
  environment: null,
};

/** 将数值约束在指定范围内，非法输入直接回退到默认值。 */
function clampFiniteNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 归一化 Scene View 可视距离，避免写入会导致相机裁剪异常的数值。 */
export function sanitizeSceneViewDistance(value: number): number {
  return clampFiniteNumber(value, SCENE_VIEW_DISTANCE_MIN, SCENE_VIEW_DISTANCE_MAX, SCENE_VIEW_DISTANCE_DEFAULT);
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

/** 归一化环境模型设置，非法 URL 或空变体会回退为未启用环境模型。 */
export function sanitizeSceneEnvironment(
  environment: SceneEnvironmentSettings | null | undefined,
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

  return {
    packagePath,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
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

  return {
    camera: {
      savedPose,
      viewDistance: sanitizeSceneViewDistance(settings.camera.viewDistance),
    },
    sensitivity: {
      zoom: sanitizeSceneSensitivityValue(settings.sensitivity.zoom),
      pan: sanitizeSceneSensitivityValue(settings.sensitivity.pan),
      rotate: sanitizeSceneSensitivityValue(settings.sensitivity.rotate),
    },
    environment: sanitizeSceneEnvironment(settings.environment),
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

/** 归一化场景 MQTT 配置，地址为空但 IP 存在时自动补齐默认 WebSocket 地址。 */
export function sanitizeMqttConfig(config: MqttConfig): MqttConfig {
  const ip = config.ip.trim();
  const address = config.address.trim() || createMqttAddressFromIp(ip);
  const topic = config.topic.trim() || DEFAULT_STACKER_MQTT_TOPIC;
  const simulatorAssetCode = config.simulatorAssetCode.trim() || DEFAULT_STACKER_SIMULATOR_ASSET_CODE;
  const simulatorIntervalMs = Number.isFinite(config.simulatorIntervalMs)
    ? Math.max(100, Math.trunc(config.simulatorIntervalMs))
    : DEFAULT_STACKER_SIMULATOR_INTERVAL_MS;

  return {
    enabled: config.enabled,
    ip,
    address,
    topic,
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
        length: 1,
        width: 1,
        height: 1,
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
): Entity {
  const id = createId('entity');
  const trimmedName = displayName.trim();
  const assetCode = createModelAssetCode(defaultAssetCodePrefix, id);

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
      },
    },
  };
}
