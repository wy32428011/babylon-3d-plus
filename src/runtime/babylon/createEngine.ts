import {
  ArcRotateCamera,
  Axis,
  Color3,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  TmpVectors,
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
  gridMaterial: ShaderMaterial;
  lineGlowGrid: Mesh;
  lineGlowMaterial: ShaderMaterial;
  lineGlowLayer: GlowLayer;
};

export type BabylonViewportRuntimeStatus =
  | { type: 'context-lost'; message: string }
  | { type: 'context-restored'; message: string }
  | { type: 'render-error'; message: string; error: unknown }
  | { type: 'render-recovered'; message: string };

/** 接收 Babylon 视口运行状态变化，供 React 面板同步错误遮罩与恢复提示。 */
export type BabylonViewportRuntimeStatusCallback = (status: BabylonViewportRuntimeStatus) => void;

export type BabylonViewport = {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  focusOnBounds: (bounds: EditorWorldBounds) => void;
  setViewDistance: (meters: number) => void;
  setSensitivity: (settings: SceneSensitivitySettings) => void;
  getCameraPose: () => SceneCameraPose;
  applyCameraPose: (pose: SceneCameraPose | null) => void;
  setTopView: () => void;
  setGridSettings: (settings: EditorGridSettings) => void;
  dispose: () => void;
};

export const EDITOR_GRID_CELL_SIZES: readonly EditorGridCellSize[] = [1, 2, 5, 10];
export const DEFAULT_EDITOR_GRID_SETTINGS: EditorGridSettings = {
  visible: true,
  cellSizeMeters: 5,
};

const GRID_SIZE_METERS = 80000;
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
const EDITOR_CAMERA_TOP_VIEW_ALPHA = -Math.PI / 2;
const EDITOR_CAMERA_TOP_VIEW_BETA_FALLBACK = 0.01;
const EDITOR_CAMERA_DEFAULT_TARGET = Vector3.Zero();
const GRID_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;

uniform mat4 world;
uniform mat4 worldViewProjection;

varying vec3 vWorldPosition;

void main(void) {
  vec4 worldPosition = world * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
const GRID_FRAGMENT_SHADER = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

varying vec3 vWorldPosition;

uniform float cellSizeMeters;
uniform vec3 lineColor;
uniform float lineAlpha;
uniform float lineWidth;

float getGridLine(vec2 worldPosition, float cellSize) {
  vec2 gridPosition = worldPosition / max(cellSize, 0.0001);
  vec2 derivative = max(fwidth(gridPosition), vec2(0.0001));
  vec2 grid = abs(fract(gridPosition - 0.5) - 0.5) / derivative;
  float distanceToLine = min(grid.x, grid.y);
  return 1.0 - smoothstep(lineWidth, lineWidth + 1.0, distanceToLine);
}

void main(void) {
  float line = getGridLine(vWorldPosition.xz, cellSizeMeters);
  if (line <= 0.001) {
    discard;
  }

  gl_FragColor = vec4(lineColor, line * lineAlpha);
}
`;

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

/** 创建地面网格过程式材质，用世界坐标绘制米制网格线，避免大范围网格生成海量几何。 */
function createEditorGridShaderMaterial(
  scene: Scene,
  name: string,
  lineColor: Color3,
  lineAlpha: number,
  lineWidth: number,
  cellSizeMeters: EditorGridCellSize,
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    {
      vertexSource: GRID_VERTEX_SHADER,
      fragmentSource: GRID_FRAGMENT_SHADER,
    },
    {
      attributes: ['position'],
      uniforms: ['world', 'worldViewProjection', 'cellSizeMeters', 'lineColor', 'lineAlpha', 'lineWidth'],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  material.setColor3('lineColor', lineColor);
  material.setFloat('lineAlpha', lineAlpha);
  material.setFloat('lineWidth', lineWidth);
  material.setFloat('cellSizeMeters', cellSizeMeters);

  return material;
}

/** 创建一组编辑器辅助地面网格资源；网格不进入 SceneDocument，也不可被拾取选中。 */
function createEditorGroundGridResources(scene: Scene, settings: EditorGridSettings): EditorGroundGridResources {
  const cellSizeLabel = `${settings.cellSizeMeters} ${SCENE_LENGTH_UNIT_SYMBOL}`;
  const grid = MeshBuilder.CreateGround(
    'EditorGroundGrid',
    {
      width: GRID_SIZE_METERS,
      height: GRID_SIZE_METERS,
      subdivisions: 1,
    },
    scene,
  );
  grid.isPickable = false;
  grid.alwaysSelectAsActiveMesh = true;
  grid.metadata = { cellSizeLabel };

  const gridMaterial = createEditorGridShaderMaterial(
    scene,
    'EditorGroundGridMaterial',
    Color3.FromHexString('#4fa8ff'),
    GRID_ALPHA_BASE,
    0.75,
    settings.cellSizeMeters,
  );
  grid.material = gridMaterial;

  const lineGlowGrid = MeshBuilder.CreateGround(
    'EditorGroundLineGlowGrid',
    {
      width: GRID_SIZE_METERS,
      height: GRID_SIZE_METERS,
      subdivisions: 1,
    },
    scene,
  );
  lineGlowGrid.position.y = 0.006;
  lineGlowGrid.isPickable = false;
  lineGlowGrid.alwaysSelectAsActiveMesh = true;
  lineGlowGrid.metadata = { cellSizeLabel };

  const lineGlowMaterial = createEditorGridShaderMaterial(
    scene,
    'EditorGroundLineGlowMaterial',
    Color3.FromHexString('#7fd4ff'),
    GRID_LINE_GLOW_ALPHA_BASE,
    1.1,
    settings.cellSizeMeters,
  );
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

  function applyGridCellSize(): void {
    if (!resources) return;

    const cellSizeLabel = `${settings.cellSizeMeters} ${SCENE_LENGTH_UNIT_SYMBOL}`;
    resources.grid.metadata = { cellSizeLabel };
    resources.lineGlowGrid.metadata = { cellSizeLabel };
    resources.gridMaterial.setFloat('cellSizeMeters', settings.cellSizeMeters);
    resources.lineGlowMaterial.setFloat('cellSizeMeters', settings.cellSizeMeters);
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

    if (!settings.visible) return;

    const pulse = (Math.sin(performance.now() * BREATHING_SPEED) + 1) / 2;
    resources.gridMaterial.setFloat('lineAlpha', GRID_ALPHA_BASE + pulse * GRID_ALPHA_PULSE);
    resources.lineGlowMaterial.setFloat('lineAlpha', GRID_LINE_GLOW_ALPHA_BASE + pulse * GRID_LINE_GLOW_ALPHA_PULSE);
    resources.lineGlowLayer.intensity = GRID_LINE_GLOW_INTENSITY_BASE + pulse * GRID_LINE_GLOW_INTENSITY_PULSE;
  });

  return {
    setSettings(nextSettings: EditorGridSettings): void {
      const cellSizeChanged = settings.cellSizeMeters !== nextSettings.cellSizeMeters;
      settings = { ...nextSettings };

      if (cellSizeChanged) {
        applyGridCellSize();
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

/** 清除相机仍在衰减的旋转、平移和缩放输入，避免程序切换视角后继续漂移。 */
function clearCameraMovement(camera: ArcRotateCamera): void {
  camera.inertialAlphaOffset = 0;
  camera.inertialBetaOffset = 0;
  camera.inertialRadiusOffset = 0;
  camera.inertialPanningX = 0;
  camera.inertialPanningY = 0;
  camera.movement.activeInput = false;
  camera.movement.resetRotationVelocity();
  camera.movement.resetPanVelocity();
  camera.movement.resetZoomVelocity();
}

/** 保留当前观察中心和距离，将 ArcRotateCamera 切换到稳定的世界 Y 轴俯视方向。 */
function applyTopCameraView(camera: ArcRotateCamera): void {
  clearCameraMovement(camera);
  camera.alpha = EDITOR_CAMERA_TOP_VIEW_ALPHA;
  camera.beta = Math.max(camera.lowerBetaLimit ?? EDITOR_CAMERA_TOP_VIEW_BETA_FALLBACK, EDITOR_CAMERA_TOP_VIEW_BETA_FALLBACK);
}

const CAMERA_FLY_KEY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC']);
/** 键盘平移速度：每秒移动距离占相机半径的比例，视野越远移动越快。 */
const CAMERA_FLY_SPEED_PER_RADIUS_SECOND = 0.6;

/** WASD 前后/左右平移 + Space 升 C 降；焦点在输入控件上时不接管按键，返回清理函数。 */
function createCameraFlyKeyControls(camera: ArcRotateCamera, engine: Engine, scene: Scene): () => void {
  const pressedKeys = new Set<string>();

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!CAMERA_FLY_KEY_CODES.has(event.code)) return;
    const active = document.activeElement;
    if (active && active !== document.body && !(active instanceof HTMLCanvasElement)) return;
    event.stopPropagation();
    pressedKeys.add(event.code);
    if (event.code === 'Space') event.preventDefault();
  };
  const handleKeyUp = (event: KeyboardEvent): void => {
    if (!CAMERA_FLY_KEY_CODES.has(event.code)) return;
    event.stopPropagation();
    pressedKeys.delete(event.code);
  };
  const handleWindowBlur = (): void => {
    pressedKeys.clear();
  };

  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('blur', handleWindowBlur, true);

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (pressedKeys.size === 0) return;

    // 相机无 roll，right 向量始终水平，俯视时也不会退化
    const rightFlat = TmpVectors.Vector3[0];
    camera.getDirectionToRef(Axis.X, rightFlat);
    rightFlat.y = 0;
    if (rightFlat.lengthSquared() < 1e-10) return;
    rightFlat.normalize();
    const forwardFlat = TmpVectors.Vector3[1];
    Vector3.CrossToRef(rightFlat, Axis.Y, forwardFlat);

    const move = TmpVectors.Vector3[2].setAll(0);
    if (pressedKeys.has('KeyW')) move.addInPlace(forwardFlat);
    if (pressedKeys.has('KeyS')) move.subtractInPlace(forwardFlat);
    if (pressedKeys.has('KeyD')) move.addInPlace(rightFlat);
    if (pressedKeys.has('KeyA')) move.subtractInPlace(rightFlat);
    if (pressedKeys.has('Space')) move.y += 1;
    if (pressedKeys.has('KeyC')) move.y -= 1;
    if (move.lengthSquared() === 0) return;

    const deltaSeconds = engine.getDeltaTime() / 1000;
    move.normalize().scaleInPlace(camera.radius * CAMERA_FLY_SPEED_PER_RADIUS_SECOND * deltaSeconds);
    camera.target.addInPlace(move);
  });

  return () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('keyup', handleKeyUp, true);
    window.removeEventListener('blur', handleWindowBlur, true);
    scene.onBeforeRenderObservable.remove(observer);
  };
}

export function createBabylonViewport(
  canvas: HTMLCanvasElement,
  onRuntimeStatus?: BabylonViewportRuntimeStatusCallback,
): BabylonViewport {
  assertWebGLSupported();

  let engine: Engine;
  try {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true });
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
  const disposeFlyControls = createCameraFlyKeyControls(camera, engine, scene);
  let disposed = false;
  let contextLost = false;
  let renderFailed = false;

  /** 在 Babylon 已确认 WebGL 上下文丢失后暂停绘制，并把恢复等待状态上报给外层面板。 */
  const contextLostObserver = engine.onContextLostObservable.add(() => {
    contextLost = true;
    onRuntimeStatus?.({
      type: 'context-lost',
      message: 'Scene View WebGL 上下文已丢失，正在自动恢复。',
    });
  });

  /** 在 Babylon 完成上下文资源恢复后继续绘制，并通知外层面板清除错误遮罩。 */
  const contextRestoredObserver = engine.onContextRestoredObservable.add(() => {
    contextLost = false;
    renderFailed = false;
    onRuntimeStatus?.({
      type: 'context-restored',
      message: 'Scene View WebGL 上下文已恢复。',
    });
  });

  engine.runRenderLoop(() => {
    if (disposed || contextLost) return;

    try {
      scene.render();
      if (renderFailed) {
        renderFailed = false;
        onRuntimeStatus?.({
          type: 'render-recovered',
          message: 'Scene View 渲染循环已恢复。',
        });
      }
    } catch (error) {
      if (renderFailed) return;

      renderFailed = true;
      onRuntimeStatus?.({
        type: 'render-error',
        message: `Scene View 渲染循环异常：${getErrorMessage(error)}`,
        error,
      });
    }
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
    /** 保留当前取景范围，把编辑器相机切换为适合 CAD 底图建模的俯视视角。 */
    setTopView: () => {
      applyTopCameraView(camera);
    },
    setGridSettings: editorGround.setSettings,
    dispose: () => {
      disposed = true;
      disposeFlyControls();
      engine.onContextLostObservable.remove(contextLostObserver);
      engine.onContextRestoredObservable.remove(contextRestoredObserver);
      editorGround.dispose();
      engine.dispose();
    },
  };
}
