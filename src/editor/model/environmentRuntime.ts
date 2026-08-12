import type { SceneEnvironmentSettings } from './SceneDocument';
import type { Vector3Data } from './math';

export type EnvironmentWorldBounds = {
  minimum: Vector3Data;
  maximum: Vector3Data;
  center: Vector3Data;
  sizeMeters: Vector3Data;
  radiusMeters: number;
};

export type EnvironmentModelStatistics = {
  meshCount: number;
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  fileSizeBytes: number | null;
};

export type EnvironmentRuntimeSnapshot = {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  requestId: string | null;
  sourceUrl: string | null;
  message: string | null;
  bounds: EnvironmentWorldBounds | null;
  statistics: EnvironmentModelStatistics | null;
};

export type EnvironmentApplyRequest = {
  id: string;
  environment: SceneEnvironmentSettings;
  autoAlign: boolean;
  focusAfterLoad: boolean;
  commandLabel: string;
  successMessage: string;
  persistSceneChange: boolean;
  runtimeEnvironment?: SceneEnvironmentSettings;
};

export type EnvironmentApplyResult = {
  environment: SceneEnvironmentSettings;
  snapshot: EnvironmentRuntimeSnapshot;
};

export function createIdleEnvironmentRuntimeSnapshot(): EnvironmentRuntimeSnapshot {
  return {
    phase: 'idle',
    requestId: null,
    sourceUrl: null,
    message: null,
    bounds: null,
    statistics: null,
  };
}
