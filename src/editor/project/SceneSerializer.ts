import type { Entity } from '../model/Entity';
import type { SceneDocument } from '../model/SceneDocument';
import type { EntityComponents, LightKind, MeshKind } from '../model/components';
import type { Vector3Data } from '../model/math';
import { SCENE_LENGTH_UNIT, normalizeModelLengthUnitInfo, type SceneLengthUnit } from '../model/sceneUnits';

const UNSUPPORTED_SCENE_FILE_ERROR = '场景文件格式不受支持。';
const MESH_KINDS: readonly MeshKind[] = ['cube', 'sphere', 'plane'];
const LIGHT_KINDS: readonly LightKind[] = ['hemispheric', 'directional', 'point'];
const AUTHORIZED_MODEL_URL_PREFIX = 'editor-asset://local/';

type SceneFileUnits = {
  length: SceneLengthUnit;
};

type SceneFileDocument = {
  version: number;
  units: SceneFileUnits;
  scene?: unknown;
};

const DEFAULT_SCENE_FILE_UNITS: SceneFileUnits = { length: SCENE_LENGTH_UNIT };

type PlainObject = Record<string, unknown>;

export function serializeScene(scene: SceneDocument): string {
  return JSON.stringify({ version: 1, units: { length: SCENE_LENGTH_UNIT }, scene }, null, 2);
}

export function deserializeScene(content: string): SceneDocument {
  try {
    const parsed = JSON.parse(content) as unknown;
    const sceneFile = assertSceneFileDocument(parsed);
    return normalizeSceneDocument(sceneFile.scene);
  } catch (error) {
    if (error instanceof Error && error.message === UNSUPPORTED_SCENE_FILE_ERROR) {
      throw error;
    }

    throw new Error(UNSUPPORTED_SCENE_FILE_ERROR);
  }
}

function assertSceneFileDocument(value: unknown): SceneFileDocument {
  const document = assertPlainObject(value);
  const keys = Object.keys(document);
  const hasLegacyShape = keys.length === 2 && keys.includes('version') && keys.includes('scene');
  const hasUnitsShape = keys.length === 3 && keys.includes('version') && keys.includes('units') && keys.includes('scene');

  if ((!hasLegacyShape && !hasUnitsShape) || document.version !== 1) {
    throwUnsupportedSceneFileError();
  }

  const units = hasUnitsShape ? normalizeSceneFileUnits(document.units) : DEFAULT_SCENE_FILE_UNITS;

  return { version: 1, units, scene: document.scene };
}

function normalizeSceneFileUnits(value: unknown): SceneFileUnits {
  const units = assertPlainObject(value);
  const keys = Object.keys(units);

  if (keys.length !== 1 || units.length !== SCENE_LENGTH_UNIT) {
    throwUnsupportedSceneFileError();
  }

  return DEFAULT_SCENE_FILE_UNITS;
}

function normalizeSceneDocument(value: unknown): SceneDocument {
  const scene = assertPlainObject(value);
  const id = assertString(scene.id);
  const name = assertString(scene.name);
  const entityIds = assertUniqueStringArray(scene.entityIds);
  const sourceEntities = assertPlainObject(scene.entities);
  const entityKeys = Object.keys(sourceEntities);
  const entityIdSet = new Set(entityIds);
  const entities: Record<string, Entity> = {};

  if (entityKeys.length !== entityIds.length || entityKeys.some((entityId) => !entityIdSet.has(entityId))) {
    throwUnsupportedSceneFileError();
  }

  for (const entityId of entityIds) {
    const entity = sourceEntities[entityId];

    if (!entity) {
      throwUnsupportedSceneFileError();
    }

    const normalizedEntity = normalizeEntity(entity);
    if (normalizedEntity.id !== entityId) {
      throwUnsupportedSceneFileError();
    }

    entities[entityId] = normalizedEntity;
  }

  validateEntityHierarchy(entityIds, entities);

  if ('selectedEntityId' in scene && scene.selectedEntityId !== null && typeof scene.selectedEntityId !== 'string') {
    throwUnsupportedSceneFileError();
  }

  return {
    id,
    name,
    entityIds,
    entities,
    selectedEntityId: null,
  };
}

function normalizeEntity(value: unknown): Entity {
  const entity = assertPlainObject(value);

  return {
    id: assertString(entity.id),
    name: assertString(entity.name),
    parentId: assertNullableString(entity.parentId),
    childrenIds: assertUniqueStringArray(entity.childrenIds),
    components: normalizeComponents(entity.components),
  };
}

function normalizeComponents(value: unknown): EntityComponents {
  const components = assertPlainObject(value);
  const normalized: EntityComponents = {
    transform: normalizeTransform(components.transform),
  };

  if ('meshRenderer' in components && components.meshRenderer !== undefined) {
    normalized.meshRenderer = normalizeMeshRenderer(components.meshRenderer);
  }

  if ('modelAsset' in components && components.modelAsset !== undefined) {
    normalized.modelAsset = normalizeModelAsset(components.modelAsset);
  }

  if ('camera' in components && components.camera !== undefined) {
    normalized.camera = normalizeCamera(components.camera);
  }

  if ('light' in components && components.light !== undefined) {
    normalized.light = normalizeLight(components.light);
  }

  return normalized;
}

function normalizeTransform(value: unknown): EntityComponents['transform'] {
  const transform = assertPlainObject(value);

  return {
    position: normalizeVector3(transform.position),
    rotation: normalizeVector3(transform.rotation),
    scale: normalizeVector3(transform.scale),
  };
}

function normalizeVector3(value: unknown): Vector3Data {
  const vector = assertPlainObject(value);

  return {
    x: assertFiniteNumber(vector.x),
    y: assertFiniteNumber(vector.y),
    z: assertFiniteNumber(vector.z),
  };
}

function normalizeMeshRenderer(value: unknown): EntityComponents['meshRenderer'] {
  const meshRenderer = assertPlainObject(value);
  const meshKind = meshRenderer.meshKind;

  if (!MESH_KINDS.includes(meshKind as MeshKind)) {
    throwUnsupportedSceneFileError();
  }

  return {
    meshKind: meshKind as MeshKind,
    materialColor: assertString(meshRenderer.materialColor),
  };
}

function normalizeModelAsset(value: unknown): EntityComponents['modelAsset'] {
  const modelAsset = assertPlainObject(value);
  const sourcePath = assertString(modelAsset.sourcePath);
  const sourceUrl = assertString(modelAsset.sourceUrl);

  if (!sourceUrl.startsWith(AUTHORIZED_MODEL_URL_PREFIX)) {
    throwUnsupportedSceneFileError();
  }

  let unitInfo;
  try {
    unitInfo = normalizeModelLengthUnitInfo(modelAsset.lengthUnit, modelAsset.unitScaleToMeters);
  } catch {
    throwUnsupportedSceneFileError();
  }

  return {
    sourcePath,
    sourceUrl,
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
  };
}

function normalizeCamera(value: unknown): EntityComponents['camera'] {
  const camera = assertPlainObject(value);

  return {
    fov: assertFiniteNumber(camera.fov),
    near: assertFiniteNumber(camera.near),
    far: assertFiniteNumber(camera.far),
  };
}

function normalizeLight(value: unknown): EntityComponents['light'] {
  const light = assertPlainObject(value);
  const lightKind = light.lightKind;

  if (!LIGHT_KINDS.includes(lightKind as LightKind)) {
    throwUnsupportedSceneFileError();
  }

  return {
    lightKind: lightKind as LightKind,
    intensity: assertFiniteNumber(light.intensity),
  };
}

function validateEntityHierarchy(entityIds: string[], entities: Record<string, Entity>): void {
  const entityIdSet = new Set(entityIds);

  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity) throwUnsupportedSceneFileError();

    if (entity.parentId !== null) {
      const parent = entities[entity.parentId];
      if (!parent || !parent.childrenIds.includes(entityId)) {
        throwUnsupportedSceneFileError();
      }
    }

    for (const childId of entity.childrenIds) {
      const child = entities[childId];
      if (!entityIdSet.has(childId) || !child || child.parentId !== entityId) {
        throwUnsupportedSceneFileError();
      }
    }
  }
}

function assertPlainObject(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throwUnsupportedSceneFileError();
  }

  return value as PlainObject;
}

function assertString(value: unknown): string {
  if (typeof value !== 'string') {
    throwUnsupportedSceneFileError();
  }

  return value;
}

function assertNullableString(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') {
    throwUnsupportedSceneFileError();
  }

  return value;
}

function assertUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throwUnsupportedSceneFileError();
  }

  const values = [...value];
  if (new Set(values).size !== values.length) {
    throwUnsupportedSceneFileError();
  }

  return values;
}

function assertFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwUnsupportedSceneFileError();
  }

  return value;
}

function throwUnsupportedSceneFileError(): never {
  throw new Error(UNSUPPORTED_SCENE_FILE_ERROR);
}
