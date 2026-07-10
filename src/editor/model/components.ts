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

export type LocatorComponent = {
  assetId: string;
  length: number;
  width: number;
  height: number;
};

export type CadReferenceOriginMode = 'center';

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

export type ModelAssetComponent = {
  assetCode: string;
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

export type EntityComponents = {
  transform: TransformComponent;
  meshRenderer?: MeshRendererComponent;
  locator?: LocatorComponent;
  cadReference?: CadReferenceComponent;
  modelAsset?: ModelAssetComponent;
  telemetryBinding?: TelemetryBindingComponent;
  camera?: CameraComponent;
  light?: LightComponent;
};
