import type { Vector3Data } from './math';
import type { ModelSourceLengthUnit } from './sceneUnits';

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

export type ModelAssetComponent = {
  sourcePath: string;
  sourceUrl: string;
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
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
  modelAsset?: ModelAssetComponent;
  camera?: CameraComponent;
  light?: LightComponent;
};
