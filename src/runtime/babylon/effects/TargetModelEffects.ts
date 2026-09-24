import {
  AbstractMesh, Color3, Color4, GlowLayer, InstancedMesh, Material, MaterialPluginBase,
  Mesh, MultiMaterial, PBRBaseMaterial, PBRMaterial, StandardMaterial, TransformNode, Vector3,
  type Scene, type UniformBuffer, type BaseTexture,
} from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';
import { ENVIRONMENT_EFFECT_TARGET_ID, isEnvironmentBuildingEffectKind } from '../../../editor/model/environmentBuildingEffect';
import { EnvironmentShadowMaterialPlugin } from '../EnvironmentShadowMaterialPlugin';
import { cloneEnvironmentMaterial } from '../cloneEnvironmentMaterial';

type Visual = NonNullable<PoiEffectComponent['visual']>;
type BoundEffect = {
  id: string; component: PoiEffectComponent; signature: string; animationKey: string; active: boolean;
  root: TransformNode | AbstractMesh | null; elapsed: number; meshes: Map<AbstractMesh, MeshState>;
  motions: MotionState[]; minimum: Vector3; maximum: Vector3; glow: GlowLayer | null;
};
type MotionState = { node: TransformNode; offset: Vector3; applied: Vector3; lastPosition: Vector3; explicit?: boolean };
type MeshState = {
  source: Mesh | InstancedMesh; mesh: Mesh | InstancedMesh; proxy: boolean; originalEnabled: boolean;
  originalMaterial: Material | null; replacement: Material | null; materials: Material[];
  outline: boolean; outlineColor: Color3; outlineWidth: number;
  edgesColor: Color4; edgesWidth: number; ownsEdges: boolean; roof: boolean;
  plugins: ModelSurfacePlugin[]; textures: Set<BaseTexture>; suspend?: () => void;
  materialDefaults: Map<Material, { alpha: number; transparencyMode: number | null; disableDepthWrite: boolean; backFaceCulling: boolean; emissiveColor?: Color3 }>;
};

const modelEffectSuspensions = new WeakMap<AbstractMesh, number>();
const modelEffectSuspensionCallbacks = new WeakMap<AbstractMesh, Set<() => void>>();

/** 报警先释放模型视觉，再捕获真实原材质；租约释放后由下一次 tick 恢复模型效果。 */
export function suspendTargetModelEffects(mesh: AbstractMesh): () => void {
  modelEffectSuspensions.set(mesh, (modelEffectSuspensions.get(mesh) ?? 0) + 1);
  for (const suspend of [...(modelEffectSuspensionCallbacks.get(mesh) ?? [])]) suspend();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (modelEffectSuspensions.get(mesh) ?? 1) - 1;
    if (remaining > 0) modelEffectSuspensions.set(mesh, remaining);
    else modelEffectSuspensions.delete(mesh);
  };
}

const MODEL_KINDS = new Set([
  'model-outline', 'model-edges', 'model-emissive', 'model-color', 'model-flash', 'model-scan', 'height-gradient',
  'hologram', 'xray', 'dissolve', 'floor-expand', 'explode', 'clip-section', 'roof-fade',
]);
const STRUCTURE_KINDS = new Set(['floor-expand', 'explode']);
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const color = (value: string) => Color3.FromHexString(/^#[\da-f]{6}$/i.test(value) ? value : '#00ccff');
const axisVector = (axis: Visual['axis']) => axis === 'x' ? Vector3.Right() : axis === 'z' ? Vector3.Forward() : Vector3.Up();
const modeFor = (kind: string) => (({ 'model-scan': 1, 'height-gradient': 2, dissolve: 3, 'clip-section': 4, hologram: 5, 'model-color': 6, 'model-flash': 6 } as Record<string, number>)[kind] ?? 0);
const isColorOverlay = (kind: string) => kind === 'model-color' || kind === 'model-flash';
const parameters = (component: PoiEffectComponent) => component.configuration?.parameters ?? {};
const numberParameter = (component: PoiEffectComponent, key: string, fallback: number, min = -1000000, max = 1000000) => {
  const value = parameters(component)[key];
  return clamp(typeof value === 'number' && Number.isFinite(value) ? value : fallback, min, max);
};
const stringParameter = (component: PoiEffectComponent, key: string, fallback: string) => typeof parameters(component)[key] === 'string' ? parameters(component)[key] as string : fallback;
function flashVisible(effect: BoundEffect): boolean {
  if (effect.component.effectKind !== 'model-flash') return true;
  const period = numberParameter(effect.component, 'flashPeriod', 1, 0.1, 3600);
  return (effect.elapsed % period) / period < numberParameter(effect.component, 'dutyCycle', 0.5, 0, 1);
}
const effectAxis = (component: PoiEffectComponent): Visual['axis'] => {
  const value = stringParameter(component, 'axis', component.visual?.axis ?? 'y');
  return value === 'x' || value === 'z' ? value : 'y';
};
const configuredRows = (component: PoiEffectComponent, key: string): Record<string, unknown>[] => {
  const value = parameters(component)[key];
  return Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 128) : [];
};
const parsePaths = (value: unknown): string[] => typeof value === 'string' ? value.split(/[\n;,]+/).map(path => path.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).slice(0, 128) : [];
function selectedNodes(root: TransformNode | AbstractMesh, value: unknown): TransformNode[] {
  const paths = parsePaths(value);
  const nodes = [root, ...root.getDescendants(false).filter((node): node is TransformNode => node instanceof TransformNode)];
  return paths.flatMap(path => {
    const matches = nodes.filter(node => {
      if (!path.includes('/')) return node.name === path;
      const names: string[] = []; let current: TransformNode | null = node;
      while (current && current !== root) { names.unshift(current.name); current = current.parent instanceof TransformNode ? current.parent : null; }
      return current === root && (names.join('/') === path || [root.name, ...names].join('/') === path);
    });
    // 重名部件必须填写完整路径，避免静默命中多台设备或多个楼层。
    return matches.length === 1 ? matches : [];
  });
}
function withinSelection(node: TransformNode, selected: TransformNode[]): boolean {
  return selected.some(parent => node === parent || node.isDescendantOf(parent));
}

function structuralSignature(component: PoiEffectComponent): string {
  const p = parameters(component);
  return JSON.stringify([component.effectKind, component.visual?.targetEntityId, p.nodePaths, p.materialNames, p.edgeThreshold, p.edgeEnabled, p.wireframe, p.structureGroups, p.roofPaths, p.glowRadius !== undefined || p.glowIntensity !== undefined, STRUCTURE_KINDS.has(component.effectKind) ? [p.axis, component.visual?.axis, p.amount, component.visual?.amount] : null]);
}

/** 循环生长须经过可见的完成状态，不能在达到 100% 的同一帧直接取模归零。 */
function resolveDissolvePhase(elapsed: number, duration: number, loop: boolean, completedHold = clamp(duration * 0.2, 0.25, 1)): number {
  const cycleTime = loop ? elapsed % (duration + completedHold) : elapsed;
  const phase = cycleTime / duration;
  // 累加逐帧时间可能略低于整周期，完成边界归一到精确的 1。
  return phase >= 1 - 1e-7 ? 1 : Math.max(0, phase);
}

/** 在克隆的 Standard/PBR 材质末尾着色，保留原模型的骨骼、贴图和子材质管线。 */
class ModelSurfacePlugin extends MaterialPluginBase {
  phase = 0;
  minimum = 0;
  range = 1;
  active = true;
  constructor(material: Material, private readonly effect: BoundEffect) {
    super(material, 'DigitalTwinModelSurface', 220, undefined, true, false);
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override getUniforms() {
    return {
      ubo: [
        { name: 'dtEffectParams', size: 4, type: 'vec4' },
        { name: 'dtEffectAxis', size: 4, type: 'vec4' },
        { name: 'dtEffectPrimary', size: 4, type: 'vec4' },
        { name: 'dtEffectSecondary', size: 4, type: 'vec4' },
        { name: 'dtEffectPlane', size: 4, type: 'vec4' },
        { name: 'dtEffectOptions', size: 4, type: 'vec4' },
        { name: 'dtEffectExtra', size: 4, type: 'vec4' },
        ...Array.from({ length: 8 }, (_, index) => ({ name: `dtEffectGradient${index}`, size: 4, type: 'vec4' })),
      ],
      fragment: '#ifndef UNIFORMBUFFERS\n' + ['dtEffectParams', 'dtEffectAxis', 'dtEffectPrimary', 'dtEffectSecondary', 'dtEffectPlane', 'dtEffectOptions', 'dtEffectExtra', ...Array.from({ length: 8 }, (_, index) => `dtEffectGradient${index}`)].map(name => `uniform vec4 ${name};`).join('\n') + '\n#endif',
    };
  }
  override hardBindForSubMesh(buffer: UniformBuffer) {
    const component = this.effect.component;
    const visual = component.visual!;
    const axis = axisVector(effectAxis(component));
    const primary = color(stringParameter(component, 'color', component.primaryColor));
    const secondary = color(component.secondaryColor);
    const p = parameters(component);
    let plane = [axis.x, axis.y, axis.z, 0];
    if (p.coordinateSpace === 'local' && this.effect.root) {
      const inverse = this.effect.root.computeWorldMatrix(true).clone().invert().m;
      const index = effectAxis(component) === 'x' ? 0 : effectAxis(component) === 'z' ? 2 : 1;
      plane = [inverse[index], inverse[index + 4], inverse[index + 8], inverse[index + 12]];
    }
    const stops = configuredRows(component, 'gradientStops').filter(stop => typeof stop.position === 'number' && Number.isFinite(stop.position) && typeof stop.color === 'string' && /^#[\da-f]{6}$/i.test(stop.color)).slice(0, 8).map(stop => ({ position: clamp(stop.position as number, 0, 1), color: color(stop.color as string) })).sort((a, b) => a.position - b.position);
    if (stops.length === 0) stops.push({ position: 0, color: primary }, { position: 1, color: secondary });
    buffer.updateFloat4('dtEffectParams', modeFor(component.effectKind), this.phase, this.minimum, this.range);
    buffer.updateFloat4('dtEffectAxis', axis.x, axis.y, axis.z, clamp(numberParameter(component, 'bandWidth', finite(visual.width, .15), .001, 1000) / this.range, .00001, 1));
    buffer.updateFloat4('dtEffectPrimary', primary.r, primary.g, primary.b, clamp(finite(component.intensity, 1), 0, 10));
    buffer.updateFloat4('dtEffectSecondary', secondary.r, secondary.g, secondary.b, stops.length);
    buffer.updateFloat4('dtEffectPlane', plane[0], plane[1], plane[2], plane[3]);
    buffer.updateFloat4('dtEffectOptions', this.active ? 1 : 0, numberParameter(component, 'noiseStrength', .04, 0, .5), numberParameter(component, 'originalMix', 0, 0, 1), numberParameter(component, 'scanLines', 90 / (2 * Math.PI), 0, 256));
    buffer.updateFloat4('dtEffectExtra', p.direction === 'reverse' ? -1 : 1, numberParameter(component, 'edgeWidth', .035, .001, .5), p.clipSide === 'above' ? 1 : p.clipSide === 'slice' ? 2 : 0, numberParameter(component, 'sliceThickness', .1, .001, 1));
    for (let index = 0; index < 8; index++) {
      const stop = stops[index] ?? stops[stops.length - 1];
      buffer.updateFloat4(`dtEffectGradient${index}`, stop.color.r, stop.color.g, stop.color.b, stop.position);
    }
  }
  override getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_MAIN_END: `
        float dtHeight = clamp((dot(vPositionW, dtEffectPlane.xyz) + dtEffectPlane.w - dtEffectParams.z) / max(0.0001, dtEffectParams.w), 0.0, 1.0);
        if (dtEffectExtra.x < 0.0 && dtEffectParams.x > 2.5 && dtEffectParams.x < 3.5) dtHeight = 1.0 - dtHeight;
        float dtMode = dtEffectParams.x;
        float dtBand = 1.0 - smoothstep(0.0, dtEffectAxis.w, abs(dtHeight - dtEffectParams.y));
        if (dtMode > 0.5 && dtMode < 1.5) {
          gl_FragColor.rgb += dtEffectPrimary.rgb * dtBand * dtEffectPrimary.a * dtEffectOptions.x;
        } else if (dtMode > 1.5 && dtMode < 2.5) {
          vec3 dtGradient = dtEffectGradient0.rgb;
          ${Array.from({ length: 7 }, (_, index) => `if (dtEffectSecondary.a > ${index + 1}.0 && dtHeight >= dtEffectGradient${index}.a) dtGradient = mix(dtEffectGradient${index}.rgb, dtEffectGradient${index + 1}.rgb, clamp((dtHeight - dtEffectGradient${index}.a) / max(.00001, dtEffectGradient${index + 1}.a - dtEffectGradient${index}.a), 0.0, 1.0));`).join('\n')}
          gl_FragColor.rgb = mix(dtGradient * dtEffectPrimary.a, gl_FragColor.rgb, dtEffectOptions.z);
        } else if (dtMode > 2.5 && dtMode < 4.5) {
          // 生长完成后完全退出裁剪与边缘着色；剖切继续保留自己的切面表现。
          if (dtMode >= 3.5 || dtEffectParams.y < 1.0) {
            float dtNoise = fract(sin(dot(vPositionW, vec3(12.9898, 78.233, 39.425))) * 43758.5453);
            float dtEdge = dtHeight + (dtMode < 3.5 ? (dtNoise - 0.5) * dtEffectOptions.y : 0.0);
            float dtDistance = abs(dtEdge - dtEffectParams.y);
            if (dtMode < 3.5 || dtEffectExtra.z < .5) {
              if (dtEffectParams.y <= 0.0 || (dtEffectParams.y < 1.0 && dtEdge > dtEffectParams.y)) discard;
            } else if (dtEffectExtra.z < 1.5) {
              if (dtEdge < dtEffectParams.y) discard;
            } else {
              if (dtDistance > dtEffectExtra.w * .5) discard;
              dtDistance = abs(dtDistance - dtEffectExtra.w * .5);
            }
            gl_FragColor.rgb += dtEffectPrimary.rgb * (1.0 - smoothstep(0.0, dtEffectExtra.y, dtDistance)) * dtEffectPrimary.a;
          }
        } else if (dtMode > 4.5 && dtMode < 5.5) {
          float dtLines = dtEffectOptions.w > 0.0 ? pow(max(0.0, sin(dtHeight * dtEffectOptions.w * 6.28318 - dtEffectParams.y * 6.28318)), 8.0) : 0.0;
          gl_FragColor.rgb += dtEffectPrimary.rgb * (0.25 + 0.5 * dtLines) * dtEffectPrimary.a;
        } else if (dtMode > 5.5) {
          // 表面整体换色仍保留明暗层次；暗相位为零混合，直接显示原材质的贴图和光照。
          float dtShade = clamp(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
          vec3 dtTint = dtEffectPrimary.rgb * dtEffectPrimary.a * (0.55 + 0.45 * dtShade);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, dtTint, (1.0 - dtEffectOptions.z) * dtEffectOptions.x);
        }
      `,
    };
  }
}

/** 模型特效按首次绑定顺序互斥占用网格；释放后恢复原对象，再交给下一特效。 */
export class TargetModelEffects {
  private readonly effects = new Map<string, BoundEffect>();
  private readonly owners = new Map<AbstractMesh, string>();
  private refreshSeconds = 0;
  private glowIntensity = 1;
  private sharedGlow: GlowLayer | null = null;
  setGlowIntensity(value: number | null): void {
    this.glowIntensity = value ?? 1;
    for (const effect of this.effects.values()) if (effect.glow) effect.glow.intensity = this.effectGlowIntensity(effect);
  }
  private effectGlowIntensity(effect: BoundEffect): number {
    const blend = isColorOverlay(effect.component.effectKind) ? 1 - numberParameter(effect.component, 'originalMix', 0, 0, 1) : 1;
    return this.glowIntensity * numberParameter(effect.component, 'glowIntensity', 1, 0, 5) * blend * (flashVisible(effect) ? 1 : 0);
  }
  constructor(private readonly scene: Scene, private readonly resolveTarget: (id: string) => TransformNode | AbstractMesh | null, private readonly alarmAppearance = false) {}

  getStatus(id: string): { status: 'active' | 'inactive' | 'loading' | 'occupied' | 'invalid'; message: string } {
    const effect=this.effects.get(id);
    if(!effect?.active)return{status:'inactive',message:'模型特效未启用'};
    if(effect.meshes.size){
      const needsMaterial=!['model-outline','model-edges','floor-expand','explode'].includes(effect.component.effectKind);
      if(needsMaterial&&![...effect.meshes.values()].some(state=>state.replacement))return{status:'invalid',message:'目标材质不支持该效果，请使用 Standard / PBR 材质'};
      return{status:'active',message:`已作用于 ${effect.meshes.size} 个网格`};
    }
    const root=effect.component.visual?.targetEntityId?this.resolveTarget(effect.component.visual.targetEntityId):null;
    if(!root||root.isDisposed())return{status:'loading',message:'等待目标模型加载'};
    const meshes=[...(root instanceof AbstractMesh?[root]:[]),...root.getChildMeshes()];
    if(meshes.some(mesh=>this.owners.has(mesh)||modelEffectSuspensions.has(mesh)))return{status:'occupied',message:'目标当前由报警或其他模型特效占用'};
    return{status:'invalid',message:'未找到可作用的网格，请检查部件路径和材质筛选'};
  }

  sync(id: string, component: PoiEffectComponent, active: boolean): void {
    const targetId = component.visual?.targetEntityId;
    const enabled = active && component.enabled && MODEL_KINDS.has(component.effectKind) && !!targetId
      && (targetId !== ENVIRONMENT_EFFECT_TARGET_ID || isEnvironmentBuildingEffectKind(component.effectKind));
    const signature = structuralSignature(component);
    const animationKey = `${component.effectKind}/${component.visual?.targetEntityId ?? ''}`;
    const previous = this.effects.get(id);
    if (previous && previous.signature === signature && previous.active === enabled) {
      previous.component = component;
      if (previous.active && previous.root) { this.updateBounds(previous); this.update(previous); }
      return;
    }
    const preserveClock = previous?.animationKey === animationKey && previous.active && enabled;
    if (previous) this.release(previous);
    const effect: BoundEffect = previous ?? {
      id, component, signature, animationKey, active: enabled, root: null, elapsed: 0,
      meshes: new Map(), motions: [], minimum: Vector3.Zero(), maximum: Vector3.One(), glow: null,
    };
    effect.component = component;
    effect.signature = signature;
    effect.active = enabled;
    effect.animationKey = animationKey;
    if (!preserveClock) effect.elapsed = 0;
    this.effects.set(id, effect);
    this.reconcile();
  }

  tick(deltaSeconds: number): void {
    const delta = clamp(finite(deltaSeconds, 0), 0, 1);
    this.refreshSeconds += delta;
    // 只定向遍历绑定目标子树，低频接纳模型异步加载、重新挂接和模型替换。
    if (this.refreshSeconds >= 0.25) { this.refreshSeconds = 0; this.reconcile(); }
    for (const effect of this.effects.values()) {
      if (!effect.active || !effect.root || effect.root.isDisposed()) continue;
      // 环境显隐独立于特效实体，隐藏和完全透明时保留当前动画，不重建覆盖材质。
      if (effect.component.visual?.targetEntityId === ENVIRONMENT_EFFECT_TARGET_ID && !effect.root.isEnabled()) continue;
      effect.elapsed += delta * clamp(finite(effect.component.speed, 1), 0, 10);
      this.update(effect);
    }
  }

  /** 外观同步先落到真实原材质，再恢复特效覆盖，保留当前动画时间。 */
  withTargetMutation(targetId: string, mutate: () => void): void {
    const affected = [...this.effects.values()].filter(effect => effect.component.visual?.targetEntityId === targetId);
    if (affected.length === 0) { mutate(); return; }
    for (const effect of affected) this.release(effect);
    try { mutate(); } finally { this.reconcile(); }
  }

  disposeMissing(ids: Set<string>): void {
    for (const [id, effect] of this.effects) {
      if (ids.has(id)) continue;
      this.release(effect);
      this.effects.delete(id);
    }
    this.reconcile();
  }

  dispose(): void {
    for (const effect of this.effects.values()) this.release(effect);
    this.effects.clear();
    this.owners.clear();
  }

  private reconcile(): void {
    const claimedTargets = new Set<string>();
    for (const effect of this.effects.values()) {
      const targetId = effect.component.visual?.targetEntityId;
      const root = effect.active && targetId && !claimedTargets.has(targetId) ? this.resolveTarget(targetId) : null;
      if (targetId && effect.active) claimedTargets.add(targetId);
      if (!root || root.isDisposed()) { this.release(effect); continue; }
      if (root !== effect.root) { this.release(effect); effect.root = root; }
      const candidates = new Set<AbstractMesh>(root.getChildMeshes(false));
      if (root instanceof AbstractMesh) candidates.add(root);
      if (parsePaths(parameters(effect.component).nodePaths).length > 0) {
        const selected = selectedNodes(root, parameters(effect.component).nodePaths);
        for (const mesh of candidates) if (!withinSelection(mesh, selected)) candidates.delete(mesh);
      }
      // 同一模型的任一部件被报警接管时暂停整项，避免重新包裹报警材质或其代理。
      if (!this.alarmAppearance && [...candidates].some(mesh => modelEffectSuspensions.has(mesh))) { this.release(effect); continue; }
      let changed = false;
      for (const [source, state] of effect.meshes) {
        if (candidates.has(source) && !source.isDisposed()) continue;
        this.restoreMesh(effect, state);
        effect.meshes.delete(source);
        changed = true;
      }
      for (const source of candidates) {
        if (effect.meshes.has(source) || this.owners.has(source) || source.isDisposed() || source.getTotalVertices() === 0) continue;
        // 代理网格以及共享源网格不再次加入，避免实例材质影响其他实体。
        if (source.metadata?.digitalTwinEffectProxy) continue;
        if (!(source instanceof Mesh || source instanceof InstancedMesh)) continue;
        if (source instanceof Mesh && (source.hasThinInstances || source.instances.length > 0) && !source.metadata?.editorEnvironmentMesh) continue;
        const state = this.attachMesh(effect, source);
        if (!state) continue;
        effect.meshes.set(source, state);
        this.owners.set(source, effect.id);
        // 报警外观拥有暂停租约，不再被自己的租约暂停；普通场景特效仍遵守暂停规则。
        if (!this.alarmAppearance) {
          state.suspend = () => this.release(effect);
          const callbacks = modelEffectSuspensionCallbacks.get(source) ?? new Set<() => void>();
          callbacks.add(state.suspend);
          modelEffectSuspensionCallbacks.set(source, callbacks);
        }
        changed = true;
      }
      this.updateBounds(effect);
      if (changed) this.prepareStructure(effect);
      this.update(effect);
    }
  }

  private attachMesh(effect: BoundEffect, source: Mesh | InstancedMesh): MeshState | null {
    const kind = effect.component.effectKind;
    const structural = STRUCTURE_KINDS.has(kind);
    // 环境容器里的源网格也参与特效，实例必须从该源的真实基准克隆，避免透明度叠乘两次。
    const originalMaterial = source instanceof InstancedMesh && source.metadata?.editorEnvironmentMesh
      ? effect.meshes.get(source.sourceMesh)?.originalMaterial ?? source.material
      : source.material;
    const proxy = source instanceof InstancedMesh && !structural;
    const mesh = proxy ? source.sourceMesh.clone(`${source.name}_digitalTwinEffect`, source.parent, true, false) : source;
    if (!(mesh instanceof Mesh)) {
      // 结构特效可以直接移动实例，其源材质与几何完全不变。
      return {
        source, mesh: source, proxy: false, originalEnabled: source.isEnabled(false),
        originalMaterial: source.material, replacement: null, materials: [], plugins: [], textures: new Set(), materialDefaults: new Map(),
        outline: false, outlineColor: Color3.Black(), outlineWidth: 0,
        edgesColor: source.edgesColor.clone(), edgesWidth: source.edgesWidth, ownsEdges: false, roof: false,
      };
    }
    const state: MeshState = {
      source, mesh, proxy, originalEnabled: source.isEnabled(false), originalMaterial,
      replacement: null, materials: [], plugins: [], textures: new Set(), materialDefaults: new Map(), outline: mesh.renderOutline,
      outlineColor: mesh.outlineColor.clone(), outlineWidth: mesh.outlineWidth,
      edgesColor: mesh.edgesColor.clone(), edgesWidth: mesh.edgesWidth, ownsEdges: false, roof: false,
    };
    if (proxy) {
      mesh.metadata = { ...source.metadata, digitalTwinEffectProxy: true };
      mesh.isPickable = source.isPickable;
      mesh.setEnabled(state.originalEnabled);
      this.copyInstanceTransform(state);
      source.setEnabled(false);
    }
    if (kind === 'model-outline') {
      mesh.renderOutline = true;
    } else if (kind === 'model-edges') {
      state.ownsEdges = !mesh.edgesRenderer;
      if (state.ownsEdges) mesh.enableEdgesRendering(numberParameter(effect.component, 'edgeThreshold', .95, 0, 1));
    } else if (!structural) {
      const clone = this.cloneMaterial(effect, state, originalMaterial);
      if (clone) { state.replacement = clone; mesh.material = clone; }
    }
    if ((kind === 'xray' || kind === 'hologram') && parameters(effect.component).edgeEnabled === true) {
      state.ownsEdges = !mesh.edgesRenderer;
      if (state.ownsEdges) mesh.enableEdgesRendering(numberParameter(effect.component, 'edgeThreshold', .95, 0, 1));
    }
    if ((kind === 'model-emissive' || isColorOverlay(kind)) && mesh instanceof Mesh) {
      const p = parameters(effect.component);
      // 未配置独立光晕的效果仍复用旧共享后处理，避免为每台设备增加一次全屏模糊。
      if (!isColorOverlay(kind) && p.glowRadius === undefined && p.glowIntensity === undefined) effect.glow = this.sharedGlow ??= new GlowLayer('digitalTwinModelGlow', this.scene, { blurKernelSize: 32 });
      else effect.glow ??= new GlowLayer(`digitalTwinModelGlow_${effect.id}`, this.scene, { blurKernelSize: numberParameter(effect.component, 'glowRadius', 32, 1, 128) });
      effect.glow.intensity = this.effectGlowIntensity(effect);
      effect.glow.addIncludedOnlyMesh(mesh);
    }
    return state;
  }

  private cloneMaterial(effect: BoundEffect, state: MeshState, original: Material | null): Material | null {
    if (original instanceof MultiMaterial) {
      const multi = new MultiMaterial(`${original.name}_${effect.id}_effect`, this.scene);
      state.materials.push(multi);
      multi.subMaterials = original.subMaterials.map(material => this.cloneMaterial(effect, state, material) ?? material);
      return multi;
    }
    const materialNames = parsePaths(parameters(effect.component).materialNames);
    if (materialNames.length > 0 && (!original || !materialNames.includes(original.name))) return null;
    // 自定义 Shader/Node 材质不能安全注入本插件，保持其原样。
    if (original && !(original instanceof StandardMaterial || original instanceof PBRBaseMaterial)) return null;
    const material = original
      ? (state.source.metadata?.editorEnvironmentMesh
          ? cloneEnvironmentMaterial(original, `${original.name}_${effect.id}_effect`)
          : original.clone(`${original.name}_${effect.id}_effect`))
      : new StandardMaterial(`${effect.id}_effect`, this.scene);
    if (!material) return null;
    state.materials.push(material);
    const originalTextures = new Set(original?.getActiveTextures() ?? []);
    for (const texture of material.getActiveTextures()) if (!originalTextures.has(texture)) state.textures.add(texture);
    state.materialDefaults.set(material, { alpha: material.alpha, transparencyMode: material.transparencyMode, disableDepthWrite: material.disableDepthWrite, backFaceCulling: material.backFaceCulling,
      ...('emissiveColor' in material && material.emissiveColor instanceof Color3 ? { emissiveColor: material.emissiveColor.clone() } : {}) });
    material.unfreeze();
    const kind = effect.component.effectKind;
    if (state.source.metadata?.editorEnvironmentMesh) {
      // 环境阴影插件不参与材质序列化，给临时特效副本补回，保持当前阴影模式。
      if (original?.pluginManager?.getPlugin('EnvironmentShadow') && (material instanceof PBRMaterial || material instanceof StandardMaterial)) {
        new EnvironmentShadowMaterialPlugin(material);
      }
      // PBR unlit 分支忽略 emissiveColor；副本保留灯光隔离，释放后仍恢复原 unlit 材质。
      if (kind === 'model-emissive' && material instanceof PBRMaterial) {
        material.unlit = false;
        material.disableLighting = true;
      }
    }
    if (modeFor(kind)) {
      const plugin = new ModelSurfacePlugin(material, effect);
      state.plugins.push(plugin);
    }
    if (kind === 'xray' || kind === 'hologram') {
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.disableDepthWrite = true;
      material.backFaceCulling = false;
    }
    if (kind === 'hologram') material.wireframe = parameters(effect.component).wireframe !== false;
    return material;
  }

  private updateBounds(effect: BoundEffect): void {
    let minimum = new Vector3(Infinity, Infinity, Infinity);
    let maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const state of effect.meshes.values()) {
      if (state.source.isDisposed()) continue;
      state.source.computeWorldMatrix(true);
      const bounds = state.source.getBoundingInfo().boundingBox;
      if (parameters(effect.component).coordinateSpace === 'local' && effect.root) {
        const inverse = effect.root.computeWorldMatrix(true).clone().invert();
        for (const vertex of bounds.vectorsWorld) {
          const local = Vector3.TransformCoordinates(vertex, inverse);
          minimum = Vector3.Minimize(minimum, local); maximum = Vector3.Maximize(maximum, local);
        }
      } else {
        minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
        maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
      }
    }
    if (!Number.isFinite(minimum.x)) { minimum = Vector3.Zero(); maximum = Vector3.One(); }
    effect.minimum = minimum;
    effect.maximum = maximum;
  }

  private prepareStructure(effect: BoundEffect): void {
    this.restoreMotions(effect);
    const kind = effect.component.effectKind;
    if (kind === 'roof-fade') {
      const states = [...effect.meshes.values()];
      const named = states.filter(state => /roof|屋顶|房顶|顶盖/i.test(state.source.name));
      const highest = Math.max(...states.map(state => state.source.getBoundingInfo().boundingBox.centerWorld.y));
      const configured = parsePaths(parameters(effect.component).roofPaths);
      const selected = effect.root ? selectedNodes(effect.root, parameters(effect.component).roofPaths) : [];
      for (const state of states) state.roof = configured.length > 0 ? withinSelection(state.source, selected) : named.length > 0 ? named.includes(state) : state.source.getBoundingInfo().boundingBox.centerWorld.y >= highest - 0.01;
    }
    if (!STRUCTURE_KINDS.has(kind) || !effect.root) return;
    const groups = configuredRows(effect.component, 'structureGroups');
    if (groups.length > 0) {
      const entries = groups.flatMap((group, index) => selectedNodes(effect.root!, group.nodePath).map(node => ({ group, node, order: typeof group.order === 'number' && Number.isFinite(group.order) ? group.order : index }))).sort((a, b) => a.order - b.order);
      const roots = new Set(entries.map(entry => entry.node));
      for (const { group, node, order } of entries) {
        if (group.fixed === true || effect.motions.some(motion => motion.node === node)) continue;
        // 父子组不叠加位移，包含 fixed 父组时同样保持父组完整。
        let ancestor = node.parent; let nested = false;
        while (ancestor instanceof TransformNode && ancestor !== effect.root) { if (roots.has(ancestor)) nested = true; ancestor = ancestor.parent; }
        if (nested) continue;
        const amount = numberParameter(effect.component, 'amount', effect.component.visual!.amount, 0, 10000);
        const distance = typeof group.distance === 'number' && Number.isFinite(group.distance) ? clamp(group.distance, -100000, 100000) : kind === 'floor-expand' ? order * amount : amount;
        const offsetData = group.offset as { x?: unknown; y?: unknown; z?: unknown } | undefined;
        let offset = offsetData && [offsetData.x, offsetData.y, offsetData.z].every(value => typeof value === 'number' && Number.isFinite(value))
          ? new Vector3(clamp(offsetData.x as number, -100000, 100000), clamp(offsetData.y as number, -100000, 100000), clamp(offsetData.z as number, -100000, 100000))
          : axisVector(group.axis === 'x' || group.axis === 'z' ? group.axis : effectAxis(effect.component)).scale(distance);
        if (node.parent instanceof TransformNode) offset = Vector3.TransformNormal(offset, node.parent.computeWorldMatrix(true).clone().invert());
        effect.motions.push({ node, offset, applied: Vector3.Zero(), lastPosition: node.position.clone(), explicit: true });
      }
      return;
    }
    const branches = new Map<TransformNode, { sum: Vector3; count: number }>();
    for (const state of effect.meshes.values()) {
      let branch: TransformNode = state.source;
      let ancestor = branch.parent;
      // 忽略 glTF 的空包装节点；只合并已有几何的父部件，避免父子网格重复位移。
      while (ancestor instanceof TransformNode && ancestor !== effect.root) {
        if (ancestor instanceof AbstractMesh && ancestor.getTotalVertices() > 0 && effect.meshes.has(ancestor)) branch = ancestor;
        ancestor = ancestor.parent;
      }
      if (branch === effect.root) continue;
      state.source.computeWorldMatrix(true);
      const center = state.source.getBoundingInfo().boundingBox.centerWorld;
      const entry = branches.get(branch) ?? { sum: Vector3.Zero(), count: 0 };
      entry.sum.addInPlace(center); entry.count++;
      branches.set(branch, entry);
    }
    const nodes = [...branches].map(([node, value]) => ({ node, center: value.sum.scale(1 / value.count) }));
    const axis = effectAxis(effect.component);
    nodes.sort((a, b) => a.center[axis] - b.center[axis] || a.node.uniqueId - b.node.uniqueId);
    const center = nodes.reduce((sum, entry) => sum.addInPlace(entry.center), Vector3.Zero()).scaleInPlace(1 / Math.max(1, nodes.length));
    const base = nodes[0]?.center[axis] ?? 0;
    const span = Math.max(0.001, (nodes.at(-1)?.center[axis] ?? base) - base);
    for (const entry of nodes) {
      const { node } = entry;
      let offset = kind === 'floor-expand' ? axisVector(axis).scale((entry.center[axis] - base) / span) : entry.center.subtract(center);
      if (kind === 'explode' && offset.lengthSquared() > 0.000001) offset.normalize();
      // 世界米偏移转换成父节点局部偏移，兼容已缩放和旋转的模型实体。
      if (node.parent instanceof TransformNode) offset = Vector3.TransformNormal(offset, node.parent.computeWorldMatrix(true).clone().invert());
      effect.motions.push({ node, offset, applied: Vector3.Zero(), lastPosition: node.position.clone() });
    }
  }

  private update(effect: BoundEffect): void {
    const component = effect.component;
    const visual = component.visual!;
    const kind = component.effectKind;
    const p = parameters(component);
    const primary = color(stringParameter(component, 'color', component.primaryColor));
    const intensity = numberParameter(component, 'emissiveIntensity', finite(component.intensity, 1), 0, 10);
    const opacity = numberParameter(component, kind === 'hologram' ? 'surfaceOpacity' : 'opacity', finite(visual.opacity, .3), 0, 1);
    const duration = numberParameter(component, 'duration', finite(visual.duration, 5), .1, 3600);
    const progress = numberParameter(component, 'progress', finite(visual.progress, .5), 0, 1);
    const delay = numberParameter(component, 'delay', 0, 0, 3600);
    const elapsed = Math.max(0, effect.elapsed - delay);
    let phase = kind === 'clip-section' ? progress : kind === 'dissolve'
      ? p.progressMode === 'external' ? progress : resolveDissolvePhase(elapsed, duration, visual.loop, numberParameter(component, 'completedHold', clamp(duration * .2, .25, 1), 0, 3600)) * progress
      : (effect.elapsed / duration) % 1;
    let active = flashVisible(effect);
    if (kind === 'model-scan') {
      const interval = numberParameter(component, 'interval', 0, 0, 3600);
      // 旧扫光一直循环；V2 只通过显式时间/范围扩展，保持旧场景节奏。
      const scanTime = elapsed % (duration + interval);
      active = effect.elapsed >= delay && scanTime < duration;
      const from = numberParameter(component, 'scanStart', 0, 0, 1), to = numberParameter(component, 'scanEnd', 1, 0, 1);
      const ratio = Math.min(1, scanTime / duration);
      phase = p.direction === 'reverse' ? to + (from - to) * ratio : from + (to - from) * ratio;
    }
    if (kind === 'hologram') phase = effect.elapsed / duration * numberParameter(component, 'scanLineSpeed', 1, -20, 20);
    if (effect.glow) {
      effect.glow.intensity = this.effectGlowIntensity(effect);
      const radius = numberParameter(component, 'glowRadius', 32, 1, 128);
      if (effect.glow.blurKernelSize !== radius) effect.glow.blurKernelSize = radius;
    }
    for (const state of effect.meshes.values()) {
      if (state.source.isDisposed() || state.mesh.isDisposed()) continue;
      if (state.proxy) this.copyInstanceTransform(state);
      const mesh = state.mesh;
      if (kind === 'model-outline') { mesh.outlineColor.copyFrom(primary); mesh.outlineWidth = numberParameter(component, 'lineWidth', finite(visual.width, .05), .001, 5); }
      if (kind === 'model-edges' || ((kind === 'hologram' || kind === 'xray') && p.edgeEnabled === true)) {
        const environmentAlpha = state.source.metadata?.editorEnvironmentMesh ? state.originalMaterial?.alpha ?? 1 : 1;
        const edgeColor = color(stringParameter(component, 'edgeColor', stringParameter(component, 'color', component.primaryColor)));
        mesh.edgesColor = new Color4(edgeColor.r * intensity, edgeColor.g * intensity, edgeColor.b * intensity, opacity * environmentAlpha);
        mesh.edgesWidth = numberParameter(component, 'edgeWidth', finite(visual.width, .15) * 10, .1, 20);
      }
      for (const material of state.materials) {
        if (!(material instanceof StandardMaterial || material instanceof PBRBaseMaterial)) continue;
        if ((kind === 'model-emissive' || kind === 'hologram' || kind === 'xray') && 'emissiveColor' in material && material.emissiveColor instanceof Color3) material.emissiveColor.copyFrom(primary.scale(intensity));
        if (isColorOverlay(kind) && 'emissiveColor' in material && material.emissiveColor instanceof Color3) {
          const original = state.materialDefaults.get(material)?.emissiveColor ?? Color3.Black();
          // 同一副本贯穿亮暗两相，原材质和兄弟实例从不被改写。
          const mix = active ? 1 - numberParameter(component, 'originalMix', 0, 0, 1) : 0;
          Color3.LerpToRef(original, primary.scale(intensity), mix, material.emissiveColor);
        }
        if (kind === 'xray' || kind === 'hologram') {
          const environmentAlpha = state.source.metadata?.editorEnvironmentMesh ? state.materialDefaults.get(material)?.alpha ?? 1 : 1;
          material.alpha = opacity * environmentAlpha;
          material.disableDepthWrite = p.depthWrite !== true;
          material.backFaceCulling = p.backFaceCulling === true;
        }
        if (kind === 'roof-fade') {
          const defaults = state.materialDefaults.get(material)!;
          const fadeDuration = numberParameter(component, 'fadeDuration', 0, 0, 3600);
          const blend = fadeDuration > 0 ? clamp(effect.elapsed / fadeDuration, 0, 1) : 1;
          material.alpha = state.roof ? blend >= 1 ? opacity : defaults.alpha + (opacity - defaults.alpha) * blend : defaults.alpha;
          material.transparencyMode = state.roof ? Material.MATERIAL_ALPHABLEND : defaults.transparencyMode;
          material.disableDepthWrite = state.roof ? true : defaults.disableDepthWrite;
          material.backFaceCulling = state.roof ? false : defaults.backFaceCulling;
        }
      }
      for (const plugin of state.plugins) {
        const axis = effectAxis(component);
        plugin.minimum = p.rangeMode === 'manual' ? numberParameter(component, 'rangeMin', effect.minimum[axis]) : effect.minimum[axis];
        const maximum = p.rangeMode === 'manual' ? numberParameter(component, 'rangeMax', effect.maximum[axis]) : effect.maximum[axis];
        plugin.range = Math.max(.0001, maximum - plugin.minimum);
        plugin.phase = phase;
        plugin.active = active;
      }
    }
    const amount = numberParameter(component, 'amount', finite(visual.amount, 3), 0, 10000) * progress;
    for (const motion of effect.motions) {
      if (motion.node.isDisposed()) continue;
      const next = motion.offset.scale(motion.explicit ? progress : amount);
      // 外部遥测/动画改写位置后，以新基准叠加；释放时只移除仍由本特效持有的偏移。
      const previous = motion.node.position.equalsWithEpsilon(motion.lastPosition, 1e-8) ? motion.applied : Vector3.Zero();
      motion.node.position.addInPlace(next.subtract(previous));
      motion.applied.copyFrom(next);
      motion.lastPosition.copyFrom(motion.node.position);
    }
  }

  private copyInstanceTransform(state: MeshState): void {
    const { source, mesh } = state;
    mesh.parent = source.parent;
    mesh.position.copyFrom(source.position);
    mesh.scaling.copyFrom(source.scaling);
    mesh.rotation.copyFrom(source.rotation);
    mesh.rotationQuaternion = source.rotationQuaternion?.clone() ?? null;
    mesh.visibility = source.visibility;
    mesh.isVisible = source.isVisible;
  }

  private restoreMotions(effect: BoundEffect): void {
    for (const motion of effect.motions) {
      if (!motion.node.isDisposed() && motion.node.position.equalsWithEpsilon(motion.lastPosition, 1e-8)) motion.node.position.subtractInPlace(motion.applied);
    }
    effect.motions = [];
  }

  private restoreMesh(effect: BoundEffect, state: MeshState): void {
    const { source, mesh } = state;
    if (state.suspend) {
      const callbacks = modelEffectSuspensionCallbacks.get(source);
      callbacks?.delete(state.suspend);
      if (callbacks?.size === 0) modelEffectSuspensionCallbacks.delete(source);
      state.suspend = undefined;
    }
    if (mesh instanceof Mesh) effect.glow?.removeIncludedOnlyMesh(mesh);
    if (!source.isDisposed() && state.proxy) source.setEnabled(state.originalEnabled);
    if (!mesh.isDisposed() && mesh instanceof Mesh) {
      if (mesh.material === state.replacement) mesh.material = state.originalMaterial;
      mesh.renderOutline = state.outline;
      mesh.outlineColor.copyFrom(state.outlineColor);
      mesh.outlineWidth = state.outlineWidth;
      mesh.edgesColor = state.edgesColor;
      mesh.edgesWidth = state.edgesWidth;
      if (state.ownsEdges) mesh.disableEdgesRendering();
      if (state.proxy) mesh.dispose(false, false);
    }
    for (const material of state.materials) material.dispose(false, false);
    for (const texture of state.textures) texture.dispose();
    if (this.owners.get(source) === effect.id) this.owners.delete(source);
  }

  private release(effect: BoundEffect): void {
    this.restoreMotions(effect);
    for (const state of effect.meshes.values()) this.restoreMesh(effect, state);
    effect.meshes.clear();
    effect.root = null;
    const glow = effect.glow;
    if (glow && (glow !== this.sharedGlow || ![...this.effects.values()].some(other => other !== effect && other.glow === glow && other.meshes.size > 0))) {
      glow.dispose();
      if (glow === this.sharedGlow) this.sharedGlow = null;
    }
    effect.glow = null;
  }
}
