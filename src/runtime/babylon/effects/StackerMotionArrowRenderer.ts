import { Color3, Constants, Mesh, MeshBuilder, ShaderMaterial, TransformNode, type Scene } from '@babylonjs/core';
import type { StackerMotionArrowChannel, StackerMotionArrowsConfig } from '../../../editor/model/stackerMotionArrows';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { ARROW_STYLE_UNIFORMS, SURFACE_ARROW_FRAGMENT_SOURCE, SURFACE_ARROW_VERTEX_SOURCE } from './ConveyorSurfaceArrowRenderer';
import { createStackerArrowSurface, resolveStackerArrowPlacement, type StackerArrowSurface } from './StackerMotionArrowSurface';

// 缺口使用整条带的原始 UV，避免方向反转移动遮挡位置，并保持平台上下箭头的流动相位连续。
const STACKER_ARROW_FRAGMENT_SOURCE = SURFACE_ARROW_FRAGMENT_SOURCE
  .replace('uniform float breathingFactor;', `uniform float breathingFactor;
uniform float liftGapEnabled;
uniform float liftGapMin;
uniform float liftGapMax;`)
  .replace('void main(void) {', `void main(void) {
  if (liftGapEnabled > 0.5 && vUV.x >= liftGapMin && vUV.x <= liftGapMax) discard;`);

type Entry = { root: TransformNode; mesh: Mesh; material: ShaderMaterial; surface: StackerArrowSurface | null;
  meshes: ModelRuntimeEntry['meshes'] | null; script: ModelRuntimeEntry['externalScriptRuntime'];
  phase: number; breathingPhase: number; fade: number; direction: 1 | -1 };

export function stackerMotionArrowKey(entityId: string, channel: StackerMotionArrowChannel): string {
  return JSON.stringify([entityId, channel]);
}

/** 四路装饰独立持有资源；正常停机只淡出，失效/隐藏立即关闭，不干预设备运动。 */
export class StackerMotionArrowRenderer {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly scene: Scene) {}

  update(entityId: string, model: ModelRuntimeEntry, config: StackerMotionArrowsConfig, channel: StackerMotionArrowChannel,
    direction: 1 | -1 | 0, deltaSeconds: number, visible: boolean): string | null {
    const key = stackerMotionArrowKey(entityId, channel), settings = config.channels[channel];
    if (!config.enabled || !settings.enabled) { this.remove(key); return null; }
    const existing = this.entries.get(key);
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    if (!visible || config.opacity <= 0 || config.intensity <= 0) {
      if (existing) { existing.fade = 0; existing.mesh.setEnabled(false); }
      return null;
    }
    if (!direction) {
      if (!existing) return null;
      existing.fade = Math.max(0, existing.fade - delta / .12);
      existing.material.setFloat('opacity', config.opacity * existing.fade);
      if (!existing.fade) { existing.mesh.setEnabled(false); return null; }
    }
    const entry = existing ?? this.create(key, entityId, channel);
    entry.mesh.setEnabled(false);
    const host = model.telemetryProxySource ?? model;
    if (host.root.isDisposed() || model.root.isDisposed()) return '堆垛机模型已释放。';
    const signature = JSON.stringify([host.assetSignature, host.assetRevision, host.loadToken, host.parameterSignature,
      host.externalScriptSignature, settings.surfaceNode, host.meshes.length, host.entitySnapshot?.components.modelAsset?.dataDrivenConfig]);
    if (!entry.surface || entry.surface.host !== host || entry.surface.signature !== signature || entry.meshes !== host.meshes
      || entry.script !== host.externalScriptRuntime) {
      entry.surface = createStackerArrowSurface(model, channel, settings, signature, this.scene);
      entry.meshes = host.meshes; entry.script = host.externalScriptRuntime;
    }
    const placement = resolveStackerArrowPlacement(entry.surface, model, channel, settings);
    if (typeof placement === 'string') { entry.fade = 0; return placement; }
    entry.root.freezeWorldMatrix(placement.matrix);
    if (direction) {
      entry.fade = 1;
      entry.direction = (settings.reverse ? -direction : direction) as 1 | -1;
      const styled = ARROW_STYLE_UNIFORMS[config.style] >= 4;
      const period = styled ? 1 : config.spacing, rate = styled ? config.speed * .65 : config.speed;
      entry.phase %= period;
      if (rate > 0) entry.phase = (entry.phase + delta % (period / rate) * rate) % period;
      entry.breathingPhase = (entry.breathingPhase + delta % config.breathingPeriod / config.breathingPeriod) % 1;
    }
    const breathing = 1 - (config.breathingEnabled ? config.breathingStrength : 0) * (1 - Math.cos(entry.breathingPhase * Math.PI * 2)) * .5;
    const uniforms = { phase: entry.phase, direction: entry.direction, arrowStyle: ARROW_STYLE_UNIFORMS[config.style],
      breathingFactor: breathing, stripLength: placement.length, stripWidth: placement.width,
      arrowLength: config.arrowLength, arrowWidth: Math.min(config.arrowWidth, placement.width), spacing: config.spacing,
      liftGapEnabled: placement.liftGap ? 1 : 0, liftGapMin: placement.liftGap?.min ?? 0, liftGapMax: placement.liftGap?.max ?? 0,
      opacity: config.opacity * entry.fade };
    for (const [name, value] of Object.entries(uniforms)) entry.material.setFloat(name, value);
    entry.material.setColor3('arrowColor', Color3.FromHexString(config.color).scale(config.intensity));
    entry.mesh.setEnabled(entry.fade > 0);
    return null;
  }

  retain(keys: ReadonlySet<string>): void { for (const key of this.entries.keys()) if (!keys.has(key)) this.remove(key); }
  clear(): void { for (const key of this.entries.keys()) this.remove(key); }
  dispose(): void { this.clear(); }

  private create(key: string, entityId: string, channel: StackerMotionArrowChannel): Entry {
    const name = `__stackerMotionArrows_${entityId}_${channel}`;
    const root = new TransformNode(name + '_root', this.scene);
    const mesh = MeshBuilder.CreateGround(name, { width: 1, height: 1 }, this.scene);
    mesh.parent = root;
    mesh.metadata = { stackerMotionArrow: true, entityId, channel };
    mesh.isPickable = false; mesh.receiveShadows = false; mesh.renderingGroupId = 0;
    const material = new ShaderMaterial(name + '_material', this.scene,
      { vertexSource: SURFACE_ARROW_VERTEX_SOURCE, fragmentSource: STACKER_ARROW_FRAGMENT_SOURCE }, {
        attributes: ['position', 'uv'], uniforms: ['worldViewProjection', 'arrowColor', 'opacity', 'stripLength', 'stripWidth',
          'arrowLength', 'arrowWidth', 'spacing', 'phase', 'direction', 'arrowStyle', 'breathingFactor',
          'liftGapEnabled', 'liftGapMin', 'liftGapMax'], needAlphaBlending: true,
      });
    material.backFaceCulling = false; material.disableDepthWrite = true; material.depthFunction = Constants.LEQUAL;
    mesh.material = material;
    const entry: Entry = { root, mesh, material, surface: null, meshes: null, script: null, phase: 0, breathingPhase: 0, fade: 0, direction: 1 };
    this.entries.set(key, entry);
    return entry;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.mesh.dispose(false, false); entry.material.dispose(); entry.root.dispose(); this.entries.delete(key);
  }
}
