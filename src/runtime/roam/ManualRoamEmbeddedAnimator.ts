import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import { createManualRoamAnimationState, stepManualRoamAnimationState, type ManualRoamAnimationFrame, type ManualRoamClip } from './manualRoamAnimationState.ts';

type PlayingClip = { weight: number; seconds: number; progress: number };
const ACTIONS: Partial<Record<ManualRoamClip, RegExp>> = {
  Idle: /idle|stand|breath|待机|站立/i,
  WalkForward: /walk|walking|move|行走|走路/i,
  RunForward: /run|running|sprint|jog|跑步|奔跑/i,
  JumpStart: /jump|跳跃|起跳/i,
  JumpUp: /jump.?up|上升/i,
  Fall: /fall|下落/i,
  Land: /land|落地/i,
  FlyIdle: /hover|fly.?idle|悬停/i,
  FlyMove: /fly|flight|飞行/i,
};
const DIRECTIONS = { Backward: /back|reverse|后退|倒退/i, Left: /left|左/i, Right: /right|右/i };

/** 普通GLB沿用自身骨架，缺动作时只回退到语义相近动作，不能任取首个片段。 */
export class ManualRoamEmbeddedAnimator {
  private readonly clips = new Map<ManualRoamClip, AnimationGroup>();
  private readonly playing = new Map<AnimationGroup, PlayingClip>();
  private state = createManualRoamAnimationState();
  private transition: { from: Map<AnimationGroup, number>; target: string; elapsed: number } | null = null;
  private paused = false;
  private phase = 0;

  constructor(private readonly groups: readonly AnimationGroup[]) {
    for (const [clip, pattern] of Object.entries(ACTIONS)) {
      const group = groups.find(group => pattern.test(group.name)
        && (!(clip === 'WalkForward' || clip === 'RunForward') || !Object.values(DIRECTIONS).some(direction => direction.test(group.name))));
      if (group) this.clips.set(clip as ManualRoamClip, group);
    }
    for (const prefix of ['Walk', 'Run'] as const) {
      for (const [direction, pattern] of Object.entries(DIRECTIONS)) {
        const group = groups.find(group => ACTIONS[`${prefix}Forward`]!.test(group.name) && pattern.test(group.name));
        if (group) this.clips.set(`${prefix}${direction}` as ManualRoamClip, group);
      }
    }
  }

  getWarnings(): string[] {
    if (!this.clips.size) return ['未识别到漫游动作名称，保留原始姿态；请使用 Idle、Walk、Run、Jump 等动作名。'];
    const missing = (['Idle', 'WalkForward', 'RunForward'] as const).filter(clip => !this.clips.has(clip));
    return missing.length ? [`模型缺少 ${missing.join('、')}，仅使用已有的相近动作；不保证完整步态。`] : [];
  }

  update(frame: ManualRoamAnimationFrame): void {
    if (this.paused) return;
    const dt = Math.min(0.1, Math.max(0, Number.isFinite(frame.deltaSeconds) ? frame.deltaSeconds : 0));
    this.state = stepManualRoamAnimationState(this.state, frame);
    const desired = new Map<AnimationGroup, number>();
    for (const [clip, weight] of Object.entries(this.state.weights)) {
      const group = this.resolve(clip as ManualRoamClip);
      if (group) desired.set(group, (desired.get(group) ?? 0) + (weight ?? 0));
    }
    const total = [...desired.values()].reduce((sum, value) => sum + value, 0);
    if (total > 0) for (const [group, weight] of desired) desired.set(group, weight / total);
    const target = [...desired.keys()].map(group => this.groups.indexOf(group)).sort((a, b) => a - b).join(',');
    const differs = [...new Set([...this.playing.keys(), ...desired.keys()])]
      .some(group => Math.abs((this.playing.get(group)?.weight ?? 0) - (desired.get(group) ?? 0)) > 1e-6);
    if ((!this.transition && differs) || (this.transition && this.transition.target !== target)) {
      this.transition = { from: new Map([...this.playing].map(([group, clip]) => [group, clip.weight])), target, elapsed: 0 };
    }
    for (const group of desired.keys()) if (!this.playing.has(group)) {
      this.playing.set(group, { weight: 0, seconds: 0, progress: 0 });
    }
    const transition = this.transition;
    if (transition) {
      transition.elapsed += dt;
      const t = Math.min(1, transition.elapsed / (this.state.kind === 'ground' ? 0.18 : 0.1));
      const blend = t * t * (3 - 2 * t);
      for (const [group, clip] of this.playing) {
        const from = transition.from.get(group) ?? 0;
        clip.weight = from + ((desired.get(group) ?? 0) - from) * blend;
      }
      if (t === 1) this.transition = null;
    }
    const speed = Math.hypot(frame.velocityX, frame.velocityZ);
    let distance = 0, movingWeight = 0;
    for (const [group, clip] of this.playing) {
      const gait = this.gait(group);
      if (!gait || clip.weight <= 0) continue;
      distance += clip.weight * this.duration(group) * (gait === 'Run' ? frame.runSpeed ?? frame.walkSpeed * 2 : frame.walkSpeed);
      movingWeight += clip.weight;
    }
    if (frame.grounded && !frame.fly && speed > 0.03 && movingWeight > 1e-6) {
      this.phase = (this.phase + dt * Math.min(4, speed / Math.max(0.01, distance / movingWeight))) % 1;
    }
    for (const [group, clip] of this.playing) {
      if (clip.weight <= 1e-6) {
        group.stop();
        this.playing.delete(group);
        continue;
      }
      const gait = this.gait(group);
      const oneShot = ['JumpStart', 'JumpUp', 'Fall', 'Land'].some(action => this.clips.get(action as ManualRoamClip) === group);
      if (!group.isStarted) {
        // 一次性动作也保持手动采样，播到尾帧后停留，避免回到绑定姿态。
        group.start(true, 0);
      } else clip.seconds += dt;
      clip.progress = gait ? this.phase : oneShot ? Math.min(1, clip.seconds / this.duration(group)) : (clip.seconds / this.duration(group)) % 1;
      group.setWeightForAllAnimatables(clip.weight);
      group.goToFrame(group.from + (group.to - group.from) * clip.progress, true);
      group.pause();
    }
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  reset(): void {
    this.stop();
    this.state = createManualRoamAnimationState();
    this.phase = 0;
    const idle = this.clips.get('Idle');
    if (idle) {
      idle.start(true, 0);
      idle.setWeightForAllAnimatables(1);
      idle.goToFrame(idle.from, true);
      idle.pause();
      this.playing.set(idle, { weight: 1, seconds: 0, progress: 0 });
    }
  }

  stop(): void {
    for (const group of this.playing.keys()) group.stop();
    this.playing.clear();
    this.transition = null;
  }

  private gait(group: AnimationGroup): 'Walk' | 'Run' | null {
    for (const [clip, candidate] of this.clips) if (candidate === group) {
      if (clip.startsWith('Walk')) return 'Walk';
      if (clip.startsWith('Run')) return 'Run';
    }
    return null;
  }

  private duration(group: AnimationGroup): number {
    const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 30;
    return Math.max(0.01, (group.to - group.from) / Math.max(1, fps));
  }

  private resolve(clip: ManualRoamClip): AnimationGroup | undefined {
    const exact = this.clips.get(clip);
    if (exact) return exact;
    if (clip.startsWith('Run')) return this.clips.get(clip.replace('Run', 'Walk') as ManualRoamClip)
      ?? this.clips.get('RunForward') ?? this.clips.get('WalkForward') ?? this.clips.get('Idle');
    if (clip.startsWith('Walk')) return this.clips.get('WalkForward') ?? this.clips.get('Idle');
    if (clip === 'JumpUp' || clip === 'Fall') return this.clips.get('JumpStart') ?? this.clips.get('Idle');
    if (clip === 'FlyMove') return this.clips.get('FlyIdle') ?? this.clips.get('Idle');
    return this.clips.get('Idle');
  }
}
