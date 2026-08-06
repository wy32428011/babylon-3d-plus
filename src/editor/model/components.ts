import type { Vector3Data } from './math';
import type { BuiltInSlotBindingConfig, LocatorBuiltInBinding } from './builtInSlotBinding';
import type { ModelParameterConfig, ModelParameterValues } from './modelParameters';
import type { ModelSourceLengthUnit } from './sceneUnits';
import type { ModelDataDrivenConfig, TelemetryBindingComponent } from './telemetryBinding';

export type TransformComponent = {
  position: Vector3Data;
  rotation: Vector3Data;
  scale: Vector3Data;
};

export type MeshKind = 'cube' | 'sphere' | 'plane';

export type MeshRendererComponent = {
  meshKind: MeshKind;
  materialColor: string;
};

export type SkyboxFormat = 'hdr' | 'exr';
export type SkyboxResolution = 256 | 512 | 1024;

/** 球形天空盒实体保存 HDR/EXR 资源及环境光参数，位置、旋转和尺寸统一使用实体 Transform。 */
export type SkyboxComponent = {
  packagePath: string;
  sourcePath: string;
  sourceUrl: string;
  assetRevision?: string;
  format: SkyboxFormat;
  intensity: number;
  resolution: SkyboxResolution;
};

export type LocatorStorageDepth = 'near' | 'far';

/** 定位线框的 fetch 数据驱动配置；区别于 MQTT 遥测驱动，由 HTTP 接口按排号拉取库存数据。 */
export type LocatorFetchDriveConfig = {
  enabled: boolean;
  /** 货箱模板来源：场景内模型生成器实体 ID；空 = 内置立方体回退。 */
  cargoGeneratorId?: string;
};

export type LocatorComponent = {
  assetId: string;
  storageDepth: LocatorStorageDepth;
  length: number;
  width: number;
  height: number;
  columns: number;
  layers: number;
  startColumn: number;
  columnGap: number;
  layerGap: number;
  deviceAssetCode: string;
  rowNumber: number;
  /** fetch 数据驱动；缺省表示不启用。 */
  fetchDrive?: LocatorFetchDriveConfig;
  /** 内置货格绑定标记；存在且 parentId 指向声明了绑定的模型实体时，维度与位置由宿主模型驱动。 */
  builtInBinding?: LocatorBuiltInBinding;
};

export type CadReferenceOriginMode = 'center';
export type CadReferenceImportMode = 'exact' | 'large-preview';
/** CAD 单位判定来源：DXF 明确声明、MEASUREMENT 推断、毫米兜底或旧场景兼容。 */
export type CadReferenceUnitDetection = 'insunits' | 'measurement' | 'fallback' | 'legacy';

export type CadReferenceLayerStat = {
  name: string;
  entityCount: number;
  polylineCount: number;
  pointCount: number;
};

export type CadReferenceBounds = {
  min: Vector3Data;
  max: Vector3Data;
  size: Vector3Data;
  center: Vector3Data;
};

export type CadReferenceComponent = {
  sourcePath: string;
  sourceUrl: string;
  sourceFileSizeBytes: number;
  importMode: CadReferenceImportMode;
  sourceUnitCode: number | null;
  sourceUnitName: string;
  unitDetection: CadReferenceUnitDetection;
  unitScaleToMeters: number;
  originMode: CadReferenceOriginMode;
  lineColor: string;
  opacity: number;
  layerStats: CadReferenceLayerStat[];
  bounds: CadReferenceBounds;
  polylineCount: number;
  pointCount: number;
};

export type ModelScriptAsset = {
  path: string;
  sourceUrl: string;
  name: string;
};

/** 可复用的模型资产模板，不包含实例级 assetCode。 */
export type ModelAssetTemplate = {
  sourcePath: string;
  sourceUrl: string;
  assetRevision?: string;
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
  scriptAssets?: ModelScriptAsset[];
  parameterScriptMetadata?: unknown[];
  animationScriptMetadata?: unknown[];
  parameterConfig?: ModelParameterConfig;
  parameterValues?: ModelParameterValues;
  dataDrivenConfig?: ModelDataDrivenConfig;
  /** 模型包声明的内置货格绑定映射；缺省表示该模型不支持内置货格。 */
  builtInSlotBindingConfig?: BuiltInSlotBindingConfig;
};

/** 运行时模型资产组件，在模板基础上追加实例级资产编号。 */
export type ModelAssetComponent = ModelAssetTemplate & {
  assetCode: string;
};

/**
 * 旧版模型矩阵阵列中的隐藏逻辑项。
 * 仅用于兼容已有场景文件；新阵列会创建真实 Scene Entity，并使用 modelArrayInstance 关联渲染源。
 */
export type ModelArrayItem = {
  id: string;
  name: string;
  assetCode: string;
  /** 相对源模型的世界坐标偏移。 */
  offset: Vector3Data;
};

/** 旧版挂载在源模型实体上的隐藏矩阵阵列，反序列化时会迁移为独立实体。 */
export type ModelArrayComponent = {
  items: ModelArrayItem[];
};

/**
 * 独立模型实体的矩阵实例关联。
 * 实体仍保留名称、资产编号、Transform、显隐和锁定等完整编辑语义，Babylon 运行时只复用 sourceEntityId 的模型几何。
 */
export type ModelArrayInstanceComponent = {
  sourceEntityId: string;
};

/** 模型生成器的导入模型目标，保存资产索引信息和完整模型模板。 */
export type ModelGeneratorModelTarget = {
  kind: 'model';
  assetId: string;
  displayName: string;
  packagePath?: string;
  thumbnailUrl?: string;
  modelAsset: ModelAssetTemplate;
};

/** 模型生成器的内置 Mesh 目标，保存创建基础几何体所需字段。 */
export type ModelGeneratorMeshTarget = {
  kind: 'mesh';
  meshKind: MeshKind;
  displayName: string;
  materialColor: string;
};

/** 模型生成器可生成的目标类型集合。 */
export type ModelGeneratorTarget = ModelGeneratorModelTarget | ModelGeneratorMeshTarget;

/** 模型生成器规则，根据属性名和值选择一个生成目标。 */
export type ModelGeneratorRule = {
  id: string;
  attributeName: string;
  attributeValue: string;
  target: ModelGeneratorTarget | null;
};

/** 模型生成器组件，作为纯货箱模板库保存默认目标与规则；由设备遥测绑定或定位线框 fetch 驱动引用。 */
export type ModelGeneratorComponent = {
  defaultTarget: ModelGeneratorTarget | null;
  rules: ModelGeneratorRule[];
};

export type CameraComponent = {
  fov: number;
  near: number;
  far: number;
};

export type LightKind = 'hemispheric' | 'directional' | 'point';

export type LightComponent = {
  lightKind: LightKind;
  intensity: number;
};

/** POI 库内置 EFF 的稳定类型集合。 */
export type PoiEffectKind =
  | 'alarm-pulse'
  | 'warning-beacon'
  | 'locator-beam'
  | 'radar-scan'
  | 'fire'
  | 'smoke'
  | 'sparks'
  | 'steam-leak'
  | 'gas-leak'
  | 'water-jet'
  | 'pipeline-flow-particles'
  | 'pipeline-flow-arrows'
  | 'moving-double-arrow'
  | 'cargo-target-frame'
  | 'conveyor-direction'
  | 'evacuation-route';

/** EFF 实体只持久化可编辑参数，Babylon 运行时资源不进入场景文件。 */
export type PoiEffectComponent = {
  effectKind: PoiEffectKind;
  enabled: boolean;
  primaryColor: string;
  secondaryColor: string;
  intensity: number;
  speed: number;
  density: number;
};

export type AutoPatrolPathType = 'smooth' | 'linear';

export type AutoPatrolPlaybackMode = 'once' | 'loop' | 'ping-pong';

/** 自动巡检节点内部保存完整 ArcRotateCamera 位姿；坐标相对于巡检实体原点。 */
export type AutoPatrolCameraPose = {
  alpha: number;
  beta: number;
  radius: number;
  target: Vector3Data;
};

/** 到达动作在首期只保留空数组扩展位，避免提前固化不完整的通用事件协议。 */
export type AutoPatrolWaypoint = {
  id: string;
  pose: AutoPatrolCameraPose;
  travelDurationSeconds: number;
  dwellSeconds: number;
  arrivalActions: [];
};

export type AutoPatrolComponent = {
  enabled: boolean;
  autoStart: boolean;
  pathType: AutoPatrolPathType;
  playbackMode: AutoPatrolPlaybackMode;
  waypoints: AutoPatrolWaypoint[];
};

export type EntityComponents = {
  transform: TransformComponent;
  meshRenderer?: MeshRendererComponent;
  skybox?: SkyboxComponent;
  locator?: LocatorComponent;
  cadReference?: CadReferenceComponent;
  modelAsset?: ModelAssetComponent;
  /** @deprecated 仅用于加载旧版隐藏阵列项。 */
  modelArray?: ModelArrayComponent;
  modelArrayInstance?: ModelArrayInstanceComponent;
  modelGenerator?: ModelGeneratorComponent;
  telemetryBinding?: TelemetryBindingComponent;
  camera?: CameraComponent;
  light?: LightComponent;
  poiEffect?: PoiEffectComponent;
  autoPatrol?: AutoPatrolComponent;
};
