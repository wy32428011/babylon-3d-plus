import { ArcRotateCamera, Color3, Scene, Vector3, type AbstractMesh, type Light, type TransformNode } from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';

type Entry = { component: PoiEffectComponent; active: boolean; time: number };
type CameraPose = { camera: ArcRotateCamera; alpha: number; beta: number; radius: number; target: Vector3 };
const environmentKinds = new Set(['environment-fog', 'day-night', 'target-follow']);
export const supportsSceneEnvironmentEffect = (kind: string) => environmentKinds.has(kind);

/** 仅拥有自己开启的全局效果；失效时恢复进入前状态，多个同类实例按登记顺序互斥。 */
export class SceneEnvironmentEffects {
  private readonly entries = new Map<string, Entry>();
  private fogBaseline: { mode: number; color: Color3; start: number; end: number; density: number } | null = null;
  private lightBaseline: { environment: number; lastEnvironment: number; lights: Map<Light, { baseline: number; lastApplied: number }> } | null = null;
  private followId: string | null = null;
  private followBaseline: CameraPose | null = null;
  private lastFollowPose: CameraPose | null = null;
  private followSuspended = false;

  constructor(private readonly scene: Scene, private readonly resolveTarget: (id: string) => TransformNode | AbstractMesh | null, private readonly canFollow: () => boolean) {}

  sync(id: string, component: PoiEffectComponent, active: boolean): void {
    if (!supportsSceneEnvironmentEffect(component.effectKind)) { this.entries.delete(id); return; }
    const existing = this.entries.get(id);
    if (existing) { existing.component = component; existing.active = active; }
    else this.entries.set(id, { component, active, time: 0 });
  }

  tick(deltaSeconds: number): void {
    const first = (kind: string) => [...this.entries].find(([, e]) => e.active && e.component.enabled && e.component.effectKind === kind);
    const fog = first('environment-fog')?.[1];
    if (fog?.component.visual) {
      this.fogBaseline ??= { mode: this.scene.fogMode, color: this.scene.fogColor.clone(), start: this.scene.fogStart, end: this.scene.fogEnd, density: this.scene.fogDensity };
      const v = fog.component.visual;
      this.scene.fogMode = v.opacity > 0 ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
      this.scene.fogColor = Color3.FromHexString(fog.component.primaryColor);
      this.scene.fogStart = v.radius;
      this.scene.fogEnd = v.radius + v.height / Math.max(0.001, v.opacity);
    } else this.restoreFog();

    const day = first('day-night')?.[1];
    if (day?.component.visual) {
      this.lightBaseline ??= { environment: this.scene.environmentIntensity, lastEnvironment: this.scene.environmentIntensity, lights: new Map() };
      const v = day.component.visual;
      day.time += deltaSeconds * day.component.speed;
      const night = v.loop ? (1 - Math.cos(day.time / v.duration * Math.PI * 2)) * 0.5 : v.progress;
      const factor = 1 - night * 0.92;
      // 灯光面板或场景配置更新时，把外部新值作为基准，而不是恢复旧配置。
      if (Math.abs(this.scene.environmentIntensity - this.lightBaseline.lastEnvironment) > 0.000001) this.lightBaseline.environment = this.scene.environmentIntensity;
      this.scene.environmentIntensity = this.lightBaseline.environment * factor;
      this.lightBaseline.lastEnvironment = this.scene.environmentIntensity;
      for (const light of this.scene.lights) {
        let state = this.lightBaseline.lights.get(light);
        if (!state) { state = { baseline: light.intensity, lastApplied: light.intensity }; this.lightBaseline.lights.set(light, state); }
        if (Math.abs(light.intensity - state.lastApplied) > 0.000001) state.baseline = light.intensity;
        light.intensity = state.baseline * factor;
        state.lastApplied = light.intensity;
      }
      for (const light of this.lightBaseline.lights.keys()) if (light.isDisposed()) this.lightBaseline.lights.delete(light);
    } else this.restoreLight();
    this.updateFollow(first('target-follow'), deltaSeconds);
  }

  private capture(camera: ArcRotateCamera): CameraPose { return { camera, alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() }; }
  private matches(pose: CameraPose): boolean {
    const c = pose.camera;
    return this.scene.activeCamera === c && Math.abs(c.alpha - pose.alpha) < 0.0001 && Math.abs(c.beta - pose.beta) < 0.0001 && Math.abs(c.radius - pose.radius) < 0.0001 && Vector3.DistanceSquared(c.target, pose.target) < 0.000001;
  }
  private updateFollow(pair: [string, Entry] | undefined, deltaSeconds: number): void {
    const [id, entry] = pair ?? [null, null];
    const v = entry?.component.visual;
    const target = v?.targetEntityId ? this.resolveTarget(v.targetEntityId) : null;
    const camera = this.scene.activeCamera;
    if (!id || !v || !target || target.isDisposed() || !target.isEnabled() || !this.canFollow() || !(camera instanceof ArcRotateCamera)) { this.restoreFollow(); return; }
    if (this.followId !== id || this.followBaseline?.camera !== camera) {
      this.restoreFollow(); this.followId = id; this.followBaseline = this.capture(camera); this.followSuspended = false;
    }
    // 用户、巡检或漫游接管镜头后不抢回控制权，重新启用组件才恢复跟随。
    if (this.lastFollowPose && (!this.matches(this.lastFollowPose) || camera.inertialAlphaOffset || camera.inertialBetaOffset || camera.inertialRadiusOffset || camera.inertialPanningX || camera.inertialPanningY)) this.followSuspended = true;
    if (this.followSuspended) return;
    target.computeWorldMatrix(true);
    const targetPosition = target.getAbsolutePosition();
    const blend = this.lastFollowPose ? 1 - Math.exp(-Math.max(0, deltaSeconds) * 8) : 1;
    camera.setTarget(Vector3.Lerp(camera.target, targetPosition, blend));
    camera.radius = Math.hypot(v.radius, v.height);
    camera.beta = Math.atan2(v.radius, v.height);
    this.lastFollowPose = this.capture(camera);
  }
  private restoreFollow(): void {
    const pose = this.followBaseline;
    if (pose && !pose.camera.isDisposed() && (!this.lastFollowPose || this.matches(this.lastFollowPose))) {
      pose.camera.setTarget(pose.target); pose.camera.alpha = pose.alpha; pose.camera.beta = pose.beta; pose.camera.radius = pose.radius;
    }
    this.followId = null; this.followBaseline = null; this.lastFollowPose = null; this.followSuspended = false;
  }
  private restoreFog(): void {
    if (!this.fogBaseline) return;
    const b = this.fogBaseline;
    this.scene.fogMode = b.mode; this.scene.fogColor = b.color; this.scene.fogStart = b.start; this.scene.fogEnd = b.end; this.scene.fogDensity = b.density;
    this.fogBaseline = null;
  }
  private restoreLight(): void {
    if (!this.lightBaseline) return;
    if (Math.abs(this.scene.environmentIntensity - this.lightBaseline.lastEnvironment) < 0.000001) this.scene.environmentIntensity = this.lightBaseline.environment;
    for (const [light, state] of this.lightBaseline.lights) if (!light.isDisposed() && Math.abs(light.intensity - state.lastApplied) < 0.000001) light.intensity = state.baseline;
    this.lightBaseline = null;
  }
  disposeMissing(ids: Set<string>): void { for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id); }
  dispose(): void { this.entries.clear(); this.restoreFollow(); this.restoreFog(); this.restoreLight(); }
}
