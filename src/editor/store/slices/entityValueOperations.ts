import { DEFAULT_EDITOR_GRID_SETTINGS, EDITOR_GRID_CELL_SIZES, type EditorGridCellSize } from '../../../runtime/babylon/createEngine';
import type { CadReferenceComponent, LightComponent, LocatorComponent, LocatorFetchDriveConfig, MeshRendererComponent, ModelAssetComponent, TransformComponent } from '../../model/components';
import type { Entity } from '../../model/Entity';
import { ENTITY_NAME_MAX_LENGTH } from '../../model/modelArray';
import { MODEL_ASSET_CODE_MAX_LENGTH, normalizeSkyboxSphereScale, type SceneEnvironmentSettings, type SceneDocument } from '../../model/SceneDocument';
import type { Vector3Data } from '../../model/math';
import { cloneModelParameterValues, findModelParameterDefinition, sanitizeModelParameterValue, type ModelParameterValue, type ModelParameterValues } from '../../model/modelParameters';
import type { EditorState } from './editorStoreTypes';
import { getSelectedEntity } from './selectionOperations';

export const RADIANS_TO_DEGREES = 180 / Math.PI;

const LOCATOR_MIN_DIMENSION = 0.01;

const LOCATOR_ASSET_ID_MAX_LENGTH = 128;

export function cloneVector3(vector: Vector3Data): Vector3Data {
  return { x: vector.x, y: vector.y, z: vector.z };
}

export function cloneTransform(transform: TransformComponent): TransformComponent {
  return {
    position: cloneVector3(transform.position),
    rotation: cloneVector3(transform.rotation),
    scale: cloneVector3(transform.scale),
  };
}

/** 对实体 Transform 应用组件级不变量；特殊编辑标记不允许产生无效缩放或倾斜。 */
export function normalizeTransformForEntity(entity: Entity, transform: TransformComponent): TransformComponent {
  const normalized = cloneTransform(transform);
  if (entity.components.skybox) normalized.scale = normalizeSkyboxSphereScale(normalized.scale);
  if (entity.components.autoPatrol) normalized.scale = { x: 1, y: 1, z: 1 };
  if (entity.components.manualRoamSpawn) {
    normalized.rotation = { x: 0, y: normalized.rotation.y, z: 0 };
    normalized.scale = { x: 1, y: 1, z: 1 };
  }
  return normalized;
}

/** 群组事务写入前逐实体收敛 Transform，确保撤销基线和目标值都遵守组件约束。 */
export function normalizeGroupRotationTransforms(
  scene: SceneDocument,
  entityIds: readonly string[],
  transforms: Readonly<Record<string, TransformComponent>>,
): Record<string, TransformComponent> {
  const normalizedTransforms = { ...transforms };
  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    const transform = transforms[entityId];
    if (entity && transform) {
      normalizedTransforms[entityId] = normalizeTransformForEntity(entity, transform);
    }
  }
  return normalizedTransforms;
}

export function cloneMeshRenderer(meshRenderer: MeshRendererComponent): MeshRendererComponent {
  return {
    meshKind: meshRenderer.meshKind,
    materialColor: meshRenderer.materialColor,
  };
}

export function cloneLocator(locator: LocatorComponent): LocatorComponent {
  return {
    assetId: locator.assetId,
    storageDepth: locator.storageDepth,
    length: locator.length,
    width: locator.width,
    height: locator.height,
    columns: locator.columns,
    layers: locator.layers,
    startColumn: locator.startColumn,
    startLayer: locator.startLayer,
    columnReversed: locator.columnReversed,
    columnGap: locator.columnGap,
    layerGap: locator.layerGap,
    deviceAssetCode: locator.deviceAssetCode,
    aisleCode: locator.aisleCode,
    rowNumber: locator.rowNumber,
    ...(locator.fetchDrive ? { fetchDrive: { ...locator.fetchDrive } } : {}),
    ...(locator.builtInBinding
      ? { builtInBinding: { ...locator.builtInBinding, originOffset: { ...locator.builtInBinding.originOffset } } }
      : {}),
    ...(locator.retainCargo ? { retainCargo: true } : {}),
  };
}

export function cloneCadReference(cadReference: CadReferenceComponent): CadReferenceComponent {
  return cloneJsonValue(cadReference);
}

export function cloneLight(light: LightComponent): LightComponent {
  return { ...light };
}

export function cloneModelAsset(modelAsset: ModelAssetComponent): ModelAssetComponent {
  return cloneJsonValue(modelAsset);
}

export function getSelectedModelParameterValues(state: EditorState): ModelParameterValues | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  if (!modelAsset?.parameterConfig) return null;

  return cloneModelParameterValues(modelAsset.parameterValues ?? {});
}

export function patchModelParameterValue(
  values: ModelParameterValues,
  key: string,
  value: ModelParameterValue,
): ModelParameterValues {
  return {
    ...cloneModelParameterValues(values),
    [key]: value,
  };
}

export function sanitizeSelectedModelParameterValue(
  state: EditorState,
  key: string,
  value: ModelParameterValue,
): ModelParameterValue | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  const definition = findModelParameterDefinition(modelAsset?.parameterConfig, key);
  if (!definition) return null;

  return sanitizeModelParameterValue(definition, value);
}

function isFiniteVector3(vector: Vector3Data): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function sanitizeVector3(value: Vector3Data | undefined, fallback = { x: 0, y: 0, z: 0 }): Vector3Data {
  if (!value || !isFiniteVector3(value)) return cloneVector3(fallback);
  return cloneVector3(value);
}

export function isFiniteTransform(transform: TransformComponent): boolean {
  return (
    isFiniteVector3(transform.position) &&
    isFiniteVector3(transform.rotation) &&
    isFiniteVector3(transform.scale)
  );
}

function areVector3Equal(left: Vector3Data, right: Vector3Data): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function areTransformsEqual(left: TransformComponent, right: TransformComponent): boolean {
  return (
    areVector3Equal(left.position, right.position) &&
    areVector3Equal(left.rotation, right.rotation) &&
    areVector3Equal(left.scale, right.scale)
  );
}

export function sanitizePositiveNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** 清洗允许 0 的非负数值，非法值使用回退值，负数收敛到 0。 */
export function sanitizeNonNegativeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function sanitizeLocatorDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(LOCATOR_MIN_DIMENSION, value);
}

export function sanitizeLocatorGap(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(10, value));
}

export function sanitizeLocatorAssetId(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return value.trim().slice(0, LOCATOR_ASSET_ID_MAX_LENGTH);
}

export function sanitizeModelAssetCode(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const normalizedAssetCode = value.trim().slice(0, MODEL_ASSET_CODE_MAX_LENGTH);
  return normalizedAssetCode || fallback;
}

export function sanitizeLocatorInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 清理定位线框 fetch 驱动 patch：undefined 保留原值，非法引用编号按空处理。 */
export function sanitizeLocatorFetchDrivePatch(
  value: LocatorFetchDriveConfig | undefined,
  before: LocatorFetchDriveConfig | undefined,
): LocatorFetchDriveConfig | undefined {
  if (value === undefined) return before;
  const cargoGeneratorId = typeof value.cargoGeneratorId === 'string' ? value.cargoGeneratorId.trim().slice(0, 128) : '';
  return {
    enabled: value.enabled === true,
    ...(cargoGeneratorId ? { cargoGeneratorId } : {}),
  };
}

function areLocatorFetchDrivesEqual(left: LocatorFetchDriveConfig | undefined, right: LocatorFetchDriveConfig | undefined): boolean {
  if (!left || !right) return left === right;
  return left.enabled === right.enabled && (left.cargoGeneratorId ?? '') === (right.cargoGeneratorId ?? '');
}

/** 清理内置货格绑定 patch：undefined 保留原值；绑定身份只能由启用/停用流程改写，这里仅允许调整 originOffset。 */
export function sanitizeLocatorBuiltInBindingPatch(
  value: LocatorComponent['builtInBinding'] | undefined,
  before: LocatorComponent['builtInBinding'],
): LocatorComponent['builtInBinding'] {
  if (value === undefined) return before;
  if (!before) return undefined;
  const read = (offset: number | undefined, fallback: number): number => (
    typeof offset === 'number' && Number.isFinite(offset) ? offset : fallback
  );
  return {
    hostEntityId: before.hostEntityId,
    rowIndex: before.rowIndex,
    originOffset: {
      x: read(value.originOffset?.x, before.originOffset.x),
      y: read(value.originOffset?.y, before.originOffset.y),
      z: read(value.originOffset?.z, before.originOffset.z),
    },
    // kind 由创建路径决定，UI patch 不可改写
    ...(before.kind ? { kind: before.kind } : {}),
  };
}

export function areLocatorsEqual(left: LocatorComponent, right: LocatorComponent): boolean {
  return (
    left.assetId === right.assetId &&
    left.storageDepth === right.storageDepth &&
    left.length === right.length &&
    left.width === right.width &&
    left.height === right.height &&
    left.columns === right.columns &&
    left.layers === right.layers &&
    left.startColumn === right.startColumn &&
    left.startLayer === right.startLayer &&
    left.columnReversed === right.columnReversed &&
    left.columnGap === right.columnGap &&
    left.layerGap === right.layerGap &&
    left.deviceAssetCode === right.deviceAssetCode &&
    left.aisleCode === right.aisleCode &&
    left.rowNumber === right.rowNumber &&
    areLocatorFetchDrivesEqual(left.fetchDrive, right.fetchDrive) &&
    areLocatorBuiltInBindingsEqual(left.builtInBinding, right.builtInBinding) &&
    Boolean(left.retainCargo) === Boolean(right.retainCargo)
  );
}

function areLocatorBuiltInBindingsEqual(
  left: LocatorComponent['builtInBinding'],
  right: LocatorComponent['builtInBinding'],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.hostEntityId === right.hostEntityId &&
    left.rowIndex === right.rowIndex &&
    left.originOffset.x === right.originOffset.x &&
    left.originOffset.y === right.originOffset.y &&
    left.originOffset.z === right.originOffset.z &&
    (left.kind ?? 'slot') === (right.kind ?? 'slot')
  );
}

export function areCadReferencesEqual(left: CadReferenceComponent, right: CadReferenceComponent): boolean {
  return left.lineColor === right.lineColor && left.opacity === right.opacity;
}

export function sanitizeEntityName(name: string): string {
  return name.trim().slice(0, ENTITY_NAME_MAX_LENGTH);
}

export function sanitizeSceneName(name: string): string {
  return name.trim().slice(0, 128);
}

export function isColorLike(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function sanitizeGridCellSize(value: EditorGridCellSize): EditorGridCellSize {
  return EDITOR_GRID_CELL_SIZES.includes(value) ? value : DEFAULT_EDITOR_GRID_SETTINGS.cellSizeMeters;
}

export function isSceneEnvironmentEqual(
  left: SceneEnvironmentSettings | null,
  right: SceneEnvironmentSettings | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 复制普通 JSON 数据，避免剪贴板和新实体共享参数化模型等嵌套引用。 */
export function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
