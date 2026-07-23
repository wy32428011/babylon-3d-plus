import {
  ArcRotateCamera,
  Axis,
  Camera,
  Color3,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  type Observer,
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

/** 编辑器视口的持久朝向状态：俯视是可持续的模式而非一次性事件。 */
export type CameraOrientation = 'orbit' | 'top';
/** 编辑器视口的投影方式，与朝向状态正交组合。 */
export type CameraProjection = 'perspective' | 'orthographic';

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

/** 创建 Babylon 视口时可覆盖的交互选项；缺省值保持编辑器现有行为。 */
export type BabylonViewportOptions = {
  showGrid?: boolean;
  allowCameraControl?: boolean;
  /** 编辑器模式设为 true 时拒绝 SwiftShader、WARP 等软件 WebGL 回退。 */
  requireHardwareAcceleration?: boolean;
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
  setCameraOrientation: (orientation: CameraOrientation) => void;
  setCameraProjection: (projection: CameraProjection) => void;
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
const SOFTWARE_WEBGL_RENDERER_PATTERNS = [
  /swiftshader/i,
  /llvmpipe/i,
  /lavapipe/i,
  /softpipe/i,
  /software (?:adapter|rasterizer|renderer)/i,
  /microsoft basic render driver/i,
  /(?:direct3d|d3d)\s*warp/i,
];
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
const EDITOR_CAMERA_TOP_VIEW_BETA = 0.01;
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

/** 判断实际 WebGL renderer 是否为软件实现，避免‘支持 WebGL’掩盖 CPU 回退。 */
function isSoftwareWebGLRenderer(renderer: string): boolean {
  return SOFTWARE_WEBGL_RENDERER_PATTERNS.some((pattern) => pattern.test(renderer));
}

/** 校验 Babylon 已连接真实 GPU，并记录可用于现场诊断的 WebGL 后端。 */
function assertHardwareAcceleratedWebGL(engine: Engine): void {
  const info = engine.getGlInfo();
  if (isSoftwareWebGLRenderer(info.renderer)) {
    throw new Error(
      '检测到软件 WebGL 渲染器（' + info.renderer + '）。编辑器要求显卡硬件加速，请更新显卡驱动或在系统图形设置中选择高性能 GPU。',
    );
  }

  console.info(
    '[Babylon] 硬件加速 WebGL 已启用：WebGL ' +
      engine.webGLVersion +
      '; vendor=' +
      info.vendor +
      '; renderer=' +
      info.renderer,
  );
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

/** 进入俯视时缓存的轨道位姿与角度限制，退出俯视时原样恢复。 */
type TopViewLockState = {
  alpha: number;
  beta: number;
  lowerAlphaLimit: number | null;
  upperAlphaLimit: number | null;
  lowerBetaLimit: number | null;
  upperBetaLimit: number | null;
};

/**
 * 进入俯视状态：缓存当前轨道位姿，切换到世界 Y 轴俯视方向并锁定旋转输入，
 * 俯视期间只允许平移和缩放，直到显式退出。
 */
function enterTopCameraView(camera: ArcRotateCamera): TopViewLockState {
  const lock: TopViewLockState = {
    alpha: camera.alpha,
    beta: camera.beta,
    lowerAlphaLimit: camera.lowerAlphaLimit,
    upperAlphaLimit: camera.upperAlphaLimit,
    lowerBetaLimit: camera.lowerBetaLimit,
    upperBetaLimit: camera.upperBetaLimit,
  };
  clearCameraMovement(camera);
  camera.alpha = EDITOR_CAMERA_TOP_VIEW_ALPHA;
  camera.beta = EDITOR_CAMERA_TOP_VIEW_BETA;
  camera.lowerAlphaLimit = EDITOR_CAMERA_TOP_VIEW_ALPHA;
  camera.upperAlphaLimit = EDITOR_CAMERA_TOP_VIEW_ALPHA;
  camera.lowerBetaLimit = EDITOR_CAMERA_TOP_VIEW_BETA;
  camera.upperBetaLimit = EDITOR_CAMERA_TOP_VIEW_BETA;
  return lock;
}

/** 退出俯视状态：先解除角度锁定再恢复进入前的轨道位姿，避免恢复值被钳制。 */
function exitTopCameraView(camera: ArcRotateCamera, lock: TopViewLockState): void {
  camera.lowerAlphaLimit = lock.lowerAlphaLimit;
  camera.upperAlphaLimit = lock.upperAlphaLimit;
  camera.lowerBetaLimit = lock.lowerBetaLimit;
  camera.upperBetaLimit = lock.upperBetaLimit;
  clearCameraMovement(camera);
  camera.alpha = lock.alpha;
  camera.beta = lock.beta;
}

/**
 * 把 ArcRotateCamera 的 radius 同步为正交投影边界，使正交模式下滚轮缩放
 * 保持与透视模式一致的取景范围和手感；宽高比跟随画布实时尺寸。
 */
function syncOrthographicBounds(camera: ArcRotateCamera, engine: Engine): void {
  const renderHeight = engine.getRenderHeight();
  const renderWidth = engine.getRenderWidth();
  if (renderHeight <= 0 || renderWidth <= 0) return;

  const halfHeight = Math.tan(camera.fov / 2) * camera.radius;
  const halfWidth = halfHeight * (renderWidth / renderHeight);
  camera.orthoTop = halfHeight;
  camera.orthoBottom = -halfHeight;
  camera.orthoRight = halfWidth;
  camera.orthoLeft = -halfWidth;
}

const CAMERA_FLY_KEY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC']);
/** 键盘平移速度：每秒移动距离占相机半径的比例，视野越远移动越快。 */
const CAMERA_FLY_SPEED_PER_RADIUS_SECOND = 0.6;

/**
 * 重映射相机鼠标键位：右键旋转、中键平移（Babylon 默认为左键旋转、右键平移）。
 * 左键的旋转映射被移除，左键仅用于拾取与 Gizmo；ctrl+左键平移保留，触摸与滚轮缩放不受影响。
 */
function remapEditorCameraMouseButtons(camera: ArcRotateCamera): void {
  const input = camera.movement.input;
  input.setInteraction('pointer', { button: 2 }, 'rotate');
  input.setInteraction('pointer', { button: 1 }, 'pan');
  for (const entry of input.getEntries('pointer', 'rotate', { button: 0 })) {
    input.inputMap.splice(input.inputMap.indexOf(entry), 1);
  }
}

/**
 * WASD 移动 + Space 升 C 降；焦点在输入控件上时不接管按键，返回清理函数。
 * W/S 沿视线方向移动（Unity 飞行模式），仰视升高、俯视降低；
 * forceHorizontalMove 返回 true 时（俯视 2D 模式）W/S 退化为水平移动，避免相机扎向地面。
 */
function createCameraFlyKeyControls(
  camera: ArcRotateCamera,
  engine: Engine,
  scene: Scene,
  forceHorizontalMove: () => boolean,
): () => void {
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

    const move = TmpVectors.Vector3[0].setAll(0);

    if (pressedKeys.has('KeyW') || pressedKeys.has('KeyS')) {
      const forward = TmpVectors.Vector3[1];
      if (forceHorizontalMove()) {
        // 俯视 2D 模式：沿屏幕上方水平移动（俯视时屏幕上方的水平投影即水平前方）
        camera.getDirectionToRef(Axis.Y, forward);
        forward.y = 0;
        if (forward.lengthSquared() < 1e-10) return;
        forward.normalize();
      } else {
        camera.getDirectionToRef(Axis.Z, forward);
      }
      if (pressedKeys.has('KeyW')) move.addInPlace(forward);
      else move.subtractInPlace(forward);
    }

    if (pressedKeys.has('KeyA') || pressedKeys.has('KeyD')) {
      // 相机无 roll，right 向量始终水平；极点退化时跳过平移
      const rightFlat = TmpVectors.Vector3[2];
      camera.getDirectionToRef(Axis.X, rightFlat);
      rightFlat.y = 0;
      if (rightFlat.lengthSquared() >= 1e-10) {
        rightFlat.normalize();
        if (pressedKeys.has('KeyD')) move.addInPlace(rightFlat);
        else move.subtractInPlace(rightFlat);
      }
    }

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
  options: BabylonViewportOptions = {},
): BabylonViewport {
  assertWebGLSupported();

  const requireHardwareAcceleration = options.requireHardwareAcceleration ?? false;
  let engine: Engine;
  try {
    const candidate = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: requireHardwareAcceleration,
    });
    try {
      if (requireHardwareAcceleration) assertHardwareAcceleratedWebGL(candidate);
      engine = candidate;
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  } catch (error) {
    const mode = requireHardwareAcceleration ? '硬件加速 WebGL' : 'WebGL';
    throw new Error('Babylon Engine ' + mode + ' 创建失败：' + getErrorMessage(error));
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
  if (options.allowCameraControl ?? true) {
    camera.attachControl(canvas, true);
    remapEditorCameraMouseButtons(camera);
  }
  camera.minZ = EDITOR_CAMERA_MIN_Z_METERS;
  camera.lowerRadiusLimit = EDITOR_CAMERA_MIN_RADIUS_METERS;
  camera.maxZ = SCENE_VIEW_DISTANCE_DEFAULT;
  camera.upperRadiusLimit = SCENE_VIEW_DISTANCE_DEFAULT;
  applyCameraSensitivity(camera, { zoom: 10, pan: 10, rotate: 10 });

  const light = new HemisphericLight('EditorLight', new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  const editorGround = createEditorGround(scene, {
    ...DEFAULT_EDITOR_GRID_SETTINGS,
    visible: options.showGrid ?? DEFAULT_EDITOR_GRID_SETTINGS.visible,
  });
  let topViewLock: TopViewLockState | null = null;
  let orthoBoundsObserver: Observer<Scene> | null = null;
  const disposeFlyControls = createCameraFlyKeyControls(camera, engine, scene, () => topViewLock !== null);
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
    /** 切换轨道/俯视朝向；俯视是持久状态，旋转输入被锁定，退出时恢复进入前的位姿。 */
    setCameraOrientation: (orientation) => {
      if (orientation === 'top') {
        topViewLock ??= enterTopCameraView(camera);
        return;
      }
      if (topViewLock) {
        exitTopCameraView(camera, topViewLock);
        topViewLock = null;
      }
    },
    /** 切换透视/正交投影；正交下把 radius 实时映射为投影边界，保持缩放取景一致。 */
    setCameraProjection: (projection) => {
      if (projection === 'orthographic') {
        syncOrthographicBounds(camera, engine);
        camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
        orthoBoundsObserver ??= scene.onBeforeRenderObservable.add(() => {
          syncOrthographicBounds(camera, engine);
        });
        return;
      }
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      if (orthoBoundsObserver) {
        scene.onBeforeRenderObservable.remove(orthoBoundsObserver);
        orthoBoundsObserver = null;
      }
    },
    setGridSettings: editorGround.setSettings,
    dispose: () => {
      disposed = true;
      disposeFlyControls();
      if (orthoBoundsObserver) {
        scene.onBeforeRenderObservable.remove(orthoBoundsObserver);
        orthoBoundsObserver = null;
      }
      engine.onContextLostObservable.remove(contextLostObserver);
      engine.onContextRestoredObservable.remove(contextRestoredObserver);
      editorGround.dispose();
      engine.dispose();
    },
  };
}
