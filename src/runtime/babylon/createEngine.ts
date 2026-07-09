import {
  ArcRotateCamera,
  Color3,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import { SCENE_LENGTH_UNIT_SYMBOL } from '../../editor/model/sceneUnits';
import type { Vector3Data } from '../../editor/model/math';
import {
  SCENE_VIEW_DISTANCE_DEFAULT,
  sanitizeSceneSensitivityValue,
  sanitizeSceneViewDistance,
  type SceneCameraPose,
  type SceneSensitivitySettings,
} from '../../editor/model/SceneDocument';

export type EditorGridCellSize = 1 | 2 | 5 | 10;

export type EditorGridSettings = {
  visible: boolean;
  cellSizeMeters: EditorGridCellSize;
};

export type EditorWorldBounds = {
  center: Vector3Data;
  radiusMeters: number;
};

type EditorGroundGridResources = {
  grid: Mesh;
  gridMaterial: StandardMaterial;
  lineGlowGrid: Mesh;
  lineGlowMaterial: StandardMaterial;
  lineGlowLayer: GlowLayer;
};

export type BabylonViewport = {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  focusOnBounds: (bounds: EditorWorldBounds) => void;
  setViewDistance: (meters: number) => void;
  setSensitivity: (settings: SceneSensitivitySettings) => void;
  getCameraPose: () => SceneCameraPose;
  applyCameraPose: (pose: SceneCameraPose | null) => void;
  setGridSettings: (settings: EditorGridSettings) => void;
  dispose: () => void;
};

export const EDITOR_GRID_CELL_SIZES: readonly EditorGridCellSize[] = [1, 2, 5, 10];
export const DEFAULT_EDITOR_GRID_SETTINGS: EditorGridSettings = {
  visible: true,
  cellSizeMeters: 5,
};

const GRID_SIZE_METERS = 240;
const GRID_ALPHA_BASE = 0.14;
const GRID_ALPHA_PULSE = 0.025;
const GRID_LINE_GLOW_ALPHA_BASE = 0.025;
const GRID_LINE_GLOW_ALPHA_PULSE = 0.035;
const GRID_LINE_GLOW_INTENSITY_BASE = 0.08;
const GRID_LINE_GLOW_INTENSITY_PULSE = 0.12;
const BREATHING_SPEED = 0.0018;
const EDITOR_CAMERA_MIN_RADIUS_METERS = 0.35;
const EDITOR_CAMERA_MIN_Z_METERS = 0.02;
const EDITOR_CAMERA_DEFAULT_ALPHA = Math.PI / 4;
const EDITOR_CAMERA_DEFAULT_BETA = Math.PI * 0.43;
const EDITOR_CAMERA_DEFAULT_RADIUS = 28;
const EDITOR_CAMERA_DEFAULT_TARGET = Vector3.Zero();

/** 将未知异常转换成可读消息，便于向上层 UI 呈现 Babylon 初始化失败原因。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 在创建 Babylon Engine 前检查 WebGL 能力，避免 Electron 内容区静默白屏。 */
function assertWebGLSupported(): void {
  if (Engine.isSupported()) return;

  throw new Error('当前 Electron 渲染进程不支持 WebGL，无法创建 Babylon Scene View。');
}

/** 限制编辑器相机距离，避免滚轮缩放过近时穿过模型或被近裁剪面裁空。 */
function clampCameraRadius(radiusMeters: number): number {
  return Math.max(radiusMeters, EDITOR_CAMERA_MIN_RADIUS_METERS);
}

/** 按当前米制网格间距吸附位置，保证网格跟随相机时仍然对齐世界坐标。 */
function snapToGrid(value: number, cellSizeMeters: EditorGridCellSize): number {
  return Math.round(value / cellSizeMeters) * cellSizeMeters;
}

/** 根据当前格子大小计算网格细分数，保持辅助网格总覆盖范围不变。 */
function getGridSubdivisions(cellSizeMeters: EditorGridCellSize): number {
  return GRID_SIZE_METERS / cellSizeMeters;
}

/** 创建一组编辑器辅助地面网格资源；网格不进入 SceneDocument，也不可被拾取选中。 */
function createEditorGroundGridResources(scene: Scene, settings: EditorGridSettings): EditorGroundGridResources {
  const subdivisions = getGridSubdivisions(settings.cellSizeMeters);
  const cellSizeLabel = `${settings.cellSizeMeters} ${SCENE_LENGTH_UNIT_SYMBOL}`;
  const grid = MeshBuilder.CreateGround(
    'EditorGroundGrid',
    {
      width: GRID_SIZE_METERS,
      height: GRID_SIZE_METERS,
      subdivisions,
    },
    scene,
  );
  grid.isPickable = false;
  grid.metadata = { cellSizeLabel };

  const gridMaterial = new StandardMaterial('EditorGroundGridMaterial', scene);
  gridMaterial.diffuseColor = Color3.FromHexString('#4fa8ff');
  gridMaterial.emissiveColor = Color3.FromHexString('#1e6fb5');
  gridMaterial.alpha = GRID_ALPHA_BASE;
  gridMaterial.wireframe = true;
  gridMaterial.backFaceCulling = false;
  grid.material = gridMaterial;

  const lineGlowGrid = MeshBuilder.CreateGround(
    'EditorGroundLineGlowGrid',
    {
      width: GRID_SIZE_METERS,
      height: GRID_SIZE_METERS,
      subdivisions,
    },
    scene,
  );
  lineGlowGrid.position.y = 0.006;
  lineGlowGrid.isPickable = false;

  const lineGlowMaterial = new StandardMaterial('EditorGroundLineGlowMaterial', scene);
  lineGlowMaterial.diffuseColor = Color3.FromHexString('#7fd4ff');
  lineGlowMaterial.emissiveColor = Color3.FromHexString('#7fd4ff');
  lineGlowMaterial.alpha = GRID_LINE_GLOW_ALPHA_BASE;
  lineGlowMaterial.wireframe = true;
  lineGlowMaterial.backFaceCulling = false;
  lineGlowGrid.material = lineGlowMaterial;

  const lineGlowLayer = new GlowLayer('EditorGroundLineGlowLayer', scene);
  lineGlowLayer.intensity = GRID_LINE_GLOW_INTENSITY_BASE;
  lineGlowLayer.addIncludedOnlyMesh(lineGlowGrid);

  grid.setEnabled(settings.visible);
  lineGlowGrid.setEnabled(settings.visible);
  if (!settings.visible) {
    lineGlowLayer.intensity = 0;
  }

  return { grid, gridMaterial, lineGlowGrid, lineGlowMaterial, lineGlowLayer };
}

/** 释放编辑器辅助地面网格资源，避免多次切换格子大小后残留 Babylon 对象。 */
function disposeEditorGroundGridResources(resources: EditorGroundGridResources | null): void {
  if (!resources) return;

  resources.lineGlowLayer.dispose();
  resources.grid.dispose(false, false);
  resources.lineGlowGrid.dispose(false, false);
  resources.gridMaterial.dispose();
  resources.lineGlowMaterial.dispose();
}

/** 创建编辑器辅助地面网格控制器，集中管理格子大小、显示状态与呼吸光晕。 */
function createEditorGround(scene: Scene, initialSettings: EditorGridSettings) {
  let settings = { ...initialSettings };
  let resources: EditorGroundGridResources | null = createEditorGroundGridResources(scene, settings);

  function rebuildGrid(): void {
    disposeEditorGroundGridResources(resources);
    resources = createEditorGroundGridResources(scene, settings);
  }

  function applyVisibility(): void {
    if (!resources) return;

    resources.grid.setEnabled(settings.visible);
    resources.lineGlowGrid.setEnabled(settings.visible);
    if (!settings.visible) {
      resources.lineGlowLayer.intensity = 0;
    }
  }

  const beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
    if (!resources) return;

    const cameraPosition = scene.activeCamera?.position;
    if (cameraPosition) {
      const snappedX = snapToGrid(cameraPosition.x, settings.cellSizeMeters);
      const snappedZ = snapToGrid(cameraPosition.z, settings.cellSizeMeters);
      resources.grid.position.x = snappedX;
      resources.grid.position.z = snappedZ;
      resources.lineGlowGrid.position.x = snappedX;
      resources.lineGlowGrid.position.z = snappedZ;
    }

    if (!settings.visible) return;

    const pulse = (Math.sin(performance.now() * BREATHING_SPEED) + 1) / 2;
    resources.gridMaterial.alpha = GRID_ALPHA_BASE + pulse * GRID_ALPHA_PULSE;
    resources.lineGlowMaterial.alpha = GRID_LINE_GLOW_ALPHA_BASE + pulse * GRID_LINE_GLOW_ALPHA_PULSE;
    resources.lineGlowLayer.intensity = GRID_LINE_GLOW_INTENSITY_BASE + pulse * GRID_LINE_GLOW_INTENSITY_PULSE;
  });

  return {
    setSettings(nextSettings: EditorGridSettings): void {
      const cellSizeChanged = settings.cellSizeMeters !== nextSettings.cellSizeMeters;
      settings = { ...nextSettings };

      if (cellSizeChanged) {
        rebuildGrid();
        return;
      }

      applyVisibility();
    },
    dispose(): void {
      scene.onBeforeRenderObservable.remove(beforeRenderObserver);
      disposeEditorGroundGridResources(resources);
      resources = null;
    },
  };
}

/** 根据包围半径计算相机观察距离，给对象周围预留一圈编辑空间。 */
function getFocusCameraRadius(bounds: EditorWorldBounds): number {
  const radiusMeters = Number.isFinite(bounds.radiusMeters) ? bounds.radiusMeters : 1;
  return clampCameraRadius(Math.max(radiusMeters * 2.2, 2.5));
}

/** 将场景灵敏度映射到 Babylon 相机参数，滑杆 10 对应原始默认手感。 */
function applyCameraSensitivity(camera: ArcRotateCamera, settings: SceneSensitivitySettings): void {
  const zoom = sanitizeSceneSensitivityValue(settings.zoom);
  const pan = sanitizeSceneSensitivityValue(settings.pan);
  const rotate = sanitizeSceneSensitivityValue(settings.rotate);

  camera.wheelPrecision = 400 / (zoom * 10);
  camera.panningSensibility = 10000 / (pan * 10);
  camera.angularSensibilityX = 10000 / (rotate * 10);
  camera.angularSensibilityY = 10000 / (rotate * 10);
}

/** 读取当前 ArcRotateCamera 位姿，保存为可写入场景文件的纯数据。 */
function readCameraPose(camera: ArcRotateCamera): SceneCameraPose {
  const target = camera.getTarget();

  return {
    alpha: camera.alpha,
    beta: camera.beta,
    radius: camera.radius,
    target: { x: target.x, y: target.y, z: target.z },
  };
}

/** 应用保存的相机位姿；未保存时回到编辑器默认观察角度。 */
function applySavedCameraPose(camera: ArcRotateCamera, pose: SceneCameraPose | null): void {
  const target = pose ? new Vector3(pose.target.x, pose.target.y, pose.target.z) : EDITOR_CAMERA_DEFAULT_TARGET.clone();
  camera.alpha = pose?.alpha ?? EDITOR_CAMERA_DEFAULT_ALPHA;
  camera.beta = pose?.beta ?? EDITOR_CAMERA_DEFAULT_BETA;
  camera.radius = clampCameraRadius(pose?.radius ?? EDITOR_CAMERA_DEFAULT_RADIUS);
  camera.setTarget(target);
}

export function createBabylonViewport(canvas: HTMLCanvasElement): BabylonViewport {
  assertWebGLSupported();

  let engine: Engine;
  try {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  } catch (error) {
    throw new Error(`Babylon Engine 创建失败：${getErrorMessage(error)}`);
  }

  const scene = new Scene(engine);
  scene.clearColor.set(0.08, 0.08, 0.09, 1);

  const camera = new ArcRotateCamera(
    'EditorCamera',
    EDITOR_CAMERA_DEFAULT_ALPHA,
    EDITOR_CAMERA_DEFAULT_BETA,
    EDITOR_CAMERA_DEFAULT_RADIUS,
    EDITOR_CAMERA_DEFAULT_TARGET.clone(),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.minZ = EDITOR_CAMERA_MIN_Z_METERS;
  camera.lowerRadiusLimit = EDITOR_CAMERA_MIN_RADIUS_METERS;
  camera.maxZ = SCENE_VIEW_DISTANCE_DEFAULT;
  camera.upperRadiusLimit = SCENE_VIEW_DISTANCE_DEFAULT;
  applyCameraSensitivity(camera, { zoom: 10, pan: 10, rotate: 10 });

  const light = new HemisphericLight('EditorLight', new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  const editorGround = createEditorGround(scene, DEFAULT_EDITOR_GRID_SETTINGS);

  engine.runRenderLoop(() => {
    scene.render();
  });

  return {
    engine,
    scene,
    camera,
    focusOnBounds: (bounds) => {
      camera.setTarget(new Vector3(bounds.center.x, bounds.center.y, bounds.center.z));
      camera.radius = getFocusCameraRadius(bounds);
    },
    setViewDistance: (meters) => {
      const viewDistance = sanitizeSceneViewDistance(meters);
      camera.maxZ = viewDistance;
      camera.upperRadiusLimit = viewDistance;
      camera.radius = clampCameraRadius(Math.min(camera.radius, viewDistance));
    },
    setSensitivity: (settings) => {
      applyCameraSensitivity(camera, settings);
    },
    getCameraPose: () => readCameraPose(camera),
    applyCameraPose: (pose) => {
      applySavedCameraPose(camera, pose);
    },
    setGridSettings: editorGround.setSettings,
    dispose: () => {
      editorGround.dispose();
      engine.dispose();
    },
  };
}
