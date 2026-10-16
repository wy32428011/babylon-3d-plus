import { type AssetContainer, type Scene, type TransformNode, type AnimationGroup, LoadAssetContainerAsync } from '@babylonjs/core';
import { AnimatorAvatar } from '@babylonjs/core/Animations/animatorAvatar.js';
import '@babylonjs/loaders/glTF/index.js';
import { fetchRuntimeAsset } from '../assets/runtimeAssetFetch.ts';
import { MANUAL_ROAM_RIG_PROFILE, MANUAL_ROAM_RIG_PROFILE_V2, getManualRoamRigProfile, prepareManualRoamReferencePose, validateManualRoamAvatarRig, validateManualRoamRigNodes, validateManualRoamRestCompatibility } from './manualRoamAvatarRig.ts';
import { MANUAL_ROAM_CLIPS, MANUAL_ROAM_TURN_CLIPS, createManualRoamAnimationState, stepManualRoamAnimationState, type ManualRoamClip, type ManualRoamAnimationFrame, type ManualRoamGaitTiming } from './manualRoamAnimationState.ts';
import type { ManualRoamTurnClip } from './manualRoamTurnState.ts';
import { humanoidLegLength, identifyRuntimeHumanoid, prepareHumanoidReference, retargetHumanoidGroup, sampleHumanoidFootReference, type ManualRoamRigBinding } from './manualRoamHumanoid.ts';

type ClipDefinition = { name: string; loop: boolean; referenceSpeed?: number; cycleDistanceMeters?: number; phaseOffset?: number; duration?:number;rotationProgress?:number[];contacts?:{left:number[]|number[][];right:number[]|number[][]} };
type MotionManifest = { version: number; profile: string; clips: Record<ManualRoamClip, ClipDefinition> };
type MotionSource = { container: AssetContainer; nodes: Map<string, TransformNode>; manifest: MotionManifest; groups: Map<ManualRoamClip, AnimationGroup> };
type SourceEntry = { promise: Promise<MotionSource>; source?: MotionSource; users: number; disposed: boolean };
type WeightTransition = { from: Map<ManualRoamClip, number>; elapsed: number; duration: number; family: string };
export type ManualRoamAvatarAnimatorOptions = {
  sourceUrl: string;
  manifestUrl: string;
  /** 仅在调用方提供步幅目标IK时启用；旧人物和编辑静态预览默认保留原步频。 */
  enableStrideWarp?: boolean;
  /** 可替换资源边界以使用真实骨架夹具验证生命周期，生产环境使用关闭自动播放的 glTF loader。 */
  loadContainer?: (url: string, scene: Scene) => Promise<AssetContainer>;
};
const sources = new WeakMap<Scene, Map<string, SourceEntry>>();
let nextAnimatorId = 0;

/** 同一骨架规范内复用动作；只操作人物关节，移动与碰撞仍由漫游控制器负责。 */
export class ManualRoamAvatarAnimator {
  static async create(scene: Scene, container: AssetContainer, options: ManualRoamAvatarAnimatorOptions): Promise<ManualRoamAvatarAnimator> {
    const original = container.skeletons.flatMap(skeleton=>skeleton.bones.map(bone=>({bone,rest:bone.getRestMatrix().clone()})));
    const transforms = container.transformNodes.map(node=>({node,position:node.position.clone(),rotation:node.rotation.clone(),quaternion:node.rotationQuaternion?.clone(),scale:node.scaling.clone()}));
    let release = () => {};
    const groups = new Map<ManualRoamClip, AnimationGroup>();
    try {
      for (const group of container.animationGroups) group.stop();
      const profile = getManualRoamRigProfile(container);
      prepareManualRoamReferencePose(container);
      for (const skeleton of container.skeletons) skeleton.returnToRest();
      let binding: ManualRoamRigBinding = profile
        ? { joints: validateManualRoamAvatarRig(container), automatic: false, facingYaw: 0, warnings: [], legLength: 0 }
        : identifyRuntimeHumanoid(container);
      const target = binding.joints as Map<string, TransformNode>;
      const acquired = acquireSource(scene, options);
      const entry = acquired.entry; release = acquired.release;
      const source = await entry.promise;
      if (scene.isDisposed || entry.disposed) throw new Error('动作加载期间场景已释放。');
      if (source.manifest.profile !== (profile ?? MANUAL_ROAM_RIG_PROFILE_V2)) throw new Error('人物与动作骨架版本不一致。');
      if (binding.automatic) binding = prepareHumanoidReference(container, binding, source.nodes);
      else validateManualRoamRestCompatibility(source.nodes, target);
      const footReference = binding.automatic ? sampleHumanoidFootReference(source.nodes, source.groups.get('Idle')!) : undefined;
      const legScale = binding.automatic ? binding.legLength / humanoidLegLength(source.nodes) : legLength(target) / legLength(source.nodes);
      const avatar = new AnimatorAvatar('manual-roam', undefined, false);
      avatar.skeletons = new Set(container.skeletons);
      avatar.showWarnings = false;
      const id = ++nextAnimatorId;
      for (const clip of source.groups.keys()) {
        const original = source.groups.get(clip)!;
        const group = binding.automatic
          ? retargetHumanoidGroup(original, source.nodes, binding, `manual-roam-${id}-${clip}`, footReference)
          : avatar.retargetAnimationGroup(original, { animationGroupName: `manual-roam-${id}-${clip}`, checkHierarchy: true, retargetAnimationKeys: true, fixRootPosition: false, fixGroundReference: false });
        groups.set(clip, group);
        if (group.targetedAnimations.length !== original.targetedAnimations.length || group.targetedAnimations.some(track => ![...target.values()].includes(track.target))) throw new Error(`动作轨道无法完整绑定：${clip}`);
        // retarget 已保留目标 rest 基高；再按腿长缩放骨盆局部起伏，始终锁定水平根位移。
        const hips = target.get('Hips')!;
        for (const track of group.targetedAnimations) {
          if (binding.automatic || track.target !== hips || track.animation.targetProperty !== 'position') continue;
          for (const key of track.animation.getKeys()) key.value.set(hips.position.x, hips.position.y + (key.value.y - hips.position.y) * legScale, hips.position.z);
        }
        group.stop();
      }
      return new ManualRoamAvatarAnimator(groups, source.manifest, release, legScale, options.enableStrideWarp === true, binding);
    } catch (error) {
      for (const group of groups.values()) group.dispose();
      release();
      for (const value of original) value.bone.setRestMatrix(value.rest);
      for (const value of transforms) {
        value.node.position.copyFrom(value.position); value.node.rotation.copyFrom(value.rotation);
        value.node.rotationQuaternion = value.quaternion?.clone() ?? null; value.node.scaling.copyFrom(value.scale);
      }
      throw error;
    }
  }

  private state = createManualRoamAnimationState();
  private readonly weights = new Map<ManualRoamClip, number>([['Idle', 1]]);
  private readonly clipTimes = new Map<ManualRoamClip, number>();
  private transition: WeightTransition | null = null;
  private readonly timing: ManualRoamGaitTiming;
  private readonly groups: Map<ManualRoamClip, AnimationGroup>;
  private readonly manifest: MotionManifest;
  private readonly release: () => void;
  private paused = false;
  private disposed = false;
  private readonly legScale: number;
  private readonly clips: ManualRoamClip[];
  private readonly sampledProgress = new Map<ManualRoamClip,number>();
  private readonly rigBinding: ManualRoamRigBinding;

  private constructor(groups: Map<ManualRoamClip, AnimationGroup>, manifest: MotionManifest, release: () => void, legScale: number, enableStrideWarp: boolean, rigBinding: ManualRoamRigBinding) {
    this.rigBinding = rigBinding;
    this.groups = groups; this.manifest = manifest; this.release = release;
    this.clips=[...groups.keys()];
    this.legScale = legScale;
    this.timing = { walkSpeed: manifest.clips.WalkForward.referenceSpeed!, runSpeed: manifest.clips.RunForward.referenceSpeed!, walkDuration: duration(groups.get('WalkForward')!), runDuration: duration(groups.get('RunForward')!), jumpStartDuration: duration(groups.get('JumpStart')!), landDuration: duration(groups.get('Land')!) };
    this.timing.clipCycleDistances = Object.fromEntries(MANUAL_ROAM_CLIPS.filter(clip=>clip.startsWith('Walk')||clip.startsWith('Run')).map(clip=>[clip,manifest.clips[clip].cycleDistanceMeters??manifest.clips[clip].referenceSpeed!*duration(groups.get(clip)!)]));
    this.timing.enableStrideWarp=enableStrideWarp&&manifest.profile===MANUAL_ROAM_RIG_PROFILE_V2;
  }

  update(frame: ManualRoamAnimationFrame): void {
    if (this.disposed || this.paused) return;
    const previousKind = this.state.kind;
    this.state = stepManualRoamAnimationState(this.state, { ...frame, worldScale: frame.worldScale * this.legScale }, this.timing);
    if(frame.turn&&this.groups.has(frame.turn.clip)&&frame.grounded&&!frame.fly) {
      const weight=Math.max(0,Math.min(1,frame.turn.weight));
      this.state.weights={Idle:1-weight,[frame.turn.clip]:weight};
    }
    const delta = Number.isFinite(frame.deltaSeconds) ? Math.min(0.1, Math.max(0, frame.deltaSeconds)) : 0;
    if(frame.turn&&this.groups.has(frame.turn.clip)&&frame.grounded&&!frame.fly) {
      // 转身已由同一动作进度提供包络，不能再额外延迟一层姿态混合。
      for(const clip of this.clips)this.weights.set(clip,this.state.weights[clip]??0);
      this.transition=null;
    } else this.updateWeights(delta, previousKind);
    for (const clip of this.clips) {
      const group = this.groups.get(clip)!;
      const weight = this.weights.get(clip) ?? 0;
      if (weight <= 1e-6) {
        if (group.isStarted) group.stop();
        this.clipTimes.delete(clip);
        continue;
      }
      // 渐出的旧组保留自己的游标；新状态的 elapsed 不得回拨旧片段。
      const seconds = (this.clipTimes.get(clip) ?? -delta) + delta;
      this.clipTimes.set(clip, seconds);
      if (!group.isStarted) group.start(this.manifest.clips[clip].loop, 0);
      group.setWeightForAllAnimatables(weight);
      const locomotion = clip.startsWith('Walk') || clip.startsWith('Run');
      const progress = frame.turn?.clip===clip ? frame.turn.progress : clip.startsWith('Turn') ? this.sampledProgress.get(clip)??0 : locomotion ? (this.state.phase+(this.manifest.clips[clip].phaseOffset??0))%1 : this.manifest.clips[clip].loop ? seconds / duration(group) % 1 : Math.min(1, seconds / duration(group));
      this.sampledProgress.set(clip,progress);
      group.goToFrame(group.from + (group.to - group.from) * progress, true);
      // 游标由本控制器推进；禁止scene.animate用speedRatio=0再次采样首帧覆盖手动结果。
      group.pause();
    }
  }

  private updateWeights(delta: number, previousKind: string): void {
    const desired = this.state.weights;
    const family = this.state.kind === 'ground'
      ? Object.keys(desired).some(clip=>clip.startsWith('Turn'))?'Turn':desired.Idle ? 'Idle' : Object.keys(desired).some(clip => clip.startsWith('Run')) ? 'Run' : 'Walk'
      : this.state.kind;
    const differs = this.clips.some(clip => Math.abs((this.weights.get(clip) ?? 0) - (desired[clip] ?? 0)) > 1e-8);
    if ((!this.transition && differs) || (this.transition && this.transition.family !== family)) {
      this.transition = { from: new Map(this.weights), elapsed: 0, duration: this.state.kind === 'ground' && previousKind === 'ground' ? 0.18 : 0.10, family };
    }
    if (!this.transition) return;
    // 同一运动族内连续改变方向只更新终点，保留过渡时钟，避免每帧重开导致永远追不上输入。
    const transition = this.transition;
    transition.elapsed += delta;
    const progress = Math.min(1, transition.elapsed / transition.duration);
    const blend = progress * progress * (3 - 2 * progress);
    for (const clip of this.clips) {
      const start = transition.from.get(clip) ?? 0;
      this.weights.set(clip, start + ((desired[clip] ?? 0) - start) * blend);
    }
    if (progress >= 1) this.transition = null;
  }

  sampleIdle(): void {
    if (this.disposed) return;
    for (const group of this.groups.values()) group.stop();
    this.weights.clear(); this.weights.set('Idle', 1); this.state = createManualRoamAnimationState();
    this.clipTimes.clear(); this.clipTimes.set('Idle', 0); this.transition = null;
    this.sampledProgress.clear();
    const idle = this.groups.get('Idle')!;
    idle.start(true, 0); idle.setWeightForAllAnimatables(1); idle.goToFrame(idle.from);
    if (this.paused) idle.pause();
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    this.paused = true;
    for (const group of this.groups.values()) if (group.isPlaying) group.pause();
  }

  resume(): void {
    if (this.disposed || !this.paused) return;
    this.paused = false;
    for (const [clip, group] of this.groups) if ((this.weights.get(clip) ?? 0) > 0 && group.isStarted) group.restart();
  }

  getStatus(): { state: string; phase: number; activeGroups: string[] } {
    return { state: this.state.kind, phase: this.state.phase, activeGroups: [...this.groups].filter(([, group]) => group.isStarted).map(([clip]) => clip) };
  }

  getStrideScale(): number { return this.state.strideScale; }
  setStrideWarpEnabled(enabled: boolean): void { this.timing.enableStrideWarp = enabled && this.manifest.profile === MANUAL_ROAM_RIG_PROFILE_V2; }
  getRigBinding(): ManualRoamRigBinding { return this.rigBinding; }

  getTurnMotion(): {turnDurations:Partial<Record<ManualRoamTurnClip,number>>;turnRotationCurves:Partial<Record<ManualRoamTurnClip,readonly number[]>>} {
    const turnDurations:Partial<Record<ManualRoamTurnClip,number>>={},turnRotationCurves:Partial<Record<ManualRoamTurnClip,readonly number[]>>={};
    for(const clip of MANUAL_ROAM_TURN_CLIPS) {const group=this.groups.get(clip),definition=this.manifest.clips[clip];if(group&&definition){turnDurations[clip]=duration(group);turnRotationCurves[clip]=definition.rotationProgress;}}
    return {turnDurations,turnRotationCurves};
  }

  getFootContacts():{left:number;right:number} {
    const result={left:0,right:0};
    for(const [clip,weight] of this.weights) {
      if(weight<=0)continue;
      const phase=this.sampledProgress.get(clip)??0,definition=this.manifest.clips[clip];
      for(const side of ['left','right'] as const) {
        const curve=definition.contacts?.[side];let contact=clip==='Idle'||clip==='Land'?1:0;
        if(curve?.length) {
          if(Array.isArray(curve[0]))contact=(curve as number[][]).some(([a,b])=>phase>=a&&phase<=b)?1:0;
          else {const values=curve as number[],i=phase*(values.length-1),lo=Math.floor(i),hi=Math.min(values.length-1,lo+1);contact=values[lo]+(values[hi]-values[lo])*(i-lo);}
        }
        result[side]+=contact*weight;
      }
    }
    return {left:Math.min(1,result.left),right:Math.min(1,result.right)};
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear(); this.weights.clear(); this.clipTimes.clear();this.sampledProgress.clear(); this.transition = null; this.release();
  }
}

function acquireSource(scene: Scene, options: ManualRoamAvatarAnimatorOptions): { entry: SourceEntry; release: () => void } {
  let cache = sources.get(scene);
  if (!cache) {
    cache = new Map(); sources.set(scene, cache);
    scene.onDisposeObservable.addOnce(() => {
      for (const entry of cache!.values()) disposeSource(entry);
      cache!.clear(); sources.delete(scene);
    });
  }
  const key = `${options.sourceUrl}\n${options.manifestUrl}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = { promise: loadSource(scene, options), users: 0, disposed: false };
    cache.set(key, entry);
    const created = entry;
    void created.promise.then(source => {
      created.source = source;
      if (created.disposed) source.container.dispose();
    }, () => undefined);
  }
  entry.users++;
  const acquired = entry;
  let released = false;
  return { entry, release: () => {
    if (released) return;
    released = true;
    if (--acquired.users === 0) { if (cache!.get(key) === acquired) cache!.delete(key); disposeSource(acquired); }
  } };
}

function disposeSource(entry: SourceEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  entry.source?.container.dispose();
}

async function loadSource(scene: Scene, options: ManualRoamAvatarAnimatorOptions): Promise<MotionSource> {
  let container: AssetContainer | null = null;
  try {
    const response = await fetchRuntimeAsset(options.manifestUrl, { signal: AbortSignal.timeout(30_000) }, undefined, 256 * 1024);
    if (!response.ok) throw new Error(`动作清单加载失败：HTTP ${response.status}`);
    const manifest = validateManifest(await response.json());
    container = await (options.loadContainer ?? ((url, targetScene) => LoadAssetContainerAsync(url, targetScene, { pluginExtension: '.glb', pluginOptions: { gltf: { animationStartMode: 0 } } })))(options.sourceUrl, scene);
    for (const group of container.animationGroups) group.stop();
    if (getManualRoamRigProfile(container) !== manifest.profile) throw new Error('动作清单与GLB骨架版本不一致。');
    const nodes = validateManualRoamRigNodes(container);
    const groups = new Map<ManualRoamClip, AnimationGroup>();
    for (const clip of [...MANUAL_ROAM_CLIPS,...MANUAL_ROAM_TURN_CLIPS.filter(clip=>manifest.clips[clip])]) {
      const matches = container.animationGroups.filter(group => group.name === manifest.clips[clip].name);
      if (matches.length !== 1) throw new Error(`动作片段缺失或重名：${clip}`);
      validateTracks(matches[0], nodes); groups.set(clip, matches[0]);
    }
    return { container, nodes, manifest, groups };
  } catch (error) { container?.dispose(); throw error; }
}

function validateManifest(value: unknown): MotionManifest {
  if (!value || typeof value !== 'object') throw new Error('动作清单格式无效。');
  const manifest = value as MotionManifest;
  if (!(manifest.version === 1 && manifest.profile === MANUAL_ROAM_RIG_PROFILE || manifest.version === 2 && manifest.profile === MANUAL_ROAM_RIG_PROFILE_V2)) throw new Error('动作清单骨架版本不兼容。');
  const names = new Set<string>();
  for (const clip of MANUAL_ROAM_CLIPS) {
    const definition = manifest.clips?.[clip];
    if (!definition || typeof definition.name !== 'string' || !definition.name || typeof definition.loop !== 'boolean' || names.has(definition.name)) throw new Error(`动作清单缺少唯一有效片段：${clip}`);
    if ((clip.startsWith('Walk') || clip.startsWith('Run')) && !(Number.isFinite(definition.referenceSpeed) && definition.referenceSpeed! > 0)) throw new Error(`动作基准速度无效：${clip}`);
    if (manifest.version === 2 && (clip.startsWith('Walk') || clip.startsWith('Run'))
      && (!(Number.isFinite(definition.cycleDistanceMeters) && definition.cycleDistanceMeters! > 0)
      || !(Number.isFinite(definition.phaseOffset) && definition.phaseOffset! >= 0 && definition.phaseOffset! < 1))) throw new Error(`动作步长或接触相位无效：${clip}`);
    names.add(definition.name);
  }
  for(const clip of MANUAL_ROAM_TURN_CLIPS) {
    const definition=manifest.clips?.[clip];if(!definition)continue;
    if(definition.name!==clip||definition.loop!==false||!definition.rotationProgress||definition.rotationProgress.length<2
      ||definition.rotationProgress[0]!==0||definition.rotationProgress.at(-1)!==1
      ||!definition.rotationProgress.every((value,i)=>Number.isFinite(value)&&value>=0&&value<=1&&(i===0||value>=definition.rotationProgress![i-1])))throw new Error(`转身动作曲线无效：${clip}`);
  }
  return manifest;
}

function validateTracks(group: AnimationGroup, nodes: Map<string, TransformNode>): void {
  const rotations = new Set<string>();
  const identities = new Set<string>();
  if (!(duration(group) > 0)) throw new Error(`动作时长无效：${group.name}`);
  for (const track of group.targetedAnimations) {
    const property = track.animation.targetProperty;
    const name = track.target.name;
    const identity = `${name}:${property}`;
    if (nodes.get(name) !== track.target || identities.has(identity) || !(property === 'rotationQuaternion' || (name === 'Hips' && property === 'position'))) throw new Error(`动作轨道不受支持：${group.name}/${identity}`);
    identities.add(identity);
    if (property === 'rotationQuaternion') rotations.add(name);
    const keys = track.animation.getKeys();
    let previous = -Infinity;
    for (const key of keys) {
      const values: number[] = key.value?.asArray?.() ?? [];
      if (!Number.isFinite(key.frame) || key.frame <= previous || !values.length || !values.every(Number.isFinite)) throw new Error(`动作轨道关键帧无效：${identity}`);
      previous = key.frame;
      if (property === 'rotationQuaternion' && (values.length !== 4 || Math.abs(Math.hypot(...values) - 1) > 0.01)) throw new Error(`动作旋转四元数无效：${identity}`);
      if (property === 'position' && (Math.abs(key.value.x - track.target.position.x) > 1e-4 || Math.abs(key.value.z - track.target.position.z) > 1e-4)) throw new Error(`动作轨道包含水平根位移：${group.name}`);
    }
    if (keys.length < 2) throw new Error(`动作轨道关键帧不足：${identity}`);
  }
  if (rotations.size !== nodes.size) throw new Error(`动作轨道缺少必要关节：${group.name}`);
}

function duration(group: AnimationGroup): number {
  const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 0;
  return fps > 0 ? (group.to - group.from) / fps : 0;
}

function legLength(nodes: Map<string, TransformNode>): number {
  return ['LeftLeg', 'LeftFoot', 'RightLeg', 'RightFoot'].reduce((sum, name) => sum + nodes.get(name)!.position.length(), 0) / 2;
}
