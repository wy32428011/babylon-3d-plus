import { AbstractMesh, AssetContainer, Color3, InstancedMesh, Material, Mesh, MeshBuilder, Scene, SceneLoader, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { ChartMarkerThemeScreen } from '../../editor/model/components';
import { resolveAlarmTrigger, resolveAlarmTargets, type AlarmTriggerKind } from '../../editor/model/alarmManager';
import { deviceTelemetryStore } from '../mqtt/deviceTelemetry';
import { ChartMarkerPresentation, getChartMarkerStyle } from './ChartMarkerPresentation';
import { PoiEffectRuntime } from './effects/PoiEffectRuntime';
import { createDefaultPoiEffectComponent } from '../../editor/model/poiEffect';
import type { DataPlatformScreenOverlayItem } from './SceneRuntime';
import type { RuntimeWorldBounds } from './runtimeNodeGeometry';
import { AssetLoadScheduler } from './AssetLoadScheduler';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';

export type AlarmActivation = { managerId: string; targetId: string; focusCamera: boolean; theme: ChartMarkerThemeScreen | null };
type Host = {
  meshes: (id: string) => readonly AbstractMesh[];
  bounds: (id: string) => RuntimeWorldBounds | null;
  visible: (id: string) => boolean;
  activate: (event: AlarmActivation) => void;
  report: (message: string) => void;
};
type ActiveAlarm = { manager: Entity; target: Entity; trigger: AlarmTriggerKind; root: TransformNode; marker?: Mesh; markerMaterial?: StandardMaterial; style: DataPlatformScreenOverlayItem['markerStyle']; appearance?: TransformNode; disposeAppearance?: () => void; generation: number };
type Tint = { original: Material | null; replacement: Material; mesh: AbstractMesh; proxy?: Mesh; originalEnabled: boolean; color: string };

/** 颜色只覆盖当前设备的运行时材质；解除、停止预览与删除均恢复原材质引用。 */
export class AlarmColorOverrides {
  private readonly entries = new Map<AbstractMesh, Tint>();
  apply(desired: ReadonlyMap<AbstractMesh, string>): void {
    for (const [mesh, entry] of this.entries) {
      if (desired.has(mesh) && !mesh.isDisposed()) continue;
      if (!mesh.isDisposed()) {
        if (entry.proxy) mesh.setEnabled(entry.originalEnabled);
        else if (mesh.material === entry.replacement) mesh.material = entry.original;
      }
      entry.proxy?.dispose(false, false);
      entry.replacement.dispose(false, false);
      this.entries.delete(mesh);
    }
    for (const [mesh, color] of desired) {
      if (mesh.isDisposed()) continue;
      let entry = this.entries.get(mesh);
      if (!entry) {
        const original = mesh.material;
        const material = new StandardMaterial(mesh.name + '_alarmColor', mesh.getScene());
        if (original) { material.alpha = original.alpha; material.backFaceCulling = original.backFaceCulling; }
        material.diffuseColor = Color3.FromHexString(color);
        material.emissiveColor = Color3.FromHexString(color).scale(0.35);
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
        entry = { original, replacement: material, mesh, proxy, originalEnabled, color };
        this.entries.set(mesh, entry);
      }
      const material = entry.replacement as StandardMaterial;
      material.diffuseColor = Color3.FromHexString(color);
      material.emissiveColor = Color3.FromHexString(color).scale(0.35);
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
  private readonly colors = new AlarmColorOverrides();
  private readonly presentation = new ChartMarkerPresentation();
  private readonly effects: PoiEffectRuntime;
  private readonly scheduler = new AssetLoadScheduler(4);
  private readonly containers = new Map<string, Promise<AssetContainer>>();
  private readonly loadedContainers = new Set<AssetContainer>();
  private readonly reportedLoadErrors = new Set<string>();
  private loadAbort = new AbortController();
  private desiredColors = new Map<AbstractMesh, string>();
  private lastEvaluation = -Infinity;
  private generation = 0;
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly host: Host) { this.effects = new PoiEffectRuntime(scene); }

  sync(document: SceneDocument): void {
    this.reset();
    this.managers = document.entityIds.flatMap(id => {
      const entity = document.entities[id];
      return entity?.components.alarmManager ? [{ entity, targets: resolveAlarmTargets(document, entity.components.alarmManager) }] : [];
    });
  }

  update(now = Date.now()): void {
    if (this.disposed) return;
    if (now - this.lastEvaluation >= 250) { this.evaluate(now); this.lastEvaluation = now; }
    this.colors.apply(this.desiredColors);
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
      if (!c.appearanceModel) {
        effectIds.add(key);
        this.effects.sync({ ...entry.target, id: key, components: {
          transform: { position: { x: center.x, y: bounds.maximum.y, z: center.z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          poiEffect: createDefaultPoiEffectComponent('fire'),
        } }, false, true, false);
      }
    }
    this.effects.disposeMissing(effectIds);
  }

  private evaluate(now: number): void {
    const desired = new Set<string>();
    const colors = new Map<AbstractMesh, string>();
    for (const { entity: manager, targets } of this.managers) {
      if (!this.host.visible(manager.id)) continue;
      const c = manager.components.alarmManager!;
      let newTarget: string | undefined;
      let newTrigger: AlarmTriggerKind | undefined;
      for (const target of targets) {
        if (!this.host.visible(target.id)) continue;
        const asset = target.components.modelAsset!;
        const binding = target.components.telemetryBinding;
        const code = binding?.assetCode || asset.assetCode;
        const type = binding?.deviceType || asset.dataDrivenConfig?.device.devType;
        const snapshot = type && code ? deviceTelemetryStore.getSnapshot(code, type, binding?.sourceId) : null;
        const trigger = resolveAlarmTrigger(c, target, snapshot, now);
        if (!trigger) continue;
        const meshes = this.host.meshes(target.id);
        if (!meshes.length) continue;
        const key = manager.id + ':alarm:' + target.id;
        desired.add(key);
        for (const mesh of meshes) if (!colors.has(mesh)) colors.set(mesh, c.overrideColor);
        const existing = this.active.get(key);
        if (!existing || existing.trigger !== trigger) {
          if (existing) existing.trigger = trigger;
          else this.createEntry(key, manager, target, trigger);
          if (!newTarget || trigger === 'warehouse') { newTarget = target.id; newTrigger = trigger; }
        }
      }
      if (newTarget) this.host.activate({ managerId: manager.id, targetId: newTarget, focusCamera: c.focusCamera,
        theme: newTrigger === 'warehouse' ? c.warehouseTheme ?? c.theme : c.theme });
    }
    for (const [key, entry] of this.active) if (!desired.has(key)) this.removeEntry(key, entry);
    this.desiredColors = colors;
  }

  private createEntry(key: string, manager: Entity, target: Entity, trigger: AlarmTriggerKind): void {
    const c = manager.components.alarmManager!;
    const entry: ActiveAlarm = { manager, target, trigger, root: new TransformNode(key, this.scene), generation: this.generation,
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
    if (c.appearanceModel?.kind === 'mesh') {
      const target = c.appearanceModel;
      const mesh = target.meshKind === 'sphere' ? MeshBuilder.CreateSphere(key + '_appearance', {}, this.scene)
        : target.meshKind === 'plane' ? MeshBuilder.CreatePlane(key + '_appearance', {}, this.scene)
        : MeshBuilder.CreateBox(key + '_appearance', {}, this.scene);
      const material = new StandardMaterial(key + '_appearanceMaterial', this.scene);
      material.diffuseColor = Color3.FromHexString(target.materialColor);
      mesh.material = material; mesh.parent = entry.root; mesh.isPickable = false;
      entry.disposeAppearance = () => { mesh.dispose(); material.dispose(); };
    }
    if (c.appearanceModel?.kind === 'model') {
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
    if (entry.marker) { this.presentation.remove(entry.marker); entry.marker.dispose(); }
    entry.markerMaterial?.dispose();
    entry.disposeAppearance?.(); entry.root.dispose();
  }
  reset(): void {
    this.generation += 1;
    this.loadAbort.abort(); this.loadAbort = new AbortController(); this.reportedLoadErrors.clear();
    this.colors.clear(); this.desiredColors.clear();
    for (const [key, entry] of this.active) this.removeEntry(key, entry);
    this.effects.disposeMissing(new Set());
    for (const container of this.loadedContainers) container.dispose();
    this.loadedContainers.clear(); this.containers.clear(); this.lastEvaluation = -Infinity;
  }
  dispose(): void { this.disposed = true; this.reset(); this.scheduler.dispose(); this.effects.dispose(); }
}
