import '../babylon/babylonSideEffects.js';
import '../babylon/babylonGltfLoader.js';
import { setDigitalTwinCameraNearPlaneOverride } from '../babylon/cameraControlStandard.ts';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Ray } from '@babylonjs/core/Culling/ray.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { AnimationGroup, Nullable, Observer } from '@babylonjs/core';
import { resolveDefaultManualRoamAvatarUrl, resolveManualRoamMotionUrls } from '../assets/manualRoamAvatarAsset';
import { ManualRoamAvatarAnimator } from './ManualRoamAvatarAnimator';
import { ManualRoamEmbeddedAnimator } from './ManualRoamEmbeddedAnimator';
import { getManualRoamRigProfile, MANUAL_ROAM_RIG_PROFILE_V2 } from './manualRoamAvatarRig';
import { ManualRoamFootIK } from './ManualRoamFootIK';
import { createManualRoamTurnState, stepManualRoamTurnState } from './manualRoamTurnState';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import {
  createDefaultManualRoamConfig,
  createInitialRoamKinematicState,
  resolveManualRoamCameraNearPlane,
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
import {
  buildSafeRadialCandidatePositions,
  computeCollisionSubstepCount,
  findOverlappingAabbBounds,
  resolveCapsuleAabbDepenetration,
} from './manualRoamCollisionRecovery.ts';
import { ProceduralAvatarMorphAnimator } from './ProceduralAvatarMorphAnimator';
import {
  createInitialProceduralGaitState,
  resolveProceduralBodyMotion,
  stepProceduralGaitState,
  type ProceduralGaitState,
} from './proceduralAvatarAnimation';

export type ManualRoamAvatarAnimationMode = 'loading' | 'shared-skeleton' | 'auto-skeleton' | 'embedded' | 'procedural' | 'static' | 'error';

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
  engine: AbstractEngine;
  camera: ArcRotateCamera;
  canvas: HTMLCanvasElement;
  avatarUrl?: string;
  /** 无出生点的编辑场景暂不加载人物；首次设置资源或启用漫游时仍走完整加载。 */
  preloadAvatar?: boolean;
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
const AVATAR_BLOB_SHADOW_NAME = '__manual_roam_avatar_blob_shadow__';
const AVATAR_BLOB_SHADOW_TEXTURE_SIZE = 64;
const AVATAR_BLOB_SHADOW_SIZE_METERS = 0.85;
const AVATAR_BLOB_SHADOW_Y_OFFSET_METERS = 0.012;
const AVATAR_BLOB_SHADOW_MAX_HEIGHT_METERS = 1.5;
const FIXED_STEP_SECONDS = 1 / 30;
const MAX_OUTER_KINEMATIC_STEPS = 2;
const MAX_FRAME_SECONDS = 0.1;
const RESET_DURATION_MS = 520;
const FALL_RECOVERY_DISTANCE = 200;
const THIRD_PERSON_CAMERA_PADDING_METERS = 0.16;
const GROUND_SLOPE_LIMIT_COSINE = Math.cos(Math.PI / 4);
const CAMERA_FOLLOW_RESPONSE = 20;
const COLLISION_PROXY_QUERY_RADIUS_METERS = 24;
const MIN_COLLISION_QUERY_RADIUS_METERS = 10;
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
  private nearbyNativeMeshes: AbstractMesh[] = [];
  private lastSceneMeshSignature = '';
  private readonly tempRay = new Ray(Vector3.Zero(), Vector3.Down(), 1);
  private readonly beforeAnimationsObserver: Nullable<Observer<Scene>>;
  private readonly afterAnimationsObserver: Nullable<Observer<Scene>>;
  private avatarBlobShadowMesh: Mesh | null = null;
  private avatarBlobShadowMaterial: StandardMaterial | null = null;
  private avatarBlobShadowTexture: RawTexture | null = null;
  private lastGroundHeight: number | null = null;
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
  private readonly frameStartPosition = Vector3.Zero();
  private readonly frameVelocity = Vector3.Zero();
  private frameJumped = false;
  private motionResetThisFrame = false;
  private embeddedAnimator: ManualRoamEmbeddedAnimator | null = null;
  private animationGroups: AnimationGroup[] = [];
  private proceduralGaitState: ProceduralGaitState = createInitialProceduralGaitState();
  private proceduralAnimator: ProceduralAvatarMorphAnimator | null = null;
  private skeletalAnimator: ManualRoamAvatarAnimator | null = null;
  private avatarBaseYaw = 0;
  private avatarStatusMessage: string | null = null;
  private footIK: ManualRoamFootIK | null = null;
  private turnState = createManualRoamTurnState(0);
  private visualBasePosition = Vector3.Zero();
  private visualCenterOffset = Vector3.Zero();
  private avatarContainer: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
  private avatarUrl: string | null = null;
  private avatarLoadGeneration = 0;
  private avatarStrideAbort: AbortController | null = null;
  private resetTransition: ResetTransition | null = null;
  private previousCameraMode = Camera.PERSPECTIVE_CAMERA;
  private previousSceneCollisionsEnabled: boolean;
  private fallbackGroundRequired = false;
  private lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
  private readonly lastSafePosition = Vector3.Zero();
  private hasLastSafePosition = false;
  private disposed = false;

  constructor(private readonly options: ManualRoamRuntimeOptions) {
    const { scene } = options;
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
    // 关闭渲染渲染标记但保留拾取与碰撞，空场景也能稳定判定落地且不进入渲染队列。
    this.fallbackGround.isVisible = false;
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
    // 先提交本帧动画，再由引擎混合，最后执行IK；避免骨骼修正被late binding覆盖。
    this.beforeAnimationsObserver = scene.onBeforeAnimationsObservable.add(() => this.update());
    this.afterAnimationsObserver = scene.onAfterAnimationsObservable.add(() => this.updateFootIK());
    this.kinematicState = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
    this.bindInputEvents();
    if (this.options.preloadAvatar !== false) this.setAvatarUrl(this.options.avatarUrl);
  }

  getSnapshot = (): ManualRoamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.snapshot.enabled === enabled) return;
    if (enabled) {
      if (this.avatarUrl === null) this.setAvatarUrl(this.options.avatarUrl);
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
      this.options.camera.mode = Camera.PERSPECTIVE_CAMERA;
      setDigitalTwinCameraNearPlaneOverride(
        this.options.camera,
        resolveManualRoamCameraNearPlane({
          viewMode: this.snapshot.viewMode,
          config: this.snapshot.config,
        }),
      );
      this.options.setOrbitControlsEnabled(false);
      this.collider.setEnabled(true);
      this.applyAvatarVisibility(true, this.snapshot.viewMode);
      if (this.snapshot.viewMode === 'thirdPerson') {
        this.embeddedAnimator?.resume();
        this.skeletalAnimator?.sampleIdle();
        this.skeletalAnimator?.resume();
      }
      this.turnState = createManualRoamTurnState(this.kinematicState.yaw);
      this.footIK?.reset();
      this.options.onActivated?.();
      this.publish({
        enabled: true,
        grounded: this.snapshot.locomotionMode === 'ground' && this.kinematicState.grounded,
        statusMessage: this.resolveStatusMessage(true),
      });
      this.updateCamera(1);
      this.updateAvatarBlobShadow();
      return;
    }

    this.clearInputs();
    this.resetTransition = null;
    this.hasLastSafePosition = false;
    this.lastGroundHeight = null;
    this.exitPointerLock();
    this.collider.setEnabled(false);
    this.facingRoot.setEnabled(false);
    this.avatarBlobShadowMesh?.setEnabled(false);
    this.skeletalAnimator?.pause();
    this.footIK?.reset();
    this.embeddedAnimator?.pause();
    this.fallbackGround.setEnabled(false);
    this.collisionProxyPool?.deactivate();
    this.localTriangleCollider.deactivate();
    this.deactivateCollisionWorld();
    setDigitalTwinCameraNearPlaneOverride(this.options.camera, null);
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
    this.hasLastSafePosition = false;
    this.lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
    this.fallbackGround.setEnabled(false);
    this.collisionProxyPool?.deactivate();
    this.localTriangleCollider.clearScene();
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
    if (this.snapshot.enabled) {
      this.updateCamera(1);
      this.updateAvatarBlobShadow();
    }
  }

  setLocomotionMode(locomotionMode: ManualRoamLocomotionMode): void {
    if (this.snapshot.locomotionMode === locomotionMode) return;
    this.kinematicState.verticalVelocity = 0;
    if (locomotionMode === 'ground') {
      if (this.snapshot.enabled) {
        this.syncCollisionProxies(this.collider.position, true);
        this.depenetrateFromActiveAabbProxies(true);
      }
      this.snapCharacterToGround(true);
      if (this.snapshot.enabled) {
        this.syncCollisionProxies(this.collider.position, true);
        if (this.depenetrateFromActiveAabbProxies(true)) {
          this.snapCharacterToGround(true);
        }
        this.recordSafePositionIfClean();
      }
      this.kinematicState.position = vectorToRoam(this.collider.position);
    }
    this.publish({ locomotionMode, grounded: locomotionMode === 'ground' && this.kinematicState.grounded });
    if (this.snapshot.enabled) this.updateAvatarBlobShadow();
  }

  updateConfig(patch: Partial<ManualRoamConfig>): void {
    const config = sanitizeManualRoamConfig({ ...this.snapshot.config, ...patch });
    this.collider.ellipsoid.copyFromFloats(config.capsuleRadius, config.capsuleHeight / 2, config.capsuleRadius);
    this.collider.ellipsoidOffset.copyFromFloats(0, config.capsuleHeight / 2, 0);
    this.publish({ config });
    if (this.snapshot.enabled) {
      this.depenetrateFromActiveAabbProxies(false);
      this.kinematicState.position = vectorToRoam(this.collider.position);
      this.recordSafePositionIfClean();
    }
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
    this.skeletalAnimator?.sampleIdle();
    this.embeddedAnimator?.reset();
    this.frameVelocity.setAll(0);
    this.turnState = createManualRoamTurnState(this.kinematicState.yaw);
    this.applyAvatarFacing(this.avatarBaseYaw);
    this.footIK?.reset();
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
    this.avatarStrideAbort?.abort();
    this.avatarStrideAbort = null;
    this.clearInputs();
    this.exitPointerLock();
    this.unbindInputEvents();
    this.options.scene.onBeforeAnimationsObservable.remove(this.beforeAnimationsObserver);
    this.options.scene.onAfterAnimationsObservable.remove(this.afterAnimationsObserver);
    if (this.collisionMeshDefaults.size > 0) this.deactivateCollisionWorld();
    this.disposeAvatarBlobShadow();
    this.stopCurrentAnimation();
    this.embeddedAnimator = null;
    this.skeletalAnimator?.dispose();
    this.skeletalAnimator = null;
    this.footIK?.dispose(); this.footIK = null;
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

  /** 更换资源时失效旧请求，避免慢请求覆盖新人物或场景卸载后泄漏。 */
  setAvatarUrl(sourceUrl?: string): void {
    if (this.disposed) return;
    const avatarUrl = resolveRuntimeAssetUrl(sourceUrl ?? resolveDefaultManualRoamAvatarUrl());
    if (this.avatarUrl === avatarUrl) return;
    this.avatarUrl = avatarUrl;
    this.avatarStrideAbort?.abort();
    this.avatarStrideAbort = null;
    this.stopCurrentAnimation();
    this.embeddedAnimator = null;
    this.skeletalAnimator?.dispose();
    this.skeletalAnimator = null;
    this.footIK?.dispose(); this.footIK = null;
    this.turnState = createManualRoamTurnState(this.kinematicState.yaw);
    this.animationGroups = [];
    this.proceduralAnimator?.dispose();
    this.proceduralAnimator = null;
    this.avatarContainer?.dispose();
    this.avatarContainer = null;
    this.avatarMeshes.clear();
    this.avatarVisualRoot.position.setAll(0);
    this.avatarVisualRoot.setEnabled(false);
    this.avatarVisualRoot.rotation.setAll(0);
    this.avatarBaseYaw = 0;
    this.avatarStatusMessage = null;
    this.avatarVisualRoot.scaling.setAll(1);
    this.visualBasePosition.setAll(0);
    this.visualCenterOffset.setAll(0);
    this.publish({ avatarAnimationMode: 'loading', statusMessage: '人物模型加载中...' });
    void this.loadAvatar(avatarUrl, ++this.avatarLoadGeneration, !sourceUrl);
  }

  private async loadAvatar(avatarUrl: string, generation: number, isDefaultAvatar: boolean): Promise<void> {
    const { rootUrl, fileName } = splitAssetUrl(avatarUrl);
    let container: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
    try {
      container = await SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.options.scene, undefined, '.glb');
      if (this.disposed || generation !== this.avatarLoadGeneration) {
        container.dispose();
        return;
      }
      if (!container.meshes.some((mesh) => mesh.getTotalVertices() > 0)) throw new Error('人物模型没有可渲染网格。');
      for (const group of container.animationGroups) group.stop();
      for (const camera of [...container.cameras]) camera.dispose();
      for (const light of [...container.lights]) light.dispose();
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
      this.avatarContainer = container;
      let skeletalError: string | null = null;
      const notices: string[] = [];
      let shared = false;
      let automatic = false;
      try {
        const rigProfile = getManualRoamRigProfile(container);
        automatic = !rigProfile && container.skeletons.length > 0 && container.meshes.some(mesh => mesh.skeleton && mesh.getTotalVertices() > 0);
        if (rigProfile || automatic) {
          // 已声明规范的旧人物维持严格校验；普通蒙皮人物交给语义适配器。
          shared = Boolean(rigProfile);
          const modern = automatic || rigProfile === MANUAL_ROAM_RIG_PROFILE_V2;
          const animator = await ManualRoamAvatarAnimator.create(this.options.scene, container, {...resolveManualRoamMotionUrls(undefined, undefined, modern ? 'v2' : 'v1'),enableStrideWarp:modern});
          if (this.disposed || generation !== this.avatarLoadGeneration) {
            animator.dispose();
            container.dispose();
            return;
          }
          this.skeletalAnimator = animator;
          shared = true;
          const binding = animator.getRigBinding();
          this.avatarBaseYaw = binding.facingYaw;
          this.avatarVisualRoot.rotation.y = this.avatarBaseYaw;
          notices.push(...binding.warnings);
          if (modern) {
            try {
              this.footIK = new ManualRoamFootIK(container,{
                probeGround:(x,z,y,length)=>{const hit=this.pickGround(x,z,y,length);return hit?{height:hit.y,normal:hit.normal}:null;},
                maxCorrection:Math.min(.28,this.snapshot.config.stepHeight+.06),maxSlopeDegrees:45,
                ...(automatic ? { joints: binding.joints, automatic: true, footReferenceUp: binding.footReferenceUp } : {}),
              });
            } catch (error) {
              // 贴地是独立增强，不能撤销已经完整绑定的基础动作。
              this.footIK?.dispose(); this.footIK = null;
              notices.push(`基础动作可用，脚部贴地未启用：${getErrorMessage(error)}`);
            }
          }
          animator.setStrideWarpEnabled(Boolean(this.footIK));
        }
      } catch (error) {
        if (this.disposed || generation !== this.avatarLoadGeneration) { container.dispose(); return; }
        // 绑定失败仍保留可显示人物，不能冒充共享动作成功或任取内嵌动作。
        this.skeletalAnimator?.dispose(); this.skeletalAnimator = null;
        this.footIK?.dispose(); this.footIK = null;
        shared = !automatic;
        if (automatic) notices.push(`人物自动适配不可用：${getErrorMessage(error)}；${container.animationGroups.length ? '使用模型自带动画。' : '保留原始姿态。'}`);
        else skeletalError = `共享骨骼动作不可用：${getErrorMessage(error)}`;
      }
      if (this.disposed || generation !== this.avatarLoadGeneration) { container.dispose(); return; }
      this.normalizeAvatar(container.meshes);
      this.skeletalAnimator?.sampleIdle();
      if (!this.snapshot.enabled) this.skeletalAnimator?.pause();
      this.animationGroups = shared ? [] : [...container.animationGroups];
      if (this.animationGroups.length) {
        this.embeddedAnimator = new ManualRoamEmbeddedAnimator(this.animationGroups);
        notices.push(...this.embeddedAnimator.getWarnings());
        this.embeddedAnimator.reset();
        if (!this.snapshot.enabled) this.embeddedAnimator.pause();
      }
      if (!shared && isDefaultAvatar && this.animationGroups.length === 0) {
        const abort = new AbortController();
        this.avatarStrideAbort = abort;
        let animator: ProceduralAvatarMorphAnimator | null;
        try {
          animator = await ProceduralAvatarMorphAnimator.create(this.options.scene, container.meshes, abort.signal);
        } finally {
          if (this.avatarStrideAbort === abort) this.avatarStrideAbort = null;
        }
        if (this.disposed || generation !== this.avatarLoadGeneration) {
          animator?.dispose();
          container.dispose();
          return;
        }
        this.proceduralAnimator = animator;
      } else {
        this.proceduralAnimator = null;
      }
      this.avatarContainer = container;
      const avatarAnimationMode: ManualRoamAvatarAnimationMode = skeletalError ? 'error' : this.skeletalAnimator ? automatic ? 'auto-skeleton' : 'shared-skeleton' : this.animationGroups.length > 0
        ? 'embedded'
        : this.proceduralAnimator ? 'procedural' : 'static';
      this.applyAvatarVisibility(this.snapshot.enabled, this.snapshot.viewMode);
      this.avatarVisualRoot.setEnabled(true);
      this.avatarStatusMessage = notices.length ? notices.join(' ') : automatic && this.skeletalAnimator ? '已自动适配漫游动作与脚部贴地。' : null;
      this.publish({
        avatarAnimationMode,
        statusMessage: skeletalError ?? this.avatarStatusMessage ?? (avatarAnimationMode === 'procedural'
          ? '当前人物模型无骨骼动画，已启用程序化步态。'
          : avatarAnimationMode === 'static' ? '人物模型无内置动画，保留原始姿态。' : null),
      });
      this.options.onLog?.(
        skeletalError ?? this.avatarStatusMessage ?? (avatarAnimationMode === 'shared-skeleton' ? '人物模型加载完成，已绑定共享骨骼动作。' : avatarAnimationMode === 'embedded'
          ? `人物模型加载完成，检测到 ${this.animationGroups.length} 个动画片段。`
          : avatarAnimationMode === 'static' ? '人物模型加载完成，保留原始姿态。'
            : `人物模型加载完成；未检测到蒙皮动画，已为 ${this.proceduralAnimator?.meshCount ?? 0} 个网格启用程序化四肢步态。`),
      );
    } catch (error) {
      if (container) {
        for (const mesh of container.meshes) this.avatarMeshes.delete(mesh);
        if (this.avatarContainer === container) this.avatarContainer = null;
        container.dispose();
      }
      if (this.disposed || generation !== this.avatarLoadGeneration) return;
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
    const offsetX = -(initialBounds.minimum.x + initialBounds.maximum.x) / 2 * scale;
    const offsetZ = -(initialBounds.minimum.z + initialBounds.maximum.z) / 2 * scale;
    this.visualCenterOffset.set(offsetX, -initialBounds.minimum.y * scale, offsetZ);
    this.applyAvatarFacing(this.avatarVisualRoot.rotation.y);
    this.visualBasePosition = this.avatarVisualRoot.position.clone();
  }

  private applyAvatarFacing(yaw: number): void {
    this.avatarVisualRoot.rotation.y = yaw;
    // 局部原点不在身体中心时，初次校准和转身都必须围绕人物中心旋转。
    const offset = this.visualCenterOffset;
    this.avatarVisualRoot.position.set(offset.x * Math.cos(yaw) + offset.z * Math.sin(yaw), offset.y,
      offset.z * Math.cos(yaw) - offset.x * Math.sin(yaw));
  }

  private update(): void {
    if (!this.snapshot.enabled || this.disposed) return;
    const proxiesChanged = this.syncCollisionProxies(this.collider.position);
    if (this.resetTransition) {
      this.updateResetTransition();
      this.updateCamera(this.options.engine.getDeltaTime() / 1000);
      return;
    }
    if (proxiesChanged) {
      this.depenetrateFromActiveAabbProxies(false);
      this.kinematicState.position = vectorToRoam(this.collider.position);
      this.recordSafePositionIfClean();
    }

    const frameSeconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, this.options.engine.getDeltaTime() / 1000));
    const input = this.collectInputFrame(frameSeconds);
    this.frameStartPosition.copyFrom(this.collider.position);
    this.frameJumped = false;
    this.motionResetThisFrame = false;
    // 限制低帧率时的外层运动学子步数，防止帧率降低后子步放大引发性能雪崩。
    const outerSteps = frameSeconds <= FIXED_STEP_SECONDS
      ? 1
      : Math.min(MAX_OUTER_KINEMATIC_STEPS, Math.ceil(frameSeconds / FIXED_STEP_SECONDS));
    const stepDelta = frameSeconds / outerSteps;
    for (let stepIndex = 0; stepIndex < outerSteps; stepIndex += 1) {
      const substepInput = stepIndex === 0
        ? input
        : { ...input, lookX: 0, lookY: 0, jump: false };
      this.stepCharacter(substepInput, stepDelta);
    }
    // 碰撞与台阶修正之后采样；复位不属于人物运动，不能放大步频。
    if (frameSeconds > 1e-6 && !this.motionResetThisFrame) {
      this.collider.position.subtractToRef(this.frameStartPosition, this.frameVelocity);
      this.frameVelocity.scaleInPlace(1 / frameSeconds);
    } else {
      this.frameVelocity.setAll(0);
    }
    this.updateCamera(frameSeconds);
    this.updateAvatarAnimation(input, frameSeconds);
    this.updateAvatarBlobShadow();
    const moving = Math.hypot(this.frameVelocity.x, this.frameVelocity.z,
      this.snapshot.locomotionMode === 'fly' ? this.frameVelocity.y : 0) > 0.03;
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
    this.frameJumped ||= step.jumped;

    const totalDisplacement = new Vector3(step.displacement.x, step.displacement.y, step.displacement.z);
    const substeps = computeCollisionSubstepCount(
      totalDisplacement,
      this.snapshot.config.capsuleRadius,
    );
    const substepDisplacement = substeps > 1
      ? totalDisplacement.scale(1 / substeps)
      : totalDisplacement;
    for (let index = 0; index < substeps; index += 1) {
      if (this.snapshot.locomotionMode === 'ground' && this.kinematicState.grounded) {
        this.moveWithSafeStepAssist(substepDisplacement);
      } else {
        this.moveColliderWithCollisions(substepDisplacement);
      }
    }

    if (this.snapshot.locomotionMode === 'ground') this.snapCharacterToGround(false);
    else this.kinematicState.grounded = false;

    if (this.depenetrateFromActiveAabbProxies(false) && this.snapshot.locomotionMode === 'ground') {
      this.snapCharacterToGround(false);
    }
    this.recordSafePositionIfClean();

    this.kinematicState.position = vectorToRoam(this.collider.position);
    this.facingRoot.rotation.y = this.kinematicState.yaw;

    if (this.collider.position.y < this.spawnPosition.y - FALL_RECOVERY_DISTANCE) {
      this.finishResetImmediately();
    }
  }

  private moveColliderWithCollisions(displacement: Vector3): void {
    this.collider.computeWorldMatrix(true);
    this.collider.moveWithCollisions(displacement);
    this.collider.computeWorldMatrix(true);
  }

  private moveWithSafeStepAssist(displacement: Vector3): void {
    const requestedHoriz = Math.hypot(displacement.x, displacement.z);
    const beforePos = this.collider.position.clone();
    this.moveColliderWithCollisions(displacement);
    if (requestedHoriz < 1e-5) return;

    const actualHoriz = Math.hypot(
      this.collider.position.x - beforePos.x,
      this.collider.position.z - beforePos.z,
    );
    if (actualHoriz >= requestedHoriz * 0.9) return;

    const config = this.snapshot.config;
    const dirX = displacement.x / requestedHoriz;
    const dirZ = displacement.z / requestedHoriz;
    const probeRadiusOffset = config.capsuleRadius + requestedHoriz;
    const probeOriginY = beforePos.y + config.stepHeight + 0.08;
    const probeLength = config.stepHeight + config.groundProbeDistance + 0.08;

    const hit = this.pickGround(
      beforePos.x + dirX * probeRadiusOffset,
      beforePos.z + dirZ * probeRadiusOffset,
      probeOriginY,
      probeLength,
    );
    let rise = hit ? hit.y - beforePos.y : 0;
    if (!hit || rise <= 0.015 || rise > config.stepHeight) {
      const fallbackHit = this.pickGround(
        beforePos.x + displacement.x,
        beforePos.z + displacement.z,
        probeOriginY,
        probeLength,
      );
      const fallbackRise = fallbackHit ? fallbackHit.y - beforePos.y : 0;
      if (!fallbackHit || fallbackRise <= 0.015 || fallbackRise > config.stepHeight) return;
      rise = fallbackRise;
    }

    const normalPos = this.collider.position.clone();
    const liftHeight = rise + 0.015;
    this.collider.position.copyFrom(beforePos);
    this.collider.computeWorldMatrix(true);

    this.moveColliderWithCollisions(new Vector3(0, liftHeight, 0));
    const actualLift = this.collider.position.y - beforePos.y;
    if (actualLift < rise * 0.85) {
      this.collider.position.copyFrom(normalPos);
      this.collider.computeWorldMatrix(true);
      return;
    }

    this.moveColliderWithCollisions(new Vector3(displacement.x, 0, displacement.z));
    const stepHoriz = Math.hypot(
      this.collider.position.x - beforePos.x,
      this.collider.position.z - beforePos.z,
    );
    if (stepHoriz <= actualHoriz + 1e-4) {
      this.collider.position.copyFrom(normalPos);
      this.collider.computeWorldMatrix(true);
      return;
    }

    this.moveColliderWithCollisions(new Vector3(0, -liftHeight, 0));

    const landedHit = this.pickGround(
      this.collider.position.x,
      this.collider.position.z,
      this.collider.position.y + config.stepHeight + 0.08,
      config.stepHeight + config.groundProbeDistance + 0.08,
    );
    if (
      !landedHit
      || (landedHit.y - this.collider.position.y > 0.04)
      || (
        Math.abs(this.collider.position.y - landedHit.y) > Math.max(0.03, config.stepHeight * 0.25)
        && !this.hasWalkableEdgeSupport(this.collider.position, config.groundProbeDistance)
      )
    ) {
      this.collider.position.copyFrom(normalPos);
      this.collider.computeWorldMatrix(true);
      return;
    }

    const activeBounds = this.collisionProxyPool?.getActiveBounds() ?? [];
    if (
      activeBounds.length > 0
      && findOverlappingAabbBounds(
        vectorToRoam(this.collider.position),
        config.capsuleRadius,
        config.capsuleHeight,
        activeBounds,
      ).length > 0
    ) {
      this.collider.position.copyFrom(normalPos);
      this.collider.computeWorldMatrix(true);
    }
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
      this.collider.position.y + config.stepHeight + 0.08,
      config.stepHeight + config.groundProbeDistance + 0.08,
    );
    this.lastGroundHeight = hit ? hit.y : null;
    if (!hit || hit.y > this.collider.position.y + config.stepHeight) {
      this.kinematicState.grounded = false;
      return;
    }
    const distance = this.collider.position.y - hit.y;
    if (!force && (distance < -config.stepHeight || distance > config.groundProbeDistance)) {
      this.kinematicState.grounded = false;
      return;
    }
    if (distance < -0.015) {
      this.tempRay.origin.copyFromFloats(
        this.collider.position.x,
        this.collider.position.y + config.capsuleHeight - 0.01,
        this.collider.position.z,
      );
      this.tempRay.direction.copyFromFloats(0, 1, 0);
      this.tempRay.length = -distance + 0.03;
      const ceiling = this.pickNearestCollisionRay(this.tempRay, true);
      if (ceiling?.hit) {
        this.kinematicState.grounded = false;
        return;
      }
    }
    if (force) {
      this.collider.position.y = hit.y;
      this.collider.computeWorldMatrix(true);
      this.kinematicState.verticalVelocity = 0;
      this.kinematicState.grounded = true;
      return;
    }

    const deltaY = hit.y - this.collider.position.y;
    const snapTolerance = Math.max(0.03, config.stepHeight * 0.25);
    if (Math.abs(deltaY) > 1e-4) {
      const beforeY = this.collider.position.y;
      this.moveColliderWithCollisions(new Vector3(0, deltaY, 0));
      const movedY = this.collider.position.y - beforeY;
      if (deltaY > 0.015 && movedY < deltaY * 0.5 && Math.abs(this.collider.position.y - hit.y) > snapTolerance) {
        this.kinematicState.grounded = false;
        return;
      }
    }

    if (Math.abs(this.collider.position.y - hit.y) <= snapTolerance) {
      this.kinematicState.verticalVelocity = 0;
      this.kinematicState.grounded = true;
      return;
    }
    if (deltaY < -1e-4 && this.hasWalkableEdgeSupport(this.collider.position, config.groundProbeDistance)) {
      this.kinematicState.verticalVelocity = 0;
      this.kinematicState.grounded = true;
      return;
    }
    this.kinematicState.grounded = false;
  }

  private hasWalkableEdgeSupport(position: Readonly<Vector3>, maxProbeDistance: number): boolean {
    const config = this.snapshot.config;
    const offset = Math.max(0.08, config.capsuleRadius * 0.85);
    const snapTolerance = Math.max(0.03, config.stepHeight * 0.25);
    const originY = position.y + config.stepHeight + 0.08;
    const length = config.stepHeight + Math.max(maxProbeDistance, config.groundProbeDistance) + 0.08;
    const offsets: ReadonlyArray<[number, number]> = [
      [offset, 0],
      [-offset, 0],
      [0, offset],
      [0, -offset],
    ];
    for (const [dx, dz] of offsets) {
      const hit = this.pickGround(position.x + dx, position.z + dz, originY, length);
      if (hit && Math.abs(position.y - hit.y) <= snapTolerance) return true;
    }
    return false;
  }

  private depenetrateFromActiveAabbProxies(
    allowRadialFallback: boolean,
    locomotionMode: ManualRoamLocomotionMode = this.snapshot.locomotionMode,
  ): boolean {
    if (!this.collisionProxyPool) return false;
    const activeBounds = this.collisionProxyPool.getActiveBounds();
    if (activeBounds.length === 0) return false;

    const config = this.snapshot.config;
    const initialPos = vectorToRoam(this.collider.position);
    const initialOverlaps = findOverlappingAabbBounds(
      initialPos,
      config.capsuleRadius,
      config.capsuleHeight,
      activeBounds,
    );
    if (initialOverlaps.length === 0) return false;

    const result = resolveCapsuleAabbDepenetration({
      position: initialPos,
      capsuleRadius: config.capsuleRadius,
      capsuleHeight: config.capsuleHeight,
      bounds: activeBounds,
      stepHeight: config.stepHeight,
      allowVerticalExit: locomotionMode === 'fly',
    });

    if (result.overlappingIds.length > 0) {
      const exitDelta = new Vector3(
        result.position.x - this.collider.position.x,
        result.position.y - this.collider.position.y,
        result.position.z - this.collider.position.z,
      );
      if (exitDelta.lengthSquared() > 1e-8) {
        const disabledProxies: Array<{ proxy: Mesh; checkCollisions: boolean }> = [];
        try {
          for (const id of result.overlappingIds) {
            const proxy = this.collisionProxyPool.getActiveProxyById(id);
            if (proxy && proxy.checkCollisions) {
              disabledProxies.push({ proxy, checkCollisions: proxy.checkCollisions });
              proxy.checkCollisions = false;
            }
          }
          const substeps = computeCollisionSubstepCount(exitDelta, config.capsuleRadius);
          const stepDelta = substeps > 1 ? exitDelta.scale(1 / substeps) : exitDelta;
          for (let index = 0; index < substeps; index += 1) {
            this.moveColliderWithCollisions(stepDelta);
          }
        } finally {
          for (const entry of disabledProxies) {
            entry.proxy.checkCollisions = entry.checkCollisions;
          }
        }
      }
    }

    const remainingAfterMove = findOverlappingAabbBounds(
      vectorToRoam(this.collider.position),
      config.capsuleRadius,
      config.capsuleHeight,
      activeBounds,
    );
    if (remainingAfterMove.length === 0) return true;

    const hasCleanLastSafe = this.hasLastSafePosition
      && findOverlappingAabbBounds(
        vectorToRoam(this.lastSafePosition),
        config.capsuleRadius,
        config.capsuleHeight,
        activeBounds,
      ).length === 0;

    if (!allowRadialFallback && hasCleanLastSafe) {
      this.collider.position.copyFrom(this.lastSafePosition);
      this.collider.computeWorldMatrix(true);
      return true;
    }

    if (allowRadialFallback || !hasCleanLastSafe) {
      for (const candidate of buildSafeRadialCandidatePositions(initialPos)) {
        if (
          findOverlappingAabbBounds(
            candidate,
            config.capsuleRadius,
            config.capsuleHeight,
            activeBounds,
          ).length > 0
        ) {
          continue;
        }
        if (locomotionMode === 'ground') {
          const candidateGround = this.pickGround(
            candidate.x,
            candidate.z,
            candidate.y + config.capsuleHeight,
            config.capsuleHeight * 2 + config.groundProbeDistance,
          );
          if (!candidateGround) continue;
          const groundedCandidate = { x: candidate.x, y: candidateGround.y, z: candidate.z };
          if (
            findOverlappingAabbBounds(
              groundedCandidate,
              config.capsuleRadius,
              config.capsuleHeight,
              activeBounds,
            ).length > 0
          ) {
            continue;
          }
          this.collider.position.set(groundedCandidate.x, groundedCandidate.y, groundedCandidate.z);
          this.collider.computeWorldMatrix(true);
          return true;
        }
        this.collider.position.set(candidate.x, candidate.y, candidate.z);
        this.collider.computeWorldMatrix(true);
        return true;
      }
      if (result.resolved) {
        this.collider.position.set(result.position.x, result.position.y, result.position.z);
        this.collider.computeWorldMatrix(true);
        return true;
      }
    }

    return false;
  }

  private recordSafePositionIfClean(): void {
    const activeBounds = this.collisionProxyPool?.getActiveBounds() ?? [];
    if (
      activeBounds.length > 0
      && findOverlappingAabbBounds(
        vectorToRoam(this.collider.position),
        this.snapshot.config.capsuleRadius,
        this.snapshot.config.capsuleHeight,
        activeBounds,
      ).length > 0
    ) {
      return;
    }
    this.lastSafePosition.copyFrom(this.collider.position);
    this.hasLastSafePosition = true;
  }

  private pickGround(
    x: number,
    z: number,
    originY: number,
    length: number,
    includeFallback = true,
  ): GroundHit | null {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(originY) || !Number.isFinite(length) || length <= 0) {
      return null;
    }
    const minY = originY - length;
    const topMargin = originY + 1e-5;
    const bottomMargin = minY - 1e-5;
    let bestHit: GroundHit | null = this.localTriangleCollider.probeVerticalRay(
      x,
      z,
      originY,
      length,
      GROUND_SLOPE_LIMIT_COSINE,
    );

    // AABB 代理盒（模型阵列、thin instance 与紧凑高模）解析求解顶面命中。
    const activeBounds = this.collisionProxyPool?.getActiveBounds();
    if (activeBounds) {
      for (let index = 0; index < activeBounds.length; index += 1) {
        const bound = activeBounds[index];
        const maxY = bound.maximum.y;
        if (maxY > topMargin || maxY < bottomMargin) continue;
        if (bestHit && maxY <= bestHit.y) continue;
        if (
          x >= bound.minimum.x - 1e-5
          && x <= bound.maximum.x + 1e-5
          && z >= bound.minimum.z - 1e-5
          && z <= bound.maximum.z + 1e-5
        ) {
          bestHit = { y: maxY, normal: Vector3.Up() };
        }
      }
    }

    // 备用地面解析求解（5000m×5000m 水平面）。
    if (includeFallback && this.fallbackGround.isEnabled()) {
      const fgPos = this.fallbackGround.position;
      if (
        fgPos.y <= topMargin
        && fgPos.y >= bottomMargin
        && (!bestHit || fgPos.y > bestHit.y)
        && Math.abs(x - fgPos.x) <= 2500
        && Math.abs(z - fgPos.z) <= 2500
      ) {
        bestHit = { y: fgPos.y, normal: Vector3.Up() };
      }
    }

    // 邻域廉价网格（<=2048 顶点）：只对真正覆盖 (x, z) 列的网格做精确求交，不扫描全场景。
    if (this.nearbyNativeMeshes.length > 0) {
      const ray = this.tempRay;
      ray.origin.copyFromFloats(x, originY, z);
      ray.direction.copyFromFloats(0, -1, 0);
      ray.length = length;

      for (let index = 0; index < this.nearbyNativeMeshes.length; index += 1) {
        const mesh = this.nearbyNativeMeshes[index];
        if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || !mesh.isPickable || !mesh.checkCollisions) {
          continue;
        }
        if (!mesh.isSynchronized()) mesh.computeWorldMatrix(true);
        const box = mesh.getBoundingInfo().boundingBox;
        const min = box.minimumWorld;
        const max = box.maximumWorld;
        if (
          x < min.x - 1e-5
          || x > max.x + 1e-5
          || z < min.z - 1e-5
          || z > max.z + 1e-5
          || max.y < bottomMargin
          || min.y > topMargin
          || (bestHit && max.y <= bestHit.y)
        ) continue;

        const hit = mesh.intersects(ray, false);
        if (!hit.hit || !hit.pickedPoint) continue;
        const hitY = hit.pickedPoint.y;
        if (bestHit && hitY <= bestHit.y) continue;
        const normal = hit.getNormal(true) ?? Vector3.Up();
        if (normal.y >= GROUND_SLOPE_LIMIT_COSINE) {
          bestHit = { y: hitY, normal };
          continue;
        }

        // 射线先碰到该单个网格的陡坡/侧面时，只针对此网格再查找其后的可行走表面。
        const hits = this.options.scene.multiPickWithRay(ray, (candidate) => candidate === mesh) ?? [];
        for (const candidateHit of hits) {
          if (!candidateHit.hit || !candidateHit.pickedPoint) continue;
          const candidateY = candidateHit.pickedPoint.y;
          if (bestHit && candidateY <= bestHit.y) continue;
          const candidateNormal = candidateHit.getNormal(true) ?? Vector3.Up();
          if (candidateNormal.y >= GROUND_SLOPE_LIMIT_COSINE) {
            bestHit = { y: candidateY, normal: candidateNormal };
          }
        }
      }
    }

    return bestHit;
  }

  private pickNearestCollisionRay(
    ray: Ray,
    includeFallback = true,
  ): { hit: boolean; distance: number } | null {
    const candidates = this.collider.surroundingMeshes;
    if (!candidates || candidates.length === 0) return null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < candidates.length; index += 1) {
      const mesh = candidates[index];
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.checkCollisions) continue;
      if (mesh === this.fallbackGround) {
        if (!includeFallback) continue;
      } else if (!this.collisionProxyPool?.has(mesh) && !this.localTriangleCollider.has(mesh)) {
        if (!mesh.isVisible || !mesh.isPickable) continue;
      }
      if (!mesh.isSynchronized()) mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      if (!ray.intersectsBoxMinMax(box.minimumWorld, box.maximumWorld)) continue;
      const pick = mesh.intersects(ray, false);
      if (pick.hit && pick.distance < bestDistance) {
        bestDistance = pick.distance;
      }
    }
    return Number.isFinite(bestDistance) ? { hit: true, distance: bestDistance } : null;
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
      setDigitalTwinCameraNearPlaneOverride(
        this.options.camera,
        resolveManualRoamCameraNearPlane({
          viewMode: 'firstPerson',
          config,
        }),
      );
      return;
    }

    const target = new Vector3(foot.x, foot.y + config.thirdPersonHeight, foot.z);
    const desiredPosition = target.subtract(lookDirection.scale(config.thirdPersonDistance));
    const cameraRayDirection = desiredPosition.subtract(target);
    const desiredDistance = cameraRayDirection.length();
    if (desiredDistance > 1e-5) cameraRayDirection.scaleInPlace(1 / desiredDistance);
    this.tempRay.origin.copyFrom(target);
    this.tempRay.direction.copyFrom(cameraRayDirection);
    this.tempRay.length = desiredDistance;
    const cameraHit = this.pickNearestCollisionRay(this.tempRay, true);
    let obstructionClearanceMeters: number | null = null;
    if (cameraHit?.hit && cameraHit.distance < desiredDistance) {
      const collisionPadding = Math.min(
        THIRD_PERSON_CAMERA_PADDING_METERS,
        Math.max(0, cameraHit.distance) * 0.5,
      );
      obstructionClearanceMeters = collisionPadding;
      desiredPosition.copyFrom(target).addInPlace(cameraRayDirection.scale(
        Math.max(0, cameraHit.distance - collisionPadding),
      ));
    }

    const blend = deltaSeconds >= 1 ? 1 : 1 - Math.exp(-CAMERA_FOLLOW_RESPONSE * Math.max(0, deltaSeconds));
    const position = Vector3.Lerp(this.options.camera.position, desiredPosition, blend);
    this.options.camera.setTarget(target);
    this.options.camera.setPosition(position);
    setDigitalTwinCameraNearPlaneOverride(
      this.options.camera,
      resolveManualRoamCameraNearPlane({
        viewMode: 'thirdPerson',
        config,
        cameraDistanceMeters: Vector3.Distance(target, position),
        obstructionClearanceMeters,
      }),
    );
  }

  /** 用实际水平速度驱动程序化步态或内置走/跑片段，使步频与位移同步。 */
  private updateAvatarAnimation(input: Readonly<RoamInputFrame>, deltaSeconds: number): void {
    if (this.snapshot.viewMode !== 'thirdPerson') return;
    if (this.skeletalAnimator) {
      const horizontalSpeed=Math.hypot(this.frameVelocity.x,this.frameVelocity.z);
      const orientToMovement=(!!this.footIK || this.snapshot.avatarAnimationMode === 'auto-skeleton')&&this.snapshot.locomotionMode==='ground';
      const movementYaw=horizontalSpeed>.03?Math.atan2(this.frameVelocity.x,this.frameVelocity.z):undefined;
      const turnMotion = this.skeletalAnimator.getTurnMotion();
      if(Object.keys(turnMotion.turnDurations).length) {
        this.turnState=stepManualRoamTurnState(this.turnState,{deltaSeconds,controlYaw:this.kinematicState.yaw,
          horizontalSpeed,grounded:this.kinematicState.grounded,orientToMovement,movementYaw,
          gaitPoseActive: horizontalSpeed <= .03 && this.skeletalAnimator.hasGaitPose(),
          fly:this.snapshot.locomotionMode==='fly',...turnMotion});
        this.applyAvatarFacing(this.avatarBaseYaw+this.turnState.visualYaw-this.kinematicState.yaw);
      } else this.turnState=createManualRoamTurnState(this.kinematicState.yaw);
      this.skeletalAnimator.update({
        deltaSeconds, velocityX: this.frameVelocity.x, velocityZ: this.frameVelocity.z,
        // 巡检人物以真实行进方向前走，视觉根平滑跟随；控制yaw仍独立负责键位和相机。
        yaw: orientToMovement&&movementYaw!==undefined?movementYaw:this.turnState.animationYaw,
        verticalVelocity: this.snapshot.locomotionMode === 'fly' ? this.frameVelocity.y : this.kinematicState.verticalVelocity,
        grounded: this.kinematicState.grounded, jumped: this.frameJumped,
        fly: this.snapshot.locomotionMode === 'fly', sprint: input.sprint,
        walkSpeed: this.snapshot.config.walkSpeed, runSpeed: this.snapshot.config.runSpeed, worldScale: this.avatarVisualRoot.scaling.y,
        turnDeltaYaw: this.turnState.deltaYaw,
        turn: this.turnState.turnClip ? {
          clip: this.turnState.turnClip,
          progress: this.turnState.turnProgress,
          weight: this.turnState.turnWeight,
          angleScale: Math.abs(this.turnState.targetYaw - this.turnState.startYaw)
            / (this.turnState.turnClip.endsWith('180') ? Math.PI : Math.PI / 2),
        } : undefined,
      });
      return;
    }
    if (this.snapshot.avatarAnimationMode === 'static') return;
    const horizontalSpeed = Math.hypot(this.frameVelocity.x, this.frameVelocity.z);
    const referenceSpeed = input.sprint ? this.snapshot.config.runSpeed : this.snapshot.config.walkSpeed;
    const horizontalAmount = Math.min(1, horizontalSpeed / referenceSpeed);
    const airborne = this.snapshot.locomotionMode === 'ground' && !this.kinematicState.grounded;
    if (this.embeddedAnimator) {
      this.embeddedAnimator.update({
        deltaSeconds, velocityX: this.frameVelocity.x, velocityZ: this.frameVelocity.z,
        yaw: this.kinematicState.yaw, verticalVelocity: this.snapshot.locomotionMode === 'fly' ? this.frameVelocity.y : this.kinematicState.verticalVelocity,
        grounded: this.kinematicState.grounded, jumped: this.frameJumped,
        fly: this.snapshot.locomotionMode === 'fly', sprint: input.sprint,
        walkSpeed: this.snapshot.config.walkSpeed, runSpeed: this.snapshot.config.runSpeed, worldScale: 1,
      });
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

  private updateFootIK(): void {
    if (!this.snapshot.enabled || this.disposed || this.snapshot.viewMode !== 'thirdPerson' || !this.skeletalAnimator) {
      return;
    }
    this.skeletalAnimator.applyUpperBodyOverlay();
    if(!this.footIK)return;
    const speed = Math.hypot(this.frameVelocity.x, this.frameVelocity.z);
    this.footIK.update({
      dt: this.options.engine.getDeltaTime() / 1000,
      grounded: this.kinematicState.grounded,
      fly: this.snapshot.locomotionMode === 'fly',
      teleported: this.motionResetThisFrame || Boolean(this.resetTransition),
      footContacts: this.skeletalAnimator.getFootContacts(),
      speed,
      gaitPoseActive: speed <= .03 && this.skeletalAnimator.hasGaitPose(),
      strideScale: this.skeletalAnimator.getStrideScale(),
      movementYawRemaining: this.turnState.deltaYaw,
      turning: speed > .03 && Math.abs(this.turnState.deltaYaw) > .08,
    });
  }

  private stopCurrentAnimation(): void {
    this.embeddedAnimator?.stop();
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
    this.collider.computeWorldMatrix(true);
    this.snapCharacterToGround(true);
    this.syncCollisionProxies(this.collider.position, true);
    if (this.depenetrateFromActiveAabbProxies(true)) {
      this.snapCharacterToGround(true);
    }
    this.collider.computeWorldMatrix(true);
    this.kinematicState.position = vectorToRoam(this.collider.position);
    this.recordSafePositionIfClean();
    this.publish({ grounded: this.kinematicState.grounded, statusMessage: this.resolveStatusMessage(true) });
  }

  private finishResetImmediately(): void {
    this.motionResetThisFrame = true;
    this.skeletalAnimator?.sampleIdle();
    this.embeddedAnimator?.reset();
    this.footIK?.reset();
    this.resetTransition = null;
    this.hasLastSafePosition = false;
    this.collider.position.copyFrom(this.spawnPosition);
    this.collider.computeWorldMatrix(true);
    this.kinematicState = createInitialRoamKinematicState(
      vectorToRoam(this.spawnPosition),
      { yaw: this.spawnYaw, pitch: this.spawnPitch },
    );
    this.snapCharacterToGround(true);
    this.syncCollisionProxies(this.collider.position, true);
    if (this.depenetrateFromActiveAabbProxies(true)) {
      this.snapCharacterToGround(true);
    }
    this.collider.computeWorldMatrix(true);
    this.kinematicState.position = vectorToRoam(this.collider.position);
    this.recordSafePositionIfClean();
    this.turnState = createManualRoamTurnState(this.kinematicState.yaw);
    this.applyAvatarFacing(this.avatarBaseYaw);
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
    this.collider.computeWorldMatrix(true);
    this.kinematicState = createInitialRoamKinematicState(vectorToRoam(this.spawnPosition), { yaw, pitch });
    this.snapCharacterToGround(true);
    this.syncCollisionProxies(this.collider.position, true);
    if (this.depenetrateFromActiveAabbProxies(true)) {
      this.syncCollisionProxies(this.collider.position, true);
      this.snapCharacterToGround(true);
    }
    this.collider.computeWorldMatrix(true);
    this.spawnPosition.copyFrom(this.collider.position);
    this.kinematicState.position = vectorToRoam(this.collider.position);
    this.recordSafePositionIfClean();
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
    this.collider.computeWorldMatrix(true);
    this.kinematicState = createInitialRoamKinematicState(
      vectorToRoam(position),
      { yaw: pose.yaw, pitch: this.spawnPitch },
    );
    this.facingRoot.rotation.y = pose.yaw;
    this.snapCharacterToGround(true);
    this.syncCollisionProxies(this.collider.position, true);
    if (this.depenetrateFromActiveAabbProxies(true)) {
      this.syncCollisionProxies(this.collider.position, true);
      this.snapCharacterToGround(true);
    }
    this.collider.computeWorldMatrix(true);
    this.spawnPosition.copyFrom(this.collider.position);
    this.kinematicState.position = vectorToRoam(this.collider.position);
    this.recordSafePositionIfClean();
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

  private registerCollisionMesh(mesh: AbstractMesh): void {
    if (this.collisionMeshDefaults.has(mesh) || !this.shouldRegisterCollisionMesh(mesh)) return;
    if (!mesh.isSynchronized()) mesh.computeWorldMatrix(true);
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
    this.lastSceneMeshSignature = '';
    this.collisionWorldDirty = true;
    this.reconcileCollisionMeshes(nowMilliseconds(), true);
    if (this.fallbackGroundRequired) this.fallbackGround.setEnabled(true);
    this.disableFallbackGroundWhenSceneFloorIsReady();
  }

  private deactivateCollisionWorld(): void {
    this.collisionProxyPool?.deactivate();
    this.localTriangleCollider.deactivate();
    this.lastCollisionMeshReconcileMs = Number.NEGATIVE_INFINITY;
    this.lastSceneMeshSignature = '';
    this.nearbyNativeMeshes = [];
    this.restoreCollisionBoundingBoxes();
    for (const [mesh, original] of this.collisionMeshDefaults) {
      if (!mesh.isDisposed()) mesh.checkCollisions = original;
    }
    this.collisionMeshDefaults.clear();
    this.collider.surroundingMeshes = null;
    this.collisionWorldDirty = false;
    this.options.scene.collisionsEnabled = this.previousSceneCollisionsEnabled;
  }

  private getCollisionQueryRadiusMeters(): number {
    if (this.snapshot.viewMode === 'firstPerson') return MIN_COLLISION_QUERY_RADIUS_METERS;
    return Math.max(
      MIN_COLLISION_QUERY_RADIUS_METERS,
      Math.min(COLLISION_PROXY_QUERY_RADIUS_METERS, Math.ceil(this.snapshot.config.thirdPersonDistance + 6)),
    );
  }

  private getSceneMeshSignature(): string {
    const meshes = this.options.scene.meshes;
    const lastId = meshes.length > 0 ? meshes[meshes.length - 1].uniqueId : 0;
    return `${meshes.length}:${lastId}`;
  }

  private shouldRegisterCollisionMesh(mesh: AbstractMesh): boolean {
    if (
      mesh === this.collider
      || mesh === this.fallbackGround
      || mesh === this.avatarBlobShadowMesh
      || this.avatarMeshes.has(mesh)
    ) return false;
    if (mesh.name.startsWith(MANUAL_ROAM_COLLISION_PROXY_PREFIX)) return false;
    return resolveManualRoamCollisionStyle(mesh) === 'native-triangle';
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
    const sceneSignature = this.getSceneMeshSignature();
    const sceneMeshesChanged = sceneSignature !== this.lastSceneMeshSignature;
    if (
      !force
      && !sceneMeshesChanged
      && nowMs - this.lastCollisionMeshReconcileMs < COLLISION_MESH_RECONCILE_INTERVAL_MS
    ) return;
    this.lastCollisionMeshReconcileMs = nowMs;

    if (force || sceneMeshesChanged) {
      this.lastSceneMeshSignature = sceneSignature;
      const previousIndexed = this.localTriangleCollider.indexedCount;
      this.localTriangleCollider.captureScene(this.options.scene.meshes);
      if (this.localTriangleCollider.indexedCount !== previousIndexed) {
        this.collisionWorldDirty = true;
      }
      for (const mesh of [...this.collisionMeshDefaults.keys()]) {
        if (!this.shouldRegisterCollisionMesh(mesh)) {
          this.unregisterCollisionMesh(mesh);
          this.collisionWorldDirty = true;
        }
      }
      for (const mesh of this.options.scene.meshes) {
        if (!this.collisionMeshDefaults.has(mesh) && this.shouldRegisterCollisionMesh(mesh)) {
          this.registerCollisionMesh(mesh);
          this.collisionWorldDirty = true;
        }
      }
      if (force) this.collisionWorldDirty = true;
      return;
    }

    for (const mesh of [...this.collisionMeshDefaults.keys()]) {
      if (!this.shouldRegisterCollisionMesh(mesh)) {
        this.unregisterCollisionMesh(mesh);
        this.collisionWorldDirty = true;
      }
    }
  }

  private syncCollisionProxies(position: Readonly<Vector3>, force = false): boolean {
    const nowMs = nowMilliseconds();
    this.reconcileCollisionMeshes(nowMs, force);
    const radiusMeters = this.getCollisionQueryRadiusMeters();
    const queryPosition = { x: position.x, y: position.y, z: position.z };
    const proxySynced = this.collisionProxyPool?.sync(
      queryPosition,
      radiusMeters,
      nowMs,
      force,
    ) ?? false;
    const proxyRefreshed = proxySynced && (this.collisionProxyPool?.lastSyncChanged ?? false);
    const triangleRefreshed = this.localTriangleCollider.sync(
      queryPosition,
      radiusMeters,
      nowMs,
      force,
    );
    const changed = proxyRefreshed || triangleRefreshed || this.collisionWorldDirty;
    if (changed) {
      this.updateColliderNeighborhood(queryPosition);
      this.collisionWorldDirty = false;
    }
    if ((proxyRefreshed || triangleRefreshed) && this.fallbackGround.isEnabled()) {
      this.disableFallbackGroundWhenSceneFloorIsReady();
    } else if (changed && this.fallbackGround.isEnabled()) {
      this.disableFallbackGroundWhenSceneFloorIsReady();
    }
    return changed;
  }

  /**
   * 把人物碰撞扫描限制在邻域廉价网格、AABB 代理和局部三角代理内。
   * Babylon 默认会遍历场景全部 checkCollisions 网格，厂区环境 GLB 会把 CPU 打满。
   */
  private updateColliderNeighborhood(position: { x: number; y: number; z: number }): void {
    const radiusMeters = this.getCollisionQueryRadiusMeters();
    const nearby: AbstractMesh[] = [];
    const nativeMeshes: AbstractMesh[] = [];
    if (this.fallbackGround.isEnabled()) nearby.push(this.fallbackGround);
    for (const mesh of this.collisionProxyPool?.getActiveMeshes() ?? []) {
      if (mesh.isEnabled()) nearby.push(mesh);
    }
    for (const mesh of this.localTriangleCollider.getActiveMeshes()) {
      if (mesh.isEnabled()) nearby.push(mesh);
    }
    for (const mesh of this.collisionMeshDefaults.keys()) {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.checkCollisions) continue;
      if (!mesh.isSynchronized()) mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      if (!isManualRoamPointNearWorldAabb(position, box.minimumWorld, box.maximumWorld, radiusMeters)) {
        continue;
      }
      nearby.push(mesh);
      nativeMeshes.push(mesh);
    }
    this.nearbyNativeMeshes = nativeMeshes;
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
    const showAvatar = enabled && viewMode === 'thirdPerson';
    this.facingRoot.setEnabled(showAvatar);
    this.collider.isVisible = enabled && this.snapshot.debugColliders;
    if (showAvatar) {
      this.skeletalAnimator?.resume();
      this.embeddedAnimator?.resume();
    } else {
      this.skeletalAnimator?.pause();
      this.embeddedAnimator?.pause();
      this.footIK?.reset();
      this.avatarBlobShadowMesh?.setEnabled(false);
    }
  }

  private ensureAvatarBlobShadow(): Mesh | null {
    if (this.disposed) return null;
    if (this.avatarBlobShadowMesh && !this.avatarBlobShadowMesh.isDisposed()) {
      return this.avatarBlobShadowMesh;
    }
    const { scene } = this.options;
    const texture = RawTexture.CreateRGBATexture(
      buildManualRoamBlobShadowPixels(AVATAR_BLOB_SHADOW_TEXTURE_SIZE),
      AVATAR_BLOB_SHADOW_TEXTURE_SIZE,
      AVATAR_BLOB_SHADOW_TEXTURE_SIZE,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.name = `${AVATAR_BLOB_SHADOW_NAME}_texture`;
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    const material = new StandardMaterial(`${AVATAR_BLOB_SHADOW_NAME}_material`, scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    material.disableLighting = true;
    material.diffuseColor = Color3.Black();
    material.emissiveColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.ambientColor = Color3.Black();
    material.backFaceCulling = false;
    material.zOffset = -2;
    material.freeze();

    const mesh = MeshBuilder.CreateGround(
      AVATAR_BLOB_SHADOW_NAME,
      { width: 1, height: 1, subdivisions: 1 },
      scene,
    );
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    mesh.doNotSerialize = true;
    mesh.material = material;
    mesh.metadata = { manualRoamAvatarShadow: true, editorShadowCatcher: true };
    mesh.setEnabled(false);

    this.avatarBlobShadowTexture = texture;
    this.avatarBlobShadowMaterial = material;
    this.avatarBlobShadowMesh = mesh;
    return mesh;
  }

  private updateAvatarBlobShadow(): void {
    const visible = this.snapshot.enabled
      && this.snapshot.viewMode === 'thirdPerson'
      && this.snapshot.locomotionMode === 'ground'
      && this.lastGroundHeight !== null
      && Number.isFinite(this.lastGroundHeight);
    if (!visible) {
      this.avatarBlobShadowMesh?.setEnabled(false);
      return;
    }
    const heightAboveGround = this.collider.position.y - this.lastGroundHeight!;
    if (heightAboveGround < -0.1 || heightAboveGround > AVATAR_BLOB_SHADOW_MAX_HEIGHT_METERS) {
      this.avatarBlobShadowMesh?.setEnabled(false);
      return;
    }
    const mesh = this.ensureAvatarBlobShadow();
    if (!mesh) return;
    const attenuation = clampFinite(1 - Math.max(0, heightAboveGround) / AVATAR_BLOB_SHADOW_MAX_HEIGHT_METERS, 0, 1);
    const footprint = AVATAR_BLOB_SHADOW_SIZE_METERS * (0.75 + 0.25 * attenuation);
    mesh.position.set(
      this.collider.position.x,
      this.lastGroundHeight! + AVATAR_BLOB_SHADOW_Y_OFFSET_METERS,
      this.collider.position.z,
    );
    mesh.scaling.set(footprint, 1, footprint);
    mesh.visibility = attenuation;
    mesh.setEnabled(true);
  }

  private disposeAvatarBlobShadow(): void {
    if (this.avatarBlobShadowMesh && !this.avatarBlobShadowMesh.isDisposed()) {
      this.avatarBlobShadowMesh.dispose(false, false);
    }
    this.avatarBlobShadowMesh = null;
    this.avatarBlobShadowMaterial?.dispose();
    this.avatarBlobShadowMaterial = null;
    this.avatarBlobShadowTexture?.dispose();
    this.avatarBlobShadowTexture = null;
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
    if (this.avatarStatusMessage) return this.avatarStatusMessage;
    if (this.snapshot.avatarAnimationMode === 'procedural') return '人物模型无骨骼动画，当前使用程序化步态。';
    if (this.snapshot.avatarAnimationMode === 'static') return '人物模型无内置动画，保留原始姿态。';
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

function buildManualRoamBlobShadowPixels(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const half = size * 0.5;
  for (let y = 0; y < size; y += 1) {
    const dy = (y + 0.5 - half) / half;
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - half) / half;
      const radius = Math.hypot(dx, dy);
      let alpha = 0;
      if (radius <= 0.15) alpha = 0.5;
      else if (radius <= 0.55) alpha = 0.5 + ((radius - 0.15) / 0.4) * (0.24 - 0.5);
      else if (radius < 0.96) alpha = 0.24 * (1 - (radius - 0.55) / 0.41);
      pixels[(y * size + x) * 4 + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
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
