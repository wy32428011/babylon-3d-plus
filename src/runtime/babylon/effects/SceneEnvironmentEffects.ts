import { ArcRotateCamera, Color3, Scene, Vector3, type AbstractMesh, type Light, type TransformNode } from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';
import type { SceneThemeSettings } from '../../../editor/model/sceneTheme';

type Entry = { component: PoiEffectComponent; active: boolean; time: number };
type CameraPose = { camera: ArcRotateCamera; alpha: number; beta: number; radius: number; target: Vector3 };
export type SceneEffectStatus = { status: 'active' | 'inactive' | 'paused' | 'missing-target' | 'occupied'; message: string };
const environmentKinds = new Set(['environment-fog', 'day-night', 'target-follow']);
export const supportsSceneEnvironmentEffect = (kind: string) => environmentKinds.has(kind);
const parameters = (component: PoiEffectComponent) => component.configuration?.parameters ?? {};
const number = (component: PoiEffectComponent, key: string, fallback: number, min = -100000, max = 100000) => {
  const value = parameters(component)[key];
  return Math.max(min, Math.min(max, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
};
const vector = (component: PoiEffectComponent, key: string, fallback: Vector3) => {
  const value = parameters(component)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('x' in value)) return fallback;
  return new Vector3(...[value.x, value.y, value.z].map(entry => typeof entry === 'number' && Number.isFinite(entry) ? Math.max(-100000, Math.min(100000, entry)) : 0) as [number, number, number]);
};
const safeColor = (value: unknown, fallback: string) => Color3.FromHexString(typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback);

/** 仅拥有自己开启的全局效果；失效时恢复进入前状态，多个同类实例按登记顺序互斥。 */
export class SceneEnvironmentEffects {
  private readonly entries = new Map<string, Entry>();
  private fixedTheme = false;
  /** 固定主题接管昼夜；显式雾组件仍可覆盖主题的雾，停用后恢复最新主题值。 */
  setThemeActive(active: boolean): void {
    this.fixedTheme = active;
    if (active) this.restoreLight();
  }
  private themeFog: Pick<SceneThemeSettings, 'fogEnabled' | 'fogColor' | 'fogStart' | 'fogEnd'> | null = null;
  /** 雾只在此处保存一份原始基线；显式组件优先，主题次之，全部停用才恢复。 */
  setThemeFog(theme: SceneThemeSettings | null): void {
    this.themeFog = theme ? { fogEnabled: theme.fogEnabled, fogColor: theme.fogColor, fogStart: theme.fogStart, fogEnd: theme.fogEnd } : null;
    this.syncFog();
  }
  private fogBaseline: { mode: number; color: Color3; start: number; end: number; density: number } | null = null;
  private lightBaseline: { environment: number; lastEnvironment: number; lights: Map<Light, { baseline: number; lastApplied: number }> } | null = null;
  private followId: string | null = null;
  private followBaseline: CameraPose | null = null;
  private lastFollowPose: CameraPose | null = null;
  private followSuspended = false;
  private followExitBehavior: 'restore' | 'hold' = 'restore';
  private readonly statuses = new Map<string, SceneEffectStatus>();

  constructor(private readonly scene: Scene, private readonly resolveTarget: (id: string) => TransformNode | AbstractMesh | null, private readonly canFollow: () => boolean) {}

  sync(id: string, component: PoiEffectComponent, active: boolean): void {
    if (!supportsSceneEnvironmentEffect(component.effectKind)) { this.entries.delete(id); return; }
    const existing = this.entries.get(id);
    if (existing) {
      const newlyActive = (!existing.active || !existing.component.enabled) && active && component.enabled;
      if (newlyActive) this.resume(id);
      if (parameters(component).dayMode !== parameters(existing.component).dayMode || (newlyActive && parameters(component).dayMode !== undefined)) existing.time = 0;
      existing.component = component; existing.active = active;
    }
    else this.entries.set(id, { component, active, time: 0 });
  }

  tick(deltaSeconds: number): void {
    deltaSeconds = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(1, deltaSeconds)) : 0;
    const first = (kind: string) => [...this.entries].find(([, e]) => e.active && e.component.enabled && e.component.effectKind === kind);
    this.statuses.clear();
    for (const [id, entry] of this.entries) {
      const enabled = entry.active && entry.component.enabled;
      const occupied = enabled && (first(entry.component.effectKind)?.[0] !== id || (entry.component.effectKind === 'day-night' && this.fixedTheme));
      this.statuses.set(id, { status: !enabled ? 'inactive' : occupied ? 'occupied' : 'active', message: !enabled ? '组件未启用' : occupied ? '同类组件或固定主题已占用控制权' : '正在运行' });
    }
    this.syncFog(deltaSeconds);

    const day = this.fixedTheme ? undefined : first('day-night')?.[1];
    if (day?.component.visual) {
      this.lightBaseline ??= { environment: this.scene.environmentIntensity, lastEnvironment: this.scene.environmentIntensity, lights: new Map() };
      const v = day.component.visual;
      day.time += deltaSeconds * Math.max(0, Math.min(10, day.component.speed));
      const p = parameters(day.component);
      const duration = number(day.component, 'duration', Math.max(.1, v.duration), .1, 86400);
      const hour = number(day.component, 'hour', 12, 0, 24);
      const external = number(day.component, 'progress', v.progress, 0, 1);
      let night = v.loop ? (1 - Math.cos(day.time / duration * Math.PI * 2)) * .5 : v.progress;
      if (p.dayMode === 'external') night = external;
      else if (p.dayMode === 'manual' || p.dayMode === 'loop' || p.dayMode === 'once') {
        const time = p.dayMode === 'loop' ? hour + day.time / duration * 24 : p.dayMode === 'once' ? hour + (number(day.component, 'endHour', 0, 0, 24) - hour) * Math.min(1, day.time / duration) : hour;
        night = (1 + Math.cos(time / 24 * Math.PI * 2)) * .5;
      }
      const factor = p.dayMode === 'once' && day.time >= duration && p.endBehavior === 'restore' ? 1 : 1 - night * (1 - number(day.component, 'lightFloor', .08, 0, 1));
      // 灯光面板或场景配置更新时，把外部新值作为基准，而不是恢复旧配置。
      if (Math.abs(this.scene.environmentIntensity - this.lightBaseline.lastEnvironment) > 0.000001) this.lightBaseline.environment = this.scene.environmentIntensity;
      this.scene.environmentIntensity = this.lightBaseline.environment * factor;
      this.lightBaseline.lastEnvironment = this.scene.environmentIntensity;
      for (const light of this.scene.lights) {
        if (light.metadata?.nightBehavior === 'keep') {
          const previous = this.lightBaseline.lights.get(light);
          if (previous) { if (Math.abs(light.intensity - previous.lastApplied) < 0.000001) light.intensity = previous.baseline; this.lightBaseline.lights.delete(light); }
          continue;
        }
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
    if (!id || !v || !entry) { this.restoreFollow(); return; }
    if (!target || target.isDisposed() || !target.isEnabled()) {
      // 暂时无设备时保留用户正在观察的位置；重新匹配后平滑继续，不跳回初始镜头。
      this.statuses.set(id, { status: 'missing-target', message: '等待绑定目标恢复，镜头保持当前位置' });
      return;
    }
    if (!this.canFollow() || !(camera instanceof ArcRotateCamera)) {
      this.statuses.set(id, { status: 'paused', message: '运行预览、巡检或漫游控制权尚未交给目标跟随' });
      return;
    }
    const p = parameters(entry.component);
    if (this.followId !== id || this.followBaseline?.camera !== camera) {
      this.restoreFollow(); this.followId = id; this.followBaseline = this.capture(camera); this.followSuspended = false;
    }
    this.followExitBehavior = p.exitBehavior === 'hold' ? 'hold' : 'restore';
    if (p.manualTakeover !== false && this.lastFollowPose && (!this.matches(this.lastFollowPose) || camera.inertialAlphaOffset || camera.inertialBetaOffset || camera.inertialRadiusOffset || camera.inertialPanningX || camera.inertialPanningY)) this.followSuspended = true;
    if (this.followSuspended) { this.statuses.set(id, { status: 'paused', message: '镜头已由手动操作接管，可点击恢复跟随' }); return; }
    target.computeWorldMatrix(true);
    const matrix = target.getWorldMatrix();
    const offset = vector(entry.component, 'targetOffset', Vector3.Zero());
    const targetPosition = target.getAbsolutePosition().add(Vector3.TransformNormal(offset, matrix));
    const smoothTime = number(entry.component, 'smoothTime', .125, 0, 30);
    const blend = this.lastFollowPose && smoothTime > 0 ? 1 - Math.exp(-deltaSeconds / smoothTime) : 1;
    let movement = targetPosition.subtract(camera.target).scale(blend);
    const maximumSpeed = number(entry.component, 'maxCatchupSpeed', 0, 0, 100000);
    if (this.lastFollowPose && maximumSpeed > 0 && movement.length() > maximumSpeed * deltaSeconds) movement = movement.normalize().scale(maximumSpeed * deltaSeconds);
    const distance = number(entry.component, 'distance', v.radius, .01, 100000), height = number(entry.component, 'height', v.height);
    let desiredAlpha = camera.alpha, desiredRadius = Math.hypot(distance, height), desiredBeta = Math.atan2(distance, height);
    if (p.cameraMode || p.heading === 'target' || p.lateral !== undefined || p.cameraOffset) {
      const axis = p.forwardAxis === '+x' ? Vector3.Right() : p.forwardAxis === '-x' ? Vector3.Left() : p.forwardAxis === '-z' ? Vector3.Backward() : Vector3.Forward();
      let forward = p.heading === 'target' ? Vector3.TransformNormal(axis, matrix) : new Vector3(-Math.cos(this.followBaseline!.alpha), 0, -Math.sin(this.followBaseline!.alpha));
      forward.y = 0; if (forward.lengthSquared() < 1e-8) forward = Vector3.Forward(); else forward.normalize();
      const right = Vector3.Cross(Vector3.Up(), forward).normalize();
      const lateral = number(entry.component, 'lateral', 0);
      let cameraOffset = p.cameraMode === 'side' ? right.scale(distance).add(forward.scale(lateral)).add(new Vector3(0, height, 0))
        : forward.scale(p.cameraMode === 'overhead' ? -.001 : -distance).add(right.scale(lateral)).add(new Vector3(0, p.cameraMode === 'overhead' ? Math.max(.01, Math.abs(height)) : height, 0));
      if (p.cameraMode === 'custom') {
        const local = vector(entry.component, 'cameraOffset', new Vector3(0, height, -distance));
        cameraOffset = right.scale(local.x).add(forward.scale(local.z)).add(new Vector3(0, local.y, 0));
      }
      desiredRadius = Math.max(.01, cameraOffset.length());
      desiredBeta = Math.acos(Math.max(-1, Math.min(1, cameraOffset.y / desiredRadius)));
      desiredAlpha = Math.atan2(cameraOffset.z, cameraOffset.x);
    }
    const poseBlend = Object.keys(p).length > 0 ? blend : 1;
    const alpha = camera.alpha + Math.atan2(Math.sin(desiredAlpha - camera.alpha), Math.cos(desiredAlpha - camera.alpha)) * poseBlend;
    const beta = camera.beta + (desiredBeta - camera.beta) * poseBlend;
    const radius = camera.radius + (desiredRadius - camera.radius) * poseBlend;
    camera.getViewMatrix(true);
    const previousPosition = camera.position.clone();
    camera.setTarget(camera.target.add(movement)); camera.alpha = alpha; camera.beta = beta; camera.radius = radius;
    if (this.lastFollowPose && maximumSpeed > 0) {
      camera.getViewMatrix(true);
      const cameraMovement = camera.position.subtract(previousPosition);
      // 目标急转弯也约束相机实际位移，防止只限制视点而相机仍绕目标瞬移。
      if (cameraMovement.length() > maximumSpeed * deltaSeconds) camera.setPosition(previousPosition.add(cameraMovement.normalize().scale(maximumSpeed * deltaSeconds)));
    }
    this.lastFollowPose = this.capture(camera);
  }
  resume(id: string): void {
    if (this.followId !== id) return;
    this.followSuspended = false;
    const camera = this.scene.activeCamera;
    if (camera instanceof ArcRotateCamera) {
      camera.inertialAlphaOffset = 0; camera.inertialBetaOffset = 0; camera.inertialRadiusOffset = 0; camera.inertialPanningX = 0; camera.inertialPanningY = 0;
      this.lastFollowPose = this.capture(camera);
    }
  }
  getStatus(id: string): SceneEffectStatus { return this.statuses.get(id) ?? { status: 'inactive', message: '组件尚未运行' }; }
  private restoreFollow(): void {
    const pose = this.followBaseline;
    if (this.followExitBehavior === 'restore' && pose && !pose.camera.isDisposed() && (!this.lastFollowPose || this.matches(this.lastFollowPose))) {
      pose.camera.setTarget(pose.target); pose.camera.alpha = pose.alpha; pose.camera.beta = pose.beta; pose.camera.radius = pose.radius;
    }
    this.followId = null; this.followBaseline = null; this.lastFollowPose = null; this.followSuspended = false;
  }
  private syncFog(deltaSeconds = 0): void {
    const fog = [...this.entries.values()].find(entry => entry.active && entry.component.enabled && entry.component.effectKind === 'environment-fog');
    const visual = fog?.component.visual;
    if (!visual && !this.themeFog) { this.restoreFog(); return; }
    this.fogBaseline ??= { mode: this.scene.fogMode, color: this.scene.fogColor.clone(), start: this.scene.fogStart, end: this.scene.fogEnd, density: this.scene.fogDensity };
    if (visual && fog) {
      const p = parameters(fog.component);
      const transition = number(fog.component, 'transition', 0, 0, 60);
      const blend = transition > 0 ? 1 - Math.exp(-deltaSeconds / transition) : 1;
      this.scene.fogMode = visual.opacity > 0 ? p.fogMode === 'exp' ? Scene.FOGMODE_EXP : p.fogMode === 'exp2' ? Scene.FOGMODE_EXP2 : Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
      this.scene.fogColor = Color3.Lerp(this.scene.fogColor, safeColor(p.color, fog.component.primaryColor), blend);
      const start = number(fog.component, 'start', visual.radius, 0, 1000000);
      const end = Math.max(start + .01, number(fog.component, 'end', visual.radius + visual.height / Math.max(.001, visual.opacity), .01, 1000000));
      this.scene.fogStart += (start - this.scene.fogStart) * blend;
      this.scene.fogEnd += (end - this.scene.fogEnd) * blend;
      this.scene.fogDensity += (number(fog.component, 'density', this.fogBaseline.density, 0, 1) - this.scene.fogDensity) * blend;
    } else if (this.themeFog) {
      this.scene.fogMode = this.themeFog.fogEnabled ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
      this.scene.fogColor = Color3.FromHexString(this.themeFog.fogColor);
      this.scene.fogStart = this.themeFog.fogStart;
      this.scene.fogEnd = this.themeFog.fogEnd;
    }
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
  disposeMissing(ids: Set<string>): void { for (const id of this.entries.keys()) if (!ids.has(id)) { this.entries.delete(id); this.statuses.delete(id); } }
  dispose(): void { this.entries.clear(); this.statuses.clear(); this.themeFog = null; this.restoreFollow(); this.restoreFog(); this.restoreLight(); }
}
