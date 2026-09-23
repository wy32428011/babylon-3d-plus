import type { Vector3Data } from './math';
import type { DataPlatformModelIdentity } from '../../../electron/shared/sceneModelUpdatePlan';

export type EffectDeviceIdentity = { sourceId: string; deviceType: string; assetCode: string };
export type EffectModelReference = {
  name: string;
  sourceUrl: string;
  sourcePath: string;
  identity?: DataPlatformModelIdentity;
  deviceType?: string;
  /** 本地模板的场景内身份证据，支持 SOURCE 路径迁移；不是业务设备编号。 */
  entityIds?: string[];
};
export type EffectTargetBinding = {
  mode: 'entity' | 'environment' | 'model' | 'device' | 'point';
  entityId: string | null;
  /** 明确选择的场景实体；缺省时兼容旧单个 entityId，空数组表示清空绑定。 */
  entityIds?: string[];
  model: EffectModelReference | null;
  sourceId: string;
  deviceType: string;
  assetCode: string;
  /** 类型绑定覆盖编辑实例及运行时生成实例，旧配置缺省使用全部来源。 */
  instanceSource?: 'all' | 'scene' | 'generated';
  generatorId?: string | null;
  instanceKey?: 'assetCode' | 'containerCode' | 'carrierAssetCode';
  followSelection?: 'unique' | 'manual';
  selection: 'single' | 'all';
  maxTargets: number;
  anchor: 'origin' | 'center' | 'node';
  nodePath: string;
  offset: Vector3Data;
};
export type EffectMappingTarget = string;
export type EffectFieldMapping = {
  field: string;
  target: EffectMappingTarget;
  scale: number;
  offset: number;
  values: { value: string; output: string | number | boolean }[];
};
export type EffectDataBinding = {
  mode: 'none' | 'inherit' | 'mqtt' | 'http';
  inheritFrom?: 'target' | 'carrier';
  sourceId: string;
  deviceType: string;
  assetCode: string;
  expectedIntervalMs: number;
  staleAfterMs: number;
  missing: 'pause' | 'hide' | 'hold';
  http: {
    mode: 'data-source' | 'mqtt-latest';
    dataSourceId: string;
    namespace: string;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  mappings: EffectFieldMapping[];
  dataset: { enabled: boolean; rowsPath: string; idPath: string; xPath: string; yPath: string; zPath: string; valuePath: string; labelPath: string; unitScale?: number; coordinateSpace?: 'local' | 'world' };
  trigger: { enabled: boolean; field: string; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: string; debounceMs: number };
};

/** 专用配置使用有界 JSON；每个 kind 的登记表决定允许字段、类型及范围。 */
export type EffectParameterValue = string | number | boolean | Vector3Data | Array<Record<string, unknown>>;
export type EffectParameterDefinition = {
  key: string;
  label: string;
  group: string;
  type: 'number' | 'boolean' | 'select' | 'color' | 'string' | 'vector' | 'rows';
  default: EffectParameterValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  description?: string;
  /** 数据字段可绑定此参数；结构拓扑仅通过低频配置更新。 */
  bindable?: boolean;
  validate?: (value: unknown) => string | null;
};
export type EffectConfiguration = {
  version: 2;
  target: EffectTargetBinding;
  data: EffectDataBinding;
  parameters: Record<string, EffectParameterValue>;
};
export type EffectDiagnosticStatus = 'static' | 'unbound' | 'missing-target' | 'ambiguous' | 'loading' | 'waiting' | 'online' | 'stale' | 'invalid' | 'error' | 'paused';
export type EffectDiagnostic = {
  status: EffectDiagnosticStatus;
  message: string;
  candidates: EffectTargetCandidate[];
  identity: EffectDeviceIdentity | null;
  updatedAt: number | null;
  fields: Record<string, unknown>;
  effectKind?: string;
  effectName?: string;
  selectedTargetId?: string | null;
  targetIdentity?: EffectDeviceIdentity | null;
  carrierIdentity?: EffectDeviceIdentity | null;
  bindingSignature?: string;
  targetStates?: Array<{id: string; name: string; status: EffectDiagnosticStatus; message: string; identity: EffectDeviceIdentity | null}>;
};

export type EffectTargetCandidate = {
  id: string; name: string; assetCode: string;
  origin?: 'scene' | 'generated';
  state?: 'loading' | 'ready' | 'hidden' | 'error';
  containerCode?: string;
  generatorId?: string | null;
};

/** 运行时只读描述，不包含持久化实体或可修改的 Babylon 节点。 */
export type EffectRuntimeTarget = {
  id: string;
  name: string;
  origin: 'scene' | 'generated';
  model: EffectModelReference;
  identity: EffectDeviceIdentity | null;
  carrierIdentity?: EffectDeviceIdentity | null;
  containerCode?: string;
  generatorId?: string | null;
  state: 'loading' | 'ready' | 'hidden' | 'error';
  generation: string | number;
  message?: string;
  modelEffectsSupported?: boolean;
};
