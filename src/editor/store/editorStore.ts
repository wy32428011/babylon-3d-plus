import { create } from 'zustand';
import {
  createCommandHistory,
  executeCommand,
  redoCommand,
  undoCommand,
  type CommandHistory,
} from '../commands/CommandHistory';
import {
  createEntityCommand,
  createFolderCommand,
  moveEntitiesToFolderCommand,
  renameEntityCommand,
  updateCadReferenceCommand,
  updateSceneDocumentCommand,
  updateEntityLockCommand,
  updateEntityVisibilityCommand,
  updateLightCommand,
  updateLocatorCommand,
  updateMeshRendererCommand,
  updateModelAssetCodeCommand,
  updateModelGeneratorCommand,
  updatePoiEffectCommand,
  updateModelParameterValuesCommand,
  updateTelemetryBindingCommand,
  updateTransformCommand,
} from '../commands/entityCommands';
import {
  DEFAULT_EDITOR_GRID_SETTINGS,
  EDITOR_GRID_CELL_SIZES,
  type EditorGridCellSize,
  type EditorGridSettings,
} from '../../runtime/babylon/createEngine';
import type { AssetEntry } from '../assets/AssetDatabase';
import { createId } from '../../shared/ids';
import type {
  CadReferenceComponent,
  LightComponent,
  LightKind,
  LocatorComponent,
  MeshKind,
  MeshRendererComponent,
  ModelAssetComponent,
  ModelAssetTemplate,
  ModelGeneratorComponent,
  ModelGeneratorTarget,
  PoiEffectComponent,
  PoiEffectKind,
  TransformComponent,
} from '../model/components';
import type { Entity } from '../model/Entity';
import { createArrayAssetNumber, getArrayAssetNumberRuleError } from '../model/arrayAssetNumbering';
import {
  MODEL_ASSET_CODE_MAX_LENGTH,
  createEmptySceneDocument,
  createCadReferenceEntity,
  createFolderEntity,
  createLightEntity,
  createLocatorEntity,
  createMeshEntity,
  createModelEntity,
  createModelGeneratorEntity,
  createPoiEffectEntity,
  createModelAssetCode,
  extractModelAssetCodePrefix,
  sanitizeMqttConfig,
  sanitizeSceneEnvironment,
  sanitizeSceneSensitivityValue,
  sanitizeSceneViewDistance,
  type SceneCameraPose,
  type MqttConfig,
  type SceneEnvironmentSettings,
  type SceneSensitivitySettings,
  type SceneDocument,
} from '../model/SceneDocument';
import type { Vector3Data } from '../model/math';
import {
  areModelParameterValuesEqual,
  cloneModelParameterValues,
  findModelParameterDefinition,
  normalizeModelParameterConfig,
  sanitizeModelParameterValue,
  sanitizeModelParameterValues,
  type ModelParameterValue,
  type ModelParameterValues,
} from '../model/modelParameters';
import { createModelLengthUnitInfo, type ModelLengthUnitInfo } from '../model/sceneUnits';
import type { ModelMeasurementResult } from '../../runtime/babylon/modelMeasurement';
import {
  isMqttConfigEqual,
  validateRuntimePreviewConfig,
  type RuntimePreviewReadiness,
} from '../model/mqttConfigUtils';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import {
  cloneModelGeneratorComponent,
  createModelGeneratorTargetFromAsset,
  sanitizeModelGeneratorComponent,
} from '../model/modelGenerator';
import { createDefaultTelemetryBinding, normalizeTelemetryBindingComponent } from '../model/telemetryBinding';
import { sanitizePoiEffectComponent } from '../model/poiEffect';
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
import {
  CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES,
  createCadReferenceComponentMetadata,
  rememberCadReferenceParseResult,
  sanitizeCadReferenceDisplayPatch,
} from '../cad/cadReference';
import { formatCadReferenceUnitSummary } from '../cad/cadUnits';
import { parseCadReferenceDxfForImport } from '../cad/cadReferenceWorkerClient';

type EditorLog = {
  id: string;
  message: string;
};

export type CadImportProgress = {
  id: string;
  active: boolean;
  percent: number;
  label: string;
  detail: string;
  fileName: string | null;
};

type EntityClipboard = {
  id: string;
  entities: Entity[];
};

export type EntityArrayDirection = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

type EntityArrayRequest = {
  id: string;
  sourceIds: string[];
  copyCount: number;
  direction: EntityArrayDirection;
  spacingMeters: number;
  assetNumberRule: string;
};

export type SceneFocusRequest = {
  id: string;
  entityIds: string[];
};

export type ProjectAssetFocusRequest = {
  id: string;
  sourcePath: string;
  sourceUrl: string;
  entityName: string;
};

export type CameraPoseSaveRequest = {
  id: string;
};

export type CameraResetRequest = {
  id: string;
};

export type CameraTopViewRequest = {
  id: string;
};

/** 当前 Inspector 选中模型的运行时米制测量快照；该状态不进入场景持久化或撤销历史。 */
export type SelectedModelMeasurement = ModelMeasurementResult & { entityId: string };

type TransformField = 'position' | 'rotation' | 'scale';
export type TransformTool = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'global';
export type TransformSnapSettingKey = 'position' | 'rotationDegrees' | 'scale';
export type SceneSensitivitySettingKey = keyof SceneSensitivitySettings;

export type TransformSnapSettings = {
  enabled: boolean;
  position: number;
  rotationDegrees: number;
  scale: number;
};

const DEFAULT_SNAP_SETTINGS: TransformSnapSettings = {
  enabled: false,
  position: 0.5,
  rotationDegrees: 15,
  scale: 0.1,
};

const LOCATOR_MIN_DIMENSION = 0.01;
const LOCATOR_ASSET_ID_MAX_LENGTH = 128;
const CLIPBOARD_PASTE_OFFSET_METERS = 0.35;
const ARRAY_COPY_COUNT_MAX = 100;

/** 比较两份模型测量快照，避免相同运行时结果触发无意义的 React 重渲染。 */
function areSelectedModelMeasurementsEqual(
  left: SelectedModelMeasurement | null,
  right: SelectedModelMeasurement | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.entityId !== right.entityId || left.status !== right.status) return false;
  if (left.status !== 'ready' || right.status !== 'ready') return true;

  return Math.abs(left.sizeMeters.x - right.sizeMeters.x) <= 1e-6
    && Math.abs(left.sizeMeters.y - right.sizeMeters.y) <= 1e-6
    && Math.abs(left.sizeMeters.z - right.sizeMeters.z) <= 1e-6;
}

/** 模型阵列方向到世界坐标单位偏移的映射，负方向通过向量符号表达。 */
const ENTITY_ARRAY_DIRECTION_VECTORS: Record<EntityArrayDirection, Vector3Data> = {
  x: { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

type EditorState = {
  scene: SceneDocument;
  runtimeMode: EditorRuntimeMode;
  history: CommandHistory;
  hierarchySelectionIds: string[];
  entityClipboard: EntityClipboard | null;
  entityArrayRequest: EntityArrayRequest | null;
  sceneFocusRequest: SceneFocusRequest | null;
  projectAssetFocusRequest: ProjectAssetFocusRequest | null;
  cameraPoseSaveRequest: CameraPoseSaveRequest | null;
  cameraResetRequest: CameraResetRequest | null;
  cameraTopViewRequest: CameraTopViewRequest | null;
  selectedModelMeasurement: SelectedModelMeasurement | null;
  cadImportProgress: CadImportProgress | null;
  logs: EditorLog[];
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  snapSettings: TransformSnapSettings;
  gridSettings: EditorGridSettings;
  startRuntimePreview: () => RuntimePreviewReadiness;
  stopRuntimePreview: () => void;
  setTransformTool: (tool: TransformTool) => void;
  setTransformSpace: (space: TransformSpace) => void;
  setSnapEnabled: (enabled: boolean) => void;
  updateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  setGridVisible: (visible: boolean) => void;
  setGridCellSize: (cellSizeMeters: EditorGridCellSize) => void;
  renameScene: (name: string) => void;
  resetSceneToBlank: () => void;
  setCameraViewDistance: (viewDistance: number) => void;
  updateSensitivitySetting: (key: SceneSensitivitySettingKey, value: number) => void;
  updateEnvironmentConfig: (environment: SceneEnvironmentSettings | null) => void;
  setEnvironmentActiveVariant: (sourceUrl: string) => void;
  requestCameraPoseSave: () => void;
  consumeCameraPoseSaveRequest: (requestId: string, pose: SceneCameraPose) => void;
  requestCameraReset: () => void;
  consumeCameraResetRequest: (requestId: string) => void;
  requestCameraTopView: () => void;
  consumeCameraTopViewRequest: (requestId: string) => void;
  setSelectedModelMeasurement: (measurement: SelectedModelMeasurement | null) => void;
  createMesh: (meshKind: MeshKind, placementPosition?: Vector3Data) => void;
  createLocator: (placementPosition?: Vector3Data) => void;
  createLight: (lightKind: LightKind, placementPosition?: Vector3Data) => void;
  createModelGenerator: (placementPosition?: Vector3Data) => void;
  createPoiEffect: (effectKind: PoiEffectKind, placementPosition?: Vector3Data) => void;
  createFolder: () => void;
  importModelAsset: (asset: AssetEntry, placementPosition?: Vector3Data) => void;
  refreshModelInstancesFromAssets: (assets: AssetEntry[]) => number;
  importCadReference: () => Promise<void>;
  loadSceneAsset: (asset: AssetEntry) => Promise<void>;
  selectEntity: (entityId: string | null) => void;
  selectHierarchyEntities: (entityIds: string[], primaryEntityId: string | null) => void;
  moveEntitiesToFolder: (entityIds: string[], folderId: string | null) => void;
  toggleEntityVisible: (entityId: string) => void;
  toggleEntityLocked: (entityId: string) => void;
  hideSelectedEntities: () => void;
  lockSelectedEntities: () => void;
  copySelectedEntities: () => void;
  pasteEntityClipboard: (targetFolderId?: string | null) => void;
  requestEntityArray: (copyCount: number, direction: EntityArrayDirection, spacingMeters: number, assetNumberRule: string) => void;
  resolveEntityArrayRequest: (requestId: string, selectionSpanMeters: number | null) => void;
  groupSelectedEntities: () => void;
  ungroupSelectedEntities: () => void;
  requestSceneFocusForSelection: () => void;
  requestProjectAssetFocusForEntity: (entityId: string | null) => void;
  consumeSceneFocusRequest: (requestId: string) => void;
  consumeProjectAssetFocusRequest: (requestId: string) => void;
  renameSelectedEntity: (name: string) => void;
  deleteSelectedEntity: () => void;
  updateSelectedTransform: (field: TransformField, axis: keyof Vector3Data, value: number) => void;
  updateSelectedMaterialColor: (materialColor: string) => void;
  updateSelectedLocator: (patch: Partial<LocatorComponent>) => void;
  updateSelectedCadReference: (patch: Partial<Pick<CadReferenceComponent, 'lineColor' | 'opacity'>>) => void;
  updateSelectedLight: (patch: Partial<LightComponent>) => void;
  updateSelectedModelAssetCode: (assetCode: string) => void;
  updateSelectedModelGenerator: (component: ModelGeneratorComponent, label?: string) => void;
  updateSelectedPoiEffect: (component: PoiEffectComponent, label?: string) => void;
  updateSelectedTelemetryBinding: (binding: import('../model/telemetryBinding').TelemetryBindingComponent | null) => void;
  restoreSelectedTelemetryBindingDefault: () => void;
  updateSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
  previewSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
  commitSelectedModelParameterValues: (before: ModelParameterValues, after: ModelParameterValues) => void;
  previewEntityTransform: (entityId: string, transform: TransformComponent) => void;
  commitEntityTransform: (entityId: string, before: TransformComponent, after: TransformComponent) => void;
  previewSelectedTransform: (transform: TransformComponent) => void;
  commitSelectedTransform: (before: TransformComponent, after: TransformComponent) => void;
  updateMqttConfig: (config: MqttConfig) => void;
  undo: () => void;
  redo: () => void;
  newScene: () => void;
  saveScene: () => Promise<void>;
  loadScene: () => Promise<boolean>;
  loadSceneFromFile: (filePath: string) => Promise<boolean>;
  loadSceneFromContent: (content: string, sourceName: string) => boolean;
  pushLog: (message: string) => void;
};

/** 判断当前 store 是否处于运行预览只读模式。 */
function isRuntimePreviewState(state: EditorState): boolean {
  return state.runtimeMode === 'preview';
}

/** 在运行预览中拦截会修改场景文档或历史记录的入口。 */
function guardRuntimePreviewMutation(state: EditorState, actionLabel: string): EditorState {
  if (!isRuntimePreviewState(state)) return state;
  return {
    ...state,
    logs: prependLog(state.logs, `运行预览只读：已阻止${actionLabel}。`),
  };
}

function createLog(message: string): EditorLog {
  return { id: crypto.randomUUID(), message };
}

function prependLog(logs: EditorLog[], message: string): EditorLog[] {
  return [createLog(message), ...logs].slice(0, 100);
}

/** 生成切换场景后的统一状态，避免旧场景的历史、选区和剪贴板泄漏到新场景。 */
function createLoadedSceneState(state: EditorState, scene: SceneDocument, message: string): Partial<EditorState> {
  return {
    scene,
    history: createCommandHistory(),
    hierarchySelectionIds: [],
    entityClipboard: null,
    entityArrayRequest: null,
    sceneFocusRequest: null,
    projectAssetFocusRequest: null,
    cameraPoseSaveRequest: null,
    cameraResetRequest: null,
    cameraTopViewRequest: null,
    selectedModelMeasurement: null,
    logs: prependLog(state.logs, message),
  };
}

/** 归一化导入进度，避免 UI 收到越界百分比后产生异常宽度。 */
function createCadImportProgress(
  id: string,
  percent: number,
  label: string,
  detail: string,
  fileName: string | null,
): CadImportProgress {
  return {
    id,
    active: true,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    label,
    detail,
    fileName,
  };
}

/** 给 React 一帧时间渲染阶段变化，避免大 DXF 同步解析前 UI 来不及显示进度。 */
function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

/** 读取 CAD 文件响应体，并在浏览器支持流读取时按字节数更新真实读取进度。 */
async function readCadResponseText(
  response: Response,
  fileSizeBytes: number,
  onProgress: (percent: number, detail: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  const totalBytes = fileSizeBytes > 0 ? fileSizeBytes : Number(response.headers.get('content-length') ?? 0);

  if (!reader) {
    onProgress(38, '正在读取 CAD 文件...');
    const content = await response.text();
    onProgress(68, 'CAD 文件读取完成。');
    return content;
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    receivedBytes += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));

    const readRatio = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    const percent = totalBytes > 0 ? 18 + readRatio * 50 : Math.min(68, 18 + Math.log2(receivedBytes + 1) * 3);
    const detail = totalBytes > 0
      ? `已读取 ${Math.round(readRatio * 100)}%。`
      : `已读取 ${(receivedBytes / 1024 / 1024).toFixed(1)} MB。`;
    onProgress(percent, detail);
  }

  chunks.push(decoder.decode());
  onProgress(68, 'CAD 文件读取完成。');
  return chunks.join('');
}

function cloneVector3(vector: Vector3Data): Vector3Data {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function cloneTransform(transform: TransformComponent): TransformComponent {
  return {
    position: cloneVector3(transform.position),
    rotation: cloneVector3(transform.rotation),
    scale: cloneVector3(transform.scale),
  };
}

function cloneMeshRenderer(meshRenderer: MeshRendererComponent): MeshRendererComponent {
  return {
    meshKind: meshRenderer.meshKind,
    materialColor: meshRenderer.materialColor,
  };
}

function cloneLocator(locator: LocatorComponent): LocatorComponent {
  return {
    assetId: locator.assetId,
    storageDepth: locator.storageDepth,
    length: locator.length,
    width: locator.width,
    height: locator.height,
  };
}

function cloneCadReference(cadReference: CadReferenceComponent): CadReferenceComponent {
  return cloneJsonValue(cadReference);
}

function cloneLight(light: LightComponent): LightComponent {
  return {
    lightKind: light.lightKind,
    intensity: light.intensity,
  };
}

function cloneModelAsset(modelAsset: ModelAssetComponent): ModelAssetComponent {
  return cloneJsonValue(modelAsset);
}

function getSelectedModelParameterValues(state: EditorState): ModelParameterValues | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  if (!modelAsset?.parameterConfig) return null;

  return cloneModelParameterValues(modelAsset.parameterValues ?? {});
}

function patchModelParameterValue(
  values: ModelParameterValues,
  key: string,
  value: ModelParameterValue,
): ModelParameterValues {
  return {
    ...cloneModelParameterValues(values),
    [key]: value,
  };
}

function sanitizeSelectedModelParameterValue(
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

function sanitizeVector3(value: Vector3Data | undefined, fallback = { x: 0, y: 0, z: 0 }): Vector3Data {
  if (!value || !isFiniteVector3(value)) return cloneVector3(fallback);
  return cloneVector3(value);
}

function isFiniteTransform(transform: TransformComponent): boolean {
  return (
    isFiniteVector3(transform.position) &&
    isFiniteVector3(transform.rotation) &&
    isFiniteVector3(transform.scale)
  );
}

function areVector3Equal(left: Vector3Data, right: Vector3Data): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function areTransformsEqual(left: TransformComponent, right: TransformComponent): boolean {
  return (
    areVector3Equal(left.position, right.position) &&
    areVector3Equal(left.rotation, right.rotation) &&
    areVector3Equal(left.scale, right.scale)
  );
}

function sanitizePositiveNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** 清洗允许 0 的非负数值，非法值使用回退值，负数收敛到 0。 */
function sanitizeNonNegativeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function sanitizeLocatorDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(LOCATOR_MIN_DIMENSION, value);
}

function sanitizeLocatorAssetId(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return value.trim().slice(0, LOCATOR_ASSET_ID_MAX_LENGTH);
}

function sanitizeModelAssetCode(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const normalizedAssetCode = value.trim().slice(0, MODEL_ASSET_CODE_MAX_LENGTH);
  return normalizedAssetCode || fallback;
}

function areLocatorsEqual(left: LocatorComponent, right: LocatorComponent): boolean {
  return (
    left.assetId === right.assetId &&
    left.storageDepth === right.storageDepth &&
    left.length === right.length &&
    left.width === right.width &&
    left.height === right.height
  );
}

function areCadReferencesEqual(left: CadReferenceComponent, right: CadReferenceComponent): boolean {
  return left.lineColor === right.lineColor && left.opacity === right.opacity;
}

function sanitizeEntityName(name: string): string {
  return name.trim().slice(0, 80);
}

function sanitizeSceneName(name: string): string {
  return name.trim().slice(0, 128);
}

function isColorLike(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function sanitizeGridCellSize(value: EditorGridCellSize): EditorGridCellSize {
  return EDITOR_GRID_CELL_SIZES.includes(value) ? value : DEFAULT_EDITOR_GRID_SETTINGS.cellSizeMeters;
}

function isSceneEnvironmentEqual(
  left: SceneEnvironmentSettings | null,
  right: SceneEnvironmentSettings | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 归一化导入资产匹配路径，避免 Windows 分隔符和大小写差异影响同包识别。 */
function normalizeAssetMatchPath(value: string | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

/** 获取模型包目录匹配键，优先使用扫描得到的 packagePath。 */
function getAssetPackageMatchPath(asset: AssetEntry): string {
  return normalizeAssetMatchPath(asset.packagePath ?? getDirectoryPath(asset.path));
}

/** 从模型文件路径中取出所在目录，用于重新导入后文件名变化时的兜底匹配。 */
function getDirectoryPath(filePath: string | undefined): string {
  const normalizedPath = (filePath ?? '').trim().replace(/\\/g, '/');
  const separatorIndex = normalizedPath.lastIndexOf('/');
  return separatorIndex > 0 ? normalizedPath.slice(0, separatorIndex) : '';
}

/** 为本轮导入的模型资产建立精确路径、URL 和唯一包目录三类索引。 */
function createImportedAssetIndexes(assets: AssetEntry[]): {
  byPath: Map<string, AssetEntry>;
  bySourceUrl: Map<string, AssetEntry>;
  uniqueByPackagePath: Map<string, AssetEntry>;
} {
  const modelAssets = assets.filter((asset) => asset.kind === 'model');
  const byPath = new Map<string, AssetEntry>();
  const bySourceUrl = new Map<string, AssetEntry>();
  const packageAssetLists = new Map<string, AssetEntry[]>();

  for (const asset of modelAssets) {
    const pathKey = normalizeAssetMatchPath(asset.path);
    if (pathKey) byPath.set(pathKey, asset);

    const sourceUrlKey = asset.sourceUrl.trim();
    if (sourceUrlKey) bySourceUrl.set(sourceUrlKey, asset);

    const packageKey = getAssetPackageMatchPath(asset);
    if (!packageKey) continue;

    const packageAssets = packageAssetLists.get(packageKey) ?? [];
    packageAssets.push(asset);
    packageAssetLists.set(packageKey, packageAssets);
  }

  const uniqueByPackagePath = new Map<string, AssetEntry>();
  for (const [packageKey, packageAssets] of packageAssetLists.entries()) {
    if (packageAssets.length === 1) uniqueByPackagePath.set(packageKey, packageAssets[0]);
  }

  return { byPath, bySourceUrl, uniqueByPackagePath };
}

/** 按 sourcePath/sourceUrl 精确匹配模型实例，必要时按唯一包目录兜底。 */
function findImportedAssetForModelAsset(
  modelAsset: ModelAssetTemplate,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
): AssetEntry | null {
  const pathMatch = indexes.byPath.get(normalizeAssetMatchPath(modelAsset.sourcePath));
  if (pathMatch) return pathMatch;

  const sourceUrlMatch = indexes.bySourceUrl.get(modelAsset.sourceUrl.trim());
  if (sourceUrlMatch) return sourceUrlMatch;

  const packageMatch = indexes.uniqueByPackagePath.get(normalizeAssetMatchPath(getDirectoryPath(modelAsset.sourcePath)));
  return packageMatch ?? null;
}

/** 根据新导入的资产快照生成场景实例的新 modelAsset，同时保留现场资产编号。 */
function createRefreshedModelAsset(modelAsset: ModelAssetComponent, asset: AssetEntry): ModelAssetComponent {
  const parameterConfig = normalizeModelParameterConfig(asset.parameterConfig) ?? undefined;
  const unitInfo: ModelLengthUnitInfo = createModelLengthUnitInfo(asset.lengthUnit);

  return {
    assetCode: modelAsset.assetCode,
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    ...(asset.assetRevision ? { assetRevision: asset.assetRevision } : {}),
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    ...(asset.scriptAssets?.length ? { scriptAssets: cloneJsonValue(asset.scriptAssets) } : {}),
    ...(asset.parameterScriptMetadata?.length ? { parameterScriptMetadata: cloneJsonValue(asset.parameterScriptMetadata) } : {}),
    ...(asset.animationScriptMetadata?.length ? { animationScriptMetadata: cloneJsonValue(asset.animationScriptMetadata) } : {}),
    ...(asset.dataDrivenConfig ? { dataDrivenConfig: cloneJsonValue(asset.dataDrivenConfig) } : {}),
    ...(parameterConfig
      ? {
          parameterConfig,
          parameterValues: sanitizeModelParameterValues(parameterConfig, modelAsset.parameterValues),
        }
      : {}),
  };
}

/** 比较可序列化元数据，供字段级模型快照比较复用。 */
function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** 判断刷新前后的模型资产快照是否等价，用于避免写入空的撤销历史。 */
function areModelAssetsEqual(left: ModelAssetComponent, right: ModelAssetComponent): boolean {
  return (
    left.assetCode === right.assetCode &&
    left.sourcePath === right.sourcePath &&
    left.sourceUrl === right.sourceUrl &&
    (left.assetRevision ?? '') === (right.assetRevision ?? '') &&
    left.lengthUnit === right.lengthUnit &&
    left.unitScaleToMeters === right.unitScaleToMeters &&
    areJsonValuesEqual(left.scriptAssets, right.scriptAssets) &&
    areJsonValuesEqual(left.parameterScriptMetadata, right.parameterScriptMetadata) &&
    areJsonValuesEqual(left.animationScriptMetadata, right.animationScriptMetadata) &&
    areJsonValuesEqual(left.dataDrivenConfig, right.dataDrivenConfig) &&
    areJsonValuesEqual(left.parameterConfig, right.parameterConfig) &&
    areModelParameterValuesEqual(left.parameterValues ?? {}, right.parameterValues ?? {})
  );
}

/** 使用本轮导入资产刷新单个生成目标；内置 Mesh 和未匹配目标保持原值。 */
function refreshModelGeneratorTargetFromImportedAssets(
  target: ModelGeneratorTarget | null,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
): { target: ModelGeneratorTarget | null; refreshedCount: number } {
  if (!target || target.kind !== 'model') return { target, refreshedCount: 0 };

  const importedAsset = findImportedAssetForModelAsset(target.modelAsset, indexes);
  if (!importedAsset) return { target, refreshedCount: 0 };

  const refreshedTarget = createModelGeneratorTargetFromAsset(importedAsset);
  if (!refreshedTarget || areJsonValuesEqual(target, refreshedTarget)) return { target, refreshedCount: 0 };
  return { target: refreshedTarget, refreshedCount: 1 };
}

/** 刷新模型生成器的默认目标和每条规则目标，生成器绑定及规则文本保持不变。 */
function refreshModelGeneratorFromImportedAssets(
  modelGenerator: ModelGeneratorComponent,
  indexes: ReturnType<typeof createImportedAssetIndexes>,
): { modelGenerator: ModelGeneratorComponent; refreshedCount: number } {
  const defaultResult = refreshModelGeneratorTargetFromImportedAssets(modelGenerator.defaultTarget, indexes);
  let refreshedCount = defaultResult.refreshedCount;
  const rules = modelGenerator.rules.map((rule) => {
    const result = refreshModelGeneratorTargetFromImportedAssets(rule.target, indexes);
    refreshedCount += result.refreshedCount;
    return result.target === rule.target ? rule : { ...rule, target: result.target };
  });

  if (refreshedCount === 0) return { modelGenerator, refreshedCount };
  return {
    modelGenerator: {
      ...modelGenerator,
      defaultTarget: defaultResult.target,
      rules,
    },
    refreshedCount,
  };
}

/** 批量刷新场景中的普通模型实例和模型生成器目标，并返回刷新引用数量。 */
function refreshSceneModelAssetsFromImportedAssets(
  scene: SceneDocument,
  assets: AssetEntry[],
): { scene: SceneDocument; refreshedCount: number } {
  const indexes = createImportedAssetIndexes(assets);
  let refreshedCount = 0;
  const entities: SceneDocument['entities'] = { ...scene.entities };

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;

    let components = entity.components;
    let entityChanged = false;
    const modelAsset = entity.components.modelAsset;
    if (modelAsset) {
      const importedAsset = findImportedAssetForModelAsset(modelAsset, indexes);
      if (importedAsset) {
        const refreshedModelAsset = createRefreshedModelAsset(modelAsset, importedAsset);
        if (!areModelAssetsEqual(modelAsset, refreshedModelAsset)) {
          refreshedCount += 1;
          components = { ...components, modelAsset: refreshedModelAsset };
          entityChanged = true;
        }
      }
    }

    const modelGenerator = entity.components.modelGenerator;
    if (modelGenerator) {
      const generatorResult = refreshModelGeneratorFromImportedAssets(modelGenerator, indexes);
      if (generatorResult.refreshedCount > 0) {
        refreshedCount += generatorResult.refreshedCount;
        components = { ...components, modelGenerator: generatorResult.modelGenerator };
        entityChanged = true;
      }
    }

    if (entityChanged) entities[entityId] = { ...entity, components };
  }

  if (refreshedCount === 0) return { scene, refreshedCount };

  return {
    scene: {
      ...scene,
      entities,
    },
    refreshedCount,
  };
}

function getSelectedEntity(state: EditorState) {
  const selectedId = state.scene.selectedEntityId;
  if (!selectedId) return null;
  return state.scene.entities[selectedId] ?? null;
}

/** 文件夹锁定会向子对象继承，用于统一拦截 Inspector、快捷键和 Gizmo 写回。 */
function isEntityEffectivelyLocked(scene: SceneDocument, entity: Entity | null | undefined): boolean {
  if (!entity) return false;
  if (entity.locked) return true;
  if (!entity.parentId) return false;

  return scene.entities[entity.parentId]?.locked === true;
}

/** 判断普通实体是否允许编辑，文件夹不参与 Transform 类编辑。 */
function isRuntimeEntityEditable(scene: SceneDocument, entity: Entity | null | undefined): entity is Entity {
  return Boolean(entity && !entity.isFolder && !isEntityEffectivelyLocked(scene, entity));
}

/** 过滤 Hierarchy 多选 ID，避免 UI 状态引用已经不存在的实体。 */
function sanitizeHierarchySelection(scene: SceneDocument, entityIds: string[]): string[] {
  return [...new Set(entityIds)].filter((entityId) => Boolean(scene.entities[entityId]));
}

/** 根据当前场景生成不重名的新建文件夹名称。 */
function createNextFolderName(scene: SceneDocument): string {
  const folderNames = new Set(
    scene.entityIds
      .map((entityId) => scene.entities[entityId])
      .filter((entity) => entity?.isFolder)
      .map((entity) => entity.name),
  );

  for (let index = 1; index < 1000; index += 1) {
    const name = `新建文件夹 ${index}`;
    if (!folderNames.has(name)) return name;
  }

  return `新建文件夹 ${Date.now()}`;
}

/** 复制普通 JSON 数据，避免剪贴板和新实体共享参数化模型等嵌套引用。 */
function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 深拷贝实体组件，确保复制/粘贴后的实例可独立编辑。 */
function cloneEntityComponents(entity: Entity): Entity['components'] {
  return {
    transform: cloneTransform(entity.components.transform),
    ...(entity.components.meshRenderer ? { meshRenderer: cloneMeshRenderer(entity.components.meshRenderer) } : {}),
    ...(entity.components.locator ? { locator: cloneLocator(entity.components.locator) } : {}),
    ...(entity.components.cadReference ? { cadReference: cloneCadReference(entity.components.cadReference) } : {}),
    ...(entity.components.modelAsset ? { modelAsset: cloneModelAsset(entity.components.modelAsset) } : {}),
    ...(entity.components.modelGenerator ? { modelGenerator: cloneModelGeneratorComponent(entity.components.modelGenerator) } : {}),
    ...(entity.components.poiEffect ? { poiEffect: { ...entity.components.poiEffect } } : {}),
    ...(entity.components.camera ? { camera: { ...entity.components.camera } } : {}),
    ...(entity.components.light ? { light: cloneLight(entity.components.light) } : {}),
  };
}

/** 生成不会和当前场景重名的副本名称，便于粘贴与阵列后快速识别对象。 */
function createUniqueEntityName(existingNames: Set<string>, baseName: string): string {
  const trimmedBaseName = sanitizeEntityName(baseName) || '对象';
  const firstCandidate = `${trimmedBaseName} 副本`;
  if (!existingNames.has(firstCandidate)) {
    existingNames.add(firstCandidate);
    return firstCandidate;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${trimmedBaseName} 副本 ${index}`;
    if (!existingNames.has(candidate)) {
      existingNames.add(candidate);
      return candidate;
    }
  }

  const fallbackName = `${trimmedBaseName} 副本 ${Date.now()}`;
  existingNames.add(fallbackName);
  return fallbackName;
}

/** 阵列副本资产编号覆盖目标，避免混合组件实体同时改写两套业务编号。 */
type EntityAssetNumberOverride = {
  kind: 'modelAsset' | 'locator';
  value: string;
};

/** 读取实体当前资产编号目标；导入模型优先于定位线框。 */
function getEntityAssetNumberTarget(entity: Entity): EntityAssetNumberOverride | null {
  if (entity.components.modelAsset) {
    return { kind: 'modelAsset', value: entity.components.modelAsset.assetCode };
  }
  if (entity.components.locator) {
    return { kind: 'locator', value: entity.components.locator.assetId };
  }
  return null;
}

/** 判断实体是否携带阵列可管理的资产编号字段。 */
function hasEntityAssetNumber(entity: Entity): boolean {
  return getEntityAssetNumberTarget(entity) !== null;
}

/** 查找场景中已经存在的模型生成器实体，场景级生成器只能保留一个。 */
function findExistingModelGeneratorEntity(scene: SceneDocument): Entity | null {
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (entity?.components.modelGenerator) return entity;
  }

  return null;
}

/** 判断实体是否是模型生成器，供复制、粘贴和阵列入口统一拦截。 */
function isModelGeneratorEntity(entity: Entity | null | undefined): boolean {
  return Boolean(entity?.components.modelGenerator);
}

/**
 * 过滤会产生第二个模型生成器的副本，只允许在当前场景没有生成器时引入一个。
 * 普通实体原样保留，返回值中的 skippedCount 用于写入中文操作日志。
 */
function filterDuplicatedModelGenerators(
  scene: SceneDocument,
  entities: Entity[],
): { entities: Entity[]; skippedCount: number; existingGenerator: Entity | null } {
  const existingGenerator = findExistingModelGeneratorEntity(scene);
  let hasAllowedGenerator = existingGenerator !== null;
  let skippedCount = 0;
  const filteredEntities: Entity[] = [];

  for (const entity of entities) {
    if (!isModelGeneratorEntity(entity)) {
      filteredEntities.push(entity);
      continue;
    }

    if (hasAllowedGenerator) {
      skippedCount += 1;
      continue;
    }

    hasAllowedGenerator = true;
    filteredEntities.push(entity);
  }

  return { entities: filteredEntities, skippedCount, existingGenerator };
}

/** 创建普通实体副本，复制所有业务组件并按偏移调整 Transform 位置。 */
function createDuplicatedRuntimeEntity(
  source: Entity,
  parentId: string | null,
  offset: Vector3Data,
  existingNames: Set<string>,
  assetNumberOverride?: EntityAssetNumberOverride,
): Entity {
  const id = createId('entity');
  const components = cloneEntityComponents(source);
  components.transform = {
    ...components.transform,
    position: {
      x: components.transform.position.x + offset.x,
      y: components.transform.position.y + offset.y,
      z: components.transform.position.z + offset.z,
    },
  };
  if (components.modelAsset) {
    components.modelAsset = {
      ...components.modelAsset,
      assetCode:
        assetNumberOverride?.kind === 'modelAsset'
          ? assetNumberOverride.value
          : createModelAssetCode(extractModelAssetCodePrefix(components.modelAsset.assetCode), id),
    };
  }
  if (components.locator && assetNumberOverride?.kind === 'locator') {
    components.locator = {
      ...components.locator,
      assetId: assetNumberOverride.value,
    };
  }

  return {
    ...source,
    id,
    name: createUniqueEntityName(existingNames, source.name),
    parentId,
    childrenIds: [],
    components,
  };
}

/** 返回当前 Hierarchy 主选区，兼容只有 Scene 单选但没有多选数组的情况。 */
function getActiveHierarchySelectionIds(state: EditorState): string[] {
  if (state.hierarchySelectionIds.length > 0) {
    return sanitizeHierarchySelection(state.scene, state.hierarchySelectionIds);
  }

  return state.scene.selectedEntityId && state.scene.entities[state.scene.selectedEntityId]
    ? [state.scene.selectedEntityId]
    : [];
}

/** 过滤可被当前批量命令改写的实体，继承锁定的对象会被保护。 */
function getUnlockedSelectionIds(state: EditorState, entityIds = getActiveHierarchySelectionIds(state)): string[] {
  return entityIds.filter((entityId) => {
    const entity = state.scene.entities[entityId];
    return Boolean(entity && !isEntityEffectivelyLocked(state.scene, entity));
  });
}

/** 过滤批量复制、阵列和群组可处理的普通运行时实体。 */
function getSelectedRuntimeEntityIds(state: EditorState): string[] {
  return getUnlockedSelectionIds(state).filter((entityId) => {
    const entity = state.scene.entities[entityId];
    return Boolean(entity && !entity.isFolder);
  });
}

/** 按右键目标推导粘贴父文件夹：文件夹内粘贴，对象则贴到同级。 */
function resolvePasteParentId(scene: SceneDocument, targetFolderId: string | null | undefined): string | null {
  if (!targetFolderId) return null;
  const targetFolder = scene.entities[targetFolderId];
  return targetFolder?.isFolder ? targetFolder.id : null;
}

/** 从选区展开 Scene View 聚焦目标，选中文件夹时聚焦其直属普通子对象。 */
function resolveSceneFocusEntityIds(scene: SceneDocument, entityIds: string[]): string[] {
  const resolvedIds: string[] = [];

  for (const entityId of entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;

    if (entity.isFolder) {
      for (const childId of entity.childrenIds) {
        const childEntity = scene.entities[childId];
        if (childEntity && !childEntity.isFolder) resolvedIds.push(childId);
      }
      continue;
    }

    resolvedIds.push(entityId);
  }

  return [...new Set(resolvedIds)];
}

/** 批量设置实体显示状态，并保持场景选择引用有效。 */
function setEntitiesVisibleInScene(scene: SceneDocument, entityIds: string[], visible: boolean): SceneDocument {
  const entities = { ...scene.entities };
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.visible === visible) continue;
    entities[entityId] = { ...entity, visible };
  }

  return { ...scene, entities };
}

/** 批量设置实体锁定状态，并保持场景选择引用有效。 */
function setEntitiesLockedInScene(scene: SceneDocument, entityIds: string[], locked: boolean): SceneDocument {
  const entities = { ...scene.entities };
  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.locked === locked) continue;
    entities[entityId] = { ...entity, locked };
  }

  return { ...scene, entities };
}

/** 批量删除实体，删除文件夹时会把未删除的子对象释放回根层级。 */
function deleteEntitiesInScene(scene: SceneDocument, entityIds: string[]): SceneDocument {
  const deletingIds = new Set(entityIds.filter((entityId) => Boolean(scene.entities[entityId])));
  if (deletingIds.size === 0) return scene;

  const entities: Record<string, Entity> = {};
  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (deletingIds.has(entityId)) continue;

    const parentId = entity.parentId && deletingIds.has(entity.parentId) ? null : entity.parentId;
    const childrenIds = entity.childrenIds.filter((childId) => !deletingIds.has(childId));
    entities[entityId] =
      parentId === entity.parentId && childrenIds.length === entity.childrenIds.length
        ? entity
        : { ...entity, parentId, childrenIds };
  }

  const selectedEntityId =
    scene.selectedEntityId && !deletingIds.has(scene.selectedEntityId) && entities[scene.selectedEntityId]
      ? scene.selectedEntityId
      : null;

  return {
    ...scene,
    entityIds: scene.entityIds.filter((entityId) => !deletingIds.has(entityId)),
    entities,
    selectedEntityId,
  };
}

/** 把新实体插入场景并更新目标文件夹的子项列表。 */
function insertDuplicatedEntitiesInScene(
  scene: SceneDocument,
  duplicatedEntities: Entity[],
  parentId: string | null,
): SceneDocument {
  const entities = { ...scene.entities };
  for (const entity of duplicatedEntities) {
    entities[entity.id] = entity;
  }

  if (parentId && entities[parentId]?.isFolder) {
    const folder = entities[parentId];
    entities[parentId] = {
      ...folder,
      childrenIds: [...folder.childrenIds, ...duplicatedEntities.map((entity) => entity.id)],
    };
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, ...duplicatedEntities.map((entity) => entity.id)],
    entities,
    selectedEntityId: duplicatedEntities[0]?.id ?? scene.selectedEntityId,
  };
}

/** 新建分组文件夹，并把选中的普通实体作为一个可撤销操作移入该分组。 */
function groupEntitiesInScene(scene: SceneDocument, entityIds: string[]): SceneDocument {
  const groupingIds = [...new Set(entityIds)].filter((entityId) => {
    const entity = scene.entities[entityId];
    return Boolean(entity && !entity.isFolder);
  });
  if (groupingIds.length === 0) return scene;

  const folder = createFolderEntity(`群组 ${groupingIds.length}`);
  const movingIdSet = new Set(groupingIds);
  const entities: Record<string, Entity> = {
    ...scene.entities,
    [folder.id]: {
      ...folder,
      childrenIds: groupingIds,
    },
  };

  for (const entityId of groupingIds) {
    const entity = entities[entityId];
    if (!entity) continue;
    entities[entityId] = { ...entity, parentId: folder.id };
  }

  for (const [entityId, entity] of Object.entries(entities)) {
    if (!entity.isFolder || entityId === folder.id) continue;
    const childrenIds = entity.childrenIds.filter((childId) => !movingIdSet.has(childId));
    if (childrenIds.length !== entity.childrenIds.length) {
      entities[entityId] = { ...entity, childrenIds };
    }
  }

  return {
    ...scene,
    entityIds: [...scene.entityIds, folder.id],
    entities,
    selectedEntityId: folder.id,
  };
}

/** 解组文件夹：子对象回到根层级，原文件夹从场景中移除。 */
function ungroupFoldersInScene(scene: SceneDocument, folderIds: string[]): SceneDocument {
  const ungroupingIds = [...new Set(folderIds)].filter((folderId) => scene.entities[folderId]?.isFolder);
  if (ungroupingIds.length === 0) return scene;

  const ungroupingIdSet = new Set(ungroupingIds);
  const entities: Record<string, Entity> = {};

  for (const [entityId, entity] of Object.entries(scene.entities)) {
    if (ungroupingIdSet.has(entityId)) continue;
    const parentId = entity.parentId && ungroupingIdSet.has(entity.parentId) ? null : entity.parentId;
    const childrenIds = entity.childrenIds.filter((childId) => !ungroupingIdSet.has(childId));
    entities[entityId] =
      parentId === entity.parentId && childrenIds.length === entity.childrenIds.length
        ? entity
        : { ...entity, parentId, childrenIds };
  }

  const releasedChildIds = ungroupingIds.flatMap((folderId) => scene.entities[folderId]?.childrenIds ?? []);
  const selectedEntityId = releasedChildIds.find((entityId) => Boolean(entities[entityId])) ?? null;

  return {
    ...scene,
    entityIds: scene.entityIds.filter((entityId) => !ungroupingIdSet.has(entityId)),
    entities,
    selectedEntityId,
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  scene: createEmptySceneDocument(),
  runtimeMode: 'edit',
  history: createCommandHistory(),
  hierarchySelectionIds: [],
  entityClipboard: null,
  entityArrayRequest: null,
  sceneFocusRequest: null,
  projectAssetFocusRequest: null,
  cameraPoseSaveRequest: null,
  cameraResetRequest: null,
  cameraTopViewRequest: null,
  selectedModelMeasurement: null,
  cadImportProgress: null,
  logs: [{ id: 'log_boot', message: '编辑器已启动。' }],
  transformTool: 'translate',
  transformSpace: 'local',
  snapSettings: DEFAULT_SNAP_SETTINGS,
  gridSettings: DEFAULT_EDITOR_GRID_SETTINGS,
  startRuntimePreview: () => {
    const currentState = get();
    if (currentState.cadImportProgress?.active) {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'cad-import-active',
        message: '请等待 CAD 导入完成。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }

    const readiness = validateRuntimePreviewConfig(currentState.scene.mqttConfig, {
      electronMqttAvailable: typeof window !== 'undefined' && typeof window.editorApi?.mqttConfigure === 'function',
    });
    if (!readiness.ok) {
      set((state) => ({ logs: prependLog(state.logs, `运行预览预检失败：${readiness.message}`) }));
      return readiness;
    }

    set((state) => {
      if (state.runtimeMode === 'preview') return state;
      return {
        runtimeMode: 'preview',
        cameraPoseSaveRequest: null,
        logs: prependLog(state.logs, '已进入运行预览模式。'),
      };
    });
    return readiness;
  },
  stopRuntimePreview: () => {
    set((state) => {
      if (state.runtimeMode === 'edit') return state;
      return {
        runtimeMode: 'edit',
        logs: prependLog(state.logs, '已停止运行预览模式。'),
      };
    });
  },
  setTransformTool: (tool) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换变换工具');
      if (state.transformTool === tool) return state;

      return {
        transformTool: tool,
        logs: prependLog(state.logs, `切换工具：${tool}`),
      };
    });
  },
  setTransformSpace: (space) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换坐标空间');
      if (state.transformSpace === space) return state;

      return {
        transformSpace: space,
        logs: prependLog(state.logs, `切换坐标空间：${space}`),
      };
    });
  },
  setSnapEnabled: (enabled) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换吸附');
      if (state.snapSettings.enabled === enabled) return state;

      return {
        snapSettings: {
          ...state.snapSettings,
          enabled,
        },
        logs: prependLog(state.logs, enabled ? '开启 Gizmo 吸附。' : '关闭 Gizmo 吸附。'),
      };
    });
  },
  updateSnapSetting: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改吸附参数');
      const nextValue = sanitizePositiveNumber(value, DEFAULT_SNAP_SETTINGS[key]);
      if (state.snapSettings[key] === nextValue) return state;

      return {
        snapSettings: {
          ...state.snapSettings,
          [key]: nextValue,
        },
      };
    });
  },
  setGridVisible: (visible) => {
    set((state) => {
      if (state.gridSettings.visible === visible) return state;

      return {
        gridSettings: {
          ...state.gridSettings,
          visible,
        },
        logs: prependLog(state.logs, visible ? '显示地面网格。' : '隐藏地面网格。'),
      };
    });
  },
  setGridCellSize: (cellSizeMeters) => {
    set((state) => {
      const nextCellSizeMeters = sanitizeGridCellSize(cellSizeMeters);
      if (state.gridSettings.cellSizeMeters === nextCellSizeMeters) return state;

      return {
        gridSettings: {
          ...state.gridSettings,
          cellSizeMeters: nextCellSizeMeters,
        },
        logs: prependLog(state.logs, `网格格子大小：${nextCellSizeMeters} m。`),
      };
    });
  },
  renameScene: (name) => {
    const nextName = sanitizeSceneName(name);
    if (!nextName) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名场景');
      if (state.scene.name === nextName) return state;

      const command = updateSceneDocumentCommand('重命名场景', (scene) => ({
        ...scene,
        name: nextName,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${nextName}`),
      };
    });
  },
  resetSceneToBlank: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '清空场景');
      return createLoadedSceneState(state, createEmptySceneDocument(), '场景已初始化。');
    });
  },
  setCameraViewDistance: (viewDistance) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改相机距离');
      const nextViewDistance = sanitizeSceneViewDistance(viewDistance);
      if (state.scene.sceneSettings.camera.viewDistance === nextViewDistance) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            camera: {
              ...state.scene.sceneSettings.camera,
              viewDistance: nextViewDistance,
            },
          },
        },
      };
    });
  },
  updateSensitivitySetting: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改相机灵敏度');
      const nextValue = sanitizeSceneSensitivityValue(value);
      if (state.scene.sceneSettings.sensitivity[key] === nextValue) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            sensitivity: {
              ...state.scene.sceneSettings.sensitivity,
              [key]: nextValue,
            },
          },
        },
      };
    });
  },
  updateEnvironmentConfig: (environment) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改环境模型');
      const nextEnvironment = sanitizeSceneEnvironment(environment);
      if (isSceneEnvironmentEqual(state.scene.sceneSettings.environment, nextEnvironment)) return state;

      const command = updateSceneDocumentCommand('更新环境模型', (scene) => ({
        ...scene,
        sceneSettings: {
          ...scene.sceneSettings,
          environment: nextEnvironment,
        },
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, nextEnvironment ? '环境模型已更新。' : '环境模型已清除。'),
      };
    });
  },
  setEnvironmentActiveVariant: (sourceUrl) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换环境效果');
      const environment = state.scene.sceneSettings.environment;
      if (!environment || environment.activeVariantUrl === sourceUrl) return state;

      const activeVariant = environment.variants.find((variant) => variant.sourceUrl === sourceUrl);
      if (!activeVariant) return state;

      const command = updateSceneDocumentCommand('切换环境效果', (scene) => ({
        ...scene,
        sceneSettings: {
          ...scene.sceneSettings,
          environment: scene.sceneSettings.environment
            ? {
                ...scene.sceneSettings.environment,
                activeVariantUrl: activeVariant.sourceUrl,
              }
            : null,
        },
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${activeVariant.name}`),
      };
    });
  },
  requestCameraPoseSave: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存当前视角');
      return {
        cameraPoseSaveRequest: { id: createId('camera_pose_save') },
        logs: prependLog(state.logs, '准备保存当前视角。'),
      };
    });
  },
  consumeCameraPoseSaveRequest: (requestId, pose) => {
    set((state) => {
      if (state.cameraPoseSaveRequest?.id !== requestId) return state;
      if (isRuntimePreviewState(state)) {
        return {
          cameraPoseSaveRequest: null,
          logs: prependLog(state.logs, '运行预览只读：已取消待保存的相机位姿。'),
        };
      }

      return {
        cameraPoseSaveRequest: null,
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            camera: {
              ...state.scene.sceneSettings.camera,
              savedPose: pose,
            },
          },
        },
        logs: prependLog(state.logs, '当前视角已保存。'),
      };
    });
  },
  requestCameraReset: () => {
    set((state) => ({
      cameraResetRequest: { id: createId('camera_reset') },
      logs: prependLog(state.logs, '准备复位视角。'),
    }));
  },
  consumeCameraResetRequest: (requestId) => {
    set((state) => {
      if (state.cameraResetRequest?.id !== requestId) return state;

      return {
        cameraResetRequest: null,
        logs: prependLog(state.logs, '视角已复位。'),
      };
    });
  },
  /** 发出一次临时俯视请求，不修改场景文档、已保存视角或撤销历史。 */
  requestCameraTopView: () => {
    set((state) => ({
      cameraTopViewRequest: { id: createId('camera_top_view') },
      logs: prependLog(state.logs, '准备切换为俯视视角。'),
    }));
  },
  /** Scene View 完成俯视切换后消费请求，避免 React 后续渲染重复执行。 */
  consumeCameraTopViewRequest: (requestId) => {
    set((state) => {
      if (state.cameraTopViewRequest?.id !== requestId) return state;

      return {
        cameraTopViewRequest: null,
        logs: prependLog(state.logs, '已切换为俯视视角。'),
      };
    });
  },
  setSelectedModelMeasurement: (measurement) => {
    set((state) => {
      if (measurement && state.scene.selectedEntityId !== measurement.entityId) return state;
      if (areSelectedModelMeasurementsEqual(state.selectedModelMeasurement, measurement)) return state;
      return { selectedModelMeasurement: measurement };
    });
  },
  createMesh: (meshKind, placementPosition) => {
    const entity = createMeshEntity(meshKind, sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建网格');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createLocator: (placementPosition) => {
    const entity = createLocatorEntity(sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建定位器');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createLight: (lightKind, placementPosition) => {
    const entity = createLightEntity(lightKind, placementPosition ? sanitizeVector3(placementPosition) : undefined);
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建灯光');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createModelGenerator: (placementPosition) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建模型生成器');

      const existingGenerator = findExistingModelGeneratorEntity(state.scene);
      if (existingGenerator) {
        return {
          scene: {
            ...state.scene,
            selectedEntityId: existingGenerator.id,
          },
          hierarchySelectionIds: [existingGenerator.id],
          selectedModelMeasurement: null,
          logs: prependLog(state.logs, '场景已存在模型生成器，已选中现有生成器，未新建第二个。'),
        };
      }

      const entity = createModelGeneratorEntity(sanitizeVector3(placementPosition));
      const command = createEntityCommand(entity);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  /** 创建可撤销的 POI 内置 EFF 实体，并把新实体设为当前选择。 */
  createPoiEffect: (effectKind, placementPosition) => {
    const entity = createPoiEffectEntity(effectKind, sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '创建 EFF 特效');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  createFolder: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '新建文件夹');
      const folder = createFolderEntity(createNextFolderName(state.scene));
      const command = createFolderCommand(folder);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: [folder.id],
        logs: prependLog(state.logs, command.label),
      };
    });
  },
  importModelAsset: (asset, placementPosition) => {
    if (asset.kind !== 'model') return;

    const displayName = asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '');
    const unitInfo: ModelLengthUnitInfo = createModelLengthUnitInfo(asset.lengthUnit);
    const entity = createModelEntity(
      asset.path,
      asset.sourceUrl,
      displayName,
      unitInfo,
      sanitizeVector3(placementPosition),
      normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
      asset.scriptAssets,
      asset.parameterScriptMetadata,
      asset.animationScriptMetadata,
      asset.defaultAssetCode,
      asset.assetRevision,
      asset.dataDrivenConfig,
    );
    const command = createEntityCommand(entity);

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '导入模型');
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, `导入模型：${asset.name}`),
      };
    });
  },
  refreshModelInstancesFromAssets: (assets) => {
    let refreshedCount = 0;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '刷新模型实例');
      const refreshResult = refreshSceneModelAssetsFromImportedAssets(state.scene, assets);
      refreshedCount = refreshResult.refreshedCount;
      if (refreshedCount === 0) return state;

      const command = updateSceneDocumentCommand('刷新导入模型', () => refreshResult.scene);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `已刷新 ${refreshedCount} 个场景模型实例。`),
      };
    });

    return refreshedCount;
  },
  importCadReference: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '导入 CAD'));
      return;
    }

    if (get().cadImportProgress?.active) {
      set((state) => ({ logs: prependLog(state.logs, 'CAD 正在导入，请等待当前任务完成。') }));
      return;
    }

    if (!window.editorApi?.importCadFile) {
      set((state) => ({ logs: prependLog(state.logs, '导入 CAD 需要 Electron 桌面环境。') }));
      return;
    }

    const importProgressId = crypto.randomUUID();

    try {
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 8, '选择 CAD 文件', '等待选择 .dxf 文件...', null),
      });

      const result = await window.editorApi.importCadFile();
      if (result.canceled || !result.filePath || !result.sourceUrl) {
        set((state) => ({
          cadImportProgress: null,
          logs: prependLog(state.logs, '已取消导入 CAD。'),
        }));
        return;
      }

      const sourceUrl = result.sourceUrl;
      const displayName = result.filePath.split(/[\\/]/).pop()?.replace(/\.dxf$/i, '') || 'CAD参考图';
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 14, '准备读取 CAD', `正在打开 ${displayName}...`, displayName),
      });

      const parseResult = await parseCadReferenceDxfForImport({
        sourceUrl,
        fileSizeBytes: result.fileSizeBytes,
        readSmallFileText: async (onProgress) => {
          const response = await fetch(sourceUrl);
          if (!response.ok) {
            throw new Error(`读取 CAD 文件失败：HTTP ${response.status}`);
          }
          return readCadResponseText(response, result.fileSizeBytes, onProgress);
        },
        onProgress: ({ percent, detail }) => {
          set({
            cadImportProgress: createCadImportProgress(importProgressId, percent, '解析 CAD 图元', detail, displayName),
          });
        },
      });
      rememberCadReferenceParseResult(sourceUrl, parseResult);
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 92, '创建参考层', '正在写入场景并同步到网格层...', displayName),
      });

      const entity = createCadReferenceEntity(
        result.filePath,
        sourceUrl,
        displayName,
        createCadReferenceComponentMetadata(parseResult, {
          sourceFileSizeBytes: result.fileSizeBytes,
          importMode: result.fileSizeBytes >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES ? 'large-preview' : 'exact',
        }),
      );
      const command = createEntityCommand(entity);

      set((state) => {
        const commandResult = executeCommand(state.scene, state.history, command);
        return {
          ...commandResult,
          cadImportProgress: createCadImportProgress(importProgressId, 100, '导入完成', 'CAD 参考图已创建。', displayName),
          hierarchySelectionIds: [entity.id],
          logs: prependLog(
            state.logs,
            parseResult.budgetLimited
              ? `导入CAD参考图：${displayName}，${formatCadReferenceUnitSummary(parseResult)}，已按大文件预算截取 ${parseResult.polylineCount} 条折线，${parseResult.pointCount} 个点`
              : `导入CAD参考图：${displayName}，${formatCadReferenceUnitSummary(parseResult)}，${parseResult.polylineCount} 条折线，${parseResult.pointCount} 个点`
          ),
        };
      });
      setTimeout(() => {
        set((state) => (
          state.cadImportProgress?.id === importProgressId
            ? { cadImportProgress: null }
            : state
        ));
      }, 900);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        cadImportProgress: createCadImportProgress(importProgressId, 100, '导入失败', message, state.cadImportProgress?.fileName ?? null),
        logs: prependLog(state.logs, `导入 CAD 失败：${message}`),
      }));
      setTimeout(() => {
        set((state) => (
          state.cadImportProgress?.id === importProgressId
            ? { cadImportProgress: null }
            : state
        ));
      }, 1600);
    }
  },
  loadSceneAsset: async (asset) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载资产场景'));
      return;
    }

    if (asset.kind !== 'scene') return;

    try {
      const result = await window.editorApi.readTextFile({ filePath: asset.path });
      const scene = deserializeScene(result.content);

      set((state) => {
        if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '加载资产场景');
        return createLoadedSceneState(state, scene, `场景已加载：${asset.name}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载资产场景失败：${message}`) }));
    }
  },
  selectEntity: (entityId) => {
    set((state) => ({
      scene: {
        ...state.scene,
        selectedEntityId: entityId && state.scene.entities[entityId] ? entityId : null,
      },
      hierarchySelectionIds: entityId && state.scene.entities[entityId] ? [entityId] : [],
      selectedModelMeasurement: null,
    }));
  },
  selectHierarchyEntities: (entityIds, primaryEntityId) => {
    set((state) => {
      const hierarchySelectionIds = sanitizeHierarchySelection(state.scene, entityIds);
      const selectedEntityId = primaryEntityId && state.scene.entities[primaryEntityId] ? primaryEntityId : hierarchySelectionIds[0] ?? null;

      return {
        scene: {
          ...state.scene,
          selectedEntityId,
        },
        hierarchySelectionIds,
        selectedModelMeasurement: null,
      };
    });
  },
  moveEntitiesToFolder: (entityIds, folderId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '拖放移动对象');
      const targetFolder = folderId ? state.scene.entities[folderId] : null;
      if (folderId && !targetFolder?.isFolder) return state;

      const movableIds = [...new Set(entityIds)].filter((entityId) => {
        const entity = state.scene.entities[entityId];
        return Boolean(entity && !entity.isFolder);
      });
      if (movableIds.length === 0) return state;

      const command = moveEntitiesToFolderCommand(movableIds, folderId);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${movableIds.length} 个对象`),
      };
    });
  },
  toggleEntityVisible: (entityId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换显隐');
      const entity = state.scene.entities[entityId];
      if (!entity) return state;

      const before = entity.visible !== false;
      const after = !before;
      const command = updateEntityVisibilityCommand(entityId, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  toggleEntityLocked: (entityId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换锁定');
      const entity = state.scene.entities[entityId];
      if (!entity) return state;

      const before = entity.locked === true;
      const after = !before;
      const command = updateEntityLockCommand(entityId, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  hideSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '隐藏对象');
      const targetIds = getUnlockedSelectionIds(state);
      const changingIds = targetIds.filter((entityId) => state.scene.entities[entityId]?.visible !== false);
      if (changingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('隐藏对象', (scene) => setEntitiesVisibleInScene(scene, changingIds, false));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${changingIds.length} 个对象`),
      };
    });
  },
  lockSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '锁定对象');
      const targetIds = getUnlockedSelectionIds(state);
      const changingIds = targetIds.filter((entityId) => state.scene.entities[entityId]?.locked !== true);
      if (changingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('锁定对象', (scene) => setEntitiesLockedInScene(scene, changingIds, true));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${changingIds.length} 个对象`),
      };
    });
  },
  copySelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '复制对象');
      const selectedIds = getActiveHierarchySelectionIds(state).filter((entityId) => {
        const entity = state.scene.entities[entityId];
        return Boolean(entity && !entity.isFolder);
      });
      const skippedModelGeneratorCount = selectedIds.reduce((count, entityId) => {
        return count + (isModelGeneratorEntity(state.scene.entities[entityId]) ? 1 : 0);
      }, 0);
      const copyingIds = selectedIds.filter((entityId) => !isModelGeneratorEntity(state.scene.entities[entityId]));
      if (copyingIds.length === 0) {
        return skippedModelGeneratorCount > 0
          ? { entityClipboard: null, logs: prependLog(state.logs, '复制已跳过模型生成器：场景只允许一个模型生成器，剪贴板已清空。') }
          : state;
      }

      const entities = copyingIds
        .map((entityId) => state.scene.entities[entityId])
        .filter((entity): entity is Entity => Boolean(entity))
        .map((entity) => ({
          ...entity,
          childrenIds: [],
          components: cloneEntityComponents(entity),
        }));

      const skippedGeneratorMessage =
        skippedModelGeneratorCount > 0 ? '；已跳过模型生成器，场景只允许一个' : '';

      return {
        entityClipboard: {
          id: createId('clipboard'),
          entities,
        },
        logs: prependLog(state.logs, `复制对象: ${entities.length} 个对象${skippedGeneratorMessage}`),
      };
    });
  },
  pasteEntityClipboard: (targetFolderId) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '粘贴对象');
      const clipboard = state.entityClipboard;
      if (!clipboard || clipboard.entities.length === 0) return state;

      const selectedEntity = getSelectedEntity(state);
      const inferredTargetFolderId =
        targetFolderId === undefined
          ? selectedEntity?.isFolder
            ? selectedEntity.id
            : selectedEntity?.parentId ?? null
          : targetFolderId;
      const parentId = resolvePasteParentId(state.scene, inferredTargetFolderId);
      const parentFolder = parentId ? state.scene.entities[parentId] : null;
      if (parentFolder && isEntityEffectivelyLocked(state.scene, parentFolder)) return state;

      const existingNames = new Set(Object.values(state.scene.entities).map((entity) => entity.name));
      const candidateEntities = clipboard.entities.map((entity) =>
        createDuplicatedRuntimeEntity(
          entity,
          parentId,
          { x: CLIPBOARD_PASTE_OFFSET_METERS, y: 0, z: CLIPBOARD_PASTE_OFFSET_METERS },
          existingNames,
        ),
      );
      const generatorFilter = filterDuplicatedModelGenerators(state.scene, candidateEntities);
      const duplicatedEntities = generatorFilter.entities;
      if (duplicatedEntities.length === 0) {
        const existingGeneratorId = generatorFilter.existingGenerator?.id ?? state.scene.selectedEntityId;
        return {
          scene: {
            ...state.scene,
            selectedEntityId: existingGeneratorId ?? null,
          },
          hierarchySelectionIds: existingGeneratorId ? [existingGeneratorId] : [],
          selectedModelMeasurement: null,
          logs: prependLog(state.logs, '粘贴已拦截：场景只允许一个模型生成器，未创建第二个。'),
        };
      }

      const command = updateSceneDocumentCommand('粘贴对象', (scene) =>
        insertDuplicatedEntitiesInScene(scene, duplicatedEntities, parentId),
      );
      const result = executeCommand(state.scene, state.history, command);
      const pastedIds = duplicatedEntities.map((entity) => entity.id);

      const skippedGeneratorMessage =
        generatorFilter.skippedCount > 0 ? '；已拦截重复模型生成器，场景只允许一个' : '';

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, pastedIds),
        logs: prependLog(state.logs, `${command.label}: ${pastedIds.length} 个对象${skippedGeneratorMessage}`),
      };
    });
  },
  requestEntityArray: (copyCount, direction, spacingMeters, assetNumberRule) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '阵列对象');
      const selectedRuntimeIds = getSelectedRuntimeEntityIds(state);
      const skippedModelGeneratorCount = selectedRuntimeIds.reduce((count, sourceId) => {
        return count + (isModelGeneratorEntity(state.scene.entities[sourceId]) ? 1 : 0);
      }, 0);
      const sourceIds = selectedRuntimeIds.filter((sourceId) => !isModelGeneratorEntity(state.scene.entities[sourceId]));
      if (sourceIds.length === 0) {
        return skippedModelGeneratorCount > 0
          ? { entityArrayRequest: null, logs: prependLog(state.logs, '模型阵列已拦截：场景只允许一个模型生成器，未创建第二个。') }
          : state;
      }

      const normalizedAssetNumberRule = assetNumberRule.trim();
      const ruleError = getArrayAssetNumberRuleError(normalizedAssetNumberRule);
      if (ruleError) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, `模型阵列失败：${ruleError}`),
        };
      }

      const assetNumberedSourceCount = sourceIds.reduce((count, sourceId) => {
        const source = state.scene.entities[sourceId];
        return source && hasEntityAssetNumber(source) ? count + 1 : count;
      }, 0);
      if (normalizedAssetNumberRule && assetNumberedSourceCount !== 1) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：自定义资产编号规则仅支持一个带资产编号的源对象。'),
        };
      }

      const normalizedCopyCount = Math.min(
        ARRAY_COPY_COUNT_MAX,
        Math.max(1, Math.floor(Number.isFinite(copyCount) ? copyCount : 3)),
      );
      const normalizedDirection = ENTITY_ARRAY_DIRECTION_VECTORS[direction] ? direction : 'x';
      const spacing = sanitizeNonNegativeNumber(spacingMeters, 1);

      return {
        entityArrayRequest: {
          id: createId('entity_array'),
          sourceIds,
          copyCount: normalizedCopyCount,
          direction: normalizedDirection,
          spacingMeters: spacing,
          assetNumberRule: normalizedAssetNumberRule,
        },
        ...(skippedModelGeneratorCount > 0
          ? { logs: prependLog(state.logs, '模型阵列已跳过模型生成器：场景只允许一个模型生成器，普通对象继续阵列。') }
          : {}),
      };
    });
  },
  resolveEntityArrayRequest: (requestId, selectionSpanMeters) => {
    set((state) => {
      const request = state.entityArrayRequest;
      if (!request || request.id !== requestId) return state;
      if (!Number.isFinite(selectionSpanMeters) || selectionSpanMeters === null || selectionSpanMeters < 0) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：模型几何尚未加载完成，请稍后重试。'),
        };
      }

      const sourceIds = request.sourceIds.filter((sourceId) => {
        const source = state.scene.entities[sourceId];
        return Boolean(source && !source.isFolder && !isEntityEffectivelyLocked(state.scene, source));
      });
      if (sourceIds.length === 0 || sourceIds.length !== request.sourceIds.length) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列已取消：原选区在解析期间已失效、被锁定或发生变化。'),
        };
      }

      const ruleError = getArrayAssetNumberRuleError(request.assetNumberRule);
      if (ruleError) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, `模型阵列失败：${ruleError}`),
        };
      }
      const assetNumberedSourceCount = sourceIds.reduce((count, sourceId) => {
        const source = state.scene.entities[sourceId];
        return source && hasEntityAssetNumber(source) ? count + 1 : count;
      }, 0);
      if (request.assetNumberRule && assetNumberedSourceCount !== 1) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列已取消：自定义资产编号规则仅支持一个带资产编号的源对象。'),
        };
      }

      // 阵列完成后继续选中原始对象，避免切换到副本造成原模型被移动的误解。
      const primarySourceId =
        state.scene.selectedEntityId && sourceIds.includes(state.scene.selectedEntityId)
          ? state.scene.selectedEntityId
          : sourceIds[0] ?? null;
      const directionVector = ENTITY_ARRAY_DIRECTION_VECTORS[request.direction] ?? ENTITY_ARRAY_DIRECTION_VECTORS.x;
      const arrayStepMeters = selectionSpanMeters + request.spacingMeters;
      const maximumOffsetMeters = arrayStepMeters * request.copyCount;
      if (!Number.isFinite(arrayStepMeters) || !Number.isFinite(maximumOffsetMeters)) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列失败：净间距或副本数量过大。'),
        };
      }
      const existingNames = new Set(Object.values(state.scene.entities).map((entity) => entity.name));
      const candidateEntities: Entity[] = [];

      for (let copyIndex = 1; copyIndex <= request.copyCount; copyIndex += 1) {
        // 阵列步长由选区在目标世界轴上的尺寸与用户输入的边缘净间距共同组成。
        const offset = {
          x: directionVector.x * arrayStepMeters * copyIndex,
          y: directionVector.y * arrayStepMeters * copyIndex,
          z: directionVector.z * arrayStepMeters * copyIndex,
        };

        for (const sourceId of sourceIds) {
          const source = state.scene.entities[sourceId];
          if (!source || source.isFolder) continue;

          const sourceAssetNumberTarget = getEntityAssetNumberTarget(source);
          let assetNumberOverride: EntityAssetNumberOverride | undefined;
          if (sourceAssetNumberTarget !== null) {
            const assetNumberResult = createArrayAssetNumber(
              sourceAssetNumberTarget.value,
              copyIndex,
              request.assetNumberRule,
            );
            if (!assetNumberResult.ok) {
              return {
                entityArrayRequest: null,
                logs: prependLog(state.logs, `模型阵列失败：${assetNumberResult.error}`),
              };
            }
            assetNumberOverride = { kind: sourceAssetNumberTarget.kind, value: assetNumberResult.value };
          }

          candidateEntities.push(
            createDuplicatedRuntimeEntity(source, source.parentId, offset, existingNames, assetNumberOverride),
          );
        }
      }

      const generatorFilter = filterDuplicatedModelGenerators(state.scene, candidateEntities);
      const duplicatedEntities = generatorFilter.entities;
      if (duplicatedEntities.length === 0) {
        return {
          entityArrayRequest: null,
          logs: prependLog(state.logs, '模型阵列已拦截：场景只允许一个模型生成器，未创建第二个。'),
        };
      }

      const command = updateSceneDocumentCommand('模型阵列', (scene) => {
        let nextScene = scene;
        const groupedByParent = new Map<string | null, Entity[]>();
        for (const entity of duplicatedEntities) {
          const list = groupedByParent.get(entity.parentId) ?? [];
          list.push(entity);
          groupedByParent.set(entity.parentId, list);
        }

        for (const [parentId, entities] of groupedByParent.entries()) {
          nextScene = insertDuplicatedEntitiesInScene(nextScene, entities, parentId);
        }

        return {
          ...nextScene,
          selectedEntityId: primarySourceId,
        };
      });
      const result = executeCommand(state.scene, state.history, command);
      const duplicatedIds = duplicatedEntities.map((entity) => entity.id);

      const skippedGeneratorMessage =
        generatorFilter.skippedCount > 0 ? '；已拦截重复模型生成器，场景只允许一个' : '';

      return {
        ...result,
        entityArrayRequest: null,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, sourceIds),
        logs: prependLog(
          state.logs,
          `${command.label}: ${duplicatedIds.length} 个对象，净间距 ${request.spacingMeters} m${skippedGeneratorMessage}`,
        ),
      };
    });
  },
  groupSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '群组对象');
      const groupingIds = getSelectedRuntimeEntityIds(state);
      if (groupingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('群组对象', (scene) => groupEntitiesInScene(scene, groupingIds));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [],
        logs: prependLog(state.logs, `${command.label}: ${groupingIds.length} 个对象`),
      };
    });
  },
  ungroupSelectedEntities: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '解组对象');
      const selectionIds = getUnlockedSelectionIds(state);
      const folderIds = selectionIds.flatMap((entityId) => {
        const entity = state.scene.entities[entityId];
        if (!entity) return [];
        if (entity.isFolder) return [entity.id];
        return entity.parentId ? [entity.parentId] : [];
      });
      const ungroupingIds = [...new Set(folderIds)].filter((folderId) => {
        const folder = state.scene.entities[folderId];
        return Boolean(folder?.isFolder && !isEntityEffectivelyLocked(state.scene, folder));
      });
      if (ungroupingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('解组对象', (scene) => ungroupFoldersInScene(scene, ungroupingIds));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [],
        logs: prependLog(state.logs, `${command.label}: ${ungroupingIds.length} 个分组`),
      };
    });
  },
  requestSceneFocusForSelection: () => {
    set((state) => {
      const focusIds = resolveSceneFocusEntityIds(state.scene, getActiveHierarchySelectionIds(state));
      if (focusIds.length === 0) return state;

      return {
        sceneFocusRequest: {
          id: createId('scene_focus'),
          entityIds: focusIds,
        },
        logs: prependLog(state.logs, `场景聚焦: ${focusIds.length} 个对象`),
      };
    });
  },
  requestProjectAssetFocusForEntity: (entityId) => {
    set((state) => {
      const entity = entityId ? state.scene.entities[entityId] : getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!entity || !modelAsset) {
        return { logs: prependLog(state.logs, '库聚焦仅支持导入模型。') };
      }

      return {
        projectAssetFocusRequest: {
          id: createId('asset_focus'),
          sourcePath: modelAsset.sourcePath,
          sourceUrl: modelAsset.sourceUrl,
          entityName: entity.name,
        },
        logs: prependLog(state.logs, `库聚焦: ${entity.name}`),
      };
    });
  },
  consumeSceneFocusRequest: (requestId) => {
    set((state) => {
      if (state.sceneFocusRequest?.id !== requestId) return state;
      return { sceneFocusRequest: null };
    });
  },
  consumeProjectAssetFocusRequest: (requestId) => {
    set((state) => {
      if (state.projectAssetFocusRequest?.id !== requestId) return state;
      return { projectAssetFocusRequest: null };
    });
  },
  renameSelectedEntity: (name) => {
    const nextName = sanitizeEntityName(name);
    if (!nextName) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名对象');
      const entity = getSelectedEntity(state);
      if (!entity || isEntityEffectivelyLocked(state.scene, entity) || entity.name === nextName) return state;

      const command = renameEntityCommand(entity.id, entity.name, nextName);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${nextName}`),
      };
    });
  },
  deleteSelectedEntity: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '删除对象');
      const deletingIds = getUnlockedSelectionIds(state);
      if (deletingIds.length === 0) return state;

      const command = updateSceneDocumentCommand('删除对象', (scene) => deleteEntitiesInScene(scene, deletingIds));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, state.hierarchySelectionIds),
        logs: prependLog(state.logs, `${command.label}: ${deletingIds.length} 个对象`),
      };
    });
  },
  updateSelectedTransform: (field, axis, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改变换');
      const entity = getSelectedEntity(state);
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;

      if (entity.components.transform[field][axis] === value) return state;

      const before = cloneTransform(entity.components.transform);
      const after: TransformComponent = {
        ...cloneTransform(entity.components.transform),
        [field]: {
          ...entity.components.transform[field],
          [axis]: value,
        },
      };
      const command = updateTransformCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedMaterialColor: (materialColor) => {
    if (!isColorLike(materialColor)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改材质颜色');
      const entity = getSelectedEntity(state);
      const meshRenderer = entity?.components.meshRenderer;
      if (!isRuntimeEntityEditable(state.scene, entity) || !meshRenderer || meshRenderer.materialColor === materialColor) return state;

      const before = cloneMeshRenderer(meshRenderer);
      const after = { ...before, materialColor };
      const command = updateMeshRendererCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedLocator: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改定位器');
      const entity = getSelectedEntity(state);
      const locator = entity?.components.locator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !locator) return state;

      const before = cloneLocator(locator);
      const after: LocatorComponent = {
        assetId: sanitizeLocatorAssetId(patch.assetId, before.assetId),
        storageDepth: patch.storageDepth === 'far' ? 'far' : (patch.storageDepth === 'near' ? 'near' : before.storageDepth),
        length: sanitizeLocatorDimension(patch.length, before.length),
        width: sanitizeLocatorDimension(patch.width, before.width),
        height: sanitizeLocatorDimension(patch.height, before.height),
      };

      if (areLocatorsEqual(before, after)) return state;

      const command = updateLocatorCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedCadReference: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改 CAD 参考图');
      const entity = getSelectedEntity(state);
      const cadReference = entity?.components.cadReference;
      if (!isRuntimeEntityEditable(state.scene, entity) || !cadReference) return state;

      const before = cloneCadReference(cadReference);
      const after = sanitizeCadReferenceDisplayPatch(before, patch);
      if (areCadReferencesEqual(before, after)) return state;

      const command = updateCadReferenceCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedLight: (patch) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改灯光');
      const entity = getSelectedEntity(state);
      const light = entity?.components.light;
      if (!isRuntimeEntityEditable(state.scene, entity) || !light) return state;

      const before = cloneLight(light);
      const after: LightComponent = {
        ...before,
        ...patch,
        intensity: patch.intensity === undefined ? before.intensity : sanitizePositiveNumber(patch.intensity, before.intensity),
      };

      if (before.lightKind === after.lightKind && before.intensity === after.intensity) return state;

      const command = updateLightCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedModelAssetCode: (assetCode) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改资产编号');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset) return state;

      const before = modelAsset.assetCode;
      const after = sanitizeModelAssetCode(assetCode, before);
      if (before === after) return state;

      const command = updateModelAssetCodeCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${after}`),
      };
    });
  },
  updateSelectedModelGenerator: (component, label = '更新模型生成器') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.modelGenerator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const normalized = sanitizeModelGeneratorComponent(component);
      if (!normalized) return state;
      const before = cloneModelGeneratorComponent(current);
      const after = cloneModelGeneratorComponent(normalized);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updateModelGeneratorCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label + ': ' + entity.name) };
    });
  },
  /** 更新选中 EFF 的完整配置快照，并通过命令历史支持撤销和重做。 */
  updateSelectedPoiEffect: (component, label = '更新 EFF 特效') => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, label);
      const entity = getSelectedEntity(state);
      const current = entity?.components.poiEffect;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) return state;

      const before = { ...current };
      const after = sanitizePoiEffectComponent(component);
      if (areJsonValuesEqual(before, after)) return state;

      const command = updatePoiEffectCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, `${command.label}: ${entity.name}`) };
    });
  },
  updateSelectedTelemetryBinding: (binding) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改遥测绑定');
      const entity = getSelectedEntity(state);
      if (!entity?.components.modelAsset) return state;
      const before = entity.components.telemetryBinding ?? null;
      const after = binding ? normalizeTelemetryBindingComponent(binding) : null;
      if (JSON.stringify(before) === JSON.stringify(after)) return state;
      const command = updateTelemetryBindingCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, command.label) };
    });
  },
  restoreSelectedTelemetryBindingDefault: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '恢复遥测绑定');
      const entity = getSelectedEntity(state);
      const devType = entity?.components.modelAsset?.dataDrivenConfig?.device.devType;
      if (!entity || !devType) return state;
      const before = entity.components.telemetryBinding ?? null;
      const after = createDefaultTelemetryBinding(devType);
      if (JSON.stringify(before) === JSON.stringify(after)) return state;
      const command = updateTelemetryBindingCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);
      return { ...result, logs: prependLog(state.logs, '已恢复模型默认数据驱动绑定') };
    });
  },
  updateSelectedModelParameterValue: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
      if (sanitizedValue === null) return state;

      const before = getSelectedModelParameterValues(state);
      if (!before) return state;

      const after = patchModelParameterValue(before, key, sanitizedValue);
      if (areModelParameterValuesEqual(before, after)) return state;

      const command = updateModelParameterValuesCommand(entity.id, before, after);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewSelectedModelParameterValue: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
      if (sanitizedValue === null) return state;

      const before = getSelectedModelParameterValues(state);
      if (!before) return state;

      const after = patchModelParameterValue(before, key, sanitizedValue);
      if (areModelParameterValuesEqual(before, after)) return state;

      return {
        scene: {
          ...state.scene,
          entities: {
            ...state.scene.entities,
            [entity.id]: {
              ...entity,
              components: {
                ...entity.components,
                modelAsset: {
                  ...modelAsset,
                  parameterValues: after,
                },
              },
            },
          },
        },
      };
    });
  },
  commitSelectedModelParameterValues: (before, after) => {
    if (areModelParameterValuesEqual(before, after)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交模型参数');
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!isRuntimeEntityEditable(state.scene, entity) || !modelAsset?.parameterConfig) return state;

      const sanitizedBefore = sanitizeModelParameterValues(modelAsset.parameterConfig, before);
      const sanitizedAfter = sanitizeModelParameterValues(modelAsset.parameterConfig, after);
      if (areModelParameterValuesEqual(sanitizedBefore, sanitizedAfter)) return state;

      const command = updateModelParameterValuesCommand(entity.id, sanitizedBefore, sanitizedAfter);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewEntityTransform: (entityId, transform) => {
    if (!isFiniteTransform(transform)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览变换');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;

      if (areTransformsEqual(entity.components.transform, transform)) return state;

      return {
        scene: {
          ...state.scene,
          entities: {
            ...state.scene.entities,
            [entityId]: {
              ...entity,
              components: {
                ...entity.components,
                transform: cloneTransform(transform),
              },
            },
          },
        },
      };
    });
  },
  commitEntityTransform: (entityId, before, after) => {
    if (!isFiniteTransform(before) || !isFiniteTransform(after)) return;
    if (areTransformsEqual(before, after)) return;

    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '提交变换');
      const entity = state.scene.entities[entityId];
      if (!isRuntimeEntityEditable(state.scene, entity)) return state;

      const command = updateTransformCommand(entityId, cloneTransform(before), cloneTransform(after));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  previewSelectedTransform: (transform) => {
    const selectedId = get().scene.selectedEntityId;
    if (!selectedId) return;

    get().previewEntityTransform(selectedId, transform);
  },
  commitSelectedTransform: (before, after) => {
    const selectedId = get().scene.selectedEntityId;
    if (!selectedId) return;

    get().commitEntityTransform(selectedId, before, after);
  },
  updateMqttConfig: (config) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存 MQTT 配置');
      const mqttConfig = sanitizeMqttConfig(config);
      if (isMqttConfigEqual(state.scene.mqttConfig, mqttConfig)) {
        return state;
      }

      const command = updateSceneDocumentCommand('更新 MQTT 配置', (scene) => ({
        ...scene,
        mqttConfig,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(
          state.logs,
          `MQTT 配置已保存：${mqttConfig.simulatorEnabled ? `本地模拟 ${mqttConfig.simulatorAssetCode}/${mqttConfig.simulatorScenario}` : mqttConfig.address || '未设置地址'}，Topic ${mqttConfig.topic}，${mqttConfig.enabled ? '已启用' : '未启用'}`,
        ),
      };
    });
  },
  undo: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '撤销');
      const result = undoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      return {
        ...result,
        hierarchySelectionIds: result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [],
        logs: prependLog(state.logs, 'Undo'),
      };
    });
  },
  redo: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重做');
      const result = redoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      return {
        ...result,
        hierarchySelectionIds: result.scene.selectedEntityId ? [result.scene.selectedEntityId] : [],
        logs: prependLog(state.logs, 'Redo'),
      };
    });
  },
  newScene: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '新建场景');
      return createLoadedSceneState(state, createEmptySceneDocument(), '已新建空白场景。');
    });
  },
  saveScene: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '保存场景'));
      return;
    }

    const sceneSnapshot = get().scene;

    try {
      const content = serializeScene(sceneSnapshot);
      const result = await window.editorApi.saveScene({
        suggestedName: `${sceneSnapshot.name}.scene.json`,
        content,
      });

      if (result.canceled) {
        set((state) => ({ logs: prependLog(state.logs, '已取消保存场景。') }));
        return;
      }

      set((state) => ({ logs: prependLog(state.logs, `场景已保存：${result.filePath ?? '未知路径'}`) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `保存场景失败：${message}`) }));
    }
  },
  loadScene: async () => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载场景'));
      return false;
    }

    try {
      const result = await window.editorApi.loadScene();

      if (result.canceled || result.content === null) {
        set((state) => ({ logs: prependLog(state.logs, '已取消加载场景。') }));
        return false;
      }

      const scene = deserializeScene(result.content);

      set((state) => createLoadedSceneState(state, scene, `场景已加载：${result.filePath ?? scene.name}`));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载场景失败：${message}`) }));
      return false;
    }
  },
  loadSceneFromFile: async (filePath) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载最近场景'));
      return false;
    }

    try {
      if (!window.editorApi?.loadSceneFile) {
        throw new Error('按路径加载场景需要 Electron 桌面环境。');
      }

      const result = await window.editorApi.loadSceneFile({ filePath });

      if (result.canceled || result.content === null) {
        set((state) => ({ logs: prependLog(state.logs, '已取消加载场景。') }));
        return false;
      }

      const scene = deserializeScene(result.content);
      set((state) => createLoadedSceneState(state, scene, `场景已加载：${result.filePath ?? scene.name}`));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载最近场景失败：${message}`) }));
      return false;
    }
  },
  loadSceneFromContent: (content, sourceName) => {
    if (get().runtimeMode === 'preview') {
      set((state) => guardRuntimePreviewMutation(state, '加载内置场景'));
      return false;
    }

    try {
      const scene = deserializeScene(content);
      set((state) => createLoadedSceneState(state, scene, `场景已加载：${sourceName || scene.name}`));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载内置场景失败：${message}`) }));
      return false;
    }
  },
  pushLog: (message) => {
    set((state) => ({ logs: prependLog(state.logs, message) }));
  },
}));
