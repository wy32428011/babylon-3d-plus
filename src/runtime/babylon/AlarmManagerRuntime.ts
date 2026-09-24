import { AbstractMesh, AssetContainer, Color3, InstancedMesh, Material, Mesh, MeshBuilder, Scene, SceneLoader, StandardMaterial, TransformNode, Vector3, Quaternion } from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { ChartMarkerThemeScreen } from '../../editor/model/components';
import { resolveAlarmTrigger, resolveAlarmTargets, resolveAlarmDeviceBinding, type AlarmTriggerKind } from '../../editor/model/alarmManager';
import { deviceTelemetryStore } from '../mqtt/deviceTelemetry';
import { AlarmTelemetryTracker } from '../mqtt/AlarmTelemetryTracker';
import { ChartMarkerPresentation, getChartMarkerStyle } from './ChartMarkerPresentation';
import { PoiEffectRuntime } from './effects/PoiEffectRuntime';
import { suspendTargetModelEffects } from './effects/TargetModelEffects';
import { MODEL_EFFECT_KINDS } from '../../editor/model/digitalTwinEffect';
import { createDefaultPoiEffectComponent } from '../../editor/model/poiEffect';
import { createDefaultEffectConfiguration } from '../../editor/model/effectConfigurationValidation';
import type { DataPlatformScreenOverlayItem } from './SceneRuntime';
import type { RuntimeWorldBounds } from './runtimeNodeGeometry';
import { AssetLoadScheduler } from './AssetLoadScheduler';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';

export type AlarmActivation = { managerId: string; targetId: string; focusCamera: boolean; theme: ChartMarkerThemeScreen | null };
type Host = {
  meshes: (id: string) => readonly AbstractMesh[];
  node?: (id: string) => TransformNode | AbstractMesh | null;
  bounds: (id: string) => RuntimeWorldBounds | null;
  visible: (id: string) => boolean;
  activate: (event: AlarmActivation) => void;
  report: (message: string) => void;
};
type ActiveAlarm = { manager: Entity; target: Entity; trigger: AlarmTriggerKind; activatedAt: number; activatedTimeText: string; root: TransformNode; marker?: Mesh; markerMaterial?: StandardMaterial; style: DataPlatformScreenOverlayItem['markerStyle']; appearance?: TransformNode; disposeAppearance?: () => void; generation: number; modelEffectLeases: Map<AbstractMesh, () => void> };
type Tint = { original: Material | null; replacement: Material; mesh: AbstractMesh; proxy?: Mesh; originalEnabled: boolean; color: string; releaseModelEffectLease: () => void };
const STATIC_EMISSIVE_STRENGTH = 0.35;
const ALARM_BREATHING_PERIOD_MS = 1600;

function alarmConditionSignature(manager: Entity, target: Entity): string {
  const c = manager.components.alarmManager!;
  return JSON.stringify([c.listenProperty, c.runningState, c.customProperty, c.customValue, c.warehouseAlarm, resolveAlarmDeviceBinding(target)]);
}

/** 颜色只覆盖当前设备的运行时材质；解除、停止预览与删除均恢复原材质引用。 */
export class AlarmColorOverrides {
  private readonly entries = new Map<AbstractMesh, Tint>();
  apply(desired: ReadonlyMap<AbstractMesh, string>, activeAlarms?: ReadonlySet<AbstractMesh>, breathingStrength = STATIC_EMISSIVE_STRENGTH): void {
    for (const [mesh, entry] of this.entries) {
      if (desired.has(mesh) && !mesh.isDisposed()) continue;
      if (!mesh.isDisposed()) {
        if (entry.proxy) mesh.setEnabled(entry.originalEnabled);
        else if (mesh.material === entry.replacement) mesh.material = entry.original;
      }
      entry.proxy?.dispose(false, false);
      entry.replacement.dispose(false, false);
      this.entries.delete(mesh);
      entry.releaseModelEffectLease();
    }
    for (const [mesh, color] of desired) {
      if (mesh.isDisposed()) continue;
      let entry = this.entries.get(mesh);
      if (!entry) {
        const releaseModelEffectLease = suspendTargetModelEffects(mesh);
        const original = mesh.material;
        const material = new StandardMaterial(mesh.name + '_alarmColor', mesh.getScene());
        if (original) { material.alpha = original.alpha; material.backFaceCulling = original.backFaceCulling; }
        material.diffuseColor = Color3.FromHexString(color);
        material.emissiveColor = Color3.FromHexString(color).scale(STATIC_EMISSIVE_STRENGTH);
        let proxy: Mesh | undefined;
        const originalEnabled = mesh.isEnabled(false);
        if (mesh instanceof InstancedMesh) {
          proxy = mesh.sourceMesh.clone(mesh.name + '_alarm', mesh.parent, true, false);
          proxy.material = material;
          proxy.isPickable = mesh.isPickable;
          proxy.metadata = mesh.metadata;
          proxy.setEnabled(originalEnabled);
          mesh.setEnabled(false);
        } else mesh.material = material;
        entry = { original, replacement: material, mesh, proxy, originalEnabled, color, releaseModelEffectLease };
        this.entries.set(mesh, entry);
      }
      const material = entry.replacement as StandardMaterial;
      material.diffuseColor = Color3.FromHexString(color);
      // 仅活动报警目标改变自发光强度；普通状态色和共享原材质保持原行为。
      const emissiveStrength = activeAlarms?.has(mesh) && Number.isFinite(breathingStrength)
        ? Math.max(0, Math.min(1, breathingStrength)) : STATIC_EMISSIVE_STRENGTH;
      material.emissiveColor = Color3.FromHexString(color).scale(emissiveStrength);
      if (entry.proxy) {
        entry.proxy.position.copyFrom(mesh.position); entry.proxy.scaling.copyFrom(mesh.scaling);
        entry.proxy.rotation.copyFrom(mesh.rotation); entry.proxy.rotationQuaternion = mesh.rotationQuaternion?.clone() ?? null;
      }
    }
  }
  clear(): void { this.apply(new Map()); }
}

/** 编辑器和发布 Viewer 共用报警边沿、资源生命周期及图表立标。 */
export class AlarmManagerRuntime {
  private managers: { entity: Entity; targets: Entity[] }[] = [];
  private readonly active = new Map<string, ActiveAlarm>();
  private readonly resumedActivations = new Map<string, { activatedAt: number; signature: string }>();
  private readonly colors = new AlarmColorOverrides();
  private readonly presentation = new ChartMarkerPresentation();
  private readonly effects: PoiEffectRuntime;
  private readonly telemetry = new AlarmTelemetryTracker(deviceTelemetryStore);
  private readonly scheduler = new AssetLoadScheduler(4);
  private readonly containers = new Map<string, Promise<AssetContainer>>();
  private readonly loadedContainers = new Set<AssetContainer>();
  private readonly reportedLoadErrors = new Set<string>();
  private loadAbort = new AbortController();
  private desiredColors = new Map<AbstractMesh, string>();
  private breathingMeshes = new Set<AbstractMesh>();
  private lastEvaluation = -Infinity;
  private generation = 0;
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly host: Host) {
    this.effects = new PoiEffectRuntime(scene, id => this.host.node?.(id) ?? this.host.meshes(id)[0] ?? null, () => false, true);
  }

  sync(document: SceneDocument): void {
    for (const [key, entry] of this.active) this.resumedActivations.set(key, { activatedAt: entry.activatedAt, signature: alarmConditionSignature(entry.manager, entry.target) });
    this.reset(false);
    this.managers = document.entityIds.flatMap(id => {
      const entity = document.entities[id];
      return entity?.components.alarmManager ? [{ entity, targets: resolveAlarmTargets(document, entity.components.alarmManager) }] : [];
    });
    const conditions = new Map(this.managers.flatMap(({ entity, targets }) => targets.map(target => [entity.id + ':alarm:' + target.id, alarmConditionSignature(entity, target)] as const)));
    for (const [key, resumed] of this.resumedActivations) if (conditions.get(key) !== resumed.signature) this.resumedActivations.delete(key);
    this.telemetry.watch(this.managers.flatMap(({ entity, targets }) => {
      const c = entity.components.alarmManager!;
      return c.listenProperty === 'CUSTOM PROPERTY' ? targets.map(target => ({ ...resolveAlarmDeviceBinding(target),
        properties: [c.customProperty, ...(c.warehouseAlarm ? ['warehouseAlarm'] : [])],
      })) : [];
    }));
  }

  update(now = Date.now()): void {
    if (this.disposed) return;
    if (now - this.lastEvaluation >= 250) { this.evaluate(now); this.lastEvaluation = now; }
    const phase = Number.isFinite(now) ? (now % ALARM_BREATHING_PERIOD_MS) / ALARM_BREATHING_PERIOD_MS : 0;
    const breathingStrength = STATIC_EMISSIVE_STRENGTH + (1 - STATIC_EMISSIVE_STRENGTH) * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
    this.colors.apply(this.desiredColors, this.breathingMeshes, breathingStrength);
    const effectIds = new Set<string>();
    for (const [key, entry] of this.active) {
      const c = entry.manager.components.alarmManager!;
      const bounds = this.host.bounds(entry.target.id);
      if (!bounds) continue;
      const center = bounds.minimum.add(bounds.maximum).scale(0.5);
      entry.root.position.set(center.x, bounds.maximum.y, center.z);
      if (entry.marker) {
        entry.marker.position.set(center.x, bounds.maximum.y + 1, center.z);
        this.presentation.update(entry.marker, c.marker, true, true);
      }
      if (c.appearanceEffect || !c.appearanceModel) {
        effectIds.add(key);
        let effect = c.appearanceEffect ?? createDefaultPoiEffectComponent('fire');
        if (effect.configuration?.parameters.fitTarget === true && effect.visual) {
          const radius = Math.hypot(bounds.maximum.x - bounds.minimum.x, bounds.maximum.z - bounds.minimum.z) * 0.5 + 0.25;
          effect = { ...effect, visual: { ...effect.visual, radius: Math.max(effect.visual.radius, radius) } };
        }
        if (effect.effectKind === 'alarm-label') {
          const configuration = effect.configuration ?? createDefaultEffectConfiguration(effect);
          effect = { ...effect, configuration: { ...configuration, parameters: { ...configuration.parameters,
            title: configuration.parameters.title || entry.target.name,
            timeText: configuration.parameters.timeText || entry.activatedTimeText,
          } } };
        }
        const emitFromTop = ['alarm-icon', 'alarm-label', 'fire', 'flame', 'smoke', 'smoke-plume', 'sparks', 'steam-leak', 'gas-leak', 'water-jet', 'warning-beacon'].includes(effect.effectKind);
        this.effects.sync({ ...entry.target, id: key, components: {
          transform: { position: { x: center.x, y: emitFromTop ? bounds.maximum.y : bounds.minimum.y, z: center.z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          poiEffect: effect.visual ? { ...effect, visual: { ...effect.visual, targetEntityId: entry.target.id } } : effect,
        } }, false, true, false);
        // 使用目标真实世界姿态，包含父级变换和运行时移动；预设尺寸继续以米计，避免重复应用 GLB 单位缩放。
        const node = this.host.node?.(entry.target.id) ?? this.host.meshes(entry.target.id)[0];
        const root = this.effects.getGizmoTarget(key);
        if (node && root) {
          root.rotationQuaternion ??= Quaternion.Identity();
          node.computeWorldMatrix(true).decompose(undefined, root.rotationQuaternion);
          // 地面外观保持水平，悬浮告警保持竖直；设备倾斜不能让警戒圈或文字跟着躺倒。
          if (['alarm-icon', 'alarm-label'].includes(effect.effectKind)) root.rotationQuaternion.copyFrom(Quaternion.Identity());
          else if (['alarm-zone', 'alarm-route', 'alarm-pulse', 'breathing-ring', 'ripple-ring'].includes(effect.effectKind)) {
            root.rotationQuaternion.copyFrom(Quaternion.FromEulerAngles(0, root.rotationQuaternion.toEulerAngles().y, 0));
          }
        }
      }
    }
    this.effects.disposeMissing(effectIds);
  }

  private evaluate(now: number): void {
    const desired = new Set<string>();
    const colors = new Map<AbstractMesh, string>();
    const breathingMeshes = new Set<AbstractMesh>();
    const modelAppearanceMeshes = new Set<AbstractMesh>();
    for (const { entity: manager, targets } of this.managers) {
      if (!this.host.visible(manager.id)) continue;
      const c = manager.components.alarmManager!;
      let newTarget: string | undefined;
      let newTrigger: AlarmTriggerKind | undefined;
      for (const target of targets) {
        if (!this.host.visible(target.id)) continue;
        const binding = resolveAlarmDeviceBinding(target);
        const { assetCode, deviceType, sourceId } = binding;
        const snapshot = c.listenProperty === 'CUSTOM PROPERTY' ? this.telemetry.getSnapshot(binding)
          : deviceType && assetCode ? deviceTelemetryStore.getSnapshot(assetCode, deviceType, sourceId) : null;
        const trigger = resolveAlarmTrigger(c, target, snapshot, now);
        const key = manager.id + ':alarm:' + target.id;
        if (!trigger) { this.resumedActivations.delete(key); continue; }
        const meshes = this.host.meshes(target.id);
        if (!meshes.length) continue;
        desired.add(key);
        if (c.overrideColorEnabled !== false) for (const mesh of meshes) {
          if (!colors.has(mesh)) colors.set(mesh, c.overrideColor);
          breathingMeshes.add(mesh);
        }
        const existing = this.active.get(key);
        if (!existing || existing.trigger !== trigger) {
          if (existing) existing.trigger = trigger;
          else this.createEntry(key, manager, target, trigger, now);
          if (!newTarget || trigger === 'warehouse') { newTarget = target.id; newTrigger = trigger; }
        }
        if (c.appearanceEffect?.enabled && MODEL_EFFECT_KINDS.has(c.appearanceEffect.effectKind)) {
          const leases = this.active.get(key)!.modelEffectLeases;
          for (const [mesh, release] of leases) if (!meshes.includes(mesh) || mesh.isDisposed()) { release(); leases.delete(mesh); }
          for (const mesh of meshes) {
            modelAppearanceMeshes.add(mesh);
            if (!leases.has(mesh)) leases.set(mesh, suspendTargetModelEffects(mesh));
          }
        }
      }
      if (newTarget) this.host.activate({ managerId: manager.id, targetId: newTarget, focusCamera: c.focusCamera,
        theme: newTrigger === 'warehouse' ? c.warehouseTheme ?? c.theme : c.theme });
    }
    for (const [key, entry] of this.active) if (!desired.has(key)) this.removeEntry(key, entry);
    this.effects.disposeMissing(new Set(this.active.keys()));
    for (const mesh of modelAppearanceMeshes) colors.delete(mesh);
    this.desiredColors = colors;
    this.breathingMeshes = breathingMeshes;
  }

  private createEntry(key: string, manager: Entity, target: Entity, trigger: AlarmTriggerKind, activatedAt: number): void {
    const c = manager.components.alarmManager!;
    // 同一持续报警的文档同步仅重建外观，不伪造新的触发时间；解除或显式reset才开始下一轮。
    activatedAt = this.resumedActivations.get(key)?.activatedAt ?? activatedAt;
    this.resumedActivations.delete(key);
    const entry: ActiveAlarm = { manager, target, trigger, activatedAt, activatedTimeText: new Date(activatedAt).toLocaleString(), root: new TransformNode(key, this.scene), generation: this.generation, modelEffectLeases: new Map(),
      style: getChartMarkerStyle({ ...c.marker, contentType: c.associationType === 'builtin' ? 'builtin' : 'screen' }) };
    this.active.set(key, entry);
    if (c.showMarker) {
      entry.marker = MeshBuilder.CreateGround(key + '_chart', { width: 2, height: 2 }, this.scene);
      const upright = c.marker.geometryBasis === 'upright';
      entry.marker.scaling.set(2, upright ? 1.125 : 1, upright ? 1 : 1.125);
      entry.marker.rotation.x = upright ? 0 : Math.PI / 2;
      entry.marker.isPickable = false;
      // 保留基础材质，让 Babylon 将动态创建的立标送入渲染队列，再由深度层替换材质。
      entry.markerMaterial = new StandardMaterial(key + '_chartMaterial', this.scene);
      entry.markerMaterial.backFaceCulling = false;
      entry.marker.material = entry.markerMaterial;
    }
    if (!c.appearanceEffect && c.appearanceModel?.kind === 'mesh') {
      const target = c.appearanceModel;
      const mesh = target.meshKind === 'sphere' ? MeshBuilder.CreateSphere(key + '_appearance', {}, this.scene)
        : target.meshKind === 'plane' ? MeshBuilder.CreatePlane(key + '_appearance', {}, this.scene)
        : MeshBuilder.CreateBox(key + '_appearance', {}, this.scene);
      const material = new StandardMaterial(key + '_appearanceMaterial', this.scene);
      material.diffuseColor = Color3.FromHexString(target.materialColor);
      mesh.material = material; mesh.parent = entry.root; mesh.isPickable = false;
      entry.disposeAppearance = () => { mesh.dispose(); material.dispose(); };
    }
    if (!c.appearanceEffect && c.appearanceModel?.kind === 'model') {
      const asset = c.appearanceModel.modelAsset;
      const url = asset.sourceUrl;
      const cacheKey = url + ':' + (asset.assetRevision ?? '');
      let promise = this.containers.get(cacheKey);
      if (!promise) {
        const generation = this.generation;
        promise = this.scheduler.run(() => SceneLoader.LoadAssetContainerAsync('', resolveRuntimeAssetUrl(url), this.scene), this.loadAbort.signal).then(container => {
          if (this.disposed || generation !== this.generation) { container.dispose(); throw new Error('报警模型加载已取消'); }
          this.loadedContainers.add(container); return container;
        });
        this.containers.set(cacheKey, promise);
      }
      void promise.then(container => {
        if (this.active.get(key) !== entry || entry.generation !== this.generation) return;
        const instance = container.instantiateModelsToScene(name => key + '_' + name, false, { doNotInstantiate: true });
        const appearance = new TransformNode(key + '_appearance', this.scene);
        appearance.parent = entry.root;
        appearance.scaling.setAll(asset.unitScaleToMeters);
        for (const node of instance.rootNodes) node.parent = appearance;
        for (const mesh of appearance.getChildMeshes()) mesh.isPickable = false;
        entry.appearance = appearance;
        entry.disposeAppearance = () => { instance.dispose(); appearance.dispose(); };
      }).catch(error => {
        if (this.active.get(key) === entry && entry.generation === this.generation && !this.reportedLoadErrors.has(cacheKey)) {
          this.reportedLoadErrors.add(cacheKey);
          this.host.report('报警外观模型加载失败：' + (error instanceof Error ? error.message : String(error)));
        }
      });
    }
  }

  getOverlayItems(): DataPlatformScreenOverlayItem[] {
    return [...this.active.entries()].flatMap(([key, entry]) => {
      if (!entry.marker) return [];
      const c = entry.manager.components.alarmManager!;
      const screen = c.markerScreen ?? (entry.trigger === 'warehouse' ? c.warehouseTheme ?? c.theme : c.theme);
      const external = c.associationType === 'third-party' || c.associationType === 'video';
      return [{ entityId: key, name: c.markerCategory + ' · ' + entry.target.name, chartMarker: true, markerStyle: entry.style, markerText: c.marker.text || entry.target.name, mesh: entry.marker,
        ...(external ? { screenUrl: c.contentUrl || undefined, alarmMediaType: c.associationType === 'video' ? 'video' as const : 'third-party' as const } : screen && c.associationType === 'chart' ? { projectId: screen.projectId, screenId: screen.screenId, screenUrl: screen.screenUrl, thumbnailUrl: screen.thumbnailUrl } : {}),
      }];
    });
  }

  isActive(managerId: string, targetId: string): boolean {
    return this.active.has(managerId + ':alarm:' + targetId);
  }

  private removeEntry(key: string, entry: ActiveAlarm): void {
    this.active.delete(key);
    for (const release of entry.modelEffectLeases.values()) release();
    entry.modelEffectLeases.clear();
    if (entry.marker) { this.presentation.remove(entry.marker); entry.marker.dispose(); }
    entry.markerMaterial?.dispose();
    entry.disposeAppearance?.(); entry.root.dispose();
  }
  reset(clearTelemetry = true): void {
    if (clearTelemetry) { this.telemetry.reset(); this.resumedActivations.clear(); }
    this.generation += 1;
    this.loadAbort.abort(); this.loadAbort = new AbortController(); this.reportedLoadErrors.clear();
    this.colors.clear(); this.desiredColors.clear(); this.breathingMeshes.clear();
    for (const [key, entry] of this.active) this.removeEntry(key, entry);
    this.effects.disposeMissing(new Set());
    for (const container of this.loadedContainers) container.dispose();
    this.loadedContainers.clear(); this.containers.clear(); this.lastEvaluation = -Infinity;
  }
  dispose(): void { this.disposed = true; this.reset(); this.telemetry.dispose(); this.scheduler.dispose(); this.effects.dispose(); }
}
