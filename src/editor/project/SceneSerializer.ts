import type { Entity } from '../model/Entity';
import { createLegacyCadReferenceUnitInfo, normalizeCadReferenceUnitInfo } from '../cad/cadUnits';
import {
  AUTHORIZED_LOCAL_ASSET_URL_PREFIX,
  createDefaultSceneSettings,
  DEFAULT_MQTT_CONFIG,
  MODEL_ASSET_CODE_MAX_LENGTH,
  createModelAssetCode,
  normalizeStackerSimulationScenario,
  sanitizeFetchConfig,
  sanitizeMqttConfig,
  sanitizeSceneSettings,
  type MqttConfig,
  type SceneDocument,
  type SceneEnvironmentSettings,
  type SceneEnvironmentVariant,
  type SceneSettings,
} from '../model/SceneDocument';
import type { EntityComponents, LightKind, MeshKind, PoiEffectComponent } from '../model/components';
import {
  MODEL_GENERATOR_MAX_BINDINGS,
  MODEL_GENERATOR_MAX_RULES,
  MODEL_GENERATOR_TTL_MAX_SECONDS,
  MODEL_GENERATOR_TTL_MIN_SECONDS,
  sanitizeModelGeneratorComponent,
  sanitizeModelGeneratorTarget,
} from '../model/modelGenerator';
import type { Vector3Data } from '../model/math';
import { isPoiEffectHexColor, isPoiEffectKind, sanitizePoiEffectComponent } from '../model/poiEffect';
import { createDefaultModelParameterValues, normalizeModelParameterConfig, sanitizeModelParameterValues } from '../model/modelParameters';
import { SCENE_LENGTH_UNIT, normalizeModelLengthUnitInfo, type SceneLengthUnit } from '../model/sceneUnits';
import {
  createDefaultTelemetryBinding,
  normalizeModelDataDrivenConfig,
  normalizeTelemetryBindingComponent,
} from '../model/telemetryBinding';

const UNSUPPORTED_SCENE_FILE_ERROR = '场景文件格式不受支持。';
const MESH_KINDS: readonly MeshKind[] = ['cube', 'sphere', 'plane'];
const LIGHT_KINDS: readonly LightKind[] = ['hemispheric', 'directional', 'point'];
const MODEL_SCRIPT_EXTENSION = '.model.ts';
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
    mqttConfig: normalizeMqttConfig(scene.mqttConfig),
    fetchConfig: sanitizeFetchConfig(scene.fetchConfig),
    sceneSettings: normalizeSceneSettings(scene.sceneSettings),
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
  const sensitivity = assertPlainObject(settings.sensitivity);

  return sanitizeSceneSettings({
    camera: {
      savedPose: normalizeSceneCameraPose(camera.savedPose),
      viewDistance: assertFiniteNumber(camera.viewDistance),
    },
    sensitivity: {
      zoom: assertFiniteNumber(sensitivity.zoom),
      pan: assertFiniteNumber(sensitivity.pan),
      rotate: assertFiniteNumber(sensitivity.rotate),
    },
    environment: normalizeSceneEnvironmentSettings(settings.environment),
  });
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

  return {
    packagePath: assertString(environment.packagePath),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(environment.thumbnailUrl === undefined ? {} : { thumbnailUrl: assertString(environment.thumbnailUrl) }),
    activeVariantUrl,
    variants,
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

  if ('locator' in components && components.locator !== undefined) {
    normalized.locator = normalizeLocator(components.locator);
  }

  if ('cadReference' in components && components.cadReference !== undefined) {
    normalized.cadReference = normalizeCadReference(components.cadReference);
  }

  if ('modelAsset' in components && components.modelAsset !== undefined) {
    normalized.modelAsset = normalizeModelAsset(components.modelAsset, entityId);
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

  return {
    assetId: assertString(locator.assetId).trim().slice(0, LOCATOR_ASSET_ID_MAX_LENGTH),
    length: normalizeLocatorDimension(locator.length),
    width: normalizeLocatorDimension(locator.width),
    height: normalizeLocatorDimension(locator.height),
    columns: normalizeLocatorInt(locator.columns, 1, 1, 100),
    layers: normalizeLocatorInt(locator.layers, 1, 1, 100),
    startColumn: normalizeLocatorInt(locator.startColumn, 1, 1, 999),
    columnGap: normalizeLocatorGap(locator.columnGap),
    layerGap: normalizeLocatorGap(locator.layerGap),
    deviceAssetCode: assertString(locator.deviceAssetCode).trim().slice(0, 128),
    rowNumber: normalizeLocatorInt(locator.rowNumber, 1, 1, 99),
  };
}
function normalizeLocatorDimension(value: unknown): number {
  return Math.max(LOCATOR_MIN_DIMENSION, assertFiniteNumber(value));
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

    if (!scriptPath.toLowerCase().endsWith(MODEL_SCRIPT_EXTENSION)) throwUnsupportedSceneFileError();
    if (!sourceUrl.startsWith(AUTHORIZED_LOCAL_ASSET_URL_PREFIX)) throwUnsupportedSceneFileError();
    if (!name.toLowerCase().endsWith(MODEL_SCRIPT_EXTENSION)) throwUnsupportedSceneFileError();

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

/** 校验并清理模型生成器组件，旧场景缺失该字段时不会进入此分支。 */
function normalizeModelGenerator(value: unknown): EntityComponents['modelGenerator'] {
  const modelGenerator = assertPlainObject(value);
  const metadataTtlSeconds = assertFiniteNumber(modelGenerator.metadataTtlSeconds);
  if (metadataTtlSeconds < MODEL_GENERATOR_TTL_MIN_SECONDS || metadataTtlSeconds > MODEL_GENERATOR_TTL_MAX_SECONDS) {
    throwUnsupportedSceneFileError();
  }

  const rules = assertArray(modelGenerator.rules);
  const bindings = assertArray(modelGenerator.bindings);
  if (rules.length > MODEL_GENERATOR_MAX_RULES || bindings.length > MODEL_GENERATOR_MAX_BINDINGS) {
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
    metadataTtlSeconds,
    bindings,
    dataSource: modelGenerator.dataSource,
    ...(modelGenerator.warehouseFlow === undefined ? {} : { warehouseFlow: modelGenerator.warehouseFlow }),
  });
  if (!normalized || normalized.rules.length !== rules.length || normalized.bindings.length !== bindings.length) {
    throwUnsupportedSceneFileError();
  }

  const ruleIds = normalized.rules.map((rule) => rule.id);
  const bindingIds = normalized.bindings.map((binding) => binding.id);
  if (new Set(ruleIds).size !== ruleIds.length || new Set(bindingIds).size !== bindingIds.length) {
    throwUnsupportedSceneFileError();
  }

  return normalized;
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

    if (entity.isFolder && entity.parentId !== null) {
      throwUnsupportedSceneFileError();
    }

    if (!entity.isFolder && entity.childrenIds.length > 0) {
      throwUnsupportedSceneFileError();
    }

    if (entity.parentId !== null) {
      const parent = entities[entity.parentId];
      if (!parent?.isFolder || !parent.childrenIds.includes(entityId)) {
        throwUnsupportedSceneFileError();
      }
    }

    for (const childId of entity.childrenIds) {
      const child = entities[childId];
      if (!entity.isFolder || !entityIdSet.has(childId) || !child || child.isFolder || child.parentId !== entityId) {
        throwUnsupportedSceneFileError();
      }
    }
  }
}

function hasRuntimeComponent(components: EntityComponents): boolean {
  return Boolean(
    components.meshRenderer ||
    components.locator ||
    components.cadReference ||
    components.modelAsset ||
    components.modelGenerator ||
    components.poiEffect ||
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
