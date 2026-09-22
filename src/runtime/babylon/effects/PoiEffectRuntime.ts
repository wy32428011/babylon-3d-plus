import { isDigitalTwinEffectKind } from '../../../editor/model/digitalTwinEffect';
import { SpatialEffects, supportsSpatialEffect } from './SpatialEffects';
import { TargetModelEffects } from './TargetModelEffects';
import { SceneEnvironmentEffects } from './SceneEnvironmentEffects';
import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  type Material,
  type AbstractMesh,
  type Nullable,
  type Observer,
} from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { SceneThemeSettings } from '../../../editor/model/sceneTheme';
import type { PoiEffectComponent, PoiEffectKind, TransformComponent } from '../../../editor/model/components';
import { sanitizePoiEffectComponent } from '../../../editor/model/poiEffect';
import { LightWallFence } from './LightWallFence';

/** 与 SceneRuntime 拾取逻辑保持一致的实体 metadata 字段。 */
const EDITOR_ENTITY_ID_METADATA_KEY = 'editorEntityId';
/** 透明拾取壳尺寸。 */
const PICK_SHELL_SIZE = 1.8;
/** 普通透明拾取壳透明度。 */
const PICK_ALPHA = 0.025;
/** 选中透明拾取壳透明度。 */
const SELECTED_PICK_ALPHA = 0.08;
/** 运行时生成粒子贴图尺寸。 */
const PARTICLE_TEXTURE_SIZE = 48;

type PoiResources = {
  meshes: Mesh[];
  materials: Material[];
  particleSystems: ParticleSystem[];
  textures: Texture[];
  lightWall: LightWallFence | null;
  spatial: SpatialEffects | null;
};

type PoiEntry = {
  root: TransformNode;
  pickMesh: Mesh;
  pickMaterial: StandardMaterial;
  signature: string;
  kind: PoiEffectKind;
  resources: PoiResources;
  visible: boolean;
  pickable: boolean;
  selected: boolean;
  seed: number;
  particlesActive: boolean;
};

type ParticleSpec = {
  name: string;
  color: string;
  color2: string;
  minBox: Vector3;
  maxBox: Vector3;
  direction1: Vector3;
  direction2: Vector3;
  gravity: Vector3;
  life: [number, number];
  size: [number, number];
  rate: number;
};

/** Babylon POI/EFF 运行时：负责实体映射、稳定拾取壳、内部视觉资源、动画与严格释放。 */
export class PoiEffectRuntime {
  private readonly entries = new Map<string, PoiEntry>();
  private readonly beforeRenderObserver: Nullable<Observer<Scene>>;
  private readonly targetEffects: TargetModelEffects;
  private readonly environmentEffects: SceneEnvironmentEffects;
  private previousFrameTime: number | null = null;

  /** 创建运行时并注册唯一 before-render 观察者。 */
  constructor(private readonly scene: Scene, private readonly resolveTarget: (id: string) => TransformNode | AbstractMesh | null = () => null, canFollow: () => boolean = () => false) {
    this.targetEffects = new TargetModelEffects(scene, resolveTarget);
    this.environmentEffects = new SceneEnvironmentEffects(scene, resolveTarget, canFollow);
    this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() => this.animate());
  }

  setSceneTheme(active: boolean, glowIntensity: number | null): void {
    this.environmentEffects.setThemeActive(active);
    this.targetEffects.setGlowIntensity(glowIntensity);
  }

  setThemeFog(theme: SceneThemeSettings | null): void { this.environmentEffects.setThemeFog(theme); }

  /** 同步单个 POI 实体；组件签名变化时只重建该实体内部资源。 */
  sync(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    const raw = entity.components.poiEffect;
    if (!raw) {
      this.disposeEntity(entity.id);
      return;
    }

    const component = sanitizePoiEffectComponent(raw);
    const signature = this.createSignature(component);
    const entry = this.ensureEntry(entity.id);

    this.applyTransform(entry.root, entity.components.transform);
    entry.visible = visible;
    entry.pickable = pickable;
    entry.selected = selected;
    entry.kind = component.effectKind;
    entry.root.setEnabled(visible);

    if (entry.signature !== signature) {
      this.disposeResources(entry.resources);
      entry.resources = component.enabled ? this.createEffect(entity.id, component, entry.root) : this.emptyResources();
      entry.signature = signature;
      entry.particlesActive = false;
    }
    entry.resources.lightWall?.update(component);
    entry.resources.spatial?.setActive(visible && component.enabled);
    entry.resources.spatial?.updatePlaybackSpeed(component.speed);
    this.targetEffects.sync(entity.id, component, visible && component.enabled);
    this.environmentEffects.sync(entity.id, component, visible && component.enabled);
    this.applyPickState(entry);
    this.applyParticlePlayback(entry, visible && component.enabled);
  }

  /** 在模型外观更新期间释放覆盖，避免将文档改动写到临时克隆材质。 */
  withTargetMutation(targetId: string, mutate: () => void): void {
    this.targetEffects.withTargetMutation(targetId, mutate);
  }

  /** 释放同步集合中已经缺失的实体。 */
  disposeMissing(ids: Set<string>): void {
    this.targetEffects.disposeMissing(ids);
    this.environmentEffects.disposeMissing(ids);
    for (const id of Array.from(this.entries.keys())) {
      if (!ids.has(id)) this.disposeEntity(id);
    }
  }

  /** 获取 Gizmo 绑定目标：稳定 TransformNode 根节点。 */
  getGizmoTarget(id: string | null): TransformNode | null {
    return id ? this.entries.get(id)?.root ?? null : null;
  }

  /** 光墙直接拾取实际侧壁，其他效果使用稳定透明拾取壳。 */
  getPickMesh(id: string | null): Mesh | null {
    if (!id) return null;
    const entry = this.entries.get(id);
    return entry?.resources.lightWall?.mesh ?? entry?.pickMesh ?? null;
  }

  /** 返回参与场景聚焦和阵列计算的可见几何；无视觉资源时回退透明拾取壳。 */
  getWorldBoundsMeshes(id: string | null): readonly Mesh[] {
    if (!id) return [];
    const entry = this.entries.get(id);
    if (!entry) return [];
    if (entry.resources.lightWall) return [entry.resources.lightWall.mesh];
    const visualMeshes = entry.resources.meshes.filter((mesh) => mesh.isVisible);
    return visualMeshes.length > 0 ? [...visualMeshes, entry.pickMesh] : [entry.pickMesh];
  }

  /**
   * 返回 POI 阵列测量与轻量预览所需的稳定根节点和 Mesh。
   * 有可见静态几何时只克隆静态几何；纯粒子效果改用范围代理，避免复制粒子系统。
   */
  getEntityArraySource(id: string | null): {
    root: TransformNode;
    geometryMeshes: readonly Mesh[];
    previewMeshes: readonly Mesh[];
  } | null {
    if (!id) return null;
    const entry = this.entries.get(id);
    if (!entry) return null;

    const visibleMeshes = entry.resources.meshes.filter((mesh) => (
      !mesh.isDisposed()
      && mesh.isVisible
      && mesh.visibility > 0
      && mesh.getTotalVertices() > 0
    ));
    const effectBoundsMeshes = entry.resources.meshes.filter((mesh) => {
      const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
      return !mesh.isDisposed()
        && mesh.isVisible
        && metadata?.effectBoundsProxy === true
        && mesh.getTotalVertices() > 0;
    });
    const geometryMeshes = visibleMeshes.length > 0 || effectBoundsMeshes.length > 0
      ? [...visibleMeshes, ...effectBoundsMeshes]
      : [entry.pickMesh];
    const previewMeshes = visibleMeshes.length > 0
      ? visibleMeshes
      : effectBoundsMeshes.length > 0
        ? effectBoundsMeshes
        : [entry.pickMesh];

    return { root: entry.root, geometryMeshes, previewMeshes };
  }

  /** 判断实体运行时资源是否存在。 */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 严格释放所有 Mesh、Material、ParticleSystem、Texture 和 Observer。 */
  dispose(): void {
    if (this.beforeRenderObserver) this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    this.targetEffects.dispose();
    this.environmentEffects.dispose();
    for (const id of Array.from(this.entries.keys())) this.disposeEntity(id);
  }

  /** 创建或复用稳定根节点与透明拾取壳。 */
  private ensureEntry(id: string): PoiEntry {
    const existing = this.entries.get(id);
    if (existing) return existing;

    const root = new TransformNode(`${id}_poiEffectRoot`, this.scene);
    const pickMesh = MeshBuilder.CreateBox(`${id}_poiEffectPickShell`, { size: PICK_SHELL_SIZE }, this.scene);
    const pickMaterial = this.createMaterial(`${id}_poiEffectPickShellMat`, '#ffffff', PICK_ALPHA);
    pickMesh.parent = root;
    pickMesh.material = pickMaterial;
    pickMesh.isPickable = true;
    pickMesh.visibility = PICK_ALPHA;
    pickMesh.metadata = { ...(pickMesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: id };

    const entry: PoiEntry = {
      root,
      pickMesh,
      pickMaterial,
      signature: '',
      kind: 'alarm-pulse',
      resources: this.emptyResources(),
      visible: true,
      pickable: true,
      selected: false,
      seed: this.seedFromId(id),
      particlesActive: false,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** 创建空资源桶。 */
  private emptyResources(): PoiResources {
    return { meshes: [], materials: [], particleSystems: [], textures: [], lightWall: null, spatial: null };
  }

  /** 按类型创建可区分效果。 */
  private createEffect(id: string, component: PoiEffectComponent, root: TransformNode): PoiResources {
    const resources = this.emptyResources();
    const kind = component.effectKind;
    const primary = component.primaryColor;
    const secondary = component.secondaryColor;
    const intensity = component.intensity;

    if (supportsSpatialEffect(kind)) {
      const spatial = new SpatialEffects(id, this.scene, root, component, this.resolveTarget);
      resources.spatial = spatial;
      resources.meshes = spatial.meshes;
      resources.materials = spatial.materials;
    } else if (kind === 'light-wall-fence') {
      const lightWall = new LightWallFence(id, this.scene, root, component);
      resources.lightWall = lightWall;
      resources.meshes.push(lightWall.mesh);
      resources.materials.push(lightWall.material);
    } else if (kind === 'alarm-pulse') {
      this.addTorus(resources, root, `${id}_alarm_outer`, primary, 1.1, 0.03, 'pulse', 0);
      this.addTorus(resources, root, `${id}_alarm_inner`, secondary, 0.65, 0.025, 'pulse', 0.35);
    } else if (kind === 'warning-beacon') {
      this.addCylinder(resources, root, `${id}_beacon_base`, '#30333a', 0.35, 0.08, null, 0.95);
      this.addSphere(resources, root, `${id}_beacon_dome`, primary, 0.45, 'beacon', 0.65).position.y = 0.25;
      this.addPlane(resources, root, `${id}_beacon_sweep`, secondary, 1.35, 0.16, 'spin', 0.4).position.y = 0.3;
    } else if (kind === 'locator-beam') {
      this.addCylinder(resources, root, `${id}_locator_beam`, primary, 0.28, 3.2, 'breathe', 0.28).position.y = 1.6;
      this.addTorus(resources, root, `${id}_locator_cap`, secondary, 0.5, 0.02, 'spin', 0.8).position.y = 3.25;
    } else if (kind === 'radar-scan') {
      this.addDisc(resources, root, `${id}_radar_disc`, primary, 1.15, null, 0.16);
      this.addPlane(resources, root, `${id}_radar_sweep`, secondary, 1.2, 0.18, 'spin', 0.42).position.z = 0.45;
      this.addTorus(resources, root, `${id}_radar_ring`, primary, 1.2, 0.015, 'pulse', 0.65);
    } else if (kind === 'fire') {
      this.addCone(resources, root, `${id}_fire_core`, primary, 0.55, 1.1, 'flame', 0.55).position.y = 0.55;
      this.addParticles(resources, root, component, { name: `${id}_fire_particles`, color: secondary, color2: primary, minBox: new Vector3(-0.25, 0, -0.25), maxBox: new Vector3(0.25, 0.1, 0.25), direction1: new Vector3(-0.2, 1.2, -0.2), direction2: new Vector3(0.2, 2.2, 0.2), gravity: new Vector3(0, 0.2, 0), life: [0.35, 0.8], size: [0.1, 0.35], rate: 80 });
      this.addBoundsProxy(resources, root, `${id}_fire_bounds`, new Vector3(1.4, 2.5, 1.4), new Vector3(0, 1.1, 0));
    } else if (kind === 'smoke') {
      this.addParticles(resources, root, component, { name: `${id}_smoke_particles`, color: primary, color2: secondary, minBox: new Vector3(-0.4, 0, -0.4), maxBox: new Vector3(0.4, 0.2, 0.4), direction1: new Vector3(-0.25, 0.35, -0.25), direction2: new Vector3(0.25, 0.9, 0.25), gravity: new Vector3(0, 0.03, 0), life: [1.4, 3], size: [0.3, 0.8], rate: 45 });
      this.addBoundsProxy(resources, root, `${id}_smoke_bounds`, new Vector3(2.2, 3.5, 2.2), new Vector3(0, 1.5, 0));
    } else if (kind === 'sparks') {
      this.addSphere(resources, root, `${id}_sparks_core`, secondary, 0.16, null, 0.9).position.y = 0.45;
      this.addParticles(resources, root, component, { name: `${id}_sparks_particles`, color: primary, color2: secondary, minBox: new Vector3(-0.05, 0.35, -0.05), maxBox: new Vector3(0.05, 0.5, 0.05), direction1: new Vector3(-1.5, 0.2, -1.5), direction2: new Vector3(1.5, 1.3, 1.5), gravity: new Vector3(0, -1.4, 0), life: [0.18, 0.55], size: [0.04, 0.12], rate: 110 });
      this.addBoundsProxy(resources, root, `${id}_sparks_bounds`, new Vector3(3, 2, 3), new Vector3(0, 0.7, 0));
    } else if (kind === 'steam-leak') {
      this.addTorus(resources, root, `${id}_steam_nozzle`, secondary, 0.22, 0.02, null, 0.8).position.y = 0.45;
      this.addParticles(resources, root, component, { name: `${id}_steam_particles`, color: primary, color2: secondary, minBox: new Vector3(0, 0.35, -0.08), maxBox: new Vector3(0.08, 0.55, 0.08), direction1: new Vector3(1, 0.15, -0.15), direction2: new Vector3(2, 0.45, 0.15), gravity: new Vector3(0, 0.08, 0), life: [0.65, 1.35], size: [0.12, 0.42], rate: 75 });
      this.addBoundsProxy(resources, root, `${id}_steam_bounds`, new Vector3(3, 1.5, 1.5), new Vector3(1.2, 0.7, 0));
    } else if (kind === 'gas-leak') {
      const cloud = this.addSphere(resources, root, `${id}_gas_cloud`, primary, 1.05, 'breathe', 0.18);
      cloud.position.y = 0.7;
      cloud.scaling.y = 0.55;
      this.addParticles(resources, root, component, { name: `${id}_gas_particles`, color: secondary, color2: primary, minBox: new Vector3(-0.45, 0.1, -0.45), maxBox: new Vector3(0.45, 0.25, 0.45), direction1: new Vector3(-0.2, 0.25, -0.2), direction2: new Vector3(0.2, 0.75, 0.2), gravity: new Vector3(0, 0.02, 0), life: [1.2, 2.4], size: [0.18, 0.56], rate: 42 });
      this.addBoundsProxy(resources, root, `${id}_gas_bounds`, new Vector3(2.5, 2, 2.5), new Vector3(0, 0.8, 0));
    } else if (kind === 'water-jet') {
      const jet = this.addCylinder(resources, root, `${id}_water_jet`, primary, 0.1, 1.45, 'slide', 0.38);
      jet.position.set(0.7, 0.55, 0);
      jet.rotation.z = Math.PI / 2;
      this.addParticles(resources, root, component, { name: `${id}_water_particles`, color: secondary, color2: primary, minBox: new Vector3(0, 0.5, -0.05), maxBox: new Vector3(0.08, 0.6, 0.05), direction1: new Vector3(1.6, -0.15, -0.08), direction2: new Vector3(2.8, 0.12, 0.08), gravity: new Vector3(0, -0.35, 0), life: [0.35, 0.8], size: [0.05, 0.16], rate: 95 });
      this.addBoundsProxy(resources, root, `${id}_water_bounds`, new Vector3(3, 1.2, 1.2), new Vector3(1.2, 0.4, 0));
    } else if (kind === 'pipeline-flow-particles') {
      const count = this.scaleRepeatedCount(8, component.density, 2, 16);
      for (let i = 0; i < count; i += 1) this.addSphere(resources, root, `${id}_pipe_dot_${i}`, primary, 0.12 * intensity, 'flow', 0.8, i, count).position.y = 0.35;
    } else if (kind === 'pipeline-flow-arrows') {
      const count = this.scaleRepeatedCount(5, component.density, 2, 10);
      for (let i = 0; i < count; i += 1) this.addArrow(resources, root, `${id}_pipe_arrow_${i}`, primary, 0.4, i, count);
    } else if (kind === 'moving-double-arrow') {
      const count = this.scaleRepeatedCount(3, component.density, 1, 6);
      this.addBox(resources, root, `${id}_double_arrow_guide`, secondary, 3.2, 0.015, 0.035, null, 0.14).position.y = 0.045;
      for (let i = 0; i < count; i += 1) {
        this.addMovingDoubleArrowGroup(resources, root, `${id}_double_arrow_${i}`, primary, secondary, i, count, intensity);
      }
    } else if (kind === 'cargo-target-frame') {
      const frame = this.addBox(resources, root, `${id}_cargo_frame`, primary, 1.25, 1, 1.25, null, 0.18);
      frame.position.y = 0.5;
      frame.enableEdgesRendering();
      frame.edgesColor = this.color4(primary, 0.95);
      frame.edgesWidth = 3;
      this.addTorus(resources, root, `${id}_cargo_ring`, secondary, 0.85, 0.02, 'pulse', 0.65);
    } else if (kind === 'conveyor-direction') {
      const count = this.scaleRepeatedCount(4, component.density, 2, 8);
      for (let i = 0; i < count; i += 1) this.addArrow(resources, root, `${id}_conveyor_arrow_${i}`, primary, 0.08, i, count, new Vector3(1.15, 0.1, 0.75));
    } else if (kind === 'evacuation-route') {
      const path = this.addPlane(resources, root, `${id}_evac_path`, primary, 2.2, 0.22, null, 0.32);
      path.rotation.x = Math.PI / 2;
      path.position.y = 0.03;
      const count = this.scaleRepeatedCount(3, component.density, 2, 7);
      for (let i = 0; i < count; i += 1) this.addArrow(resources, root, `${id}_evac_arrow_${i}`, secondary, 0.08, i, count, new Vector3(0.75, 0.08, 0.55));
      this.addSphere(resources, root, `${id}_evac_exit`, primary, 0.22, 'breathe', 0.85).position.set(1.25, 0.25, 0);
    }

    for (const mesh of resources.meshes) {
      mesh.isPickable = false;
      if (!resources.spatial && mesh.material instanceof StandardMaterial) {
        const baseAlpha = typeof mesh.metadata?.baseAlpha === 'number' ? mesh.metadata.baseAlpha : mesh.material.alpha;
        const scaledAlpha = Math.min(1, Math.max(0.02, baseAlpha * component.intensity));
        mesh.metadata = { ...(mesh.metadata ?? {}), baseAlpha: scaledAlpha };
        mesh.material.alpha = scaledAlpha;
      }
    }
    return resources;
  }

  /** 按密度倍率计算重复几何数量，并限制在固定预算内。 */
  private scaleRepeatedCount(baseCount: number, density: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(baseCount * density)));
  }

  /** 创建零可见度范围代理，只参与聚焦和阵列包围盒，不参与渲染或拾取。 */
  private addBoundsProxy(
    resources: PoiResources,
    root: TransformNode,
    name: string,
    size: Vector3,
    position: Vector3,
  ): void {
    const proxy = MeshBuilder.CreateBox(name, { width: size.x, height: size.y, depth: size.z }, this.scene);
    proxy.parent = root;
    proxy.position.copyFrom(position);
    proxy.visibility = 0;
    proxy.isVisible = true;
    proxy.isPickable = false;
    proxy.metadata = { effectBoundsProxy: true };
    resources.meshes.push(proxy);
  }

  /** 添加球体视觉资源。 */
  private addSphere(resources: PoiResources, root: TransformNode, name: string, color: string, diameter: number, role: string | null, alpha: number, index = 0, count = 1): Mesh {
    const mesh = MeshBuilder.CreateSphere(name, { diameter, segments: 16 }, this.scene);
    return this.registerMesh(resources, root, mesh, color, alpha, role, index, count);
  }

  /** 添加圆柱视觉资源。 */
  private addCylinder(resources: PoiResources, root: TransformNode, name: string, color: string, diameter: number, height: number, role: string | null, alpha: number): Mesh {
    const mesh = MeshBuilder.CreateCylinder(name, { diameter, height, tessellation: 24 }, this.scene);
    return this.registerMesh(resources, root, mesh, color, alpha, role);
  }

  /** 添加锥体视觉资源。 */
  private addCone(resources: PoiResources, root: TransformNode, name: string, color: string, diameter: number, height: number, role: string | null, alpha: number): Mesh {
    const mesh = MeshBuilder.CreateCylinder(name, { diameterTop: 0, diameterBottom: diameter, height, tessellation: 24 }, this.scene);
    return this.registerMesh(resources, root, mesh, color, alpha, role);
  }

  /** 添加盒体视觉资源。 */
  private addBox(resources: PoiResources, root: TransformNode, name: string, color: string, width: number, height: number, depth: number, role: string | null, alpha: number): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, this.scene);
    return this.registerMesh(resources, root, mesh, color, alpha, role);
  }

  /** 添加平面视觉资源。 */
  private addPlane(resources: PoiResources, root: TransformNode, name: string, color: string, width: number, height: number, role: string | null, alpha: number, index = 0, count = 1): Mesh {
    const mesh = MeshBuilder.CreatePlane(name, { width, height, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    return this.registerMesh(resources, root, mesh, color, alpha, role, index, count);
  }

  /** 添加圆环视觉资源。 */
  private addTorus(resources: PoiResources, root: TransformNode, name: string, color: string, diameter: number, thickness: number, role: string | null, alpha: number): Mesh {
    const mesh = MeshBuilder.CreateTorus(name, { diameter, thickness, tessellation: 48 }, this.scene);
    mesh.rotation.x = Math.PI / 2;
    return this.registerMesh(resources, root, mesh, color, alpha, role);
  }

  /** 添加圆盘视觉资源。 */
  private addDisc(resources: PoiResources, root: TransformNode, name: string, color: string, radius: number, role: string | null, alpha: number): Mesh {
    const mesh = MeshBuilder.CreateDisc(name, { radius, tessellation: 48, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    mesh.rotation.x = Math.PI / 2;
    return this.registerMesh(resources, root, mesh, color, alpha, role);
  }

  /** 添加箭头视觉资源，用盒体和锥头组合实现。 */
  private addArrow(resources: PoiResources, root: TransformNode, name: string, color: string, y: number, index: number, count: number, scale = Vector3.One()): void {
    const shaft = this.addBox(resources, root, `${name}_shaft`, color, 0.5, 0.08, 0.14, 'flow', 0.82);
    const head = this.addCone(resources, root, `${name}_head`, color, 0.28, 0.34, 'flow', 0.82);
    shaft.position.set(-1 + (index / count) * 2, y, 0);
    head.position.set(shaft.position.x + 0.32, y, 0);
    head.rotation.z = -Math.PI / 2;
    shaft.scaling.copyFrom(scale);
    head.scaling.copyFrom(scale);
    shaft.metadata = { effectRole: 'flow', flowIndex: index, flowCount: count, arrowPart: 'shaft' };
    head.metadata = { effectRole: 'flow', flowIndex: index, flowCount: count, arrowPart: 'head' };
  }

  /** 创建一个成组移动的 `>>`，并把同材质折线段预合并为有限数量的动画 Mesh。 */
  private addMovingDoubleArrowGroup(
    resources: PoiResources,
    root: TransformNode,
    name: string,
    primaryColor: string,
    secondaryColor: string,
    groupIndex: number,
    groupCount: number,
    intensity: number,
  ): void {
    const sizeScale = 0.9 + Math.min(3, Math.max(0.1, intensity)) * 0.08;
    const trailingOffset = -0.2;
    const leadingOffset = 0.2;

    this.addMovingDoubleArrowMesh(
      resources,
      root,
      `${name}_glow`,
      secondaryColor,
      [trailingOffset, leadingOffset],
      0.48,
      0.09,
      0.14,
      sizeScale * 1.18,
      0.14,
      groupIndex,
      groupCount,
      0.105,
    );
    this.addMovingDoubleArrowMesh(
      resources,
      root,
      `${name}_trailing`,
      secondaryColor,
      [trailingOffset],
      0.42,
      0.065,
      0.1,
      sizeScale,
      0.86,
      groupIndex,
      groupCount,
      0.12,
    );
    this.addMovingDoubleArrowMesh(
      resources,
      root,
      `${name}_leading`,
      primaryColor,
      [leadingOffset],
      0.42,
      0.065,
      0.1,
      sizeScale,
      0.86,
      groupIndex,
      groupCount,
      0.12,
    );
  }

  /** 创建并登记一块移动双箭头合并几何；每个偏移对应一枚朝本地 +X 的 `>`。 */
  private addMovingDoubleArrowMesh(
    resources: PoiResources,
    root: TransformNode,
    name: string,
    color: string,
    chevronOffsets: readonly number[],
    segmentLength: number,
    segmentHeight: number,
    segmentDepth: number,
    scale: number,
    alpha: number,
    groupIndex: number,
    groupCount: number,
    baseY: number,
  ): Mesh {
    const segments: Mesh[] = [];

    for (let chevronIndex = 0; chevronIndex < chevronOffsets.length; chevronIndex += 1) {
      const chevronOffset = chevronOffsets[chevronIndex];
      const upper = MeshBuilder.CreateBox(`${name}_${chevronIndex}_upper`, { width: segmentLength, height: segmentHeight, depth: segmentDepth }, this.scene);
      const lower = MeshBuilder.CreateBox(`${name}_${chevronIndex}_lower`, { width: segmentLength, height: segmentHeight, depth: segmentDepth }, this.scene);
      // 上下折线段在本地 +X 端汇合，确保箭头朝向与运动方向一致。
      upper.position.set(chevronOffset, 0, 0.115);
      upper.rotation.y = Math.PI / 4;
      lower.position.set(chevronOffset, 0, -0.115);
      lower.rotation.y = -Math.PI / 4;
      upper.scaling.set(scale, 1, scale);
      lower.scaling.set(scale, 1, scale);
      upper.computeWorldMatrix(true);
      lower.computeWorldMatrix(true);
      segments.push(upper, lower);
    }

    const merged = Mesh.MergeMeshes(segments, true, true);
    if (!merged) {
      for (const segment of segments) {
        if (!segment.isDisposed()) segment.dispose(false, false);
      }
      throw new Error(`移动双箭头几何合并失败：${name}`);
    }

    merged.name = name;
    const mesh = this.registerMesh(resources, root, merged, color, alpha, 'double-arrow-flow', groupIndex, groupCount);
    mesh.position.y = baseY;
    mesh.metadata = { ...(mesh.metadata ?? {}), baseY };
    return mesh;
  }

  /** 注册 Mesh、材质、父子关系和动画元数据。 */
  private registerMesh(resources: PoiResources, root: TransformNode, mesh: Mesh, color: string, alpha: number, role: string | null, index = 0, count = 1): Mesh {
    const material = this.createMaterial(`${mesh.name}_mat`, color, alpha);
    mesh.parent = root;
    mesh.material = material;
    mesh.metadata = { ...(mesh.metadata ?? {}), effectRole: role, baseAlpha: alpha, flowIndex: index, flowCount: count };
    resources.meshes.push(mesh);
    resources.materials.push(material);
    return mesh;
  }

  /** 添加粒子系统，并使用挂在 root 下的不可见 Mesh 作为受实体变换驱动的发射器。 */
  private addParticles(resources: PoiResources, root: TransformNode, component: PoiEffectComponent, spec: ParticleSpec): void {
    const capacity = Math.max(24, Math.round(spec.rate * component.density * component.intensity));
    const system = new ParticleSystem(spec.name, capacity, this.scene);
    const texture = this.createParticleTexture(`${spec.name}_texture`, spec.color);
    const emitter = MeshBuilder.CreateBox(`${spec.name}_emitter`, { size: 0.01 }, this.scene);
    emitter.parent = root;
    emitter.isVisible = false;
    emitter.isPickable = false;
    resources.meshes.push(emitter);
    system.particleTexture = texture;
    system.emitter = emitter;
    system.minEmitBox = spec.minBox;
    system.maxEmitBox = spec.maxBox;
    system.direction1 = spec.direction1;
    system.direction2 = spec.direction2;
    system.gravity = spec.gravity;
    system.color1 = this.color4(spec.color, 0.85);
    system.color2 = this.color4(spec.color2, 0.45);
    system.colorDead = this.color4(spec.color2, 0);
    system.minLifeTime = spec.life[0] / component.speed;
    system.maxLifeTime = spec.life[1] / component.speed;
    system.minSize = spec.size[0] * component.intensity;
    system.maxSize = spec.size[1] * component.intensity;
    system.emitRate = capacity * component.speed;
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    system.updateSpeed = 0.01;
    resources.particleSystems.push(system);
    resources.textures.push(texture);
  }

  /** 创建运行时径向渐变粒子贴图。 */
  private createParticleTexture(name: string, color: string): DynamicTexture {
    const texture = new DynamicTexture(name, { width: PARTICLE_TEXTURE_SIZE, height: PARTICLE_TEXTURE_SIZE }, this.scene, false);
    const context = texture.getContext();
    const radius = PARTICLE_TEXTURE_SIZE / 2;
    const hex = this.normalizeHex(color);
    const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, hex);
    gradient.addColorStop(0.5, `${hex}cc`);
    gradient.addColorStop(1, `${hex}00`);
    context.clearRect(0, 0, PARTICLE_TEXTURE_SIZE, PARTICLE_TEXTURE_SIZE);
    context.fillStyle = gradient;
    context.fillRect(0, 0, PARTICLE_TEXTURE_SIZE, PARTICLE_TEXTURE_SIZE);
    texture.hasAlpha = true;
    texture.update(false);
    return texture;
  }

  /** 创建标准透明自发光材质。 */
  private createMaterial(name: string, color: string, alpha: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    const parsed = this.readColor(color);
    material.disableLighting = true;
    material.alpha = alpha;
    material.diffuseColor = parsed;
    material.emissiveColor = parsed;
    material.specularColor = Color3.Black();
    material.backFaceCulling = false;
    return material;
  }

  /** 单一 before-render 动画入口。 */
  private animate(): void {
    const time = this.now() * 0.001;
    // 切回隐藏标签页后不追赶长时间间隔，避免流动相位突然跳变。
    const deltaSeconds = this.previousFrameTime === null ? 0 : Math.max(0, Math.min(0.1, time - this.previousFrameTime));
    this.previousFrameTime = time;
    this.targetEffects.tick(deltaSeconds);
    this.environmentEffects.tick(deltaSeconds);
    for (const entry of this.entries.values()) {
      if (!entry.visible) continue;
      if (entry.resources.spatial) { entry.resources.spatial.tick(deltaSeconds); continue; }
      if (entry.resources.lightWall) {
        entry.resources.lightWall.animate(deltaSeconds);
        continue;
      }
      const speed = this.readSpeed(entry.signature);
      const localTime = time * speed + entry.seed;
      for (const mesh of entry.resources.meshes) this.animateMesh(mesh, localTime);
    }
  }

  /** 根据 Mesh 元数据执行轻量动画。 */
  private animateMesh(mesh: Mesh, time: number): void {
    const role = typeof mesh.metadata?.effectRole === 'string' ? mesh.metadata.effectRole : null;
    const baseAlpha = typeof mesh.metadata?.baseAlpha === 'number' ? mesh.metadata.baseAlpha : 0.8;
    if (role === 'pulse') {
      const phase = (time + 0.35) % 1;
      const scale = 0.75 + phase * 0.75;
      mesh.scaling.set(scale, scale, scale);
      this.setAlpha(mesh, Math.max(0.05, baseAlpha * (1 - phase)));
    } else if (role === 'spin') {
      mesh.rotation.y = time * Math.PI * 2;
    } else if (role === 'beacon' || role === 'breathe') {
      this.setAlpha(mesh, baseAlpha * (0.55 + Math.sin(time * Math.PI * 2) * 0.25 + 0.25));
    } else if (role === 'flame') {
      mesh.scaling.x = 0.9 + Math.sin(time * 13) * 0.08;
      mesh.scaling.z = 0.92 + Math.cos(time * 11) * 0.08;
    } else if (role === 'slide') {
      mesh.position.x = 0.6 + ((time % 1) - 0.5) * 0.25;
    } else if (role === 'flow') {
      const index = typeof mesh.metadata?.flowIndex === 'number' ? mesh.metadata.flowIndex : 0;
      const count = typeof mesh.metadata?.flowCount === 'number' ? mesh.metadata.flowCount : 1;
      const phase = (time * 0.65 + index / count) % 1;
      const offset = mesh.metadata?.arrowPart === 'head' ? 0.32 : 0;
      mesh.position.x = -1 + phase * 2 + offset;
      this.setAlpha(mesh, 0.35 + phase * 0.55);
    } else if (role === 'double-arrow-flow') {
      const index = typeof mesh.metadata?.flowIndex === 'number' ? mesh.metadata.flowIndex : 0;
      const count = typeof mesh.metadata?.flowCount === 'number' ? mesh.metadata.flowCount : 1;
      const baseY = typeof mesh.metadata?.baseY === 'number' ? mesh.metadata.baseY : 0.12;
      const phase = (time * 0.58 + index / count) % 1;
      const edgeFade = Math.pow(Math.sin(Math.PI * phase), 0.7);
      mesh.position.set(-1.45 + phase * 2.9, baseY, 0);
      this.setAlpha(mesh, baseAlpha * (0.24 + edgeFade * 0.76));
    }
  }

  /** 应用 Transform 组件到稳定根节点。 */
  private applyTransform(target: TransformNode, transform: TransformComponent): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotationQuaternion = null;
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  /** 应用拾取壳的显隐、可拾取和选中状态。 */
  private applyPickState(entry: PoiEntry): void {
    if (entry.resources.spatial) {
      entry.pickMesh.isVisible = entry.selected && entry.visible;
      entry.pickMesh.isPickable = entry.visible && entry.pickable;
      for (const mesh of entry.resources.meshes) {
        mesh.isPickable = entry.visible && entry.pickable;
        mesh.metadata = { ...(mesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entry.pickMesh.metadata[EDITOR_ENTITY_ID_METADATA_KEY] };
      }
      return;
    }
    if (entry.kind === 'light-wall-fence') {
      const wall = entry.resources.lightWall?.mesh;
      // 围栏中心通常是建筑；禁用后也不显示辅助壳，实体仍可通过层级选中和 Gizmo 编辑。
      entry.pickMesh.isVisible = false;
      entry.pickMesh.isPickable = false;
      if (wall) {
        wall.isVisible = entry.visible;
        wall.isPickable = entry.visible && entry.pickable;
      }
      return;
    }
    entry.pickMesh.isVisible = entry.visible;
    entry.pickMesh.isPickable = entry.visible && entry.pickable;
    entry.pickMesh.visibility = entry.selected ? SELECTED_PICK_ALPHA : PICK_ALPHA;
    entry.pickMaterial.alpha = entry.selected ? SELECTED_PICK_ALPHA : PICK_ALPHA;
  }

  /** 根据实体显隐和启用状态启动或停止粒子，隐藏时清空残留粒子避免继续渲染。 */
  private applyParticlePlayback(entry: PoiEntry, active: boolean): void {
    if (entry.particlesActive === active) return;
    entry.particlesActive = active;
    for (const system of entry.resources.particleSystems) {
      if (active) {
        system.start();
        continue;
      }
      system.stop();
      system.reset();
    }
  }

  /** 生成组件签名，作为内部资源重建边界。 */
  private createSignature(component: PoiEffectComponent): string {
    if (supportsSpatialEffect(component.effectKind)) return JSON.stringify({ ...component, speed: 0 });
    if (isDigitalTwinEffectKind(component.effectKind)) return JSON.stringify(component);
    if (component.effectKind === 'light-wall-fence') {
      return JSON.stringify([component.effectKind, component.enabled, component.lightWall?.height, component.lightWall?.points]);
    }
    return [component.effectKind, component.enabled ? '1' : '0', component.primaryColor, component.secondaryColor, component.intensity.toFixed(3), component.speed.toFixed(3), component.density.toFixed(3)].join('|');
  }

  /** 从组件签名读取速度。 */
  private readSpeed(signature: string): number {
    const speed = Number(signature.split('|')[5]);
    return Number.isFinite(speed) && speed > 0 ? speed : 1;
  }

  /** 释放单个实体及其所有资源。 */
  private disposeEntity(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.disposeResources(entry.resources);
    entry.pickMesh.dispose(false, false);
    entry.pickMaterial.dispose();
    entry.root.dispose(false, true);
    this.entries.delete(id);
  }

  /** 严格释放资源桶内容。 */
  private disposeResources(resources: PoiResources): void {
    resources.lightWall = null;
    if (resources.spatial) {
      resources.spatial.dispose();
      resources.spatial = null;
      resources.meshes = []; resources.materials = [];
    }
    for (const system of resources.particleSystems.splice(0)) {
      system.stop();
      system.dispose(false);
    }
    for (const mesh of resources.meshes.splice(0)) mesh.dispose(false, false);
    for (const material of resources.materials.splice(0)) material.dispose();
    for (const texture of resources.textures.splice(0)) texture.dispose();
  }

  /** 将十六进制颜色转为 Babylon Color3。 */
  private readColor(color: string): Color3 {
    try {
      return Color3.FromHexString(this.normalizeHex(color));
    } catch {
      return Color3.White();
    }
  }

  /** 将十六进制颜色转为 Babylon Color4。 */
  private color4(color: string, alpha: number): Color4 {
    const parsed = this.readColor(color);
    return new Color4(parsed.r, parsed.g, parsed.b, alpha);
  }

  /** 归一化颜色字符串。 */
  private normalizeHex(color: string): string {
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#ffffff';
  }

  /** 设置标准材质透明度。 */
  private setAlpha(mesh: Mesh, alpha: number): void {
    if (mesh.material instanceof StandardMaterial) mesh.material.alpha = Math.max(0, Math.min(1, alpha));
  }

  /** 根据实体 ID 生成稳定动画相位。 */
  private seedFromId(id: string): number {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    return (hash % 1000) / 1000;
  }

  /** 获取当前时间，兼容浏览器与非浏览器静态环境。 */
  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}

