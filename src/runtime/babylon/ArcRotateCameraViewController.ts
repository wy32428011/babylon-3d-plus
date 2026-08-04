import {
  type ArcRotateCamera,
  Camera,
  type Engine,
  type Observer,
  Scalar,
  type Scene,
  Vector3,
} from '@babylonjs/core';
import {
  isStandardSceneCameraOrientation,
  type SceneCameraOrientation,
  type SceneCameraPose,
  type SceneCameraProjection,
  type SceneCameraSettings,
  type StandardSceneCameraOrientation,
} from '../../editor/model/SceneDocument';
import {
  getShortestCameraAlphaDelta,
  getStandardCameraViewAngles,
} from '../../editor/model/cameraOrientation';
import { clampDigitalTwinCameraRadius, syncDigitalTwinCameraPanScale } from './cameraControlStandard';

export const EDITOR_CAMERA_DEFAULT_ALPHA = Math.PI / 4;
export const EDITOR_CAMERA_DEFAULT_BETA = Math.PI * 0.43;
export const EDITOR_CAMERA_DEFAULT_RADIUS = 28;
export const CAMERA_VIEW_TRANSITION_DURATION_MS = 200;

export type CameraViewTransitionOptions = {
  animate?: boolean;
};

export type CameraViewApplicationOptions = CameraViewTransitionOptions & {
  lockStandardOrientation?: boolean;
};

export type CameraNavigationMode = 'orbit' | 'standard' | 'transition';

export type ArcRotateCameraViewControllerOptions = {
  transitionDurationMs?: number;
  suspendCameraControl?: () => void;
  resumeCameraControl?: () => void;
  prefersReducedMotion?: () => boolean;
};

type CameraAngleLimits = {
  lowerAlphaLimit: number | null;
  upperAlphaLimit: number | null;
  lowerBetaLimit: number | null;
  upperBetaLimit: number | null;
};

type StandardViewLockState = CameraAngleLimits & {
  restoreAlpha: number;
  restoreBeta: number;
};

type CameraTransition = {
  startedAt: number;
  durationMs: number;
  fromAlpha: number;
  alphaDelta: number;
  fromBeta: number;
  toBeta: number;
  fromRadius: number;
  toRadius: number;
  fromTarget: Vector3;
  toTarget: Vector3;
  finalize: () => void;
};

/** 读取当前 ArcRotateCamera 位姿，保存为可写入场景文件的纯数据。 */
export function readCameraPose(camera: ArcRotateCamera): SceneCameraPose {
  const target = camera.getTarget();
  return {
    alpha: camera.alpha,
    beta: camera.beta,
    radius: camera.radius,
    target: { x: target.x, y: target.y, z: target.z },
  };
}

/** 应用保存位姿；未保存时回到编辑器默认观察角度。 */
export function applySavedCameraPose(camera: ArcRotateCamera, pose: SceneCameraPose | null): void {
  const target = pose ? new Vector3(pose.target.x, pose.target.y, pose.target.z) : Vector3.Zero();
  camera.alpha = pose?.alpha ?? EDITOR_CAMERA_DEFAULT_ALPHA;
  camera.beta = pose?.beta ?? EDITOR_CAMERA_DEFAULT_BETA;
  camera.radius = clampDigitalTwinCameraRadius(pose?.radius ?? EDITOR_CAMERA_DEFAULT_RADIUS);
  // setTarget 默认会按旧 position 重算角度和距离，恢复时必须保留刚写入的轨道位姿。
  camera.setTarget(target, false, false, true);
  syncDigitalTwinCameraPanScale(camera);
}

/** 清除仍在衰减的旋转、平移和缩放输入，避免程序切换视角后继续漂移。 */
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

function readCameraAngleLimits(camera: ArcRotateCamera): CameraAngleLimits {
  return {
    lowerAlphaLimit: camera.lowerAlphaLimit,
    upperAlphaLimit: camera.upperAlphaLimit,
    lowerBetaLimit: camera.lowerBetaLimit,
    upperBetaLimit: camera.upperBetaLimit,
  };
}

function applyCameraAngleLimits(camera: ArcRotateCamera, limits: CameraAngleLimits): void {
  camera.lowerAlphaLimit = limits.lowerAlphaLimit;
  camera.upperAlphaLimit = limits.upperAlphaLimit;
  camera.lowerBetaLimit = limits.lowerBetaLimit;
  camera.upperBetaLimit = limits.upperBetaLimit;
}

function lockCameraAngles(camera: ArcRotateCamera, alpha: number, beta: number): void {
  camera.alpha = alpha;
  camera.beta = beta;
  camera.lowerAlphaLimit = alpha;
  camera.upperAlphaLimit = alpha;
  camera.lowerBetaLimit = beta;
  camera.upperBetaLimit = beta;
}

/** 正交模式下把 radius 映射为投影边界，保持滚轮缩放和透视取景范围一致。 */
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

function readTimestampMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function defaultPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function easeOutCubic(progress: number): number {
  const remaining = 1 - progress;
  return 1 - remaining * remaining * remaining;
}

/**
 * 统一管理 ArcRotateCamera 的六面硬锁、投影、动画和轨道位姿恢复。
 * 连续切换标准面时只缓存首次进入前的自由轨道方向，平移和缩放始终保留。
 */
export class ArcRotateCameraViewController {
  private orientation: SceneCameraOrientation = 'orbit';
  private standardViewLock: StandardViewLockState | null = null;
  private transition: CameraTransition | null = null;
  private readonly transitionObserver: Observer<Scene>;
  private orthographicObserver: Observer<Scene> | null = null;
  private cameraControlSuspended = false;
  private disposed = false;

  constructor(
    private readonly camera: ArcRotateCamera,
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly options: ArcRotateCameraViewControllerOptions = {},
  ) {
    this.transitionObserver = scene.onBeforeRenderObservable.add(() => this.updateTransition());
  }

  getCameraOrientation(): SceneCameraOrientation {
    return this.orientation;
  }

  getNavigationMode(): CameraNavigationMode {
    if (this.transition) return 'transition';
    return this.orientation === 'orbit' ? 'orbit' : 'standard';
  }

  getCameraPose(): SceneCameraPose {
    return readCameraPose(this.camera);
  }

  setCameraOrientation(
    orientation: SceneCameraOrientation,
    transitionOptions: CameraViewTransitionOptions = {},
  ): void {
    if (this.disposed || orientation === this.orientation) return;
    if (orientation === 'orbit') {
      this.exitStandardView(transitionOptions);
      return;
    }
    this.enterStandardView(orientation, transitionOptions);
  }

  setCameraProjection(projection: SceneCameraProjection): void {
    if (this.disposed) return;
    if (projection === 'orthographic') {
      syncOrthographicBounds(this.camera, this.engine);
      this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      this.orthographicObserver ??= this.scene.onBeforeRenderObservable.add(() => {
        syncOrthographicBounds(this.camera, this.engine);
      });
      return;
    }

    this.camera.mode = Camera.PERSPECTIVE_CAMERA;
    if (this.orthographicObserver) {
      this.scene.onBeforeRenderObservable.remove(this.orthographicObserver);
      this.orthographicObserver = null;
    }
  }

  applyCameraPose(pose: SceneCameraPose | null, options: CameraViewTransitionOptions = {}): void {
    this.applyCameraView({
      savedPose: pose,
      savedOrientation: 'orbit',
      savedProjection: this.camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? 'orthographic' : 'perspective',
      viewDistance: this.camera.maxZ,
    }, { ...options, lockStandardOrientation: false });
  }

  applyCameraView(settings: SceneCameraSettings, options: CameraViewApplicationOptions = {}): void {
    if (this.disposed) return;

    const unlockedLimits = this.standardViewLock ?? readCameraAngleLimits(this.camera);
    applyCameraAngleLimits(this.camera, unlockedLimits);
    this.standardViewLock = null;

    const pose = settings.savedPose ?? {
      alpha: EDITOR_CAMERA_DEFAULT_ALPHA,
      beta: EDITOR_CAMERA_DEFAULT_BETA,
      radius: EDITOR_CAMERA_DEFAULT_RADIUS,
      target: { x: 0, y: 0, z: 0 },
    };
    const shouldLock = options.lockStandardOrientation !== false
      && isStandardSceneCameraOrientation(settings.savedOrientation);
    const finalOrientation: SceneCameraOrientation = shouldLock ? settings.savedOrientation : 'orbit';
    const finalAngles = shouldLock
      ? getStandardCameraViewAngles(settings.savedOrientation as StandardSceneCameraOrientation)
      : { alpha: pose.alpha, beta: pose.beta };

    this.orientation = finalOrientation;
    if (shouldLock) {
      this.standardViewLock = {
        restoreAlpha: finalAngles.alpha,
        restoreBeta: finalAngles.beta,
        lowerAlphaLimit: unlockedLimits.lowerAlphaLimit,
        upperAlphaLimit: unlockedLimits.upperAlphaLimit,
        lowerBetaLimit: unlockedLimits.lowerBetaLimit,
        upperBetaLimit: unlockedLimits.upperBetaLimit,
      };
    }

    this.setCameraProjection(settings.savedProjection);
    const lockSnapshot = this.standardViewLock;
    this.startTransition({
      alpha: finalAngles.alpha,
      beta: finalAngles.beta,
      radius: pose.radius,
      target: new Vector3(pose.target.x, pose.target.y, pose.target.z),
    }, options, () => {
      if (lockSnapshot && this.orientation === finalOrientation && this.standardViewLock === lockSnapshot) {
        lockCameraAngles(this.camera, finalAngles.alpha, finalAngles.beta);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transition = null;
    this.scene.onBeforeRenderObservable.remove(this.transitionObserver);
    if (this.orthographicObserver) {
      this.scene.onBeforeRenderObservable.remove(this.orthographicObserver);
      this.orthographicObserver = null;
    }
  }

  private enterStandardView(
    orientation: StandardSceneCameraOrientation,
    transitionOptions: CameraViewTransitionOptions,
  ): void {
    let lock = this.standardViewLock;
    if (!lock) {
      const limits = readCameraAngleLimits(this.camera);
      lock = {
        restoreAlpha: this.camera.alpha,
        restoreBeta: this.camera.beta,
        ...limits,
      };
      this.standardViewLock = lock;
    }

    applyCameraAngleLimits(this.camera, lock);
    this.orientation = orientation;
    const targetAngles = getStandardCameraViewAngles(orientation);
    const lockSnapshot = lock;
    this.startTransition({
      alpha: targetAngles.alpha,
      beta: targetAngles.beta,
      radius: this.camera.radius,
      target: this.camera.getTarget().clone(),
    }, transitionOptions, () => {
      if (this.orientation === orientation && this.standardViewLock === lockSnapshot) {
        lockCameraAngles(this.camera, targetAngles.alpha, targetAngles.beta);
      }
    });
  }

  private exitStandardView(transitionOptions: CameraViewTransitionOptions): void {
    const lock = this.standardViewLock;
    this.orientation = 'orbit';
    this.standardViewLock = null;
    if (!lock) return;

    applyCameraAngleLimits(this.camera, lock);
    this.startTransition({
      alpha: lock.restoreAlpha,
      beta: lock.restoreBeta,
      radius: this.camera.radius,
      target: this.camera.getTarget().clone(),
    }, transitionOptions, () => {
      applyCameraAngleLimits(this.camera, lock);
    });
  }

  private startTransition(
    target: { alpha: number; beta: number; radius: number; target: Vector3 },
    options: CameraViewTransitionOptions,
    finalize: () => void,
  ): void {
    this.transition = null;
    clearCameraMovement(this.camera);

    const durationMs = Math.max(0, this.options.transitionDurationMs ?? CAMERA_VIEW_TRANSITION_DURATION_MS);
    const prefersReducedMotion = (this.options.prefersReducedMotion ?? defaultPrefersReducedMotion)();
    const animate = options.animate !== false && durationMs > 0 && !prefersReducedMotion;
    const toRadius = clampDigitalTwinCameraRadius(target.radius);

    if (!animate) {
      this.applyTransitionPose(target.alpha, target.beta, toRadius, target.target);
      finalize();
      this.resumeCameraControl();
      return;
    }

    this.suspendCameraControl();
    this.transition = {
      startedAt: readTimestampMs(),
      durationMs,
      fromAlpha: this.camera.alpha,
      alphaDelta: getShortestCameraAlphaDelta(this.camera.alpha, target.alpha),
      fromBeta: this.camera.beta,
      toBeta: target.beta,
      fromRadius: this.camera.radius,
      toRadius,
      fromTarget: this.camera.getTarget().clone(),
      toTarget: target.target.clone(),
      finalize,
    };
  }

  private updateTransition(): void {
    const transition = this.transition;
    if (!transition) return;

    const elapsed = Math.max(0, readTimestampMs() - transition.startedAt);
    const linearProgress = Scalar.Clamp(elapsed / transition.durationMs, 0, 1);
    const progress = easeOutCubic(linearProgress);
    const alpha = transition.fromAlpha + transition.alphaDelta * progress;
    const beta = Scalar.Lerp(transition.fromBeta, transition.toBeta, progress);
    const radius = Scalar.Lerp(transition.fromRadius, transition.toRadius, progress);
    const target = Vector3.Lerp(transition.fromTarget, transition.toTarget, progress);
    this.applyTransitionPose(alpha, beta, radius, target);

    if (linearProgress < 1) return;
    this.transition = null;
    transition.finalize();
    this.resumeCameraControl();
  }

  private applyTransitionPose(alpha: number, beta: number, radius: number, target: Vector3): void {
    this.camera.alpha = alpha;
    this.camera.beta = beta;
    this.camera.radius = radius;
    this.camera.setTarget(target, false, false, true);
    syncDigitalTwinCameraPanScale(this.camera);
  }

  private suspendCameraControl(): void {
    if (this.cameraControlSuspended) return;
    this.options.suspendCameraControl?.();
    this.cameraControlSuspended = true;
  }

  private resumeCameraControl(): void {
    if (!this.cameraControlSuspended) return;
    this.cameraControlSuspended = false;
    this.options.resumeCameraControl?.();
  }
}
