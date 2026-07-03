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
export const DEFAULT_STACKER_MQTT_TOPIC = 'dt/factory/logistics/stacker/+/twindatadriven/joint';
export const DEFAULT_STACKER_SIMULATOR_ASSET_CODE = 'DDJ2';
export const DEFAULT_STACKER_SIMULATOR_INTERVAL_MS = 500;

export const STACKER_SIMULATION_SCENARIOS = ['cycle', 'target', 'movement', 'fault'] as const;

export type StackerSimulationScenario = (typeof STACKER_SIMULATION_SCENARIOS)[number];

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
};

export function createEmptySceneDocument(name = 'Untitled Scene'): SceneDocument {
  return {
    id: createId('scene'),
    name,
    entityIds: [],
    entities: {},
    selectedEntityId: null,
    mqttConfig: DEFAULT_MQTT_CONFIG,
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
