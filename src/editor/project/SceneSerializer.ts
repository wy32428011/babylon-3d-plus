import { normalizeAlarmManager } from '../model/alarmManager';
import type { Entity } from '../model/Entity';
import { convertLegacyChartMarkerTransform, normalizeChartMarker } from '../model/chartMarker';
import { createPersistedModelThinInstanceScene } from '../model/editModeModelThinInstances';
import { createLegacyCadReferenceUnitInfo, normalizeCadReferenceUnitInfo } from '../cad/cadUnits';
import {
  AUTHORIZED_LOCAL_ASSET_URL_PREFIX,
  SCENE_CAMERA_ORIENTATION_DEFAULT,
  SCENE_CAMERA_PROJECTION_DEFAULT,
  createDefaultSceneSettings,
  createSkyboxEntity,
  DEFAULT_MQTT_CONFIG,
  MODEL_ASSET_CODE_MAX_LENGTH,
  createModelAssetCode,
  normalizeDataPlatformResourceId,
  readOwnDataProperty,
  normalizeSkyboxSphereScale,
  normalizeStackerSimulationScenario,
  sanitizeFetchConfig,
  sanitizeMqttConfig,
  sanitizeSceneSettings,
  sanitizeSceneShadowSettings,
  sanitizeSceneSkybox,
  sanitizeSceneViewDistance,
  isSceneCameraOrientation,
  isSceneShadowQuality,
  SCENE_SENSITIVITY_DEFAULT,
  SCENE_SKYBOX_VIEW_DISTANCE_MIN,
  type MqttConfig,
  type SceneCameraOrientation,
  type SceneCameraProjection,
  type SceneDocument,
  type SceneEnvironmentSettings,
  type SceneEnvironmentVariant,
  type SceneSettings,
  type SceneSkyboxSettings,
} from '../model/SceneDocument';
import type { AutoPatrolComponent, ClickEventBindingComponent, EntityComponents, LightKind, LocatorComponent, LocatorStorageDepth, ManualRoamSpawnComponent, MeshKind, PoiEffectComponent } from '../model/components';
import {
  MODEL_GENERATOR_MAX_RULES,
  sanitizeModelGeneratorComponent,
  sanitizeModelGeneratorTarget,
} from '../model/modelGenerator';
import { sanitizeClickEventBindingComponent } from '../model/clickEventBinding';
import type { Vector3Data } from '../model/math';
import { ENTITY_NAME_MAX_LENGTH, MODEL_ARRAY_ITEM_COUNT_MAX } from '../model/modelArray';
import { isPoiEffectHexColor, isPoiEffectKind, sanitizePoiEffectComponent } from '../model/poiEffect';
import { sanitizeAutoPatrolComponent } from '../model/autoPatrolInspection';
import { createDefaultModelParameterValues, normalizeModelParameterConfig, sanitizeModelParameterValues } from '../model/modelParameters';
import { SCENE_LENGTH_UNIT, normalizeModelLengthUnitInfo, type SceneLengthUnit } from '../model/sceneUnits';
import {
  createDefaultTelemetryBinding,
  normalizeModelDataDrivenConfig,
  normalizeTelemetryBindingComponent,
} from '../model/telemetryBinding';
import { normalizeBuiltInSlotBindingConfig, normalizeLocatorBuiltInBinding } from '../model/builtInSlotBinding';
import {
  normalizeDataPlatformScreenComponent,
  normalizeDataPlatformViewportScreen,
} from '../model/dataPlatformScreen';
import type { DataPlatformScreenComponent } from '../model/components';
import {
  logLegacySceneMigrationSummary,
  logSceneV2ToV3MigrationSummary,
  logSceneV3ToV4MigrationSummary,
  logSceneV4ToV5MigrationSummary,
  migrateLegacySceneV1ToV2,
  migrateSceneV2ToV3,
  migrateSceneV3ToV4,
  migrateSceneV4ToV5,
} from './sceneMigration';

const UNSUPPORTED_SCENE_FILE_ERROR = '场景文件格式不受支持。';
const INVALID_SKYBOX_RESOURCE_ID_ERROR = '场景文件格式不受支持：dataPlatformResourceId 必须是 trim 后 1-64 位正十进制字符串。';
const MESH_KINDS: readonly MeshKind[] = ['cube', 'sphere', 'plane'];
const LIGHT_KINDS: readonly LightKind[] = ['hemispheric', 'directional', 'point'];
const MODEL_SCRIPT_EXTENSION = '.ts';
const MODEL_SCRIPT_DECLARATION_EXTENSION = '.d.ts';
const LOCATOR_MIN_DIMENSION = 0.01;
const LOCATOR_ASSET_ID_MAX_LENGTH = 128;
const CAD_REFERENCE_LAYER_STATS_MAX_LENGTH = 512;

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
  const snapshot = createSerializableSceneSnapshot(createPersistedModelThinInstanceScene(scene));
  return JSON.stringify({ version: 5, units: { length: SCENE_LENGTH_UNIT }, scene: snapshot }, null, 2);
}

/** 保存前只替换天空盒嵌套对象，保留其它场景引用并确保不修改输入。 */
function createSerializableSceneSnapshot(scene: SceneDocument): SceneDocument {
  const entities = Object.fromEntries(
    Object.entries(scene.entities).map(([entityId, entity]) => [
      entityId,
      createSerializableEntitySnapshot(entity),
    ]),
  );
  const sceneSettings = scene.sceneSettings as SceneSettings | undefined;
  if (sceneSettings === undefined) return { ...scene, entities };
  return {
    ...scene,
    entities,
    sceneSettings: {
      ...sceneSettings,
      skybox: normalizeSceneSkyboxSettings(sceneSettings.skybox),
    },
  };
}

/** 可编辑资源组件使用加载入口同一套严格规范化，避免保存无法重新打开的配置。 */
function createSerializableEntitySnapshot(entity: Entity): Entity {
  if (!entity.components.skybox && !entity.components.chartMarker) return entity;
  return {
    ...entity,
    components: {
      ...entity.components,
      ...(entity.components.skybox ? { skybox: normalizeSkyboxComponent(entity.components.skybox) } : {}),
      ...(entity.components.chartMarker ? { chartMarker: normalizeChartMarker(entity.components.chartMarker) } : {}),
    },
  };
}

export function deserializeScene(content: string): SceneDocument {
  try {
    const parsed = JSON.parse(content) as unknown;
    const sceneFile = assertSceneFileDocument(parsed);
    const rawScene = assertPlainObject(sceneFile.scene);
    if (sceneFile.version === 1) {
      logLegacySceneMigrationSummary(migrateLegacySceneV1ToV2(rawScene));
    }
    if (sceneFile.version <= 2) {
      logSceneV2ToV3MigrationSummary(migrateSceneV2ToV3(rawScene));
    }
    if (sceneFile.version <= 3) {
      logSceneV3ToV4MigrationSummary(migrateSceneV3ToV4(rawScene));
    }
    if (sceneFile.version <= 4) {
      logSceneV4ToV5MigrationSummary(migrateSceneV4ToV5(rawScene));
    }
    return normalizeSceneDocument(rawScene);
  } catch (error) {
    if (error instanceof Error && (
      error.message === UNSUPPORTED_SCENE_FILE_ERROR
      || error.message === INVALID_SKYBOX_RESOURCE_ID_ERROR
    )) {
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

  if ((!hasLegacyShape && !hasUnitsShape) || (
    document.version !== 1
    && document.version !== 2
    && document.version !== 3
    && document.version !== 4
    && document.version !== 5
  )) {
    throwUnsupportedSceneFileError();
  }

  const units = hasUnitsShape ? normalizeSceneFileUnits(document.units) : DEFAULT_SCENE_FILE_UNITS;

  return { version: document.version, units, scene: document.scene };
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

  const migratedScene = migrateLegacyModelArrays(entityIds, entities);
  const sceneSettings = normalizeSceneSettings(scene.sceneSettings);
  const migratedSkybox = migrateLegacySkyboxSettingsToEntity(
    migratedScene.entityIds,
    migratedScene.entities,
    sceneSettings,
  );
  const normalizedPatrolEntities = enforceSingleAutoStartPatrol(
    migratedSkybox.entityIds,
    migratedSkybox.entities,
  );
  validateSingleManualRoamSpawn(migratedSkybox.entityIds, normalizedPatrolEntities);
  validateEntityHierarchy(migratedSkybox.entityIds, normalizedPatrolEntities);
  validateModelArrayInstanceReferences(migratedSkybox.entityIds, migratedSkybox.entities);

  if ('selectedEntityId' in scene && scene.selectedEntityId !== null && typeof scene.selectedEntityId !== 'string') {
    throwUnsupportedSceneFileError();
  }

  return {
    id,
    name,
    entityIds: migratedSkybox.entityIds,
    entities: normalizedPatrolEntities,
    selectedEntityId: null,
    mqttConfig: normalizeMqttConfig(scene.mqttConfig),
    fetchConfig: sanitizeFetchConfig(scene.fetchConfig),
    sceneSettings: migratedSkybox.sceneSettings,
  };
}

/** 天空盒存在时把持久化相机距离提升到 12 km，避免 10 km 球体被远裁剪面截断。 */
function enforceSkyboxMinimumViewDistance(sceneSettings: SceneSettings): SceneSettings {
  const viewDistance = sanitizeSceneViewDistance(
    sceneSettings.camera.viewDistance,
    SCENE_SKYBOX_VIEW_DISTANCE_MIN,
  );
  if (viewDistance === sceneSettings.camera.viewDistance) return sceneSettings;
  return {
    ...sceneSettings,
    camera: { ...sceneSettings.camera, viewDistance },
  };
}

/** 把旧 sceneSettings.skybox 自动迁移为可进入 Hierarchy 的球形天空盒实体。 */
function migrateLegacySkyboxSettingsToEntity(
  entityIds: string[],
  entities: Record<string, Entity>,
  sceneSettings: SceneSettings,
): { entityIds: string[]; entities: Record<string, Entity>; sceneSettings: SceneSettings } {
  const skyboxEntityIds = entityIds.filter((entityId) => Boolean(entities[entityId]?.components.skybox));
  if (skyboxEntityIds.length > 1) throwUnsupportedSceneFileError();
  if (skyboxEntityIds.length === 1 || !sceneSettings.skybox) {
    const nextSceneSettings = sceneSettings.skybox ? { ...sceneSettings, skybox: null } : sceneSettings;
    return {
      entityIds,
      entities,
      sceneSettings: skyboxEntityIds.length === 1
        ? enforceSkyboxMinimumViewDistance(nextSceneSettings)
        : nextSceneSettings,
    };
  }

  let skyboxEntity = createSkyboxEntity(sceneSettings.skybox);
  for (let attempt = 0; entities[skyboxEntity.id] && attempt < 8; attempt += 1) {
    skyboxEntity = createSkyboxEntity(sceneSettings.skybox);
  }
  if (entities[skyboxEntity.id]) throwUnsupportedSceneFileError();

  return {
    entityIds: [...entityIds, skyboxEntity.id],
    entities: { ...entities, [skyboxEntity.id]: skyboxEntity },
    sceneSettings: enforceSkyboxMinimumViewDistance({ ...sceneSettings, skybox: null }),
  };
}

function normalizeMqttConfig(value: unknown): MqttConfig {
  if (value === undefined) return DEFAULT_MQTT_CONFIG;

  const config = assertPlainObject(value);
  return sanitizeMqttConfig({
    enabled: assertOptionalBoolean(config.enabled, DEFAULT_MQTT_CONFIG.enabled),
    ip: config.ip === undefined ? DEFAULT_MQTT_CONFIG.ip : assertString(config.ip),
    address: config.address === undefined ? DEFAULT_MQTT_CONFIG.address : assertString(config.address),
    topic: config.topic === undefined ? DEFAULT_MQTT_CONFIG.topic : assertString(config.topic),
    simulatorEnabled: assertOptionalBoolean(config.simulatorEnabled, DEFAULT_MQTT_CONFIG.simulatorEnabled),
    simulatorAssetCode: config.simulatorAssetCode === undefined
      ? DEFAULT_MQTT_CONFIG.simulatorAssetCode
      : assertString(config.simulatorAssetCode),
    simulatorScenario: normalizeStackerSimulationScenario(config.simulatorScenario),
    simulatorIntervalMs: config.simulatorIntervalMs === undefined
      ? DEFAULT_MQTT_CONFIG.simulatorIntervalMs
      : assertFiniteNumber(config.simulatorIntervalMs),
    subscriptions: Array.isArray(config.subscriptions) ? config.subscriptions : [],
  });
}

function normalizeSceneSettings(value: unknown): SceneSettings {
  if (value === undefined) return createDefaultSceneSettings();

  const settings = assertPlainObject(value);
  const camera = assertPlainObject(settings.camera);
  const sensitivity = settings.sensitivity === undefined ? undefined : assertPlainObject(settings.sensitivity);
  const shadows = settings.shadows === undefined ? undefined : assertPlainObject(settings.shadows);

  return sanitizeSceneSettings({
    camera: {
      savedPose: normalizeSceneCameraPose(camera.savedPose),
      savedOrientation: normalizeSceneCameraOrientation(camera.savedOrientation),
      savedProjection: normalizeSceneCameraProjection(camera.savedProjection),
      viewDistance: assertFiniteNumber(camera.viewDistance),
    },
    sensitivity: {
      zoom: typeof sensitivity?.zoom === 'number' ? sensitivity.zoom : SCENE_SENSITIVITY_DEFAULT,
      pan: typeof sensitivity?.pan === 'number' ? sensitivity.pan : SCENE_SENSITIVITY_DEFAULT,
      rotate: typeof sensitivity?.rotate === 'number' ? sensitivity.rotate : SCENE_SENSITIVITY_DEFAULT,
    },
    shadows: sanitizeSceneShadowSettings(shadows ? {
      enabled: typeof shadows.enabled === 'boolean' ? shadows.enabled : undefined,
      quality: isSceneShadowQuality(shadows.quality) ? shadows.quality : undefined,
      darkness: typeof shadows.darkness === 'number' ? shadows.darkness : undefined,
      catcherEnabled: typeof shadows.catcherEnabled === 'boolean' ? shadows.catcherEnabled : undefined,
      sunAzimuthDegrees: typeof shadows.sunAzimuthDegrees === 'number' ? shadows.sunAzimuthDegrees : undefined,
      sunElevationDegrees: typeof shadows.sunElevationDegrees === 'number' ? shadows.sunElevationDegrees : undefined,
      sunIntensity: typeof shadows.sunIntensity === 'number' ? shadows.sunIntensity : undefined,
      distanceMeters: typeof shadows.distanceMeters === 'number' ? shadows.distanceMeters : undefined,
      bias: typeof shadows.bias === 'number' ? shadows.bias : undefined,
      normalBias: typeof shadows.normalBias === 'number' ? shadows.normalBias : undefined,
      fillIntensity: typeof shadows.fillIntensity === 'number' ? shadows.fillIntensity : undefined,
      iblIntensityMax: typeof shadows.iblIntensityMax === 'number' ? shadows.iblIntensityMax : undefined,
    } : undefined),
    environment: normalizeSceneEnvironmentSettings(settings.environment),
    skybox: normalizeSceneSkyboxSettings(settings.skybox),
    // 旧场景文件没有该字段；宽松读取，缺失/非法一律 null，不阻断打开。
    defaultCargoGeneratorId: typeof settings.defaultCargoGeneratorId === 'string'
      ? settings.defaultCargoGeneratorId
      : null,
    viewportScreen: normalizeDataPlatformViewportScreen(settings.viewportScreen),
  });
}

function normalizeSceneSkyboxSettings(value: unknown): SceneSkyboxSettings | null {
  if (value === null || value === undefined) return null;

  const skybox = assertPlainObject(value);
  const sourceUrl = assertString(skybox.sourceUrl);
  if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) {
    throwUnsupportedSceneFileError();
  }

  const format = skybox.format;
  if (format !== 'hdr' && format !== 'exr') {
    throwUnsupportedSceneFileError();
  }

  const dataPlatformResourceId = normalizeOptionalDataPlatformResourceId(skybox);
  const normalized = sanitizeSceneSkybox({
    packagePath: assertString(skybox.packagePath),
    sourcePath: assertString(skybox.sourcePath),
    sourceUrl,
    ...(skybox.assetRevision === undefined ? {} : { assetRevision: assertString(skybox.assetRevision) }),
    ...(dataPlatformResourceId ? { dataPlatformResourceId } : {}),
    format,
    rotationDegrees: assertFiniteNumber(skybox.rotationDegrees),
    intensity: assertFiniteNumber(skybox.intensity),
    resolution: assertFiniteNumber(skybox.resolution) as SceneSkyboxSettings['resolution'],
  });
  if (!normalized) throwUnsupportedSceneFileError();
  return normalized;
}

function normalizeSceneCameraPose(value: unknown): SceneSettings['camera']['savedPose'] {
  if (value === null || value === undefined) return null;

  const pose = assertPlainObject(value);
  return {
    alpha: assertFiniteNumber(pose.alpha),
    beta: assertFiniteNumber(pose.beta),
    radius: assertFiniteNumber(pose.radius),
    target: normalizeVector3(pose.target),
  };
}

function normalizeSceneCameraOrientation(value: unknown): SceneCameraOrientation {
  if (value === undefined) return SCENE_CAMERA_ORIENTATION_DEFAULT;
  if (isSceneCameraOrientation(value)) return value;
  throwUnsupportedSceneFileError();
}

function normalizeSceneCameraProjection(value: unknown): SceneCameraProjection {
  if (value === undefined) return SCENE_CAMERA_PROJECTION_DEFAULT;
  if (value === 'perspective' || value === 'orthographic') return value;
  throwUnsupportedSceneFileError();
}

function normalizeSceneEnvironmentSettings(value: unknown): SceneEnvironmentSettings | null {
  if (value === null || value === undefined) return null;

  const environment = assertPlainObject(value);
  const variants = normalizeSceneEnvironmentVariants(environment.variants);
  const activeVariantUrl = assertString(environment.activeVariantUrl);

  if (!activeVariantUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) {
    throwUnsupportedSceneFileError();
  }

  let unitInfo;
  try {
    unitInfo = normalizeModelLengthUnitInfo(environment.lengthUnit, environment.unitScaleToMeters);
  } catch {
    throwUnsupportedSceneFileError();
  }

  const placementMode = environment.placementMode === undefined
    ? 'legacy-left'
    : environment.placementMode;
  if (placementMode !== 'legacy-left' && placementMode !== 'scene-base') {
    throwUnsupportedSceneFileError();
  }
  const transform = environment.transform === undefined
    ? undefined
    : normalizeSceneEnvironmentTransform(environment.transform);
  const opacity = environment.opacity === undefined ? 1 : assertFiniteNumber(environment.opacity);
  const fileSizeBytes = environment.fileSizeBytes === undefined
    ? undefined
    : assertFiniteNumber(environment.fileSizeBytes);
  if (fileSizeBytes !== undefined && fileSizeBytes <= 0) throwUnsupportedSceneFileError();
  const sourceField = readOwnDataProperty(environment, 'source');
  const resourceTypeField = readOwnDataProperty(environment, 'resourceType');
  const resourceIdField = readOwnDataProperty(environment, 'dataPlatformResourceId');
  const sourceKeyField = readOwnDataProperty(environment, 'dataPlatformSourceKey');
  const revisionField = readOwnDataProperty(environment, 'dataPlatformRevision');
  const source = sourceField.kind === 'data' && sourceField.value === 'data-platform'
    ? 'data-platform'
    : undefined;
  const resourceType = resourceTypeField.kind === 'data' && resourceTypeField.value === 'ENV_MODEL'
    ? 'ENV_MODEL'
    : undefined;
  const dataPlatformResourceId = resourceIdField.kind === 'data'
    ? normalizeDataPlatformResourceId(resourceIdField.value)
    : null;
  const dataPlatformSourceKey = sourceKeyField.kind === 'data' && typeof sourceKeyField.value === 'string'
    && /^[0-9a-f]{64}$/.test(sourceKeyField.value.trim()) ? sourceKeyField.value.trim() : null;
  const dataPlatformRevision = revisionField.kind === 'data' && typeof revisionField.value === 'string'
    && /^[1-9]\d{0,63}$/.test(revisionField.value.trim()) ? revisionField.value.trim() : null;
  const hasAnyRemoteIdentity = [sourceField, resourceTypeField, resourceIdField, sourceKeyField, revisionField]
    .some((field) => field.kind !== 'missing');
  if (hasAnyRemoteIdentity && (!source || !resourceType || !dataPlatformResourceId || !dataPlatformSourceKey || !dataPlatformRevision)) {
    throwUnsupportedSceneFileError();
  }
  const displayNameSnapshot = source && environment.displayNameSnapshot !== undefined
    ? assertString(environment.displayNameSnapshot).trim()
    : undefined;

  return {
    packagePath: assertString(environment.packagePath),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(environment.thumbnailUrl === undefined ? {} : { thumbnailUrl: assertString(environment.thumbnailUrl) }),
    ...(environment.displayName === undefined ? {} : { displayName: assertString(environment.displayName) }),
    ...(fileSizeBytes === undefined ? {} : { fileSizeBytes }),
    ...(source ? {
      source,
      resourceType: resourceType!,
      dataPlatformResourceId: dataPlatformResourceId!,
      dataPlatformSourceKey: dataPlatformSourceKey!,
      dataPlatformRevision: dataPlatformRevision!,
      ...(displayNameSnapshot ? { displayNameSnapshot } : {}),
    } : {}),
    placementMode,
    transform: transform ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
    visible: assertOptionalBoolean(environment.visible, true),
    opacity,
    activeVariantUrl,
    variants,
  };
}

function normalizeSceneEnvironmentTransform(value: unknown): NonNullable<SceneEnvironmentSettings['transform']> {
  const transform = assertPlainObject(value);
  return {
    position: normalizeVector3(transform.position),
    rotation: normalizeVector3(transform.rotation),
    scale: assertFiniteNumber(transform.scale),
  };
}

function normalizeSceneEnvironmentVariants(value: unknown): SceneEnvironmentVariant[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throwUnsupportedSceneFileError();
  }

  return value.map((item) => {
    const variant = assertPlainObject(item);
    const sourceUrl = assertString(variant.sourceUrl);

    if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) {
      throwUnsupportedSceneFileError();
    }

    return {
      name: assertString(variant.name),
      sourcePath: assertString(variant.sourcePath),
      sourceUrl,
    };
  });
}

function normalizeEntity(value: unknown): Entity {
  const entity = assertPlainObject(value);
  const id = assertString(entity.id);
  const isFolder = assertOptionalBoolean(entity.isFolder, false);
  const components = normalizeComponents(entity.components, id);

  if (isFolder && hasRuntimeComponent(components)) {
    throwUnsupportedSceneFileError();
  }

  return {
    id,
    name: assertString(entity.name),
    isFolder,
    visible: assertOptionalBoolean(entity.visible, true),
    locked: assertOptionalBoolean(entity.locked, false),
    parentId: assertNullableString(entity.parentId),
    childrenIds: assertUniqueStringArray(entity.childrenIds),
    components,
  };
}

function normalizeComponents(value: unknown, entityId: string): EntityComponents {
  const components = assertPlainObject(value);
  const normalized: EntityComponents = {
    transform: normalizeTransform(components.transform),
  };

  if ('meshRenderer' in components && components.meshRenderer !== undefined) {
    normalized.meshRenderer = normalizeMeshRenderer(components.meshRenderer);
  }

  if ('dataPlatformScreen' in components && components.dataPlatformScreen !== undefined) {
    if (normalized.meshRenderer?.meshKind !== 'plane') throwUnsupportedSceneFileError();
    normalized.dataPlatformScreen = normalizeDataPlatformScreen(components.dataPlatformScreen);
  }

  if ('chartMarker' in components && components.chartMarker !== undefined) {
    if (normalized.meshRenderer?.meshKind !== 'plane') throwUnsupportedSceneFileError();
    normalized.chartMarker = normalizeChartMarker(components.chartMarker);
    if (normalized.chartMarker.geometryBasis !== 'upright') {
      normalized.transform = convertLegacyChartMarkerTransform(normalized.transform);
      normalized.chartMarker = { ...normalized.chartMarker, geometryBasis: 'upright' };
    }
  }

  if ('skybox' in components && components.skybox !== undefined) {
    normalized.skybox = normalizeSkyboxComponent(components.skybox);
    normalized.transform = {
      ...normalized.transform,
      scale: normalizeSkyboxSphereScale(normalized.transform.scale),
    };
  }

  if ('locator' in components && components.locator !== undefined) {
    normalized.locator = normalizeLocator(components.locator);
  }

  if ('cadReference' in components && components.cadReference !== undefined) {
    normalized.cadReference = normalizeCadReference(components.cadReference);
  }

  if ('modelAsset' in components && components.modelAsset !== undefined) {
    normalized.modelAsset = normalizeModelAsset(components.modelAsset, entityId);
  }

  if ('modelArray' in components && components.modelArray !== undefined) {
    if (!normalized.modelAsset) throwUnsupportedSceneFileError();
    normalized.modelArray = normalizeModelArray(components.modelArray);
  }

  if ('modelArrayInstance' in components && components.modelArrayInstance !== undefined) {
    if (!normalized.modelAsset) throwUnsupportedSceneFileError();
    normalized.modelArrayInstance = normalizeModelArrayInstance(components.modelArrayInstance);
  }

  if ('modelGenerator' in components && components.modelGenerator !== undefined) {
    normalized.modelGenerator = normalizeModelGenerator(components.modelGenerator);
  }

  if ('telemetryBinding' in components && components.telemetryBinding !== undefined) {
    const telemetryBinding = normalizeTelemetryBindingComponent(components.telemetryBinding);
    if (!telemetryBinding) throwUnsupportedSceneFileError();
    normalized.telemetryBinding = telemetryBinding;
  } else if (normalized.modelAsset?.dataDrivenConfig?.device.devType) {
    normalized.telemetryBinding = createDefaultTelemetryBinding(normalized.modelAsset.dataDrivenConfig.device.devType);
  }

  if ('camera' in components && components.camera !== undefined) {
    normalized.camera = normalizeCamera(components.camera);
  }

  if ('light' in components && components.light !== undefined) {
    normalized.light = normalizeLight(components.light);
  }

  if ('poiEffect' in components && components.poiEffect !== undefined) {
    normalized.poiEffect = normalizePoiEffect(components.poiEffect);
  }

  if ('autoPatrol' in components && components.autoPatrol !== undefined) {
    normalized.autoPatrol = normalizeAutoPatrol(components.autoPatrol);
    normalized.transform = {
      ...normalized.transform,
      scale: { x: 1, y: 1, z: 1 },
    };
  }

  if ('manualRoamSpawn' in components && components.manualRoamSpawn !== undefined) {
    normalized.manualRoamSpawn = normalizeManualRoamSpawn(components.manualRoamSpawn);
    normalized.transform = {
      ...normalized.transform,
      rotation: { x: 0, y: normalized.transform.rotation.y, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
  }

  if (components.alarmManager !== undefined) normalized.alarmManager = normalizeAlarmManager(components.alarmManager);

  if ('clickEventBinding' in components && components.clickEventBinding !== undefined) {
    normalized.clickEventBinding = normalizeClickEventBinding(components.clickEventBinding);
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

/** 严格恢复源模型上的矩阵阵列逻辑项，Babylon 运行时资源不会进入场景文件。 */
function normalizeModelArray(value: unknown): NonNullable<EntityComponents['modelArray']> {
  const modelArray = assertPlainObject(value);
  const items = assertArray(modelArray.items);
  if (items.length > MODEL_ARRAY_ITEM_COUNT_MAX) throwUnsupportedSceneFileError();

  const normalizedItems = items.map((item) => {
    const source = assertPlainObject(item);
    const id = assertString(source.id).trim();
    const name = assertString(source.name).trim();
    const assetCode = assertString(source.assetCode).trim();
    if (
      !id
      || id.length > 128
      || !name
      || name.length > ENTITY_NAME_MAX_LENGTH
      || !assetCode
      || assetCode.length > MODEL_ASSET_CODE_MAX_LENGTH
    ) {
      throwUnsupportedSceneFileError();
    }

    return {
      id,
      name,
      assetCode,
      offset: normalizeVector3(source.offset),
    };
  });

  if (new Set(normalizedItems.map((item) => item.id)).size !== normalizedItems.length) {
    throwUnsupportedSceneFileError();
  }

  return { items: normalizedItems };
}

/** 恢复独立阵列模型与其共享渲染源之间的稳定引用。 */
function normalizeModelArrayInstance(value: unknown): NonNullable<EntityComponents['modelArrayInstance']> {
  const modelArrayInstance = assertPlainObject(value);
  const sourceEntityId = assertString(modelArrayInstance.sourceEntityId).trim();
  if (!sourceEntityId || sourceEntityId.length > 128) throwUnsupportedSceneFileError();
  return { sourceEntityId };
}

/** 深拷贝已经通过 JSON 边界校验的组件快照，避免迁移出的实体共享可变嵌套引用。 */
function cloneNormalizedComponents(components: EntityComponents): EntityComponents {
  return JSON.parse(JSON.stringify(components)) as EntityComponents;
}

/**
 * 把旧版源实体上的隐藏 modelArray.items 转换为真实 Scene Entity。
 * 新实体保留完整模型组件和独立 Transform，仅通过 modelArrayInstance 共享 Babylon 渲染源。
 */
function migrateLegacyModelArrays(
  entityIds: string[],
  entities: Record<string, Entity>,
): { entityIds: string[]; entities: Record<string, Entity> } {
  if (!entityIds.some((entityId) => (entities[entityId]?.components.modelArray?.items.length ?? 0) > 0)) {
    return { entityIds, entities };
  }

  const migratedEntities: Record<string, Entity> = { ...entities };
  const migratedEntityIds: string[] = [];
  const parentAdditions = new Map<string, string[]>();

  for (const entityId of entityIds) {
    const source = migratedEntities[entityId];
    if (!source) throwUnsupportedSceneFileError();
    migratedEntityIds.push(entityId);

    const legacyItems = source.components.modelArray?.items ?? [];
    if (legacyItems.length === 0) continue;
    if (!source.components.modelAsset || source.components.modelArrayInstance) throwUnsupportedSceneFileError();

    const sourceComponents = cloneNormalizedComponents(source.components);
    delete sourceComponents.modelArray;
    migratedEntities[entityId] = { ...source, components: sourceComponents };

    for (const item of legacyItems) {
      if (migratedEntities[item.id]) throwUnsupportedSceneFileError();

      const components = cloneNormalizedComponents(sourceComponents);
      components.transform = {
        ...components.transform,
        position: {
          x: components.transform.position.x + item.offset.x,
          y: components.transform.position.y + item.offset.y,
          z: components.transform.position.z + item.offset.z,
        },
      };
      components.modelAsset = {
        ...components.modelAsset!,
        assetCode: item.assetCode,
      };
      components.modelArrayInstance = { sourceEntityId: source.id };

      migratedEntities[item.id] = {
        ...source,
        id: item.id,
        name: item.name,
        parentId: source.parentId,
        childrenIds: [],
        components,
      };
      migratedEntityIds.push(item.id);

      if (source.parentId) {
        const additions = parentAdditions.get(source.parentId) ?? [];
        additions.push(item.id);
        parentAdditions.set(source.parentId, additions);
      }
    }
  }

  for (const [parentId, additions] of parentAdditions) {
    const parent = migratedEntities[parentId];
    if (!parent?.isFolder) throwUnsupportedSceneFileError();
    migratedEntities[parentId] = {
      ...parent,
      childrenIds: [...parent.childrenIds, ...additions.filter((entityId) => !parent.childrenIds.includes(entityId))],
    };
  }

  return { entityIds: migratedEntityIds, entities: migratedEntities };
}

/** 阵列实例必须直接引用一个仍存在的非实例源模型，禁止悬空、自引用和链式引用。 */
function validateModelArrayInstanceReferences(entityIds: string[], entities: Record<string, Entity>): void {
  const instanceCounts = new Map<string, number>();
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    const instance = entity?.components.modelArrayInstance;
    if (!instance) continue;

    const source = entities[instance.sourceEntityId];
    if (
      !entity.components.modelAsset
      || instance.sourceEntityId === entity.id
      || !source?.components.modelAsset
      || source.components.modelArrayInstance
    ) {
      throwUnsupportedSceneFileError();
    }

    const nextCount = (instanceCounts.get(instance.sourceEntityId) ?? 0) + 1;
    if (nextCount > MODEL_ARRAY_ITEM_COUNT_MAX) throwUnsupportedSceneFileError();
    instanceCounts.set(instance.sourceEntityId, nextCount);
  }
}

/** 严格恢复球形天空盒实体资源，Transform 单独负责位置、旋转和缩放。 */
function normalizeSkyboxComponent(value: unknown): NonNullable<EntityComponents['skybox']> {
  const skybox = assertPlainObject(value);
  const sourceUrl = assertString(skybox.sourceUrl);
  if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) throwUnsupportedSceneFileError();
  const format = skybox.format;
  if (format !== 'hdr' && format !== 'exr') throwUnsupportedSceneFileError();

  const dataPlatformResourceId = normalizeOptionalDataPlatformResourceId(skybox);
  const normalized = sanitizeSceneSkybox({
    packagePath: assertString(skybox.packagePath),
    sourcePath: assertString(skybox.sourcePath),
    sourceUrl,
    ...(skybox.assetRevision === undefined ? {} : { assetRevision: assertString(skybox.assetRevision) }),
    ...(dataPlatformResourceId ? { dataPlatformResourceId } : {}),
    format,
    rotationDegrees: 0,
    intensity: assertFiniteNumber(skybox.intensity),
    resolution: assertFiniteNumber(skybox.resolution) as SceneSkyboxSettings['resolution'],
  });
  if (!normalized) throwUnsupportedSceneFileError();
  return {
    packagePath: normalized.packagePath,
    sourcePath: normalized.sourcePath,
    sourceUrl: normalized.sourceUrl,
    ...(normalized.assetRevision ? { assetRevision: normalized.assetRevision } : {}),
    ...(normalized.dataPlatformResourceId ? { dataPlatformResourceId: normalized.dataPlatformResourceId } : {}),
    format: normalized.format,
    intensity: normalized.intensity,
    resolution: normalized.resolution,
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

function normalizeDataPlatformScreen(value: unknown): DataPlatformScreenComponent {
  const normalized = normalizeDataPlatformScreenComponent(value);
  if (!normalized) throwUnsupportedSceneFileError();
  return normalized;
}

/** 严格读取 POI EFF 配置，再通过共享边界约束数值范围。 */
function normalizePoiEffect(value: unknown): PoiEffectComponent {
  const poiEffect = assertPlainObject(value);
  if (!isPoiEffectKind(poiEffect.effectKind)) throwUnsupportedSceneFileError();
  if (!isPoiEffectHexColor(poiEffect.primaryColor) || !isPoiEffectHexColor(poiEffect.secondaryColor)) {
    throwUnsupportedSceneFileError();
  }

  return sanitizePoiEffectComponent({
    effectKind: poiEffect.effectKind,
    enabled: assertOptionalBoolean(poiEffect.enabled, true),
    primaryColor: poiEffect.primaryColor,
    secondaryColor: poiEffect.secondaryColor,
    intensity: assertFiniteNumber(poiEffect.intensity),
    speed: assertFiniteNumber(poiEffect.speed),
    density: assertFiniteNumber(poiEffect.density),
  });
}

function normalizeLocator(value: unknown): EntityComponents['locator'] {
  const locator = assertPlainObject(value);

  const fetchDrive = normalizeLocatorFetchDrive(locator.fetchDrive);
  const builtInBinding = normalizeLocatorBuiltInBinding(locator.builtInBinding);
  return {
    assetId: assertString(locator.assetId).trim().slice(0, LOCATOR_ASSET_ID_MAX_LENGTH),
    storageDepth: normalizeLocatorStorageDepth(locator.storageDepth),
    length: normalizeLocatorDimension(locator.length),
    width: normalizeLocatorDimension(locator.width),
    height: normalizeLocatorDimension(locator.height),
    columns: normalizeLocatorInt(locator.columns, 1, 1, 100),
    layers: normalizeLocatorInt(locator.layers, 1, 1, 100),
    startColumn: normalizeLocatorInt(locator.startColumn, 1, 0, 999),
    startLayer: normalizeLocatorInt(locator.startLayer, 1, 0, 999),
    columnReversed: locator.columnReversed === true,
    columnGap: normalizeLocatorGap(locator.columnGap),
    layerGap: normalizeLocatorGap(locator.layerGap),
    deviceAssetCode: (typeof locator.deviceAssetCode === 'string' ? locator.deviceAssetCode : '').trim().slice(0, 128),
    rowNumber: normalizeLocatorInt(locator.rowNumber, 1, 0, 999),
    ...(fetchDrive ? { fetchDrive } : {}),
    ...(builtInBinding ? { builtInBinding } : {}),
  };
}

/** 清理定位线框 fetch 驱动配置，结构非法时整体缺省（不阻断加载）。 */
function normalizeLocatorFetchDrive(value: unknown): LocatorComponent['fetchDrive'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as PlainObject;
  if (typeof record.enabled !== 'boolean') return undefined;
  const cargoGeneratorId = typeof record.cargoGeneratorId === 'string' ? record.cargoGeneratorId.trim().slice(0, 128) : '';
  return {
    enabled: record.enabled,
    ...(cargoGeneratorId ? { cargoGeneratorId } : {}),
  };
}
function normalizeLocatorDimension(value: unknown): number {
  return Math.max(LOCATOR_MIN_DIMENSION, assertFiniteNumber(value));
}

function normalizeLocatorStorageDepth(value: unknown): LocatorStorageDepth {
  return value === 'far' ? 'far' : 'near';
}

function normalizeLocatorGap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function normalizeLocatorInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeCadReference(value: unknown): EntityComponents['cadReference'] {
  const cadReference = assertPlainObject(value);
  const sourcePath = assertString(cadReference.sourcePath);
  const sourceUrl = assertString(cadReference.sourceUrl);

  if (!sourcePath.toLowerCase().endsWith('.dxf')) {
    throwUnsupportedSceneFileError();
  }

  if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) {
    throwUnsupportedSceneFileError();
  }

  if (cadReference.originMode !== 'center') {
    throwUnsupportedSceneFileError();
  }

  const unitScaleToMeters = assertPositiveFiniteNumber(cadReference.unitScaleToMeters);
  const hasUnitAuditFields = cadReference.sourceUnitCode !== undefined
    || cadReference.sourceUnitName !== undefined
    || cadReference.unitDetection !== undefined;
  let unitInfo;

  try {
    unitInfo = hasUnitAuditFields
      ? normalizeCadReferenceUnitInfo(
          cadReference.sourceUnitCode,
          cadReference.sourceUnitName,
          cadReference.unitDetection,
          unitScaleToMeters,
        )
      : createLegacyCadReferenceUnitInfo(unitScaleToMeters);
  } catch {
    throwUnsupportedSceneFileError();
  }

  return {
    sourcePath,
    sourceUrl,
    sourceFileSizeBytes: normalizeNonNegativeInteger(cadReference.sourceFileSizeBytes ?? 0),
    importMode: cadReference.importMode === 'large-preview' ? 'large-preview' : 'exact',
    sourceUnitCode: unitInfo.sourceUnitCode,
    sourceUnitName: unitInfo.sourceUnitName,
    unitDetection: unitInfo.unitDetection,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    originMode: 'center',
    lineColor: assertColorString(cadReference.lineColor),
    opacity: normalizeOpacity(cadReference.opacity),
    layerStats: normalizeCadReferenceLayerStats(cadReference.layerStats),
    bounds: normalizeCadReferenceBounds(cadReference.bounds),
    polylineCount: normalizeNonNegativeInteger(cadReference.polylineCount),
    pointCount: normalizeNonNegativeInteger(cadReference.pointCount),
  };
}

function normalizeCadReferenceLayerStats(value: unknown): NonNullable<EntityComponents['cadReference']>['layerStats'] {
  if (!Array.isArray(value) || value.length > CAD_REFERENCE_LAYER_STATS_MAX_LENGTH) {
    throwUnsupportedSceneFileError();
  }

  return value.map((item) => {
    const stat = assertPlainObject(item);

    return {
      name: assertString(stat.name).trim().slice(0, 128) || '0',
      entityCount: normalizeNonNegativeInteger(stat.entityCount),
      polylineCount: normalizeNonNegativeInteger(stat.polylineCount),
      pointCount: normalizeNonNegativeInteger(stat.pointCount),
    };
  });
}

function normalizeCadReferenceBounds(value: unknown): NonNullable<EntityComponents['cadReference']>['bounds'] {
  const bounds = assertPlainObject(value);

  return {
    min: normalizeVector3(bounds.min),
    max: normalizeVector3(bounds.max),
    size: normalizeVector3(bounds.size),
    center: normalizeVector3(bounds.center),
  };
}

function normalizeOpacity(value: unknown): number {
  const opacity = assertFiniteNumber(value);
  if (opacity < 0 || opacity > 1) throwUnsupportedSceneFileError();
  return opacity;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const numberValue = assertFiniteNumber(value);
  if (numberValue < 0 || !Number.isInteger(numberValue)) throwUnsupportedSceneFileError();
  return numberValue;
}

function assertPositiveFiniteNumber(value: unknown): number {
  const numberValue = assertFiniteNumber(value);
  if (numberValue <= 0) throwUnsupportedSceneFileError();
  return numberValue;
}

function assertColorString(value: unknown): string {
  const color = assertString(value);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throwUnsupportedSceneFileError();
  return color;
}

function normalizeModelAsset(value: unknown, entityId: string): EntityComponents['modelAsset'] {
  const modelAsset = assertPlainObject(value);
  const assetCode = normalizeModelAssetCode(modelAsset.assetCode, entityId);
  const sourcePath = assertString(modelAsset.sourcePath);
  const sourceUrl = assertString(modelAsset.sourceUrl);
  const assetRevision = normalizeOptionalString(modelAsset.assetRevision);

  if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) {
    throwUnsupportedSceneFileError();
  }

  let unitInfo;
  try {
    unitInfo = normalizeModelLengthUnitInfo(modelAsset.lengthUnit, modelAsset.unitScaleToMeters);
  } catch {
    throwUnsupportedSceneFileError();
  }

  const parameterConfig = normalizeModelParameterConfig(modelAsset.parameterConfig);
  const parameterValues = parameterConfig
    ? 'parameterValues' in modelAsset
      ? sanitizeModelParameterValues(parameterConfig, modelAsset.parameterValues)
      : createDefaultModelParameterValues(parameterConfig)
    : undefined;
  const scriptAssets = normalizeModelScriptAssets(modelAsset.scriptAssets);
  const parameterScriptMetadata = normalizeOptionalJsonArray(modelAsset.parameterScriptMetadata);
  const animationScriptMetadata = normalizeOptionalJsonArray(modelAsset.animationScriptMetadata);
  const dataDrivenConfig = modelAsset.dataDrivenConfig === undefined ? null : normalizeModelDataDrivenConfig(modelAsset.dataDrivenConfig);
  if ('dataDrivenConfig' in modelAsset && !dataDrivenConfig) throwUnsupportedSceneFileError();
  const builtInSlotBindingConfig = modelAsset.builtInSlotBindingConfig === undefined
    ? null
    : normalizeBuiltInSlotBindingConfig(modelAsset.builtInSlotBindingConfig);
  if ('builtInSlotBindingConfig' in modelAsset && !builtInSlotBindingConfig) throwUnsupportedSceneFileError();

  return {
    assetCode,
    sourcePath,
    sourceUrl,
    ...(assetRevision ? { assetRevision } : {}),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(scriptAssets.length ? { scriptAssets } : {}),
    ...(parameterScriptMetadata.length ? { parameterScriptMetadata } : {}),
    ...(animationScriptMetadata.length ? { animationScriptMetadata } : {}),
    ...(parameterConfig ? { parameterConfig, parameterValues } : {}),
    ...(dataDrivenConfig ? { dataDrivenConfig } : {}),
    ...(builtInSlotBindingConfig ? { builtInSlotBindingConfig } : {}),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const normalizedValue = assertString(value).trim();
  return normalizedValue || undefined;
}

function normalizeModelAssetCode(value: unknown, entityId: string): string {
  if (value === undefined) return createModelAssetCode(undefined, entityId);
  const normalizedAssetCode = assertString(value).trim().slice(0, MODEL_ASSET_CODE_MAX_LENGTH);
  return normalizedAssetCode || createModelAssetCode(undefined, entityId);
}

/** 判断场景中的脚本路径是否为可执行 TypeScript 文件，声明文件不允许持久化为运行脚本。 */
function isRuntimeModelScriptFileName(value: string): boolean {
  const normalizedValue = value.toLowerCase();
  return normalizedValue.endsWith(MODEL_SCRIPT_EXTENSION)
    && !normalizedValue.endsWith(MODEL_SCRIPT_DECLARATION_EXTENSION);
}

function normalizeModelScriptAssets(
  value: unknown,
): NonNullable<NonNullable<EntityComponents['modelAsset']>['scriptAssets']> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throwUnsupportedSceneFileError();

  return value.map((item) => {
    const asset = assertPlainObject(item);
    const scriptPath = assertString(asset.path);
    const sourceUrl = assertString(asset.sourceUrl);
    const name = assertString(asset.name);

    if (!isRuntimeModelScriptFileName(scriptPath)) throwUnsupportedSceneFileError();
    if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) throwUnsupportedSceneFileError();
    if (!isRuntimeModelScriptFileName(name)) throwUnsupportedSceneFileError();

    return { path: scriptPath, sourceUrl, name };
  });
}

function normalizeOptionalJsonArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throwUnsupportedSceneFileError();

  return value.map((item) => normalizeJsonValue(item, 0, { count: 0 }));
}

function normalizeJsonValue(value: unknown, depth: number, seen: { count: number }): unknown {
  seen.count += 1;
  if (depth > 12 || seen.count > 2048) throwUnsupportedSceneFileError();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throwUnsupportedSceneFileError();
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > 256) throwUnsupportedSceneFileError();
    return value.map((item) => normalizeJsonValue(item, depth + 1, seen));
  }

  const record = assertPlainObject(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (!key || key.length > 128) throwUnsupportedSceneFileError();
      return [key, normalizeJsonValue(item, depth + 1, seen)];
    }),
  );
}

/** 校验并清理模型生成器组件；旧版 fetchBindings/dataSource/metadataTtlSeconds 由迁移处理或宽容忽略。 */
function normalizeModelGenerator(value: unknown): EntityComponents['modelGenerator'] {
  const modelGenerator = assertPlainObject(value);

  const rules = assertArray(modelGenerator.rules);
  if (rules.length > MODEL_GENERATOR_MAX_RULES) {
    throwUnsupportedSceneFileError();
  }

  const rawDefaultTarget = modelGenerator.defaultTarget;
  if (rawDefaultTarget !== undefined && rawDefaultTarget !== null && !sanitizeModelGeneratorTarget(rawDefaultTarget)) {
    throwUnsupportedSceneFileError();
  }
  for (const ruleValue of rules) {
    const rule = assertPlainObject(ruleValue);
    if (rule.target !== undefined && rule.target !== null && !sanitizeModelGeneratorTarget(rule.target)) {
      throwUnsupportedSceneFileError();
    }
  }

  const normalized = sanitizeModelGeneratorComponent({
    defaultTarget: rawDefaultTarget,
    rules,
  });
  if (!normalized || normalized.rules.length !== rules.length) {
    throwUnsupportedSceneFileError();
  }

  const ruleIds = normalized.rules.map((rule) => rule.id);
  if (new Set(ruleIds).size !== ruleIds.length) {
    throwUnsupportedSceneFileError();
  }

  return normalized;
}

function normalizeAutoPatrol(value: unknown): AutoPatrolComponent {
  const normalized = sanitizeAutoPatrolComponent(value);
  if (!normalized) throwUnsupportedSceneFileError();
  return normalized;
}

function normalizeManualRoamSpawn(value: unknown): ManualRoamSpawnComponent {
  const component = assertPlainObject(value);
  if (component.avatar === undefined) return {};
  const avatar = assertPlainObject(component.avatar);
  const name = assertString(avatar.name).trim();
  const sourcePath = assertString(avatar.sourcePath).trim();
  const sourceUrl = assertString(avatar.sourceUrl).trim();
  if (!name || !sourcePath || !sourceUrl) throwUnsupportedSceneFileError();
  return { avatar: {
    name, sourcePath, sourceUrl,
    ...(avatar.assetRevision === undefined ? {} : { assetRevision: assertString(avatar.assetRevision) }),
  } };
}

/** 点击事件绑定为 v3 新增组件，无旧版字段；非法条目宽容过滤而不判定文件损坏。 */
function normalizeClickEventBinding(value: unknown): ClickEventBindingComponent {
  assertPlainObject(value);
  return sanitizeClickEventBindingComponent(value);
}

/** 手动漫游只有一个权威出生点；重复数据说明场景文件已损坏或被非法修改。 */
function validateSingleManualRoamSpawn(
  entityIds: readonly string[],
  entities: Readonly<Record<string, Entity>>,
): void {
  let found = false;
  for (const entityId of entityIds) {
    if (!entities[entityId]?.components.manualRoamSpawn) continue;
    if (found) throwUnsupportedSceneFileError();
    found = true;
  }
}

/** 宽容处理外部场景中的重复自动启动标记，只保留 Hierarchy 顺序中的第一条。 */
function enforceSingleAutoStartPatrol(
  entityIds: readonly string[],
  entities: Record<string, Entity>,
): Record<string, Entity> {
  let foundAutoStart = false;
  let normalizedEntities = entities;
  for (const entityId of entityIds) {
    const entity = normalizedEntities[entityId];
    const autoPatrol = entity?.components.autoPatrol;
    if (!autoPatrol?.autoStart) continue;
    if (!foundAutoStart) {
      foundAutoStart = true;
      continue;
    }
    if (normalizedEntities === entities) normalizedEntities = { ...entities };
    normalizedEntities[entityId] = {
      ...entity,
      components: {
        ...entity.components,
        autoPatrol: { ...autoPatrol, autoStart: false },
      },
    };
  }
  return normalizedEntities;
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

    if (!entity.isFolder && entity.childrenIds.length > 0) {
      throwUnsupportedSceneFileError();
    }

    if (entity.parentId !== null) {
      const parent = entities[entity.parentId];
      if (
        entity.parentId === entityId
        || !parent?.isFolder
        || !parent.childrenIds.includes(entityId)
      ) {
        throwUnsupportedSceneFileError();
      }
    }

    for (const childId of entity.childrenIds) {
      const child = entities[childId];
      if (
        !entity.isFolder
        || childId === entityId
        || !entityIdSet.has(childId)
        || !child
        || child.parentId !== entityId
      ) {
        throwUnsupportedSceneFileError();
      }
    }
  }

  // 复用父级链做三色标记；每个实体只访问一次，同时拒绝任意深度的文件夹循环。
  const visitState = new Map<string, 'visiting' | 'visited'>();
  for (const entityId of entityIds) {
    if (visitState.get(entityId) === 'visited') continue;

    const path: string[] = [];
    let currentId: string | null = entityId;
    while (currentId) {
      const state = visitState.get(currentId);
      if (state === 'visiting') throwUnsupportedSceneFileError();
      if (state === 'visited') break;

      visitState.set(currentId, 'visiting');
      path.push(currentId);
      currentId = entities[currentId]?.parentId ?? null;
    }

    for (const pathEntityId of path) visitState.set(pathEntityId, 'visited');
  }
}

function hasRuntimeComponent(components: EntityComponents): boolean {
  return Boolean(
    components.meshRenderer ||
    components.dataPlatformScreen ||
    components.skybox ||
    components.locator ||
    components.cadReference ||
    components.modelAsset ||
    components.modelGenerator ||
    components.poiEffect ||
    components.autoPatrol ||
    components.manualRoamSpawn ||
    components.alarmManager ||
    components.clickEventBinding ||
    components.camera ||
    components.light,
  );
}

function assertPlainObject(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throwUnsupportedSceneFileError();
  }

  return value as PlainObject;
}

function assertArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throwUnsupportedSceneFileError();
  }

  return value;
}

function normalizeOptionalDataPlatformResourceId(value: PlainObject): string | undefined {
  const field = readOwnDataProperty(value, 'dataPlatformResourceId');
  if (field.kind === 'missing') return undefined;
  if (field.kind === 'accessor') throw new Error(INVALID_SKYBOX_RESOURCE_ID_ERROR);
  const normalized = normalizeDataPlatformResourceId(field.value);
  if (!normalized) throw new Error(INVALID_SKYBOX_RESOURCE_ID_ERROR);
  return normalized;
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

function assertOptionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
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
