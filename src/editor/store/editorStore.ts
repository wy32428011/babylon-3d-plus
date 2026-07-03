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
  updateModelParameterValuesCommand,
  updateTransformCommand,
} from '../commands/entityCommands';
import {
  DEFAULT_EDITOR_CAMERA_SETTINGS,
  DEFAULT_EDITOR_GRID_SETTINGS,
  EDITOR_CAMERA_VIEW_RANGES,
  EDITOR_GRID_CELL_SIZES,
  type EditorCameraSettings,
  type EditorCameraViewRangeKey,
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
  TransformComponent,
} from '../model/components';
import type { Entity } from '../model/Entity';
import {
  MODEL_ASSET_CODE_MAX_LENGTH,
  createEmptySceneDocument,
  createCadReferenceEntity,
  createFolderEntity,
  createLightEntity,
  createLocatorEntity,
  createMeshEntity,
  createModelEntity,
  createModelAssetCode,
  extractModelAssetCodePrefix,
  sanitizeMqttConfig,
  type MqttConfig,
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
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, type ModelLengthUnitInfo } from '../model/sceneUnits';
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
import {
  createCadReferenceComponentMetadata,
  parseCadReferenceDxf,
  rememberCadReferenceParseResult,
  sanitizeCadReferenceDisplayPatch,
} from '../cad/cadReference';

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

export type EntityArrayAxis = 'x' | 'y' | 'z';

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

type TransformField = 'position' | 'rotation' | 'scale';
export type TransformTool = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'global';
export type TransformSnapSettingKey = 'position' | 'rotationDegrees' | 'scale';

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

type EditorState = {
  scene: SceneDocument;
  history: CommandHistory;
  hierarchySelectionIds: string[];
  entityClipboard: EntityClipboard | null;
  sceneFocusRequest: SceneFocusRequest | null;
  projectAssetFocusRequest: ProjectAssetFocusRequest | null;
  cadImportProgress: CadImportProgress | null;
  logs: EditorLog[];
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  snapSettings: TransformSnapSettings;
  gridSettings: EditorGridSettings;
  cameraSettings: EditorCameraSettings;
  setTransformTool: (tool: TransformTool) => void;
  setTransformSpace: (space: TransformSpace) => void;
  setSnapEnabled: (enabled: boolean) => void;
  updateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  setGridVisible: (visible: boolean) => void;
  setGridCellSize: (cellSizeMeters: EditorGridCellSize) => void;
  setCameraViewRange: (viewRangeKey: EditorCameraViewRangeKey) => void;
  createMesh: (meshKind: MeshKind, placementPosition?: Vector3Data) => void;
  createLocator: (placementPosition?: Vector3Data) => void;
  createLight: (lightKind: LightKind, placementPosition?: Vector3Data) => void;
  createFolder: () => void;
  importModelAsset: (asset: AssetEntry, placementPosition?: Vector3Data) => void;
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
  arraySelectedEntities: (copyCount: number, axis: EntityArrayAxis, spacingMeters: number) => void;
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
    sceneFocusRequest: null,
    projectAssetFocusRequest: null,
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

function isColorLike(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function sanitizeGridCellSize(value: EditorGridCellSize): EditorGridCellSize {
  return EDITOR_GRID_CELL_SIZES.includes(value) ? value : DEFAULT_EDITOR_GRID_SETTINGS.cellSizeMeters;
}

function sanitizeCameraViewRangeKey(value: EditorCameraViewRangeKey): EditorCameraViewRangeKey {
  return EDITOR_CAMERA_VIEW_RANGES.some((range) => range.key === value)
    ? value
    : DEFAULT_EDITOR_CAMERA_SETTINGS.viewRangeKey;
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

/** 创建普通实体副本，复制所有业务组件并按偏移调整 Transform 位置。 */
function createDuplicatedRuntimeEntity(
  source: Entity,
  parentId: string | null,
  offset: Vector3Data,
  existingNames: Set<string>,
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
      assetCode: createModelAssetCode(extractModelAssetCodePrefix(components.modelAsset.assetCode), id),
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
  history: createCommandHistory(),
  hierarchySelectionIds: [],
  entityClipboard: null,
  sceneFocusRequest: null,
  projectAssetFocusRequest: null,
  cadImportProgress: null,
  logs: [{ id: 'log_boot', message: '编辑器已启动。' }],
  transformTool: 'translate',
  transformSpace: 'local',
  snapSettings: DEFAULT_SNAP_SETTINGS,
  gridSettings: DEFAULT_EDITOR_GRID_SETTINGS,
  cameraSettings: DEFAULT_EDITOR_CAMERA_SETTINGS,
  setTransformTool: (tool) => {
    set((state) => {
      if (state.transformTool === tool) return state;

      return {
        transformTool: tool,
        logs: prependLog(state.logs, `切换工具：${tool}`),
      };
    });
  },
  setTransformSpace: (space) => {
    set((state) => {
      if (state.transformSpace === space) return state;

      return {
        transformSpace: space,
        logs: prependLog(state.logs, `切换坐标空间：${space}`),
      };
    });
  },
  setSnapEnabled: (enabled) => {
    set((state) => {
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
  setCameraViewRange: (viewRangeKey) => {
    set((state) => {
      const nextViewRangeKey = sanitizeCameraViewRangeKey(viewRangeKey);
      if (state.cameraSettings.viewRangeKey === nextViewRangeKey) return state;

      const label = EDITOR_CAMERA_VIEW_RANGES.find((range) => range.key === nextViewRangeKey)?.label ?? '标准';
      return {
        cameraSettings: {
          viewRangeKey: nextViewRangeKey,
        },
        logs: prependLog(state.logs, `Scene View 可视范围：${label}。`),
      };
    });
  },
  createMesh: (meshKind, placementPosition) => {
    const entity = createMeshEntity(meshKind, sanitizeVector3(placementPosition));
    const command = createEntityCommand(entity);

    set((state) => {
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
    const unitInfo: ModelLengthUnitInfo = {
      lengthUnit: asset.lengthUnit ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit,
      unitScaleToMeters: asset.unitScaleToMeters ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.unitScaleToMeters,
    };
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
    );
    const command = createEntityCommand(entity);

    set((state) => {
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        hierarchySelectionIds: [entity.id],
        logs: prependLog(state.logs, `导入模型：${asset.name}`),
      };
    });
  },
  importCadReference: async () => {
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

      const displayName = result.filePath.split(/[\\/]/).pop()?.replace(/\.dxf$/i, '') || 'CAD参考图';
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 14, '准备读取 CAD', `正在打开 ${displayName}...`, displayName),
      });

      const response = await fetch(result.sourceUrl);
      if (!response.ok) {
        throw new Error(`读取 CAD 文件失败：HTTP ${response.status}`);
      }

      const content = await readCadResponseText(response, result.fileSizeBytes, (percent, detail) => {
        set({
          cadImportProgress: createCadImportProgress(importProgressId, percent, '读取 CAD 文件', detail, displayName),
        });
      });

      set({
        cadImportProgress: createCadImportProgress(importProgressId, 76, '解析 CAD 图元', '正在折线化 LINE、ARC、CIRCLE 与 POLYLINE...', displayName),
      });
      await waitForNextFrame();

      const parseResult = parseCadReferenceDxf(content);
      rememberCadReferenceParseResult(result.sourceUrl, parseResult);
      set({
        cadImportProgress: createCadImportProgress(importProgressId, 92, '创建参考层', '正在写入场景并同步到网格层...', displayName),
      });

      const entity = createCadReferenceEntity(
        result.filePath,
        result.sourceUrl,
        displayName,
        createCadReferenceComponentMetadata(parseResult),
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
            `导入CAD参考图：${displayName}，${parseResult.polylineCount} 条折线，${parseResult.pointCount} 个点`,
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
    if (asset.kind !== 'scene') return;

    try {
      const result = await window.editorApi.readTextFile({ filePath: asset.path });
      const scene = deserializeScene(result.content);

      set((state) => createLoadedSceneState(state, scene, `场景已加载：${asset.name}`));
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
      };
    });
  },
  moveEntitiesToFolder: (entityIds, folderId) => {
    set((state) => {
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
      const copyingIds = getActiveHierarchySelectionIds(state).filter((entityId) => {
        const entity = state.scene.entities[entityId];
        return Boolean(entity && !entity.isFolder);
      });
      if (copyingIds.length === 0) return state;

      const entities = copyingIds
        .map((entityId) => state.scene.entities[entityId])
        .filter((entity): entity is Entity => Boolean(entity))
        .map((entity) => ({
          ...entity,
          childrenIds: [],
          components: cloneEntityComponents(entity),
        }));

      return {
        entityClipboard: {
          id: createId('clipboard'),
          entities,
        },
        logs: prependLog(state.logs, `复制对象: ${entities.length} 个对象`),
      };
    });
  },
  pasteEntityClipboard: (targetFolderId) => {
    set((state) => {
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
      const duplicatedEntities = clipboard.entities.map((entity) =>
        createDuplicatedRuntimeEntity(
          entity,
          parentId,
          { x: CLIPBOARD_PASTE_OFFSET_METERS, y: 0, z: CLIPBOARD_PASTE_OFFSET_METERS },
          existingNames,
        ),
      );
      const command = updateSceneDocumentCommand('粘贴对象', (scene) =>
        insertDuplicatedEntitiesInScene(scene, duplicatedEntities, parentId),
      );
      const result = executeCommand(state.scene, state.history, command);
      const pastedIds = duplicatedEntities.map((entity) => entity.id);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, pastedIds),
        logs: prependLog(state.logs, `${command.label}: ${pastedIds.length} 个对象`),
      };
    });
  },
  arraySelectedEntities: (copyCount, axis, spacingMeters) => {
    set((state) => {
      const sourceIds = getSelectedRuntimeEntityIds(state);
      if (sourceIds.length === 0) return state;

      const normalizedCopyCount = Math.min(
        ARRAY_COPY_COUNT_MAX,
        Math.max(1, Math.floor(Number.isFinite(copyCount) ? copyCount : 3)),
      );
      const spacing = sanitizePositiveNumber(spacingMeters, 1);
      const existingNames = new Set(Object.values(state.scene.entities).map((entity) => entity.name));
      const duplicatedEntities: Entity[] = [];

      for (let copyIndex = 1; copyIndex <= normalizedCopyCount; copyIndex += 1) {
        const offset = {
          x: axis === 'x' ? spacing * copyIndex : 0,
          y: axis === 'y' ? spacing * copyIndex : 0,
          z: axis === 'z' ? spacing * copyIndex : 0,
        };

        for (const sourceId of sourceIds) {
          const source = state.scene.entities[sourceId];
          if (!source || source.isFolder) continue;
          duplicatedEntities.push(createDuplicatedRuntimeEntity(source, source.parentId, offset, existingNames));
        }
      }

      if (duplicatedEntities.length === 0) return state;

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
          selectedEntityId: duplicatedEntities[0]?.id ?? nextScene.selectedEntityId,
        };
      });
      const result = executeCommand(state.scene, state.history, command);
      const duplicatedIds = duplicatedEntities.map((entity) => entity.id);

      return {
        ...result,
        hierarchySelectionIds: sanitizeHierarchySelection(result.scene, duplicatedIds),
        logs: prependLog(state.logs, `${command.label}: ${duplicatedIds.length} 个对象`),
      };
    });
  },
  groupSelectedEntities: () => {
    set((state) => {
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
      const entity = getSelectedEntity(state);
      const locator = entity?.components.locator;
      if (!isRuntimeEntityEditable(state.scene, entity) || !locator) return state;

      const before = cloneLocator(locator);
      const after: LocatorComponent = {
        assetId: sanitizeLocatorAssetId(patch.assetId, before.assetId),
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
  updateSelectedModelParameterValue: (key, value) => {
    set((state) => {
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
      const mqttConfig = sanitizeMqttConfig(config);
      if (
        state.scene.mqttConfig.enabled === mqttConfig.enabled &&
        state.scene.mqttConfig.ip === mqttConfig.ip &&
        state.scene.mqttConfig.address === mqttConfig.address &&
        state.scene.mqttConfig.topic === mqttConfig.topic &&
        state.scene.mqttConfig.simulatorEnabled === mqttConfig.simulatorEnabled &&
        state.scene.mqttConfig.simulatorAssetCode === mqttConfig.simulatorAssetCode &&
        state.scene.mqttConfig.simulatorScenario === mqttConfig.simulatorScenario &&
        state.scene.mqttConfig.simulatorIntervalMs === mqttConfig.simulatorIntervalMs
      ) {
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
    set((state) => createLoadedSceneState(state, createEmptySceneDocument(), '已新建空白场景。'));
  },
  saveScene: async () => {
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
