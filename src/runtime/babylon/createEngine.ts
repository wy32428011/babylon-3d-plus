import './babylonSideEffects.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { ViewportBackend, ViewportBackendDecision } from './viewportBackend';
import { prepareGpuParticleRuntime } from './gpuParticleRuntime';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Axis } from '@babylonjs/core/Maths/math.axis.js';
import { TmpVectors, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';
import { EDITOR_FILL_LIGHT_INTENSITY, EDITOR_FILL_LIGHT_NAME } from './SceneShadowRuntime';
import { warmupLocalBabylonDecoders } from './localDecoderConfiguration';
import { registerKtx2WorkerEngine } from './ktx2WorkerDecoder';
import { ScenePreparationFrameBudget } from './scenePreparationFrameBudget';
import {
  createEditorGroundGrid,
  DEFAULT_EDITOR_GRID_SETTINGS,
  type EditorGridSettings,
} from './EditorGroundGrid';
import {
  DIGITAL_TWIN_CAMERA_CONTROL_STANDARD,
  applyDigitalTwinCameraSensitivity,
  attachDigitalTwinCameraControl,
  resolveDigitalTwinCameraFocusBeta,
  resolveDigitalTwinCameraFocusRadius,
  clampDigitalTwinCameraRadius,
  syncDigitalTwinCameraPanScale,
  setDigitalTwinCameraDepthPrecision,
} from './cameraControlStandard';
import type { Vector3Data } from '../../editor/model/math';
import {
  SCENE_VIEW_DISTANCE_DEFAULT,
  sanitizeSceneViewDistance,
  type SceneCameraOrientation,
  type SceneCameraPose,
  type SceneCameraProjection,
  type SceneCameraSettings,
  type SceneSensitivitySettings,
  type StandardSceneCameraOrientation,
} from '../../editor/model/SceneDocument';
import {
  ArcRotateCameraViewController,
  EDITOR_CAMERA_DEFAULT_ALPHA,
  EDITOR_CAMERA_DEFAULT_BETA,
  EDITOR_CAMERA_DEFAULT_RADIUS,
  type CameraNavigationMode,
  type CameraTransitionCancelReason,
  type CameraViewApplicationOptions,
  type CameraViewTransitionOptions,
} from './ArcRotateCameraViewController';
import { createBackgroundFrameRequester } from './backgroundFrameRequester';
import { AdaptiveResolutionController } from './AdaptiveResolutionController';
import type { Observer } from '@babylonjs/core/Misc/observable.js';

export { EDITOR_GRID_CELL_SIZES, DEFAULT_EDITOR_GRID_SETTINGS } from './EditorGroundGrid';
export { applySavedCameraPose } from './ArcRotateCameraViewController';
export type { EditorGridCellSize, EditorGridSettings } from './EditorGroundGrid';

/** 编辑器视口的当前朝向状态；可在显式保存视角时写入场景。 */
export type CameraOrientation = SceneCameraOrientation;
export type StandardCameraOrientation = StandardSceneCameraOrientation;
/** 编辑器视口的当前投影方式；可在显式保存视角时写入场景。 */
export type CameraProjection = SceneCameraProjection;

export type EditorWorldBounds = {
  center: Vector3Data;
  radiusMeters: number;
  /** 可选的模型专用透视取景；未声明距离上限时沿用普通模型 3m 规则。 */
  focusView?: Pick<SceneCameraPose, 'target' | 'alpha' | 'beta'> & { maxRadiusMeters?: number };
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
  /** 轨道视口可显式启用中距离深度精度补偿，不依赖鼠标控制权限；人物漫游接管时关闭。 */
  depthPrecisionCompensation?: boolean;
  /** 显式不透明画布选项；缺省仍保留原透明上下文，供 Viewer 单独验收后选择。 */
  opaqueCanvas?: boolean;
  /** 显式运动降分辨率，静止后恢复；缺省关闭，不改变脚本或MQTT节拍。 */
  adaptiveResolution?: boolean;
  /** 设为 true 时要求真实硬件 WebGL，并拒绝 SwiftShader、WARP 等软件 renderer 回退。 */
  requireHardwareAcceleration?: boolean;
  /** 可选日志回调，用于向上层控制台输出 GPU renderer 诊断信息。 */
  onLog?: (message: string) => void;
  /** 创建视口时立即应用的场景灵敏度，避免首次 attach/resize 使用默认 10。 */
  initialSensitivity?: SceneSensitivitySettings;
  /** 发布 Viewer 使用 Worker 帧节拍，避免隐藏标签暂停基于渲染帧的运行逻辑。 */
  keepRenderingInBackground?: boolean;
  /** 仅在不可交互的准备蒙版下节流绘制；就绪后立即恢复完整渲染频率。 */
  isScenePreparing?: () => boolean;
  /** 默认 WebGL；Editor/Player 用同一文档兼容门决定显式 WebGPU 请求。 */
  backendDecision?: ViewportBackendDecision;
  signal?: AbortSignal;
  /** 由 React 换新画布，不能在已绑定 WebGPU context 的同一 DOM canvas 上创建 WebGL。 */
  replaceCanvas?: (previous: HTMLCanvasElement, signal: AbortSignal) => Promise<HTMLCanvasElement>;
};

export type BabylonFocusOptions = CameraViewTransitionOptions & {
  /** 普通模型默认为 3m；环境等特殊目标可传入 Infinity。 */
  maxRadiusMeters?: number;
  /** 透视模式下普通模型默认使用斜上方 45°；正交模式及特殊目标保留当前观察方向。 */
  useModelFocusAngle?: boolean;
  /** 聚焦距离倍率，>1 时比恰好容纳更远一些（点击事件聚焦默认 1.4，避免贴脸）。 */
  radiusScale?: number;
};

export type BabylonViewport = {
  engine: AbstractEngine;
  canvas: HTMLCanvasElement;
  backend: ViewportBackend;
  fallbackReason: string | null;
  scene: Scene;
  camera: ArcRotateCamera;
  focusOnBounds: (bounds: EditorWorldBounds, options?: BabylonFocusOptions) => void;
  cancelCameraTransition: (reason?: CameraTransitionCancelReason) => boolean;
  setViewDistance: (meters: number) => void;
  setSensitivity: (settings: SceneSensitivitySettings) => void;
  /** 在轨道相机与人物漫游之间移交输入所有权。 */
  setCameraControlsEnabled: (enabled: boolean) => void;
  /** 按画布实际尺寸刷新引擎，并重新应用场景灵敏度，避免小画布把平移放大。 */
  resize: () => void;
  getCameraPose: () => SceneCameraPose;
  getCameraView: () => ReturnType<ArcRotateCameraViewController['getCameraView']>;
  applyCameraPose: (pose: SceneCameraPose | null, options?: CameraViewTransitionOptions) => void;
  applyCameraView: (settings: SceneCameraSettings, options?: CameraViewApplicationOptions) => void;
  setCameraOrientation: (orientation: CameraOrientation, options?: CameraViewTransitionOptions) => void;
  setCameraProjection: (projection: CameraProjection) => void;
  setGridSettings: (settings: EditorGridSettings) => void;
  setAdaptiveResolution: (enabled: boolean) => void;
  /** 宿主/DPR更新基础像素比，不覆盖本控制器临时运动等级。 */
  setBaseHardwareScalingLevel: (level: number) => void;
  getAdaptiveResolutionState: () => ReturnType<AdaptiveResolutionController['getSnapshot']> | null;
  dispose: () => void;
};

const SOFTWARE_WEBGL_RENDERER_PATTERNS = [
  /swiftshader/i,
  /llvmpipe/i,
  /lavapipe/i,
  /softpipe/i,
  /software (?:adapter|rasterizer|renderer)/i,
  /microsoft basic render driver/i,
  /\bwarp\b/i,
];
const UNKNOWN_WEBGL_RENDERER_PATTERN = /^unknown(?:\s+renderer)?$/i;
/** 将未知异常转换成可读消息，便于向上层 UI 呈现 Babylon 初始化失败原因。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判断实际 WebGL renderer 是否为软件实现，避免‘支持 WebGL’掩盖 CPU 回退。 */
function isSoftwareWebGLRenderer(renderer: string): boolean {
  return SOFTWARE_WEBGL_RENDERER_PATTERNS.some((pattern) => pattern.test(renderer));
}

/** 校验 Babylon 已连接真实 GPU，并记录可用于现场诊断的 WebGL 后端。 */
function assertHardwareAcceleratedWebGL(engine: Engine, onLog?: (message: string) => void): void {
  const info = engine.getGlInfo();
  const renderer = info.renderer.trim();
  if (!renderer || UNKNOWN_WEBGL_RENDERER_PATTERN.test(renderer)) {
    throw new Error('无法识别 WebGL renderer，当前 3D 视口无法确认硬件 GPU，已阻止加载。');
  }
  if (isSoftwareWebGLRenderer(renderer)) {
    throw new Error(
      '检测到软件 WebGL 渲染器（' + renderer + '）。当前 3D 视口要求显卡硬件加速，禁止使用软件 renderer。',
    );
  }

  const message =
    '[Babylon] 硬件加速 WebGL 已启用：WebGL ' +
    engine.webGLVersion +
    '; vendor=' +
    info.vendor +
    '; renderer=' +
    renderer;
  console.info(message);
  onLog?.(message);
}

/** 在创建 Babylon Engine 前检查 WebGL 能力，避免 3D 视口静默白屏。 */
function assertWebGLSupported(): void {
  if (Engine.isSupported()) return;

  throw new Error('当前运行环境不支持 WebGL，无法创建 Babylon 3D 视口。');
}

/**
 * 仅开发环境生效的临时逃生门：本机无可用 GPU（如虚拟机、远程桌面）时，
 * 在 devtools 执行 localStorage.setItem('editor.allowSoftwareWebGL','1') 后刷新，允许软件 WebGL 回退。
 * 发布构建中 import.meta.env.DEV 恒为 false，此路径被静态消除，不影响发布结果。
 */
export function isSoftwareWebGLFallbackAllowed(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return globalThis.localStorage?.getItem('editor.allowSoftwareWebGL') === '1';
  } catch {
    return false;
  }
}

/**
 * 根据包围球、相机 FOV 与实际画布宽高比计算几何取景距离。
 * 旧的固定 2.2 倍半径在窄画布或超长场景中会把左右边缘裁出视野；这里取水平/垂直较窄半角，
 * 先得到带少量编辑边距的完整显示距离；普通模型再由聚焦规则硬钳制到 3m，非模型目标保留原有完整取景规则。
 */
function getFocusCameraRadius(
  bounds: EditorWorldBounds,
  camera: ArcRotateCamera,
  engine: AbstractEngine,
  maxRadiusMeters?: number,
  useModelFocusAngle: boolean = true,
): number {
  const radiusMeters = Number.isFinite(bounds.radiusMeters) ? Math.max(bounds.radiusMeters, 0.5) : 1;
  const renderWidth = Math.max(1, engine.getRenderWidth());
  const renderHeight = Math.max(1, engine.getRenderHeight());
  const aspectRatio = renderWidth / renderHeight;
  const configuredHalfFov = Math.min(Math.PI / 2 - 0.001, Math.max(0.01, camera.fov / 2));
  const verticalHalfFov = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
    ? Math.atan(Math.tan(configuredHalfFov) / aspectRatio)
    : configuredHalfFov;
  const horizontalHalfFov = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
    ? configuredHalfFov
    : Math.atan(Math.tan(configuredHalfFov) * aspectRatio);
  const limitingHalfFov = Math.max(0.01, Math.min(verticalHalfFov, horizontalHalfFov));
  const fitDistance = radiusMeters / Math.sin(limitingHalfFov);
  if (!useModelFocusAngle) {
    const requestedRadiusMeters = Math.max(fitDistance * 1.08, 2.5);
    return clampDigitalTwinCameraRadius(Math.min(maxRadiusMeters ?? Number.POSITIVE_INFINITY, requestedRadiusMeters));
  }
  return resolveDigitalTwinCameraFocusRadius(fitDistance * 1.08, bounds.center.y, maxRadiusMeters);
}

/** 只计算聚焦位姿，供同步聚焦与相机控制器动画共用同一套距离和位置规则。 */
function getFocusCameraPose(
  camera: ArcRotateCamera,
  engine: AbstractEngine,
  bounds: EditorWorldBounds,
  maxRadiusMeters?: number,
  useModelFocusAngle: boolean = true,
): SceneCameraPose {
  const modelView = useModelFocusAngle ? bounds.focusView : undefined;
  const target = modelView ? { ...modelView.target } : { ...bounds.center };
  const radius = getFocusCameraRadius({ ...bounds, center: target }, camera, engine, maxRadiusMeters ?? modelView?.maxRadiusMeters, useModelFocusAngle);
  return {
    alpha: modelView?.alpha ?? camera.alpha,
    beta: modelView?.beta ?? (useModelFocusAngle ? resolveDigitalTwinCameraFocusBeta() : camera.beta),
    radius,
    target,
  };
}


/**
 * 透视默认聚焦包围盒中心并斜上方 45° 观察；模型可指定目标、角度和距离上限（普通 3m、堆垛机 8m）。正交保持当前方向。
 */
export function focusArcRotateCameraOnBounds(
  camera: ArcRotateCamera,
  engine: AbstractEngine,
  bounds: EditorWorldBounds,
  maxRadiusMeters?: number,
  useModelFocusAngle: boolean = true,
): void {
  const shouldUseModelFocusAngle = camera.mode !== Camera.ORTHOGRAPHIC_CAMERA && useModelFocusAngle;
  const pose = getFocusCameraPose(camera, engine, bounds, maxRadiusMeters, shouldUseModelFocusAngle);
  const target = new Vector3(pose.target.x, pose.target.y, pose.target.z);
  camera.setTarget(target);
  camera.alpha = pose.alpha;
  camera.beta = pose.beta;
  camera.radius = pose.radius;
  syncDigitalTwinCameraPanScale(camera);
}

/**
 * 通过统一相机控制器执行聚焦；无选项时保持编辑器同步行为，并解除此前的六面标准视角锁。
 */
export function focusArcRotateCameraViewOnBounds(
  cameraViewController: ArcRotateCameraViewController,
  camera: ArcRotateCamera,
  engine: AbstractEngine,
  bounds: EditorWorldBounds,
  options?: BabylonFocusOptions,
): void {
  // 正交投影只允许平移观察中心和缩放，不能因模型聚焦切换方向或解除六面硬锁。
  const preserveOrientation =
    camera.mode === Camera.ORTHOGRAPHIC_CAMERA
    || options?.useModelFocusAngle === false;
  const useModelFocusAngle = !preserveOrientation;
  const pose = getFocusCameraPose(camera, engine, bounds, options?.maxRadiusMeters, useModelFocusAngle);
  const radiusScale = options?.radiusScale;
  if (typeof radiusScale === 'number' && Number.isFinite(radiusScale) && radiusScale > 0) {
    pose.radius *= radiusScale;
  }
  const transitionOptions: CameraViewTransitionOptions = options
    ? {
        animate: options.animate,
        durationMs: options.durationMs,
        onCompleted: options.onCompleted,
        onCancelled: options.onCancelled,
      }
    : { animate: false };
  if (preserveOrientation) {
    cameraViewController.applyCameraPosePreservingOrientation(pose, transitionOptions);
    return;
  }
  cameraViewController.applyCameraPose(pose, transitionOptions);
}

const CAMERA_FLY_KEY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC']);
/** 键盘平移速度：每秒移动距离占相机半径的比例，视野越远移动越快。 */
const CAMERA_FLY_SPEED_PER_RADIUS_SECOND = 0.6;
/** 键盘平移最小速度（m/s），防止极端近距离时 WASD 移动过于迟缓。 */
const CAMERA_FLY_MIN_SPEED_METERS_PER_SECOND = 0.5;

/**
 * WASD 移动 + Space 升 C 降；焦点在输入控件上时不接管按键，返回清理函数。
 * 自由轨道下沿用 Unity 飞行语义；六面硬锁下改为屏幕平面二维导航，动画期间暂停输入。
 */
function createCameraFlyKeyControls(
  camera: ArcRotateCamera,
  engine: AbstractEngine,
  scene: Scene,
  getNavigationMode: () => CameraNavigationMode,
  isEnabled: () => boolean,
): { clear: () => void; dispose: () => void } {
  const pressedKeys = new Set<string>();

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isEnabled()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!CAMERA_FLY_KEY_CODES.has(event.code)) return;
    const active = document.activeElement;
    if (active && active !== document.body && !(active instanceof HTMLCanvasElement)) return;
    // 人物预览等独立画布拥有自己的键盘输入，不能同时推动底层编辑器相机。
    if (active instanceof HTMLCanvasElement && active !== engine.getRenderingCanvas()) return;
    const navigationMode = getNavigationMode();
    if (navigationMode === 'transition' || (navigationMode === 'standard' && (event.code === 'Space' || event.code === 'KeyC'))) {
      event.preventDefault();
      return;
    }
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
    if (!isEnabled() || pressedKeys.size === 0) return;
    const navigationMode = getNavigationMode();
    if (navigationMode === 'transition') return;

    const move = TmpVectors.Vector3[0].setAll(0);

    if (pressedKeys.has('KeyW') || pressedKeys.has('KeyS')) {
      const vertical = TmpVectors.Vector3[1];
      camera.getDirectionToRef(navigationMode === 'standard' ? Axis.Y : Axis.Z, vertical);
      if (navigationMode === 'standard') vertical.normalize();
      if (pressedKeys.has('KeyW')) move.addInPlace(vertical);
      else move.subtractInPlace(vertical);
    }

    if (pressedKeys.has('KeyA') || pressedKeys.has('KeyD')) {
      const right = TmpVectors.Vector3[2];
      camera.getDirectionToRef(Axis.X, right);
      if (navigationMode === 'orbit') right.y = 0;
      if (right.lengthSquared() >= 1e-10) {
        right.normalize();
        if (pressedKeys.has('KeyD')) move.addInPlace(right);
        else move.subtractInPlace(right);
      }
    }

    if (navigationMode === 'orbit') {
      if (pressedKeys.has('Space')) move.y += 1;
      if (pressedKeys.has('KeyC')) move.y -= 1;
    }
    if (move.lengthSquared() === 0) return;

    const deltaSeconds = engine.getDeltaTime() / 1000;
    const speed = Math.max(CAMERA_FLY_MIN_SPEED_METERS_PER_SECOND, camera.radius * CAMERA_FLY_SPEED_PER_RADIUS_SECOND);
    move.normalize().scaleInPlace(speed * deltaSeconds);
    camera.target.addInPlace(move);
  });

  return {
    clear: handleWindowBlur,
    dispose: () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur, true);
      scene.onBeforeRenderObservable.remove(observer);
    },
  };
}

const canvasInitializations = new WeakMap<HTMLCanvasElement, Promise<void>>();

/** StrictMode/快速切换可能在前一初始化尚未结算时重入；同一画布必须串行释放和创建。 */
async function initializeOnCanvas<T extends AbstractEngine>(
  canvas: HTMLCanvasElement,
  signal: AbortSignal | undefined,
  initialize: () => T | Promise<T>,
): Promise<T> {
  const previous = canvasInitializations.get(canvas);
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  canvasInitializations.set(canvas, completed);
  try {
    if (previous) await previous;
    signal?.throwIfAborted();
    const engine = await initialize();
    try { signal?.throwIfAborted(); } catch (error) { engine.dispose(); throw error; }
    return engine;
  } finally {
    release();
    if (canvasInitializations.get(canvas) === completed) canvasInitializations.delete(canvas);
  }
}

function assertHardwareAcceleratedBackend(engine: AbstractEngine, onLog?: (message: string) => void): void {
  if (engine instanceof Engine) { assertHardwareAcceleratedWebGL(engine, onLog); return; }
  // AbstractEngine 没有 getInfo 声明；只读取具体后端确实公开的诊断能力，不伪装为 Engine。
  const getInfo: unknown = Reflect.get(engine, 'getInfo');
  const info: unknown = typeof getInfo === 'function' ? getInfo.call(engine) : null;
  const renderer: unknown = info && typeof info === 'object' ? Reflect.get(info, 'renderer') : null;
  if (typeof renderer !== 'string' || !renderer.trim() || UNKNOWN_WEBGL_RENDERER_PATTERN.test(renderer.trim()) || isSoftwareWebGLRenderer(renderer)) {
    throw new Error('WebGPU 未提供可确认的硬件 GPU renderer，保留硬件 WebGL 路径。');
  }
  onLog?.(`[Babylon] 硬件加速 WebGPU 已启用：renderer=${renderer}`);
}

function createWebGLViewportEngine(canvas: HTMLCanvasElement, options: BabylonViewportOptions): Engine {
  const requireHardwareAcceleration = options.requireHardwareAcceleration ?? false;
  if (!requireHardwareAcceleration) assertWebGLSupported();
  try {
    const candidate = new Engine(canvas, true, {
      alpha: options.opaqueCanvas !== true,
      preserveDrawingBuffer: false,
      stencil: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: requireHardwareAcceleration,
      desynchronized: false,
    });
    try {
      if (requireHardwareAcceleration) assertHardwareAcceleratedWebGL(candidate, options.onLog);
      return candidate;
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  } catch (error) {
    const mode = requireHardwareAcceleration ? '硬件加速 WebGL' : 'WebGL';
    const guidance = requireHardwareAcceleration
      ? ' 请确认浏览器或桌面应用已启用硬件加速并重启，同时检查显卡驱动与系统图形策略是否允许当前程序使用 GPU。'
      : '';
    throw new Error('Babylon Engine ' + mode + ' 创建失败：' + getErrorMessage(error) + guidance, { cause: error });
  }
}

/** 保留旧调用方的同步 WebGL 入口；显式 WebGPU 和可选异步预热使用 Async 入口。 */
export function createBabylonViewport(
  canvas: HTMLCanvasElement,
  onRuntimeStatus?: BabylonViewportRuntimeStatusCallback,
  options: BabylonViewportOptions = {},
): BabylonViewport {
  options.signal?.throwIfAborted();
  if (options.backendDecision?.backend === 'webgpu') throw new Error('WebGPU 必须通过 createBabylonViewportAsync 初始化。');
  const engine = createWebGLViewportEngine(canvas, options);
  try { return createViewportResources(canvas, engine, onRuntimeStatus, options, options.backendDecision?.reasons.join('；') || null); }
  catch (error) { engine.dispose(); throw error; }
}

export async function createBabylonViewportAsync(
  initialCanvas: HTMLCanvasElement,
  onRuntimeStatus?: BabylonViewportRuntimeStatusCallback,
  options: BabylonViewportOptions = {},
): Promise<BabylonViewport> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const decision = options.backendDecision;
  let canvas = initialCanvas;
  let engine: AbstractEngine | null = null;
  let fallbackReason = decision?.reasons.join('；') || null;
  if (decision?.requested === 'webgpu' && decision.backend === 'webgl') {
    options.onLog?.(`[Babylon] WebGPU 请求已回退完整 WebGL：${fallbackReason}`);
  }
  if (decision?.backend === 'webgpu') {
    let attemptedInitialization = false;
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('当前环境未提供 WebGPU（需要安全上下文及可用的 GPU adapter）。');
      const { createWebGPUViewportEngine } = await import('./webgpuViewportEngine');
      signal?.throwIfAborted();
      attemptedInitialization = true;
      engine = await initializeOnCanvas(canvas, signal, () => createWebGPUViewportEngine(canvas, options.opaqueCanvas === true, signal));
      if (options.requireHardwareAcceleration) assertHardwareAcceleratedBackend(engine, options.onLog);
    } catch (error) {
      if (engine) { engine.dispose(); engine = null; }
      signal?.throwIfAborted();
      fallbackReason = getErrorMessage(error);
      options.onLog?.(`[Babylon] WebGPU 初始化失败，回退完整 WebGL：${fallbackReason}`);
      if (attemptedInitialization) {
        if (!options.replaceCanvas || !signal) throw new Error('WebGPU 回退需要宿主提供新的 canvas。', { cause: error });
        // 只在这一处换画布并重试一次 WebGL；不重放宿主配置、资源清单、MQTT 或开场流程。
        canvas = await options.replaceCanvas(canvas, signal);
      }
    }
  }
  if (!engine) engine = await initializeOnCanvas(canvas, signal, () => createWebGLViewportEngine(canvas, options));
  let viewport: BabylonViewport | null = null;
  const disposeAbortedViewport = () => viewport?.dispose();
  try {
    signal?.throwIfAborted();
    options.onLog?.(`[Babylon] 当前渲染后端：${engine.isWebGPU ? 'WebGPU' : 'WebGL'}`);
    viewport = createViewportResources(canvas, engine, onRuntimeStatus, options, fallbackReason);
    // 预热尚未结算时宿主还未取得 viewport；取消必须立即释放旧渲染循环，不能等到模块下载结束。
    signal?.addEventListener('abort', disposeAbortedViewport, { once: true });
    signal?.throwIfAborted();
    await prepareGpuParticleRuntime(viewport.scene, new URLSearchParams(globalThis.location?.search ?? '').get('gpuParticles') === '1');
    signal?.throwIfAborted();
    return viewport;
  } catch (error) {
    if (viewport) viewport.dispose();
    else engine.dispose();
    throw error;
  } finally {
    signal?.removeEventListener('abort', disposeAbortedViewport);
  }
}

function createViewportResources(
  canvas: HTMLCanvasElement,
  engine: AbstractEngine,
  onRuntimeStatus: BabylonViewportRuntimeStatusCallback | undefined,
  options: BabylonViewportOptions,
  fallbackReason: string | null,
): BabylonViewport {
  const requireHardwareAcceleration = options.requireHardwareAcceleration ?? false;
  const backend: ViewportBackend = engine.isWebGPU ? 'webgpu' : 'webgl';
  registerKtx2WorkerEngine(engine);
  const backgroundFrameRequester = options.keepRenderingInBackground
    ? createBackgroundFrameRequester()
    : null;
  if (backgroundFrameRequester) {
    engine.customAnimationFrameRequester = backgroundFrameRequester;
    engine.renderEvenInBackground = true;
  }
  if (engine instanceof Engine && !requireHardwareAcceleration && isSoftwareWebGLFallbackAllowed()) {
    const message = '[Babylon] 已按开发环境配置允许软件 WebGL 回退：renderer=' + engine.getGlInfo().renderer;
    console.warn(message);
    options.onLog?.(message);
  }

  const scene = new Scene(engine);
  scene.clearColor.set(0.08, 0.08, 0.09, 1);
  void warmupLocalBabylonDecoders();

  const camera = new ArcRotateCamera(
    'EditorCamera',
    EDITOR_CAMERA_DEFAULT_ALPHA,
    EDITOR_CAMERA_DEFAULT_BETA,
    EDITOR_CAMERA_DEFAULT_RADIUS,
    Vector3.Zero(),
    scene,
  );
  const allowCameraControl = options.allowCameraControl ?? true;
  // 禁止交互的发布页面仍需相同深度精度，显示精度不受鼠标控制权限影响。
  setDigitalTwinCameraDepthPrecision(camera, options.depthPrecisionCompensation === true);
  const defaultSensitivity = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.sensitivity.default;
  let cameraSensitivity: SceneSensitivitySettings = options.initialSensitivity
    ? { ...options.initialSensitivity }
    : {
      zoom: defaultSensitivity,
      pan: defaultSensitivity,
      rotate: defaultSensitivity,
    };
  let cameraControlsEnabled = allowCameraControl;
  let cameraControlAttached = false;
  const attachCameraControl = (): void => {
    if (!allowCameraControl || !cameraControlsEnabled || cameraControlAttached) return;
    attachDigitalTwinCameraControl(camera, cameraSensitivity);
    cameraControlAttached = true;
  };
  const detachCameraControl = (): void => {
    if (!cameraControlAttached) return;
    camera.detachControl();
    cameraControlAttached = false;
  };
  attachCameraControl();
  camera.maxZ = SCENE_VIEW_DISTANCE_DEFAULT;
  camera.upperRadiusLimit = SCENE_VIEW_DISTANCE_DEFAULT;

  /** 半球补光不投影；SceneShadowRuntime 在主阴影光就绪后会压低强度。 */
  const light = new HemisphericLight(EDITOR_FILL_LIGHT_NAME, new Vector3(0, 1, 0), scene);
  light.intensity = EDITOR_FILL_LIGHT_INTENSITY;

  const editorGround = createEditorGroundGrid(scene, camera, engine, {
    ...DEFAULT_EDITOR_GRID_SETTINGS,
    visible: options.showGrid ?? DEFAULT_EDITOR_GRID_SETTINGS.visible,
  });
  const cameraViewController = new ArcRotateCameraViewController(camera, engine, scene, {
    suspendCameraControl: detachCameraControl,
    resumeCameraControl: attachCameraControl,
  });
  const cameraPanScaleObserver = scene.onBeforeRenderObservable.add(() => {
    syncDigitalTwinCameraPanScale(camera);
  });
  const flyControls = createCameraFlyKeyControls(
    camera,
    engine,
    scene,
    () => cameraViewController.getNavigationMode(),
    () => cameraControlsEnabled,
  );
  let disposed = false;
  let adaptiveResolution: AdaptiveResolutionController | null = null;
  let observedCamera: Camera | null = null;
  let cameraMotionObserver: Observer<Camera> | null = null;
  let cameraMoved = false;
  const clearAdaptiveCamera = (): void => {
    if (cameraMotionObserver) observedCamera?.onViewMatrixChangedObservable.remove(cameraMotionObserver);
    observedCamera = null; cameraMotionObserver = null; cameraMoved = false;
  };
  const setAdaptiveResolution = (enabled: boolean): void => {
    if (disposed) return;
    if (!enabled) { adaptiveResolution?.dispose(); adaptiveResolution = null; clearAdaptiveCamera(); return; }
    if (!adaptiveResolution) {
      adaptiveResolution = new AdaptiveResolutionController(engine, {
        onError: error => options.onLog?.(`运动分辨率控制已暂停：${getErrorMessage(error)}`),
      });
    }
  };
  const setBaseHardwareScalingLevel = (level: number): void => {
    if (!Number.isFinite(level) || level <= 0) throw new RangeError('基础渲染缩放等级无效。');
    const state = adaptiveResolution?.getSnapshot();
    if (state && Math.abs(state.baselineLevel - level) <= .001) return;
    const reenable = adaptiveResolution !== null;
    if (reenable) setAdaptiveResolution(false);
    // 保留Viewer原DPR桥接的1e-3容差，关闭自适应时也不引入无意义的resize。
    if (Math.abs(engine.getHardwareScalingLevel() - level) > .001) engine.setHardwareScalingLevel(level);
    // 明确的宿主基础配置变更开启新周期；同步观察者抢占时不重新接管。
    if (reenable && engine.getHardwareScalingLevel() === level) setAdaptiveResolution(true);
  };
  setAdaptiveResolution(options.adaptiveResolution === true);
  let contextLost = false;
  let renderFailed = false;

  /** 在 Babylon 已确认 WebGL 上下文丢失后暂停绘制，并把恢复等待状态上报给外层面板。 */
  const contextLostObserver = engine.onContextLostObservable.add(() => {
    contextLost = true;
    onRuntimeStatus?.({
      type: 'context-lost',
      message: `Scene View ${engine.isWebGPU ? 'WebGPU 设备' : 'WebGL 上下文'}已丢失，正在自动恢复。`,
    });
  });

  /** 上下文恢复后重新校验 renderer，避免 GPU 异常后静默切换到软件后端。 */
  const contextRestoredObserver = engine.onContextRestoredObservable.add(() => {
    try {
      if (requireHardwareAcceleration) assertHardwareAcceleratedBackend(engine, options.onLog);
    } catch (error) {
      contextLost = true;
      renderFailed = true;
      onRuntimeStatus?.({
        type: 'render-error',
        message: `Scene View 硬件加速 ${engine.isWebGPU ? 'WebGPU' : 'WebGL'} 恢复失败：${getErrorMessage(error)}`,
        error,
      });
      return;
    }

    registerKtx2WorkerEngine(engine);
    if (adaptiveResolution) {
      adaptiveResolution.onContextRestored();
      adaptiveResolution.update({ enabled: false, moving: false, now: performance.now() });
      cameraMoved = false;
    }
    contextLost = false;
    renderFailed = false;
    onRuntimeStatus?.({
      type: 'context-restored',
      message: `Scene View ${engine.isWebGPU ? 'WebGPU 设备' : 'WebGL 上下文'}已恢复。`,
    });
  });

  const preparationFrameBudget = new ScenePreparationFrameBudget();
  engine.runRenderLoop(() => {
    if (disposed || contextLost) return;
    if (!preparationFrameBudget.shouldRender(options.isScenePreparing?.() === true, performance.now())) return;

    try {
      if (adaptiveResolution) {
        const activeCamera = scene.activeCamera;
        if (activeCamera !== observedCamera) {
          clearAdaptiveCamera(); observedCamera = activeCamera; cameraMoved = true;
          cameraMotionObserver = activeCamera?.onViewMatrixChangedObservable.add(() => { cameraMoved = true; }) ?? null;
        }
        // 只观察相机自然更新事件，不额外计算视图/世界矩阵；首个运动帧后开始降采样。
        adaptiveResolution.update({ enabled: true, moving: cameraMoved, now: performance.now() });
        cameraMoved = false;
      }
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
    canvas,
    backend,
    fallbackReason,
    scene,
    camera,
    focusOnBounds: (bounds, transitionOptions) => {
      focusArcRotateCameraViewOnBounds(cameraViewController, camera, engine, bounds, transitionOptions);
    },
    cancelCameraTransition: (reason) => cameraViewController.cancelTransition(reason),
    setViewDistance: (meters) => {
      const viewDistance = sanitizeSceneViewDistance(meters);
      camera.maxZ = viewDistance;
      camera.upperRadiusLimit = viewDistance;
      camera.radius = clampDigitalTwinCameraRadius(Math.min(camera.radius, viewDistance));
      syncDigitalTwinCameraPanScale(camera);
    },
    setSensitivity: (settings) => {
      cameraSensitivity = { ...settings };
      applyDigitalTwinCameraSensitivity(camera, cameraSensitivity);
    },
    setCameraControlsEnabled: (enabled) => {
      cameraControlsEnabled = allowCameraControl && enabled;
      setDigitalTwinCameraDepthPrecision(camera, enabled && options.depthPrecisionCompensation === true);
      if (cameraControlsEnabled) attachCameraControl();
      else {
        flyControls.clear();
        detachCameraControl();
      }
    },
    resize: () => {
      engine.resize();
      applyDigitalTwinCameraSensitivity(camera, cameraSensitivity);
    },
    getCameraPose: () => cameraViewController.getCameraPose(),
    getCameraView: () => cameraViewController.getCameraView(),
    applyCameraPose: (pose, transitionOptions) => {
      cameraViewController.applyCameraPose(pose, transitionOptions);
    },
    applyCameraView: (settings, transitionOptions) => {
      cameraViewController.applyCameraView(settings, transitionOptions);
    },
    setCameraOrientation: (orientation, transitionOptions) => {
      cameraViewController.setCameraOrientation(orientation, transitionOptions);
    },
    setCameraProjection: (projection) => {
      cameraViewController.setCameraProjection(projection);
    },
    setGridSettings: editorGround.setSettings,
    setAdaptiveResolution,
    setBaseHardwareScalingLevel,
    getAdaptiveResolutionState: () => adaptiveResolution?.getSnapshot() ?? null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      adaptiveResolution?.dispose(); adaptiveResolution = null; clearAdaptiveCamera();
      flyControls.dispose();
      scene.onBeforeRenderObservable.remove(cameraPanScaleObserver);
      cameraViewController.dispose();
      engine.onContextLostObservable.remove(contextLostObserver);
      engine.onContextRestoredObservable.remove(contextRestoredObserver);
      editorGround.dispose();
      engine.dispose();
      backgroundFrameRequester?.dispose();
    },
  };
}
