import { Camera, type ArcRotateCamera } from '@babylonjs/core';

/** 数字孪生相机灵敏度；数值只调整运动幅度，不允许改变原有键位。 */
export type DigitalTwinCameraSensitivity = {
  zoom: number;
  pan: number;
  rotate: number;
};

/** 相机位姿的最小结构，用于编辑器拾取与视角拖拽冲突判断。 */
export type DigitalTwinCameraPose = {
  alpha: number;
  beta: number;
  radius: number;
  target: { x: number; y: number; z: number };
};

/**
 * 数字孪生相机运动幅度标准 V2。
 * 键位沿用编辑器既有习惯；编辑态、运行预览和发布 Viewer 只统一旋转、平移与缩放幅度。
 */
export const DIGITAL_TWIN_CAMERA_CONTROL_STANDARD = {
  version: 2,
  pointer: {
    selectButton: 0,
    rotateButton: 2,
    panButton: 1,
    alternatePanButton: 0,
    alternatePanRequiresCtrl: true,
  },
  rotation: {
    degreesPerPixelAtDefault: 0.3,
    radiansPerPixelAtDefault: Math.PI / 600,
  },
  pan: {
    screenPixelsPerPointerPixelAtDefault: 1,
  },
  wheel: {
    interaction: 'zoom',
    radiusPercentagePerStepAtDefault: 0.05,
    zoomToMouseLocation: false,
  },
  zoom: {
    minRadiusMeters: 0.2,
    minZMeters: 0.02,
    perspectiveMinZRadiusRatio: 0.001,
  },
  focus: {
    minCameraHeightMeters: 0.05,
    maxRadiusMeters: 3,
    preferredRadiusMeters: 2,
    defaultBetaRadians: Math.PI / 4,
  },
  sensitivity: {
    min: 1,
    max: 20,
    default: 10,
  },
  selection: {
    clickTolerancePx: 4,
    poseChangeEpsilon: 1e-6,
  },
} as const;

const panSensitivityMultiplierByCamera = new WeakMap<ArcRotateCamera, number>();

function sanitizeSensitivityValue(value: number): number {
  const { min, max, default: fallback } = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.sensitivity;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function getSensitivityMultiplier(value: number): number {
  return sanitizeSensitivityValue(value) / DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.sensitivity.default;
}

/** 将半径限制到统一近距保护范围，避免缩放越过观察中心或被近裁剪面裁空。 */
export function clampDigitalTwinCameraRadius(radiusMeters: number): number {
  if (!Number.isFinite(radiusMeters)) return DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minRadiusMeters;
  return Math.max(radiusMeters, DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minRadiusMeters);
}

/**
 * 计算聚焦半径：以模型中心为 Target，常规模型优先使用 2 m，所有模型硬性限制在 3 m 内。
 * 环境等非模型目标可显式传入 Infinity 取消该上限。
 */
export function resolveDigitalTwinCameraFocusRadius(
  fitDistanceMeters: number,
  targetYMeters: number,
  maxRadiusMeters: number = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus.maxRadiusMeters,
): number {
  const { minCameraHeightMeters, preferredRadiusMeters, defaultBetaRadians } =
    DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus;
  const heightRadiusMeters = Math.max(0, (minCameraHeightMeters - targetYMeters) / Math.cos(defaultBetaRadians));
  const requestedRadiusMeters = Math.max(preferredRadiusMeters, fitDistanceMeters, heightRadiusMeters);
  return clampDigitalTwinCameraRadius(Math.min(maxRadiusMeters, requestedRadiusMeters));
}

/**
 * 聚焦时把相机置于模型斜上方 45°；alpha 保留当前水平方向，beta=π/4 表示 45° 仰角。
 */
export function resolveDigitalTwinCameraFocusBeta(): number {
  return DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus.defaultBetaRadians;
}

/**
 * 透视投影的深度精度主要集中在 near plane 附近；远景时按观察距离同步放大近裁剪面，
 * 避免大尺度模型的相邻表面因深度精度不足出现条纹、缺面，同时保留近景 2 cm 下限。
 */
function resolveDigitalTwinCameraMinZ(camera: ArcRotateCamera): number {
  const { minZMeters, perspectiveMinZRadiusRatio } = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom;
  if (camera.mode !== Camera.PERSPECTIVE_CAMERA) return minZMeters;
  return Math.max(minZMeters, clampDigitalTwinCameraRadius(camera.radius) * perspectiveMinZRadiusRatio);
}

/** 仅在近裁剪面实际变化时更新投影矩阵，避免稳定画面每帧重复失效。 */
function syncDigitalTwinCameraNearPlane(camera: ArcRotateCamera): void {
  const nextMinZ = resolveDigitalTwinCameraMinZ(camera);
  if (camera.minZ !== nextMinZ) camera.minZ = nextMinZ;
}

/**
 * 恢复并固化原有鼠标习惯：右键旋转、中键平移、Ctrl+左键平移、左键单击选择、滚轮缩放。
 * 先移除 Babylon 默认的左键旋转和右键平移，再添加标准项，重复执行不会产生重复映射。
 */
function applyDigitalTwinCameraInputMap(camera: ArcRotateCamera): void {
  const input = camera.movement.input;
  for (let index = input.inputMap.length - 1; index >= 0; index -= 1) {
    const entry = input.inputMap[index];
    const isPointerCameraGesture = entry.source === 'pointer'
      && (entry.interaction === 'rotate' || entry.interaction === 'pan');
    if (isPointerCameraGesture || entry.source === 'wheel') input.inputMap.splice(index, 1);
  }

  input.addEntry({
    source: 'pointer',
    button: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pointer.alternatePanButton,
    modifiers: { ctrl: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pointer.alternatePanRequiresCtrl },
    interaction: 'pan',
  });
  input.addEntry({
    source: 'pointer',
    button: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pointer.rotateButton,
    interaction: 'rotate',
  });
  input.addEntry({
    source: 'pointer',
    button: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pointer.panButton,
    interaction: 'pan',
  });
  input.addEntry({ source: 'wheel', interaction: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.wheel.interaction });
}

/**
 * 按相机当前取景高度计算世界单位/屏幕像素，使远近场景中的中键平移保持一致的屏幕幅度；
 * 同时同步依赖 radius 的透视近裁剪面。默认灵敏度 10 时，鼠标移动 1 px，画面中的观察目标也移动约 1 px。
 */
export function syncDigitalTwinCameraPanScale(camera: ArcRotateCamera): void {
  syncDigitalTwinCameraNearPlane(camera);
  const engine = camera.getEngine();
  const renderWidth = Math.max(1, engine.getRenderWidth());
  const renderHeight = Math.max(1, engine.getRenderHeight());
  const aspectRatio = renderWidth / renderHeight;
  const cameraFov = Number.isFinite(camera.fov) ? camera.fov : 0.8;
  const configuredHalfFov = Math.min(Math.PI / 2 - 0.001, Math.max(0.01, cameraFov / 2));
  const verticalHalfFov = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
    ? Math.atan(Math.tan(configuredHalfFov) / aspectRatio)
    : configuredHalfFov;
  const radius = clampDigitalTwinCameraRadius(camera.radius);
  const visibleWorldHeight = 2 * radius * Math.tan(verticalHalfFov);
  const sensitivityMultiplier = panSensitivityMultiplierByCamera.get(camera) ?? 1;

  camera.movement.panSpeed = visibleWorldHeight
    / renderHeight
    * DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pan.screenPixelsPerPointerPixelAtDefault
    * sensitivityMultiplier;
}

/** 将灵敏度映射为明确的角度/像素、屏幕空间平移倍率和半径百分比缩放。 */
export function applyDigitalTwinCameraSensitivity(
  camera: ArcRotateCamera,
  settings: DigitalTwinCameraSensitivity,
): void {
  const rotateMultiplier = getSensitivityMultiplier(settings.rotate);
  const panMultiplier = getSensitivityMultiplier(settings.pan);
  const zoomMultiplier = getSensitivityMultiplier(settings.zoom);
  const radiansPerPixel = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.rotation.radiansPerPixelAtDefault
    * rotateMultiplier;

  for (const entry of camera.movement.input.getEntries('pointer', 'rotate')) {
    entry.sensitivityX = radiansPerPixel;
    entry.sensitivityY = radiansPerPixel;
    delete entry.sensitivity;
  }
  for (const entry of camera.movement.input.getEntries('pointer', 'pan')) {
    entry.sensitivity = 1;
    delete entry.sensitivityX;
    delete entry.sensitivityY;
  }

  // 同步旧属性，保证 Babylon 内部仍使用 legacy fallback 的触摸路径获得相同幅度。
  camera.angularSensibilityX = 1 / radiansPerPixel;
  camera.angularSensibilityY = 1 / radiansPerPixel;
  camera.panningSensibility = 1;
  camera.wheelDeltaPercentage = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.wheel.radiusPercentagePerStepAtDefault
    * zoomMultiplier;
  // 像素灵敏度已经写进 inputMap；运动层保持 1，避免再乘一次把发布 Viewer 拖拽放大。
  camera.movement.rotationXSpeed = 1;
  camera.movement.rotationYSpeed = 1;
  camera.movement.zoomSpeed = 1;
  panSensitivityMultiplierByCamera.set(camera, panMultiplier);
  syncDigitalTwinCameraPanScale(camera);
}

/** 一次性应用相机运动标准；调用方应在 attachControl 之后执行，避免重绑恢复 Babylon 默认键位。 */
export function applyDigitalTwinCameraControlStandard(
  camera: ArcRotateCamera,
  settings: DigitalTwinCameraSensitivity,
): void {
  applyDigitalTwinCameraInputMap(camera);
  syncDigitalTwinCameraNearPlane(camera);
  camera.lowerRadiusLimit = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minRadiusMeters;
  camera.zoomToMouseLocation = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.wheel.zoomToMouseLocation;
  applyDigitalTwinCameraSensitivity(camera, settings);
}

/**
 * 绑定 Babylon 相机控制，并在其兼容参数写入完成后恢复数字孪生键位。
 * 视角动画等流程重新 attachControl 时必须复用此入口，避免默认右键平移覆盖中键平移。
 */
export function attachDigitalTwinCameraControl(
  camera: ArcRotateCamera,
  settings: DigitalTwinCameraSensitivity,
): void {
  camera.attachControl(
    true,
    DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pointer.alternatePanRequiresCtrl,
    DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.pointer.panButton,
  );
  applyDigitalTwinCameraControlStandard(camera, settings);
}

/** 判断指针会话前后是否发生有效位姿变化，让模型表面上的拖拽优先控制视角。 */
export function hasDigitalTwinCameraPoseChanged(
  before: DigitalTwinCameraPose | null,
  after: DigitalTwinCameraPose | null,
): boolean {
  if (!before || !after) return false;
  const epsilon = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.selection.poseChangeEpsilon;

  return (
    Math.abs(after.alpha - before.alpha) > epsilon
    || Math.abs(after.beta - before.beta) > epsilon
    || Math.abs(after.radius - before.radius) > epsilon
    || Math.abs(after.target.x - before.target.x) > epsilon
    || Math.abs(after.target.y - before.target.y) > epsilon
    || Math.abs(after.target.z - before.target.z) > epsilon
  );
}

/** 判断相机是否已累计本帧输入，覆盖快速微拖拽尚未刷新到位姿的窗口。 */
export function hasPendingDigitalTwinCameraInput(camera: ArcRotateCamera | null): boolean {
  const movement = camera?.movement;
  if (!movement) return false;
  const epsilon = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.selection.poseChangeEpsilon;

  return (
    movement.activeInput
    || Math.abs(movement.zoomAccumulatedPixels) > epsilon
    || movement.panAccumulatedPixels.lengthSquared() > epsilon
    || movement.rotationAccumulatedPixels.lengthSquared() > epsilon
  );
}
