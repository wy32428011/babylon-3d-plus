import { Light } from '@babylonjs/core/Lights/light.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { DrawWrapper } from '@babylonjs/core/Materials/drawWrapper.js';
import type { PoiEffectComponent } from '../../../editor/model/components';

const TARGET_REFRESH_SECONDS = 0.5;
const MAX_LIGHTS = 8;
const MAX_LIGHTS_PER_MESH = 2;

type TargetGroup = { members: AbstractMesh[]; distances: number[]; tieDistances: number[] };

/** 灯带以有限点光近似局部散射，不修改原有灯光和材质的参数。 */
export class GlowStripLighting {
  private readonly lights: PointLight[] = [];
  private readonly targets: AbstractMesh[][] = [];
  private readonly lastPositions: Vector3[] = [];
  private active = true;
  private elapsed = 0;
  private range = 2;
  private strength = 1;
  private color = Color3.White();
  private radius = 0.04;
  private offset = 0.12;
  private initialized = false;
  private parentEnabled: boolean;

  constructor(private readonly id: string, private readonly scene: Scene, private readonly root: TransformNode,
    private readonly path: readonly Vector3[], component: PoiEffectComponent) {
    this.parentEnabled = root.isEnabled();
    this.update(component);
  }

  update(component: PoiEffectComponent): void {
    const parameters = component.configuration?.parameters;
    const value = (key: string, fallback: number, min: number, max: number) => {
      const input = parameters?.[key];
      return typeof input === 'number' && Number.isFinite(input) ? Math.max(min, Math.min(max, input)) : fallback;
    };
    const range = value('lightRange', 2, 0.1, 20);
    const offset = value('lightOffset', 0.12, -2, 2);
    const strength = value('lightStrength', 1, 0, 4) * component.intensity * (component.visual?.opacity ?? 1);
    const color = Color3.FromHexString(component.primaryColor);
    const radius = Math.max(0.02, Math.min(0.25, (component.visual?.width ?? 0.08) * 0.5));
    const appearanceChanged = range !== this.range || strength !== this.strength || !color.equals(this.color) || radius !== this.radius;
    const refresh = !this.initialized || range !== this.range || offset !== this.offset || (strength <= 0) !== (this.strength <= 0);
    this.range = range;
    this.offset = offset;
    this.strength = strength;
    this.color = color;
    this.radius = radius;
    for (const light of this.lights) this.applyAppearance(light);
    this.initialized = true;
    if (refresh) { this.refreshTargets(); this.elapsed = 0; }
    if (appearanceChanged) this.refreshFrozen(this.affectedMeshes());
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) this.refreshTargets();
    else this.disableLights();
  }

  tick(deltaSeconds: number): void {
    if (!this.active || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const enabled = this.root.isEnabled();
    if (enabled !== this.parentEnabled) {
      this.parentEnabled = enabled;
      this.refreshAffected(this.affectedMeshes());
      if (enabled) { this.refreshTargets(); this.elapsed = 0; }
    }
    if (!enabled) return;
    if (this.strength > 0) this.refreshMovedLights();
    this.elapsed += deltaSeconds;
    if (this.elapsed < TARGET_REFRESH_SECONDS) return;
    this.elapsed = 0;
    this.refreshTargets();
  }

  dispose(): void {
    const affected = this.affectedMeshes();
    for (const light of this.lights) light.dispose();
    this.lights.length = 0;
    this.targets.length = 0;
    this.lastPositions.length = 0;
    this.refreshAffected(affected);
  }

  private applyAppearance(light: PointLight): void {
    light.diffuse.copyFrom(this.color);
    light.specular.copyFrom(this.color);
    light.intensity = this.strength;
    light.range = this.range;
    light.radius = this.radius;
  }

  private disableLights(): void {
    let changed = false;
    for (const light of this.lights) if (light.isEnabled(false)) { light.setEnabled(false); changed = true; }
    if (changed) this.refreshAffected(this.affectedMeshes());
  }

  private affectedMeshes(): AbstractMesh[] {
    return [...this.targets.flat(), ...this.lights.flatMap(light => light.includedOnlyMeshes)];
  }

  /** 灯光属性或位置变化只需重绑定冻结材质，不重新编译着色器。 */
  private refreshFrozen(meshes: readonly AbstractMesh[]): void {
    const affected = new Set<AbstractMesh>();
    for (const mesh of meshes) if (!mesh.isDisposed()) affected.add(mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh);
    let changed = false;
    for (const mesh of affected) {
      if (mesh.isDisposed()) continue;
      for (const subMesh of mesh.subMeshes ?? []) {
        if (!subMesh.getMaterial()?.isFrozen) continue;
        const wrappers = new Set<DrawWrapper>(subMesh._drawWrappers.filter(Boolean));
        if (subMesh._drawWrapperOverride) wrappers.add(subMesh._drawWrapperOverride);
        for (const wrapper of wrappers) { wrapper._forceRebindOnNextCall = true; changed = true; }
      }
    }
    if (changed) this.scene.resetCachedMaterial();
  }

  private refreshMovedLights(): void {
    const matrix = this.root.computeWorldMatrix(true);
    let moved = this.lastPositions.length !== this.lights.length;
    for (let index = 0; index < this.lights.length; index += 1) {
      const position = Vector3.TransformCoordinates(this.lights[index].position, matrix);
      if (!this.lastPositions[index]) { this.lastPositions[index] = position; moved = true; }
      else if (!this.lastPositions[index].equals(position)) { this.lastPositions[index].copyFrom(position); moved = true; }
    }
    this.lastPositions.length = this.lights.length;
    if (moved) this.refreshFrozen(this.affectedMeshes());
  }

  /** 保留实例源和冻结材质的原冻结状态，仅使受影响网格的绘制缓存重新检查光源。 */
  private refreshAffected(meshes: readonly AbstractMesh[]): void {
    if (!meshes.length) return;
    const registered = new Set(this.scene.meshes);
    const affected = new Set<AbstractMesh>();
    for (const mesh of meshes) {
      if (mesh.isDisposed()) continue;
      affected.add(mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh);
    }
    let changed = false;
    for (const mesh of affected) {
      if (mesh.isDisposed()) continue;
      if (!registered.has(mesh)) mesh._resyncLightSources();
      for (const subMesh of mesh.subMeshes ?? []) {
        const wrappers = new Set<DrawWrapper>(subMesh._drawWrappers.filter(Boolean));
        if (subMesh._drawWrapperOverride) wrappers.add(subMesh._drawWrapperOverride);
        for (const wrapper of wrappers) {
          wrapper._wasPreviouslyReady = false;
          wrapper._wasPreviouslyUsingInstances = null;
          wrapper._forceRebindOnNextCall = true;
          if (wrapper.defines && typeof wrapper.defines !== 'string') wrapper.defines.markAsLightDirty(true);
          changed = true;
        }
      }
    }
    if (changed) this.scene.resetCachedMaterial();
  }

  private refreshTargets(): void {
    if (!this.active || this.strength <= 0) { this.disableLights(); return; }
    const matrix = this.root.computeWorldMatrix(true);
    const worldPath = this.path.map(point => Vector3.TransformCoordinates(point, matrix));
    const lengths = worldPath.map((point, index) => index ? Vector3.Distance(point, worldPath[index - 1]) : 0);
    for (let index = 1; index < lengths.length; index += 1) lengths[index] += lengths[index - 1];
    const total = lengths.at(-1) ?? 0;
    const count = Math.max(1, Math.min(MAX_LIGHTS, Math.ceil(total / (this.range * 1.5))));
    const affected: AbstractMesh[] = [];
    while (this.lights.length > count) {
      affected.push(...this.targets.pop()!);
      const light = this.lights.pop()!;
      affected.push(...light.includedOnlyMeshes);
      light.dispose();
    }
    while (this.lights.length < count) {
      const light = new PointLight(`${this.id}_glow_strip_light_${this.lights.length}`, Vector3.Zero(), this.scene);
      // 空 includedOnlyMeshes 表示全场；设置受光目标前先禁用。
      light.setEnabled(false);
      light.parent = this.root;
      light.metadata = { glowStripLight: true };
      light.shadowEnabled = false;
      light.falloffType = Light.FALLOFF_GLTF;
      this.applyAppearance(light);
      this.lights.push(light);
      this.targets.push([]);
    }
    for (let index = 0; index < count; index += 1) {
      const distance = total * (index + 0.5) / count;
      let segment = 1;
      while (segment < lengths.length - 1 && lengths[segment] < distance) segment += 1;
      const start = lengths[segment - 1] ?? 0, span = (lengths[segment] ?? start) - start;
      Vector3.LerpToRef(this.path[segment - 1], this.path[segment], span > 0 ? (distance - start) / span : 0, this.lights[index].position);
      this.lights[index].position.y += this.offset;
    }
    const positions = this.lights.map(light => Vector3.TransformCoordinates(light.position, matrix));
    const groups = new Map<AbstractMesh, TargetGroup>();
    const rangeSquared = this.range * this.range;
    for (const mesh of this.scene.meshes) {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || !mesh.material || mesh.metadata?.effectRole || mesh.metadata?.editorEntityId === this.id) continue;
      const bounds = mesh.getBoundingInfo().boundingBox;
      const min = bounds.minimumWorld, max = bounds.maximumWorld, center = bounds.centerWorld;
      const key = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
      let group = groups.get(key);
      if (!group) { group = { members: [], distances: positions.map(() => Infinity), tieDistances: positions.map(() => Infinity) }; groups.set(key, group); }
      group.members.push(mesh);
      for (let index = 0; index < positions.length; index += 1) {
        const point = positions[index];
        const dx = Math.max(min.x - point.x, 0, point.x - max.x);
        const dy = Math.max(min.y - point.y, 0, point.y - max.y);
        const dz = Math.max(min.z - point.z, 0, point.z - max.z);
        const distance = dx * dx + dy * dy + dz * dz;
        const tie = Vector3.DistanceSquared(point, center);
        if (distance < group.distances[index] || distance === group.distances[index] && tie < group.tieDistances[index]) {
          group.distances[index] = distance; group.tieDistances[index] = tie;
        }
      }
    }
    const next = positions.map(() => new Set<AbstractMesh>());
    for (const [source, group] of groups) {
      const indices = positions.map((_, index) => index).filter(index => group.distances[index] <= rangeSquared)
        .sort((a, b) => group.distances[a] - group.distances[b] || group.tieDistances[a] - group.tieDistances[b]).slice(0, MAX_LIGHTS_PER_MESH);
      for (const index of indices) {
        next[index].add(source);
        for (const member of group.members) next[index].add(member);
      }
    }
    for (let index = 0; index < this.lights.length; index += 1) {
      const light = this.lights[index], previous = this.targets[index];
      // 烘焙代理也参与距离筛选；未变更目标时保留其他运行时追加的代理列表。
      const desired = [...next[index]];
      if (desired.length !== previous.length || desired.some((mesh, position) => mesh !== previous[position])) {
        affected.push(...previous, ...desired, ...light.includedOnlyMeshes);
        if (!desired.length && light.isEnabled(false)) light.setEnabled(false);
        light.includedOnlyMeshes = desired;
        this.targets[index] = desired;
      }
      const enabled = desired.length > 0;
      if (light.isEnabled(false) !== enabled) { light.setEnabled(enabled); affected.push(...desired); }
    }
    this.refreshAffected(affected);
    this.refreshMovedLights();
  }
}
