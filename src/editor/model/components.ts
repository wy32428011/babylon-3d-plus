import type { Vector3Data } from './math';
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

export type LocatorStorageDepth = 'near' | 'far';

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
};

/** 运行时模型资产组件，在模板基础上追加实例级资产编号。 */
export type ModelAssetComponent = ModelAssetTemplate & {
  assetCode: string;
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

/** 模型生成器绑定，将外部设备身份绑定到生成出的资产编号。 */
export type ModelGeneratorBinding = {
  id: string;
  sourceId: string;
  deviceType: string;
  assetCode: string;
};

/** 模型生成器仓储流配置，通过稳定绑定 ID 引用入库输送机、堆垛机和出库输送机。 */
export type ModelGeneratorWarehouseFlow = {
  enabled: boolean;
  inboundBindingId: string;
  stackerBindingId: string;
  outboundBindingId: string;
};

/** 模型生成器的数据源类型：mqtt 走遥测驱动，fetch 走 HTTP 接口驱动。 */
export type ModelGeneratorDataSource = 'mqtt' | 'fetch';

/** 模型生成器组件，保存默认目标、规则、元数据 TTL、设备绑定和可选仓储流。 */
export type ModelGeneratorComponent = {
  defaultTarget: ModelGeneratorTarget | null;
  rules: ModelGeneratorRule[];
  metadataTtlSeconds: number;
  bindings: ModelGeneratorBinding[];
  warehouseFlow?: ModelGeneratorWarehouseFlow;
  dataSource: ModelGeneratorDataSource;
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

export type EntityComponents = {
  transform: TransformComponent;
  meshRenderer?: MeshRendererComponent;
  locator?: LocatorComponent;
  cadReference?: CadReferenceComponent;
  modelAsset?: ModelAssetComponent;
  modelGenerator?: ModelGeneratorComponent;
  telemetryBinding?: TelemetryBindingComponent;
  camera?: CameraComponent;
  light?: LightComponent;
  poiEffect?: PoiEffectComponent;
};
