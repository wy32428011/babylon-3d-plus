import '@babylonjs/loaders';
import {
  AbstractMesh,
  type AnimationGroup,
  ArcRotateCamera,
  Camera,
  Color3,
  Engine,
  Mesh,
  MeshBuilder,
  type Nullable,
  type Observer,
  Ray,
  Scene,
  SceneLoader,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { resolveDefaultManualRoamAvatarUrl } from '../assets/manualRoamAvatarAsset';
import {
  createDefaultManualRoamConfig,
  createInitialRoamKinematicState,
  resolveRoamHorizontalSpeed,
  resolveRoamKinematicStep,
  sanitizeManualRoamConfig,
  sanitizeManualRoamSpawnPose,
  type ManualRoamConfig,
  type ManualRoamLocomotionMode,
  type ManualRoamSpawnPose,
  type ManualRoamViewMode,
  type RoamInputFrame,
  type RoamKinematicState,
} from './manualRoamCore';
import {
  applyGamepadDeadZone,
  createEmptyRoamInputFrame,
  mergeRoamInputFrames,
  resolveKeyboardRoamInput,
} from './manualRoamInput';
import type { ManualRoamCollisionBoundsResolver } from './manualRoamCollisionBounds.ts';
import {
  MANUAL_ROAM_COLLISION_PROXY_PREFIX,
  ManualRoamCollisionProxyPool,
} from './ManualRoamCollisionProxyPool.ts';
import { ManualRoamLocalTriangleCollider } from './ManualRoamLocalTriangleCollider.ts';
import {
  isManualRoamPointNearWorldAabb,
  resolveManualRoamCollisionStyle,
} from './manualRoamCollisionPolicy.ts';
import { ProceduralAvatarMorphAnimator } from './ProceduralAvatarMorphAnimator';
import {
  createInitialProceduralGaitState,
  resolveProceduralBodyMotion,
  stepProceduralGaitState,
  type ProceduralGaitState,
} from './proceduralAvatarAnimation';

export type ManualRoamAvatarAnimationMode = 'loading' | 'embedded' | 'procedural' | 'error';

export type ManualRoamSnapshot = {
  enabled: boolean;
  viewMode: ManualRoamViewMode;
  locomotionMode: ManualRoamLocomotionMode;
  grounded: boolean;
  moving: boolean;
  sprinting: boolean;
  pointerLocked: boolean;
  gamepadConnected: boolean;
  debugColliders: boolean;
  avatarAnimationMode: ManualRoamAvatarAnimationMode;
  statusMessage: string | null;
  config: ManualRoamConfig;
};

export type ManualRoamTouchAction = 'jump' | 'ascend' | 'descend' | 'sprint';

export type ManualRoamRuntimeOptions = {
  scene: Scene;
  engine: Engine;
  camera: ArcRotateCamera;
  canvas: HTMLCanvasElement;
  avatarUrl?: string;
  resolveSpawnPose?: () => ManualRoamSpawnPose | null;
  resolveCollisionBounds?: ManualRoamCollisionBoundsResolver;
  setOrbitControlsEnabled: (enabled: boolean) => void;
  onActivated?: () => void;
  onDeactivated?: () => void;
  onManualInput?: () => void;
  onLog?: (message: string) => void;
};

type PointerPosition = { x: number; y: number };
type ResetTransition = {
  fromPosition: Vector3;
  fromYaw: number;
  fromPitch: number;
  startedAtMs: number;
  durationMs: number;
};

type GroundHit = {
  y: number;
  normal: Vector3;
};

const COLLIDER_NAME = '__manual_roam_character_collider__';
const FALLBACK_GROUND_NAME = '__manual_roam_fallback_ground__';
const AVATAR_ROOT_NAME = '__manual_roam_avatar_root__';
const AVATAR_VISUAL_NAME = '__manual_roam_avatar_visual__';
const FIXED_STEP_SECONDS = 1 / 60;
const MAX_FRAME_SECONDS = 0.1;
const RESET_DURATION_MS = 520;
const FALL_RECOVERY_DISTANCE = 200;
const THIRD_PERSON_CAMERA_PADDING_METERS = 0.16;
const GROUND_SLOPE_LIMIT_COSINE = Math.cos(Math.PI / 4);
const CAMERA_FOLLOW_RESPONSE = 20;
const COLLISION_PROXY_QUERY_RADIUS_METERS = 24;
const COLLISION_MESH_RECONCILE_INTERVAL_MS = 180;
const KEYBOARD_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyQ',
  'KeyE',
  'Space',
  'ShiftLeft',
  'ShiftRight',
]);

export function createInitialManualRoamSnapshot(): ManualRoamSnapshot {
  return {
    enabled: false,
    viewMode: 'thirdPerson',
    locomotionMode: 'ground',
    grounded: false,
    moving: false,
    sprinting: false,
    pointerLocked: false,
    gamepadConnected: false,
    debugColliders: false,
    avatarAnimationMode: 'loading',
    statusMessage: '人物模型加载中...',
    config: createDefaultManualRoamConfig(),
  };
}

/**
 * 编辑器运行预览与发布 Viewer 共用的人物漫游运行时。
 * 廉价网格用椭球对三角防穿透，中小型高模和阵列走邻域 AABB 代理，
 * 厂区环境等高模只提交人物附近三角；向下射线负责贴地、坡度判断和小台阶辅助。
 */
export class ManualRoamRuntime {
  private readonly listeners = new Set<() => void>();
  private readonly pressedKeys = new Set<string>();
  private readonly touchActions = new Set<ManualRoamTouchAction>();
  private readonly touchPointers = new Map<number, PointerPosition>();
  private readonly avatarMeshes = new Set<AbstractMesh>();
  private readonly collisionMeshDefaults = new Map<AbstractMesh, boolean>();
  private readonly collisionBoundingBoxDefaults = new Map<AbstractMesh, boolean>();
  private readonly collider: Mesh;
  private readonly facingRoot: TransformNode;
  private readonly avatarVisualRoot: TransformNode;
  private readonly fallbackGround: Mesh;
  private readonly collisionProxyPool: ManualRoamCollisionProxyPool | null;
  private readonly localTriangleCollider: ManualRoamLocalTriangleCollider;
  private collisionWorldDirty = false;
  private readonly beforeRenderObserver: Nullable<Observer<Scene>>;
  private readonly meshAddedObserver: Nullable<Observer<AbstractMesh>>;
  private snapshot = createInitialManualRoamSnapshot();
  private kinematicState: RoamKinematicState;
  private spawnPosition = Vector3.Zero();
  private spawnYaw = 0;
  private spawnPitch = -0.2;
  private spawnInitialized = false;
  private spawnSource: 'camera' | 'explicit' | null = null;
  private pointerLookX = 0;
  private pointerLookY = 0;
  private virtualMoveX = 0;
  private virtualMoveY = 0;
  private dragPointerId: number | null = null;
  private lastPinchDistance: number | null = null;
  private jumpQueued = false;
  private previousGamepadJumpPressed = false;
  private currentAnimation: AnimationGroup | null = null;
  private animationGroups: AnimationGroup[] = [];
  private proceduralGaitState: ProceduralGaitState = createInitialProceduralGaitState();
  private proceduralAnimator: ProceduralAvatarMorphAnimator | null = null;
  private visualBasePosition = Vector3.Zero();
  private avatarContainer: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
  private resetTransition: ResetTransition | null = null;
  private previousCameraMode = Camera.PERSPECTIVE_CAMERA;
  private previousCameraMinZ: number;
  private previousSceneCollisionsEnabled: boolean;
  private fallbackGroundRequired = false;
  private lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly options: ManualRoamRuntimeOptions) {
    const { scene, camera } = options;
    this.previousCameraMinZ = camera.minZ;
    this.previousSceneCollisionsEnabled = scene.collisionsEnabled;
    this.collider = MeshBuilder.CreateCapsule(COLLIDER_NAME, {
      height: this.snapshot.config.capsuleHeight,
      radius: this.snapshot.config.capsuleRadius,
      tessellation: 12,
      subdivisions: 2,
    }, scene);
    this.collider.bakeTransformIntoVertices(
      this.collider.getWorldMatrix().setTranslationFromFloats(0, this.snapshot.config.capsuleHeight / 2, 0),
    );
    this.collider.position.setAll(0);
    this.collider.ellipsoid.copyFromFloats(
      this.snapshot.config.capsuleRadius,
      this.snapshot.config.capsuleHeight / 2,
      this.snapshot.config.capsuleRadius,
    );
    this.collider.ellipsoidOffset.copyFromFloats(0, this.snapshot.config.capsuleHeight / 2, 0);
    this.collider.checkCollisions = true;
    this.collider.isPickable = false;
    this.collider.metadata = { manualRoamCollider: true };

    const colliderMaterial = new StandardMaterial('__manual_roam_collider_material__', scene);
    colliderMaterial.diffuseColor = new Color3(0.05, 0.92, 0.72);
    colliderMaterial.emissiveColor = new Color3(0.02, 0.35, 0.28);
    colliderMaterial.alpha = 0.32;
    colliderMaterial.wireframe = true;
    colliderMaterial.disableLighting = true;
    this.collider.material = colliderMaterial;

    this.facingRoot = new TransformNode(AVATAR_ROOT_NAME, scene);
    this.facingRoot.parent = this.collider;
    this.avatarVisualRoot = new TransformNode(AVATAR_VISUAL_NAME, scene);
    this.avatarVisualRoot.parent = this.facingRoot;

    this.fallbackGround = MeshBuilder.CreateGround(FALLBACK_GROUND_NAME, {
      width: 5000,
      height: 5000,
      subdivisions: 1,
    }, scene);
    this.fallbackGround.position.y = -0.002;
    // 保持渲染透明但允许内部向下射线拾取，空场景也能稳定判定落地。
    this.fallbackGround.isVisible = true;
    this.fallbackGround.visibility = 0;
    this.fallbackGround.isPickable = true;
    this.fallbackGround.checkCollisions = true;
    this.fallbackGround.metadata = { manualRoamFallbackGround: true };
    this.fallbackGround.setEnabled(false);
    this.collisionProxyPool = options.resolveCollisionBounds
      ? new ManualRoamCollisionProxyPool(scene, options.resolveCollisionBounds)
      : null;
    this.localTriangleCollider = new ManualRoamLocalTriangleCollider(scene);

    this.collider.setEnabled(false);
    this.facingRoot.setEnabled(false);
    this.meshAddedObserver = scene.onNewMeshAddedObservable.add((mesh) => {
      if (!this.snapshot.enabled) return;
      this.observeCollisionMesh(mesh);
      this.disableFallbackGroundWhenSceneFloorIsReady();
    });
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => this.update());
    this.kinematicState = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
    this.bindInputEvents();
    void this.loadAvatar();
  }

  getSnapshot = (): ManualRoamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.snapshot.enabled === enabled) return;
    if (enabled) {
      this.proceduralGaitState = createInitialProceduralGaitState();
      this.activateCollisionWorld();
      const explicitSpawn = this.resolveExplicitSpawnPose();
      if (explicitSpawn) {
        this.initializeExplicitSpawn(explicitSpawn);
      } else {
        if (this.spawnSource === 'explicit') {
          this.spawnInitialized = false;
          this.spawnSource = null;
        }
        this.ensureSpawnInitialized();
      }
      this.previousCameraMode = this.options.camera.mode;
      this.previousCameraMinZ = this.options.camera.minZ;
      this.options.camera.mode = Camera.PERSPECTIVE_CAMERA;
      this.options.camera.minZ = 0.025;
      this.options.setOrbitControlsEnabled(false);
      this.collider.setEnabled(true);
      this.applyAvatarVisibility(true, this.snapshot.viewMode);
      this.options.onActivated?.();
      this.publish({ enabled: true, statusMessage: this.resolveStatusMessage(true) });
      this.updateCamera(1);
      return;
    }

    this.clearInputs();
    this.resetTransition = null;
    this.exitPointerLock();
    this.collider.setEnabled(false);
    this.facingRoot.setEnabled(false);
    this.fallbackGround.setEnabled(false);
    this.collisionProxyPool?.deactivate();
    this.localTriangleCollider.deactivate();
    this.deactivateCollisionWorld();
    this.options.camera.minZ = this.previousCameraMinZ;
    this.options.camera.mode = this.previousCameraMode;
    this.options.setOrbitControlsEnabled(true);
    this.options.onDeactivated?.();
    this.publish({ enabled: false, moving: false, sprinting: false, grounded: false });
  }

  /** 场景会话切换时丢弃旧场景的出生点、备用地面和碰撞代理。 */
  invalidateSpawn(): void {
    if (this.disposed) return;
    this.setEnabled(false);
    this.clearInputs();
    this.resetTransition = null;
    this.spawnInitialized = false;
    this.spawnSource = null;
    this.fallbackGroundRequired = false;
    this.lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
    this.fallbackGround.setEnabled(false);
    this.collisionProxyPool?.deactivate();
    this.localTriangleCollider.deactivate();
    this.spawnPosition.setAll(0);
    this.spawnYaw = 0;
    this.spawnPitch = -0.2;
    this.proceduralGaitState = createInitialProceduralGaitState();
    this.collider.position.setAll(0);
    this.kinematicState = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
  }

  setViewMode(viewMode: ManualRoamViewMode): void {
    if (this.snapshot.viewMode === viewMode) return;
    this.applyAvatarVisibility(this.snapshot.enabled, viewMode);
    this.publish({ viewMode });
    if (this.snapshot.enabled) this.updateCamera(1);
  }

  setLocomotionMode(locomotionMode: ManualRoamLocomotionMode): void {
    if (this.snapshot.locomotionMode === locomotionMode) return;
    this.kinematicState.verticalVelocity = 0;
    if (locomotionMode === 'ground') this.snapCharacterToGround(true);
    this.publish({ locomotionMode, grounded: locomotionMode === 'ground' && this.kinematicState.grounded });
  }

  updateConfig(patch: Partial<ManualRoamConfig>): void {
    const config = sanitizeManualRoamConfig({ ...this.snapshot.config, ...patch });
    this.collider.ellipsoid.copyFromFloats(config.capsuleRadius, config.capsuleHeight / 2, config.capsuleRadius);
    this.collider.ellipsoidOffset.copyFromFloats(0, config.capsuleHeight / 2, 0);
    this.publish({ config });
  }

  setDebugColliders(debugColliders: boolean): void {
    if (this.snapshot.debugColliders === debugColliders) return;
    this.collider.isVisible = debugColliders && this.snapshot.enabled;
    this.collisionProxyPool?.setDebugVisible(debugColliders);
    this.localTriangleCollider.setDebugVisible(debugColliders);
    if (debugColliders) {
      this.collisionBoundingBoxDefaults.clear();
      for (const mesh of this.collisionMeshDefaults.keys()) {
        if (mesh.isDisposed() || !this.shouldRegisterCollisionMesh(mesh)) continue;
        this.collisionBoundingBoxDefaults.set(mesh, mesh.showBoundingBox);
        mesh.showBoundingBox = true;
      }
    } else {
      this.restoreCollisionBoundingBoxes();
    }
    this.publish({ debugColliders });
  }

  setVirtualMovement(right: number, forward: number): void {
    this.virtualMoveX = clampFinite(right, -1, 1);
    this.virtualMoveY = clampFinite(forward, -1, 1);
  }

  setTouchAction(action: ManualRoamTouchAction, pressed: boolean): void {
    if (pressed) {
      if (action === 'jump' && !this.touchActions.has(action)) this.jumpQueued = true;
      this.touchActions.add(action);
    } else {
      this.touchActions.delete(action);
    }
  }

  requestPointerLock(): void {
    if (!this.snapshot.enabled || document.pointerLockElement === this.options.canvas) return;
    try {
      void Promise.resolve(this.options.canvas.requestPointerLock()).catch((error) => {
        this.options.onLog?.(`鼠标锁定失败：${getErrorMessage(error)}`);
      });
    } catch (error) {
      this.options.onLog?.(`鼠标锁定失败：${getErrorMessage(error)}`);
    }
  }

  reset(): void {
    if (!this.spawnInitialized) this.ensureSpawnInitialized();
    this.clearInputs();
    this.proceduralGaitState = createInitialProceduralGaitState();
    this.resetTransition = {
      fromPosition: this.collider.position.clone(),
      fromYaw: this.kinematicState.yaw,
      fromPitch: this.kinematicState.pitch,
      startedAtMs: nowMilliseconds(),
      durationMs: RESET_DURATION_MS,
    };
    this.kinematicState.verticalVelocity = 0;
    this.kinematicState.grounded = false;
    this.publish({ grounded: false, moving: false, sprinting: false, statusMessage: '正在复位视角...' });
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.snapshot.enabled) this.setEnabled(false);
    this.disposed = true;
    this.clearInputs();
    this.exitPointerLock();
    this.unbindInputEvents();
    this.options.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    this.options.scene.onNewMeshAddedObservable.remove(this.meshAddedObserver);
    if (this.collisionMeshDefaults.size > 0) this.deactivateCollisionWorld();
    this.stopCurrentAnimation();
    this.proceduralAnimator?.dispose();
    this.proceduralAnimator = null;
    this.avatarContainer?.dispose();
    this.avatarContainer = null;
    this.collisionProxyPool?.dispose();
    this.localTriangleCollider.dispose();
    this.collider.surroundingMeshes = null;
    const colliderMaterial = this.collider.material;
    this.collider.dispose(false, false);
    colliderMaterial?.dispose();
    this.fallbackGround.dispose(false, false);
    this.listeners.clear();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.snapshot.enabled || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!KEYBOARD_CODES.has(event.code) || isEditableTarget(event.target)) return;
    event.stopPropagation();
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    if (event.code === 'Space' && !event.repeat && !this.pressedKeys.has('Space')) this.jumpQueued = true;
    this.pressedKeys.add(event.code);
    this.options.onManualInput?.();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (!KEYBOARD_CODES.has(event.code)) return;
    this.pressedKeys.delete(event.code);
  };

  private readonly handleBlur = (): void => this.clearInputs();

  private readonly handlePointerDown = (event: globalThis.PointerEvent): void => {
    if (!this.snapshot.enabled) return;
    if (event.pointerType === 'touch') {
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touchPointers.size === 2) this.lastPinchDistance = this.getTouchPinchDistance();
      this.options.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      this.options.onManualInput?.();
      return;
    }
    if (event.button !== 2) return;
    this.dragPointerId = event.pointerId;
    this.options.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    this.options.onManualInput?.();
  };

  private readonly handlePointerMove = (event: globalThis.PointerEvent): void => {
    if (!this.snapshot.enabled || document.pointerLockElement === this.options.canvas) return;
    if (event.pointerType === 'touch') {
      const previous = this.touchPointers.get(event.pointerId);
      if (!previous) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touchPointers.size >= 2) {
        const distance = this.getTouchPinchDistance();
        if (distance !== null && this.lastPinchDistance !== null) {
          this.adjustThirdPersonDistance((this.lastPinchDistance - distance) * 0.012);
        }
        this.lastPinchDistance = distance;
      } else {
        const sensitivityRatio = this.snapshot.config.touchLookSensitivity
          / this.snapshot.config.mouseSensitivity;
        this.pointerLookX += (event.clientX - previous.x) * sensitivityRatio;
        this.pointerLookY += (event.clientY - previous.y) * sensitivityRatio;
      }
      event.preventDefault();
      return;
    }
    if (this.dragPointerId !== event.pointerId || event.buttons === 0) return;
    this.pointerLookX += event.movementX;
    this.pointerLookY += event.movementY;
    event.preventDefault();
  };

  private readonly handlePointerUp = (event: globalThis.PointerEvent): void => {
    if (event.pointerType === 'touch') {
      this.touchPointers.delete(event.pointerId);
      this.lastPinchDistance = this.touchPointers.size >= 2 ? this.getTouchPinchDistance() : null;
    }
    if (this.dragPointerId === event.pointerId) this.dragPointerId = null;
  };

  private readonly handleLockedPointerMove = (event: MouseEvent): void => {
    if (!this.snapshot.enabled || document.pointerLockElement !== this.options.canvas) return;
    this.pointerLookX += event.movementX;
    this.pointerLookY += event.movementY;
    this.options.onManualInput?.();
  };

  private readonly handlePointerLockChange = (): void => {
    this.publish({ pointerLocked: document.pointerLockElement === this.options.canvas });
  };

  private readonly handleDoubleClick = (): void => this.requestPointerLock();

  private readonly handleWheel = (event: globalThis.WheelEvent): void => {
    if (!this.snapshot.enabled || this.snapshot.viewMode !== 'thirdPerson') return;
    this.adjustThirdPersonDistance(event.deltaY * 0.0025);
    event.preventDefault();
    this.options.onManualInput?.();
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (this.snapshot.enabled) event.preventDefault();
  };

  private bindInputEvents(): void {
    const { canvas } = this.options;
    window.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('keyup', this.handleKeyUp, true);
    window.addEventListener('blur', this.handleBlur);
    canvas.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('dblclick', this.handleDoubleClick);
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    document.addEventListener('mousemove', this.handleLockedPointerMove);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  private unbindInputEvents(): void {
    const { canvas } = this.options;
    window.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('keyup', this.handleKeyUp, true);
    window.removeEventListener('blur', this.handleBlur);
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerUp);
    canvas.removeEventListener('wheel', this.handleWheel);
    canvas.removeEventListener('dblclick', this.handleDoubleClick);
    canvas.removeEventListener('contextmenu', this.handleContextMenu);
    document.removeEventListener('mousemove', this.handleLockedPointerMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  private async loadAvatar(): Promise<void> {
    const avatarUrl = this.options.avatarUrl ?? resolveDefaultManualRoamAvatarUrl();
    const { rootUrl, fileName } = splitAssetUrl(avatarUrl);
    let container: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
    try {
      container = await SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.options.scene);
      if (this.disposed) {
        container.dispose();
        return;
      }
      for (const mesh of container.meshes) {
        this.unregisterCollisionMesh(mesh);
        mesh.isPickable = false;
        mesh.checkCollisions = false;
        mesh.metadata = { ...(mesh.metadata ?? {}), manualRoamAvatar: true };
        this.avatarMeshes.add(mesh);
      }
      // 先标记人物网格再加入场景，避免 onNewMeshAdded 将人物误判为静态碰撞体。
      container.addAllToScene();
      for (const node of container.rootNodes) node.parent = this.avatarVisualRoot;
      this.normalizeAvatar(container.meshes);
      this.animationGroups = [...container.animationGroups];
      this.proceduralAnimator = this.animationGroups.length === 0
        ? ProceduralAvatarMorphAnimator.create(this.options.scene, container.meshes)
        : null;
      this.avatarContainer = container;
      const avatarAnimationMode: ManualRoamAvatarAnimationMode = this.animationGroups.length > 0
        ? 'embedded'
        : 'procedural';
      this.applyAvatarVisibility(this.snapshot.enabled, this.snapshot.viewMode);
      this.publish({
        avatarAnimationMode,
        statusMessage: avatarAnimationMode === 'procedural'
          ? '当前人物模型无骨骼动画，已启用程序化步态。'
          : null,
      });
      this.options.onLog?.(
        avatarAnimationMode === 'embedded'
          ? `人物模型加载完成，检测到 ${this.animationGroups.length} 个动画片段。`
          : `人物模型加载完成；未检测到蒙皮动画，已为 ${this.proceduralAnimator?.meshCount ?? 0} 个网格启用程序化四肢步态。`,
      );
    } catch (error) {
      if (container) {
        for (const mesh of container.meshes) this.avatarMeshes.delete(mesh);
        if (this.avatarContainer === container) this.avatarContainer = null;
        container.dispose();
      }
      if (this.disposed) return;
      const message = `人物模型加载失败：${getErrorMessage(error)}`;
      this.publish({ avatarAnimationMode: 'error', statusMessage: message });
      this.options.onLog?.(message);
    }
  }

  private normalizeAvatar(meshes: readonly AbstractMesh[]): void {
    this.avatarVisualRoot.position.setAll(0);
    this.avatarVisualRoot.scaling.setAll(1);
    this.avatarVisualRoot.computeWorldMatrix(true);
    const initialBounds = collectBoundsRelativeToNode(meshes, this.avatarVisualRoot);
    if (!initialBounds) return;
    const initialHeight = initialBounds.maximum.y - initialBounds.minimum.y;
    const scale = initialHeight > 1e-5
      ? this.snapshot.config.capsuleHeight / initialHeight
      : 1;
    if (initialHeight > 1e-5) {
      this.avatarVisualRoot.scaling.setAll(scale);
    }
    this.avatarVisualRoot.position.set(
      -(initialBounds.minimum.x + initialBounds.maximum.x) / 2 * scale,
      -initialBounds.minimum.y * scale,
      -(initialBounds.minimum.z + initialBounds.maximum.z) / 2 * scale,
    );
    this.visualBasePosition = this.avatarVisualRoot.position.clone();
  }

  private update(): void {
    if (!this.snapshot.enabled || this.disposed) return;
    this.syncCollisionProxies(this.collider.position);
    if (this.resetTransition) {
      this.updateResetTransition();
      this.updateCamera(this.options.engine.getDeltaTime() / 1000);
      return;
    }

    const frameSeconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, this.options.engine.getDeltaTime() / 1000));
    const input = this.collectInputFrame(frameSeconds);
    let remaining = frameSeconds;
    let firstStep = true;
    while (remaining > 1e-6) {
      const delta = Math.min(FIXED_STEP_SECONDS, remaining);
      const substepInput = firstStep
        ? input
        : { ...input, lookX: 0, lookY: 0, jump: false };
      this.stepCharacter(substepInput, delta);
      remaining -= delta;
      firstStep = false;
    }
    this.updateCamera(frameSeconds);
    this.updateAvatarAnimation(input, frameSeconds);
    const moving = Math.hypot(input.forward, input.right, input.vertical) > 0.05;
    this.publish({
      grounded: this.kinematicState.grounded,
      moving,
      sprinting: moving && input.sprint,
      statusMessage: this.resolveStatusMessage(true),
    });
  }

  private collectInputFrame(deltaSeconds: number): RoamInputFrame {
    const keyboard = resolveKeyboardRoamInput(this.pressedKeys, this.snapshot.locomotionMode);
    if (this.snapshot.locomotionMode === 'ground') keyboard.jump = this.jumpQueued;
    const touch = createEmptyRoamInputFrame();
    touch.forward = this.virtualMoveY;
    touch.right = this.virtualMoveX;
    touch.sprint = this.touchActions.has('sprint');
    if (this.snapshot.locomotionMode === 'fly') {
      touch.vertical = Number(this.touchActions.has('ascend') || this.touchActions.has('jump'))
        - Number(this.touchActions.has('descend'));
    } else {
      touch.jump = this.jumpQueued;
    }

    const gamepad = this.readGamepadFrame(deltaSeconds);
    const pointer = createEmptyRoamInputFrame();
    pointer.lookX = this.pointerLookX;
    pointer.lookY = this.pointerLookY;
    this.pointerLookX = 0;
    this.pointerLookY = 0;
    this.jumpQueued = false;
    return mergeRoamInputFrames(keyboard, touch, gamepad, pointer);
  }

  private readGamepadFrame(deltaSeconds: number): RoamInputFrame {
    const frame = createEmptyRoamInputFrame();
    const gamepads = typeof navigator === 'undefined' || !navigator.getGamepads
      ? []
      : navigator.getGamepads();
    const gamepad = Array.from(gamepads).find((candidate): candidate is Gamepad => Boolean(candidate?.connected));
    this.publish({ gamepadConnected: Boolean(gamepad) });
    if (!gamepad) {
      this.previousGamepadJumpPressed = false;
      return frame;
    }

    const left = applyGamepadDeadZone(gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0, this.snapshot.config.gamepadDeadZone);
    const right = applyGamepadDeadZone(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0, this.snapshot.config.gamepadDeadZone);
    frame.right = left.x;
    frame.forward = -left.y;
    frame.lookX = right.x * this.snapshot.config.gamepadLookSpeed * deltaSeconds
      / this.snapshot.config.mouseSensitivity;
    frame.lookY = right.y * this.snapshot.config.gamepadLookSpeed * deltaSeconds
      / this.snapshot.config.mouseSensitivity;
    frame.sprint = Boolean(gamepad.buttons[10]?.pressed || gamepad.buttons[7]?.value > 0.7);
    const jumpPressed = Boolean(gamepad.buttons[0]?.pressed);
    if (this.snapshot.locomotionMode === 'fly') {
      frame.vertical = Number(jumpPressed || gamepad.buttons[5]?.pressed)
        - Number(gamepad.buttons[1]?.pressed || gamepad.buttons[4]?.pressed);
    } else {
      frame.jump = jumpPressed && !this.previousGamepadJumpPressed;
    }
    this.previousGamepadJumpPressed = jumpPressed;
    return frame;
  }

  private stepCharacter(input: Readonly<RoamInputFrame>, deltaSeconds: number): void {
    const step = resolveRoamKinematicStep(
      this.kinematicState,
      input,
      this.snapshot.config,
      deltaSeconds,
      this.snapshot.locomotionMode,
    );
    this.kinematicState.yaw = step.yaw;
    this.kinematicState.pitch = step.pitch;
    this.kinematicState.verticalVelocity = step.verticalVelocity;

    const displacement = new Vector3(step.displacement.x, step.displacement.y, step.displacement.z);
    if (this.snapshot.locomotionMode === 'ground' && this.kinematicState.grounded) {
      this.applyStepAssist(displacement);
    }
    this.collider.moveWithCollisions(displacement);
    if (this.snapshot.locomotionMode === 'ground') this.snapCharacterToGround(false);
    else this.kinematicState.grounded = false;
    this.kinematicState.position = vectorToRoam(this.collider.position);
    this.facingRoot.rotation.y = this.kinematicState.yaw;

    if (this.collider.position.y < this.spawnPosition.y - FALL_RECOVERY_DISTANCE) {
      this.finishResetImmediately();
    }
  }

  private applyStepAssist(displacement: Vector3): void {
    if (Math.hypot(displacement.x, displacement.z) < 1e-5) return;
    const config = this.snapshot.config;
    const targetX = this.collider.position.x + displacement.x;
    const targetZ = this.collider.position.z + displacement.z;
    const hit = this.pickGround(
      targetX,
      targetZ,
      this.collider.position.y + config.stepHeight + 0.08,
      config.stepHeight + config.groundProbeDistance + 0.08,
    );
    if (!hit) return;
    const rise = hit.y - this.collider.position.y;
    if (rise <= 0.015 || rise > config.stepHeight) return;
    this.collider.moveWithCollisions(new Vector3(0, rise + 0.015, 0));
  }

  private snapCharacterToGround(force: boolean): void {
    if (!force && this.kinematicState.verticalVelocity > 0) {
      this.kinematicState.grounded = false;
      return;
    }
    const config = this.snapshot.config;
    const hit = this.pickGround(
      this.collider.position.x,
      this.collider.position.z,
      this.collider.position.y + 0.08,
      config.groundProbeDistance + 0.08,
    );
    if (!hit || hit.y > this.collider.position.y + config.stepHeight) {
      this.kinematicState.grounded = false;
      return;
    }
    const distance = this.collider.position.y - hit.y;
    if (!force && (distance < -0.02 || distance > config.groundProbeDistance)) {
      this.kinematicState.grounded = false;
      return;
    }
    this.collider.position.y = hit.y;
    this.kinematicState.verticalVelocity = 0;
    this.kinematicState.grounded = true;
  }

  private pickGround(
    x: number,
    z: number,
    originY: number,
    length: number,
    includeFallback = true,
  ): GroundHit | null {
    const ray = new Ray(new Vector3(x, originY, z), Vector3.Down(), length);
    const predicate = (mesh: AbstractMesh): boolean => this.isCollisionCandidate(mesh, includeFallback);
    const firstHit = this.options.scene.pickWithRay(ray, predicate, false);
    if (firstHit?.hit && firstHit.pickedPoint) {
      const normal = firstHit.getNormal(true) ?? Vector3.Up();
      if (normal.y >= GROUND_SLOPE_LIMIT_COSINE) {
        return { y: firstHit.pickedPoint.y, normal };
      }
    }
    if (!firstHit?.hit) return null;

    // 射线先碰到台阶侧面或陡坡时，再查找其后的可行走表面；普通地面只执行一次拾取。
    const hits = this.options.scene.multiPickWithRay(
      ray,
      predicate,
    ) ?? [];
    let nearest: { distance: number; ground: GroundHit } | null = null;
    for (const hit of hits) {
      if (!hit.hit || !hit.pickedPoint) continue;
      const normal = hit.getNormal(true) ?? Vector3.Up();
      if (normal.y < GROUND_SLOPE_LIMIT_COSINE) continue;
      if (!nearest || hit.distance < nearest.distance) {
        nearest = { distance: hit.distance, ground: { y: hit.pickedPoint.y, normal } };
      }
    }
    return nearest?.ground ?? null;
  }

  private updateCamera(deltaSeconds: number): void {
    const config = this.snapshot.config;
    const foot = this.collider.position;
    const head = new Vector3(foot.x, foot.y + config.eyeHeight, foot.z);
    const cosPitch = Math.cos(this.kinematicState.pitch);
    const lookDirection = new Vector3(
      Math.sin(this.kinematicState.yaw) * cosPitch,
      Math.sin(this.kinematicState.pitch),
      Math.cos(this.kinematicState.yaw) * cosPitch,
    ).normalize();

    if (this.snapshot.viewMode === 'firstPerson') {
      this.options.camera.setTarget(head.add(lookDirection));
      this.options.camera.setPosition(head);
      return;
    }

    const target = new Vector3(foot.x, foot.y + config.thirdPersonHeight, foot.z);
    const desiredPosition = target.subtract(lookDirection.scale(config.thirdPersonDistance));
    const cameraRayDirection = desiredPosition.subtract(target);
    const desiredDistance = cameraRayDirection.length();
    if (desiredDistance > 1e-5) cameraRayDirection.scaleInPlace(1 / desiredDistance);
    const cameraHit = this.options.scene.pickWithRay(
      new Ray(target, cameraRayDirection, desiredDistance),
      (mesh) => this.isCollisionCandidate(mesh),
      false,
    );
    if (cameraHit?.hit && cameraHit.distance < desiredDistance) {
      const collisionPadding = Math.min(
        THIRD_PERSON_CAMERA_PADDING_METERS,
        Math.max(0, cameraHit.distance) * 0.5,
      );
      desiredPosition.copyFrom(target).addInPlace(cameraRayDirection.scale(
        Math.max(0, cameraHit.distance - collisionPadding),
      ));
    }

    const blend = deltaSeconds >= 1 ? 1 : 1 - Math.exp(-CAMERA_FOLLOW_RESPONSE * Math.max(0, deltaSeconds));
    const position = Vector3.Lerp(this.options.camera.position, desiredPosition, blend);
    this.options.camera.setTarget(target);
    this.options.camera.setPosition(position);
  }

  /** 用实际水平速度驱动程序化步态或内置走/跑片段，使步频与位移同步。 */
  private updateAvatarAnimation(input: Readonly<RoamInputFrame>, deltaSeconds: number): void {
    const horizontalAmount = Math.hypot(input.forward, input.right);
    const horizontalSpeed = resolveRoamHorizontalSpeed(input, this.snapshot.config);
    const airborne = this.snapshot.locomotionMode === 'ground' && !this.kinematicState.grounded;
    const animationName = airborne ? 'jump' : horizontalAmount > 0.05 ? input.sprint ? 'run' : 'walk' : 'idle';
    if (this.animationGroups.length > 0) {
      this.playEmbeddedAnimation(animationName, horizontalSpeed);
      return;
    }
    this.stopCurrentAnimation();
    this.proceduralGaitState = stepProceduralGaitState(
      this.proceduralGaitState,
      horizontalAmount,
      horizontalSpeed,
      airborne,
      deltaSeconds,
    );
    const { phase, amount } = this.proceduralGaitState;
    this.proceduralAnimator?.update(phase, amount, airborne);
    const bodyMotion = resolveProceduralBodyMotion(phase, amount, airborne);
    this.avatarVisualRoot.position.copyFrom(this.visualBasePosition);
    this.avatarVisualRoot.position.y += bodyMotion.verticalOffsetMeters;
    this.avatarVisualRoot.rotation.z = bodyMotion.rollRadians;
  }

  /** 按当前水平速度缩放内置走/跑片段，避免滑步或原地碎步。 */
  private playEmbeddedAnimation(
    kind: 'idle' | 'walk' | 'run' | 'jump',
    horizontalSpeed: number,
  ): void {
    const patterns: Record<typeof kind, RegExp[]> = {
      idle: [/idle/i, /stand/i],
      walk: [/walk/i, /move/i],
      run: [/run/i, /sprint/i, /walk/i],
      jump: [/jump/i, /fall/i, /walk/i],
    };
    const next = patterns[kind]
      .map((pattern) => this.animationGroups.find((group) => pattern.test(group.name)))
      .find((group): group is AnimationGroup => Boolean(group))
      ?? this.animationGroups[0]
      ?? null;
    if (!next) return;
    next.speedRatio = resolveEmbeddedAnimationSpeedRatio(kind, horizontalSpeed, this.snapshot.config);
    if (next === this.currentAnimation) return;
    this.stopCurrentAnimation();
    next.play(kind !== 'jump');
    this.currentAnimation = next;
  }

  private stopCurrentAnimation(): void {
    this.currentAnimation?.stop();
    this.currentAnimation = null;
  }

  private updateResetTransition(): void {
    const transition = this.resetTransition;
    if (!transition) return;
    const progress = clampFinite((nowMilliseconds() - transition.startedAtMs) / transition.durationMs, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    this.collider.position.copyFrom(Vector3.Lerp(transition.fromPosition, this.spawnPosition, eased));
    this.kinematicState.yaw = lerpAngle(transition.fromYaw, this.spawnYaw, eased);
    this.kinematicState.pitch = transition.fromPitch + (this.spawnPitch - transition.fromPitch) * eased;
    this.facingRoot.rotation.y = this.kinematicState.yaw;
    if (progress < 1) return;
    this.resetTransition = null;
    this.kinematicState.position = vectorToRoam(this.spawnPosition);
    this.snapCharacterToGround(true);
    this.publish({ grounded: this.kinematicState.grounded, statusMessage: this.resolveStatusMessage(true) });
  }

  private finishResetImmediately(): void {
    this.resetTransition = null;
    this.collider.position.copyFrom(this.spawnPosition);
    this.kinematicState = createInitialRoamKinematicState(
      vectorToRoam(this.spawnPosition),
      { yaw: this.spawnYaw, pitch: this.spawnPitch },
    );
    this.snapCharacterToGround(true);
  }

  private ensureSpawnInitialized(): void {
    if (this.spawnInitialized) return;
    for (const mesh of this.options.scene.meshes) this.registerCollisionMesh(mesh);
    const cameraTarget = this.options.camera.getTarget();
    this.syncCollisionProxies(cameraTarget, true);
    const forward = this.options.camera.getForwardRay().direction.normalize();
    const yaw = Math.atan2(forward.x, forward.z);
    const pitch = Math.asin(clampFinite(forward.y, -1, 1));
    const ground = this.pickGround(
      cameraTarget.x,
      cameraTarget.z,
      cameraTarget.y + this.snapshot.config.capsuleHeight * 2,
      Math.max(100, this.snapshot.config.capsuleHeight * 4),
      false,
    );
    const useFallbackGround = !ground;
    if (useFallbackGround) {
      this.fallbackGround.position.copyFromFloats(
        cameraTarget.x,
        cameraTarget.y - 0.002,
        cameraTarget.z,
      );
      this.fallbackGroundRequired = true;
      this.fallbackGround.setEnabled(true);
      this.fallbackGround.computeWorldMatrix(true);
    } else {
      this.fallbackGroundRequired = false;
      this.fallbackGround.setEnabled(false);
    }
    this.spawnPosition = new Vector3(
      cameraTarget.x,
      ground?.y ?? (useFallbackGround ? this.fallbackGround.position.y : cameraTarget.y),
      cameraTarget.z,
    );
    this.spawnYaw = yaw;
    this.spawnPitch = pitch;
    this.collider.position.copyFrom(this.spawnPosition);
    this.kinematicState = createInitialRoamKinematicState(vectorToRoam(this.spawnPosition), { yaw, pitch });
    this.snapCharacterToGround(true);
    this.spawnInitialized = true;
    this.spawnSource = 'camera';
  }

  /** 显式出生点以人物脚底坐标为权威值，每次启用漫游都从该姿态重新开始。 */
  private initializeExplicitSpawn(pose: ManualRoamSpawnPose): void {
    const position = new Vector3(pose.position.x, pose.position.y, pose.position.z);
    for (const mesh of this.options.scene.meshes) this.registerCollisionMesh(mesh);
    this.syncCollisionProxies(position, true);
    const ground = this.pickGround(
      position.x,
      position.z,
      position.y + 0.08,
      Math.max(100, this.snapshot.config.groundProbeDistance + 0.08),
      false,
    );
    if (ground) {
      this.fallbackGroundRequired = false;
      this.fallbackGround.setEnabled(false);
    } else {
      this.fallbackGround.position.copyFrom(position);
      this.fallbackGroundRequired = true;
      this.fallbackGround.setEnabled(true);
      this.fallbackGround.computeWorldMatrix(true);
    }
    this.spawnPosition.copyFrom(position);
    this.spawnYaw = pose.yaw;
    this.spawnPitch = -0.2;
    this.collider.position.copyFrom(position);
    this.kinematicState = createInitialRoamKinematicState(
      vectorToRoam(position),
      { yaw: pose.yaw, pitch: this.spawnPitch },
    );
    this.facingRoot.rotation.y = pose.yaw;
    this.snapCharacterToGround(true);
    this.spawnInitialized = true;
    this.spawnSource = 'explicit';
  }

  private resolveExplicitSpawnPose(): ManualRoamSpawnPose | null {
    if (!this.options.resolveSpawnPose) return null;
    try {
      return sanitizeManualRoamSpawnPose(this.options.resolveSpawnPose());
    } catch (error) {
      this.options.onLog?.(`读取手动漫游初始位置失败：${getErrorMessage(error)}`);
      return null;
    }
  }

  private observeCollisionMesh(mesh: AbstractMesh): void {
    this.localTriangleCollider.observe(mesh);
    this.registerCollisionMesh(mesh);
    this.collisionWorldDirty = true;
  }

  private registerCollisionMesh(mesh: AbstractMesh): void {
    if (this.collisionMeshDefaults.has(mesh) || !this.shouldRegisterCollisionMesh(mesh)) return;
    this.collisionMeshDefaults.set(mesh, mesh.checkCollisions);
    mesh.checkCollisions = true;
    if (this.snapshot.debugColliders) {
      this.collisionBoundingBoxDefaults.set(mesh, mesh.showBoundingBox);
      mesh.showBoundingBox = true;
    }
  }

  private unregisterCollisionMesh(mesh: AbstractMesh): void {
    if (this.collisionMeshDefaults.has(mesh)) {
      if (!mesh.isDisposed()) mesh.checkCollisions = this.collisionMeshDefaults.get(mesh) ?? false;
      this.collisionMeshDefaults.delete(mesh);
    }
    if (this.collisionBoundingBoxDefaults.has(mesh)) {
      if (!mesh.isDisposed()) mesh.showBoundingBox = this.collisionBoundingBoxDefaults.get(mesh) ?? false;
      this.collisionBoundingBoxDefaults.delete(mesh);
    }
  }

  private activateCollisionWorld(): void {
    this.previousSceneCollisionsEnabled = this.options.scene.collisionsEnabled;
    this.options.scene.collisionsEnabled = true;
    this.lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
    this.collisionWorldDirty = true;
    this.localTriangleCollider.captureScene(this.options.scene.meshes);
    for (const mesh of this.options.scene.meshes) this.registerCollisionMesh(mesh);
    if (this.fallbackGroundRequired) this.fallbackGround.setEnabled(true);
    this.disableFallbackGroundWhenSceneFloorIsReady();
  }

  private deactivateCollisionWorld(): void {
    this.collisionProxyPool?.deactivate();
    this.localTriangleCollider.deactivate();
    this.lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
    this.restoreCollisionBoundingBoxes();
    for (const [mesh, original] of this.collisionMeshDefaults) {
      if (!mesh.isDisposed()) mesh.checkCollisions = original;
    }
    this.collisionMeshDefaults.clear();
    this.collider.surroundingMeshes = null;
    this.collisionWorldDirty = false;
    this.options.scene.collisionsEnabled = this.previousSceneCollisionsEnabled;
  }

  private shouldRegisterCollisionMesh(mesh: AbstractMesh): boolean {
    if (mesh === this.collider || mesh === this.fallbackGround || this.avatarMeshes.has(mesh)) return false;
    if (mesh.name.startsWith(MANUAL_ROAM_COLLISION_PROXY_PREFIX)) return false;
    return resolveManualRoamCollisionStyle(mesh) === 'native-triangle';
  }

  private isCollisionCandidate(mesh: AbstractMesh, includeFallback = true): boolean {
    if (includeFallback && mesh === this.fallbackGround && mesh.isEnabled()) return true;
    if (this.collisionProxyPool?.has(mesh) && mesh.isEnabled()) return true;
    if (this.localTriangleCollider.has(mesh) && mesh.isEnabled()) return true;
    if (
      mesh === this.collider
      || mesh === this.fallbackGround
      || this.avatarMeshes.has(mesh)
      || !this.collisionMeshDefaults.has(mesh)
      || !mesh.checkCollisions
      || !mesh.isEnabled()
    ) return false;
    const box = mesh.getBoundingInfo().boundingBox;
    return isManualRoamPointNearWorldAabb(
      this.collider.position,
      box.minimumWorld,
      box.maximumWorld,
      COLLISION_PROXY_QUERY_RADIUS_METERS,
    );
  }

  private disableFallbackGroundWhenSceneFloorIsReady(): void {
    if (!this.spawnInitialized || !this.fallbackGround.isEnabled()) return;
    const config = this.snapshot.config;
    const ground = this.pickGround(
      this.collider.position.x,
      this.collider.position.z,
      this.collider.position.y + config.capsuleHeight * 2,
      Math.max(100, config.capsuleHeight * 4),
      false,
    );
    if (ground) {
      this.fallbackGroundRequired = false;
      this.fallbackGround.setEnabled(false);
    }
  }

  private restoreCollisionBoundingBoxes(): void {
    for (const [mesh, original] of this.collisionBoundingBoxDefaults) {
      if (!mesh.isDisposed()) mesh.showBoundingBox = original;
    }
    this.collisionBoundingBoxDefaults.clear();
  }

  private reconcileCollisionMeshes(nowMs: number, force = false): void {
    if (
      !force
      && nowMs - this.lastCollisionMeshReconcileMs < COLLISION_MESH_RECONCILE_INTERVAL_MS
    ) return;
    this.lastCollisionMeshReconcileMs = nowMs;
    this.localTriangleCollider.captureScene(this.options.scene.meshes);
    for (const mesh of [...this.collisionMeshDefaults.keys()]) {
      if (!this.shouldRegisterCollisionMesh(mesh)) this.unregisterCollisionMesh(mesh);
    }
    for (const mesh of this.options.scene.meshes) this.registerCollisionMesh(mesh);
    this.collisionWorldDirty = true;
  }

  private syncCollisionProxies(position: Readonly<Vector3>, force = false): void {
    const nowMs = nowMilliseconds();
    this.reconcileCollisionMeshes(nowMs, force);
    const queryPosition = { x: position.x, y: position.y, z: position.z };
    const proxyRefreshed = this.collisionProxyPool?.sync(
      queryPosition,
      COLLISION_PROXY_QUERY_RADIUS_METERS,
      nowMs,
      force,
    ) ?? false;
    const triangleRefreshed = this.localTriangleCollider.sync(
      queryPosition,
      COLLISION_PROXY_QUERY_RADIUS_METERS,
      nowMs,
      force,
    );
    if (proxyRefreshed || triangleRefreshed || this.collisionWorldDirty) {
      this.updateColliderNeighborhood(queryPosition);
      this.collisionWorldDirty = false;
    }
    if ((proxyRefreshed || triangleRefreshed) && this.fallbackGround.isEnabled()) {
      this.disableFallbackGroundWhenSceneFloorIsReady();
    }
  }

  /**
   * 把人物碰撞扫描限制在邻域廉价网格、AABB 代理和局部三角代理内。
   * Babylon 默认会遍历场景全部 checkCollisions 网格，厂区环境 GLB 会把 CPU 打满。
   */
  private updateColliderNeighborhood(position: { x: number; y: number; z: number }): void {
    const nearby: AbstractMesh[] = [];
    if (this.fallbackGround.isEnabled()) nearby.push(this.fallbackGround);
    for (const mesh of this.collisionProxyPool?.getActiveMeshes() ?? []) {
      if (mesh.isEnabled()) nearby.push(mesh);
    }
    for (const mesh of this.localTriangleCollider.getActiveMeshes()) {
      if (mesh.isEnabled()) nearby.push(mesh);
    }
    for (const mesh of this.collisionMeshDefaults.keys()) {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.checkCollisions) continue;
      const box = mesh.getBoundingInfo().boundingBox;
      if (!isManualRoamPointNearWorldAabb(position, box.minimumWorld, box.maximumWorld, COLLISION_PROXY_QUERY_RADIUS_METERS)) {
        continue;
      }
      nearby.push(mesh);
    }
    this.collider.surroundingMeshes = nearby;
  }

  private adjustThirdPersonDistance(delta: number): void {
    this.updateConfig({ thirdPersonDistance: this.snapshot.config.thirdPersonDistance + delta });
  }

  private getTouchPinchDistance(): number | null {
    const points = [...this.touchPointers.values()];
    if (points.length < 2) return null;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  private applyAvatarVisibility(enabled: boolean, viewMode: ManualRoamViewMode): void {
    this.facingRoot.setEnabled(enabled && viewMode === 'thirdPerson');
    this.collider.isVisible = enabled && this.snapshot.debugColliders;
  }

  private clearInputs(): void {
    this.pressedKeys.clear();
    this.touchActions.clear();
    this.touchPointers.clear();
    this.pointerLookX = 0;
    this.pointerLookY = 0;
    this.virtualMoveX = 0;
    this.virtualMoveY = 0;
    this.dragPointerId = null;
    this.lastPinchDistance = null;
    this.jumpQueued = false;
    this.previousGamepadJumpPressed = false;
  }

  private exitPointerLock(): void {
    if (document.pointerLockElement === this.options.canvas) document.exitPointerLock();
  }

  private resolveStatusMessage(enabled: boolean): string | null {
    if (!enabled) return this.snapshot.statusMessage;
    if (this.snapshot.avatarAnimationMode === 'loading') return '人物模型加载中，漫游控制已可用。';
    if (this.snapshot.avatarAnimationMode === 'procedural') return '人物模型无骨骼动画，当前使用程序化步态。';
    if (this.snapshot.avatarAnimationMode === 'error') return this.snapshot.statusMessage;
    return null;
  }

  private publish(patch: Partial<ManualRoamSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (areSnapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function splitAssetUrl(url: string): { rootUrl: string; fileName: string } {
  const index = url.lastIndexOf('/');
  return index < 0
    ? { rootUrl: '', fileName: url }
    : { rootUrl: url.slice(0, index + 1), fileName: url.slice(index + 1) };
}

function collectBoundsRelativeToNode(
  meshes: readonly AbstractMesh[],
  relativeTo: TransformNode,
): { minimum: Vector3; maximum: Vector3 } | null {
  relativeTo.computeWorldMatrix(true);
  const inverseWorld = relativeTo.getWorldMatrix().clone().invert();
  let minimum: Vector3 | null = null;
  let maximum: Vector3 | null = null;
  for (const mesh of meshes) {
    if (mesh.isDisposed() || mesh.getTotalVertices() <= 0) continue;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    for (const worldCorner of box.vectorsWorld) {
      const localCorner = Vector3.TransformCoordinates(worldCorner, inverseWorld);
      minimum = minimum ? Vector3.Minimize(minimum, localCorner) : localCorner.clone();
      maximum = maximum ? Vector3.Maximize(maximum, localCorner) : localCorner.clone();
    }
  }
  return minimum && maximum ? { minimum, maximum } : null;
}

/** 按当前水平速度相对走/跑参考速度缩放内置片段播放倍率。 */
function resolveEmbeddedAnimationSpeedRatio(
  kind: 'idle' | 'walk' | 'run' | 'jump',
  horizontalSpeed: number,
  config: ManualRoamConfig,
): number {
  if (kind === 'idle' || kind === 'jump') return 1;
  const referenceSpeed = kind === 'run' ? config.runSpeed : config.walkSpeed;
  if (!(referenceSpeed > 1e-8)) return 1;
  const ratio = Math.max(0, horizontalSpeed) / referenceSpeed;
  return Math.max(0.01, ratio);
}

function vectorToRoam(vector: Vector3): { x: number; y: number; z: number } {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(minimum, value));
}

function lerpAngle(from: number, to: number, amount: number): number {
  const delta = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return from + delta * amount;
}

function nowMilliseconds(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    'input, textarea, select, button, a[href], [role="button"], [contenteditable="true"]',
  ));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function areSnapshotsEqual(left: ManualRoamSnapshot, right: ManualRoamSnapshot): boolean {
  return left.enabled === right.enabled
    && left.viewMode === right.viewMode
    && left.locomotionMode === right.locomotionMode
    && left.grounded === right.grounded
    && left.moving === right.moving
    && left.sprinting === right.sprinting
    && left.pointerLocked === right.pointerLocked
    && left.gamepadConnected === right.gamepadConnected
    && left.debugColliders === right.debugColliders
    && left.avatarAnimationMode === right.avatarAnimationMode
    && left.statusMessage === right.statusMessage
    && left.config === right.config;
}
