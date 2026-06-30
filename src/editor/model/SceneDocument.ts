import { createId } from '../../shared/ids';
import type { LightKind, MeshKind } from './components';
import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import type { ModelParameterConfig } from './modelParameters';
import { createDefaultModelParameterValues } from './modelParameters';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, type ModelLengthUnitInfo } from './sceneUnits';
import { vector3 } from './math';

export type SceneDocument = {
  id: string;
  name: string;
  entityIds: string[];
  entities: Record<string, Entity>;
  selectedEntityId: string | null;
};

export function createEmptySceneDocument(name = 'Untitled Scene'): SceneDocument {
  return {
    id: createId('scene'),
    name,
    entityIds: [],
    entities: {},
    selectedEntityId: null,
  };
}

export function createMeshEntity(meshKind: MeshKind, position: Vector3Data = vector3()): Entity {
  const id = createId('entity');
  const displayName = meshKind.charAt(0).toUpperCase() + meshKind.slice(1);

  return {
    id,
    name: displayName,
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

export function createLightEntity(lightKind: LightKind, position?: Vector3Data): Entity {
  const id = createId('entity');
  const displayName = `${lightKind.charAt(0).toUpperCase()}${lightKind.slice(1)} Light`;
  const defaultPosition = lightKind === 'hemispheric' ? vector3(0, 2, 0) : vector3(0, 3, 0);
  const lightPosition = position ? vector3(position.x, position.y, position.z) : defaultPosition;

  return {
    id,
    name: displayName,
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

export function createModelEntity(
  sourcePath: string,
  sourceUrl: string,
  displayName: string,
  unitInfo: ModelLengthUnitInfo = DEFAULT_MODEL_LENGTH_UNIT_INFO,
  position: Vector3Data = vector3(),
  parameterConfig?: ModelParameterConfig,
): Entity {
  const id = createId('entity');
  const trimmedName = displayName.trim();

  return {
    id,
    name: trimmedName.length > 0 ? trimmedName : 'Imported Model',
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      modelAsset: {
        sourcePath,
        sourceUrl,
        lengthUnit: unitInfo.lengthUnit,
        unitScaleToMeters: unitInfo.unitScaleToMeters,
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
