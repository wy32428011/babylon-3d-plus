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
  deleteEntityCommand,
  renameEntityCommand,
  updateLightCommand,
  updateMeshRendererCommand,
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
import type { LightComponent, LightKind, MeshKind, MeshRendererComponent, TransformComponent } from '../model/components';
import {
  createEmptySceneDocument,
  createLightEntity,
  createMeshEntity,
  createModelEntity,
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

type EditorLog = {
  id: string;
  message: string;
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

type EditorState = {
  scene: SceneDocument;
  history: CommandHistory;
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
  createLight: (lightKind: LightKind, placementPosition?: Vector3Data) => void;
  importModelAsset: (asset: AssetEntry, placementPosition?: Vector3Data) => void;
  loadSceneAsset: (asset: AssetEntry) => Promise<void>;
  selectEntity: (entityId: string | null) => void;
  renameSelectedEntity: (name: string) => void;
  deleteSelectedEntity: () => void;
  updateSelectedTransform: (field: TransformField, axis: keyof Vector3Data, value: number) => void;
  updateSelectedMaterialColor: (materialColor: string) => void;
  updateSelectedLight: (patch: Partial<LightComponent>) => void;
  updateSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
  previewSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
  commitSelectedModelParameterValues: (before: ModelParameterValues, after: ModelParameterValues) => void;
  previewEntityTransform: (entityId: string, transform: TransformComponent) => void;
  commitEntityTransform: (entityId: string, before: TransformComponent, after: TransformComponent) => void;
  previewSelectedTransform: (transform: TransformComponent) => void;
  commitSelectedTransform: (before: TransformComponent, after: TransformComponent) => void;
  undo: () => void;
  redo: () => void;
  saveScene: () => Promise<void>;
  loadScene: () => Promise<void>;
  pushLog: (message: string) => void;
};

function createLog(message: string): EditorLog {
  return { id: crypto.randomUUID(), message };
}

function prependLog(logs: EditorLog[], message: string): EditorLog[] {
  return [createLog(message), ...logs].slice(0, 100);
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

function cloneLight(light: LightComponent): LightComponent {
  return {
    lightKind: light.lightKind,
    intensity: light.intensity,
  };
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

export const useEditorStore = create<EditorState>((set, get) => ({
  scene: createEmptySceneDocument(),
  history: createCommandHistory(),
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
    );
    const command = createEntityCommand(entity);

    set((state) => {
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        logs: prependLog(state.logs, `导入模型：${asset.name}`),
      };
    });
  },
  loadSceneAsset: async (asset) => {
    if (asset.kind !== 'scene') return;

    try {
      const result = await window.editorApi.readTextFile({ filePath: asset.path });
      const scene = deserializeScene(result.content);

      set((state) => ({
        scene,
        history: createCommandHistory(),
        logs: prependLog(state.logs, `场景已加载：${asset.name}`),
      }));
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
    }));
  },
  renameSelectedEntity: (name) => {
    const nextName = sanitizeEntityName(name);
    if (!nextName) return;

    set((state) => {
      const entity = getSelectedEntity(state);
      if (!entity || entity.name === nextName) return state;

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
      const entity = getSelectedEntity(state);
      if (!entity) return state;

      const command = deleteEntityCommand(entity.id);
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
      };
    });
  },
  updateSelectedTransform: (field, axis, value) => {
    set((state) => {
      const entity = getSelectedEntity(state);
      if (!entity) return state;

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
      if (!entity || !meshRenderer || meshRenderer.materialColor === materialColor) return state;

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
  updateSelectedLight: (patch) => {
    set((state) => {
      const entity = getSelectedEntity(state);
      const light = entity?.components.light;
      if (!entity || !light) return state;

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
  updateSelectedModelParameterValue: (key, value) => {
    set((state) => {
      const entity = getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!entity || !modelAsset?.parameterConfig) return state;

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
      if (!entity || !modelAsset?.parameterConfig) return state;

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
      if (!entity || !modelAsset?.parameterConfig) return state;

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
      if (!entity) return state;

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
      if (!entity) return state;

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
  undo: () => {
    set((state) => {
      const result = undoCommand(state.scene, state.history);
      if (result.history === state.history) return state;

      return {
        ...result,
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
        logs: prependLog(state.logs, 'Redo'),
      };
    });
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
        return;
      }

      const scene = deserializeScene(result.content);

      set((state) => ({
        scene,
        history: createCommandHistory(),
        logs: prependLog(state.logs, `场景已加载：${result.filePath ?? scene.name}`),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ logs: prependLog(state.logs, `加载场景失败：${message}`) }));
    }
  },
  pushLog: (message) => {
    set((state) => ({ logs: prependLog(state.logs, message) }));
  },
}));
