import {
  AnimationGroup,
  Bone,
  type Nullable,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { ModelAssetComponent } from '../../../editor/model/components';
import type { TelemetryBindingComponent, TelemetryMotionChannel } from '../../../editor/model/telemetryBinding';
import { deviceTelemetryStore, type DeviceTelemetrySnapshot, type DeviceTelemetryStore } from '../../mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore, type TelemetryRuntimeDiagnosticsStore } from '../../mqtt/telemetryRuntimeDiagnostics';
import { clampTelemetryValue, mapTelemetryMotionValue } from './motionValue';
import { compileTelemetryMotionBinding, type CompiledTelemetryMotionBinding } from './motionBindingCompiler';

export type GenericTelemetryModelSyncOptions = {
  entityId: string;
  root: TransformNode;
  contentRoot: TransformNode;
  modelAsset: ModelAssetComponent;
  binding: TelemetryBindingComponent | null | undefined;
  externalDataDrivenConfigs: readonly unknown[];
  specializedDriver: boolean;
  loadToken: number;
  baselineRevision: string;
  animationGroups: readonly AnimationGroup[];
};

type GenericTelemetryMotionRuntimeOptions = {
  telemetryStore?: DeviceTelemetryStore;
  diagnosticsStore?: TelemetryRuntimeDiagnosticsStore;
  pushLog?: (message: string) => void;
};

type TelemetryTargetOptions = {
  nodeTargets: string[];
  boneTargets: string[];
  animationTargets: string[];
};

type RuntimeModelEntry = {
  entityId: string;
  root: TransformNode;
  contentRoot: TransformNode;
  modelAsset: ModelAssetComponent;
  loadToken: number;
  baselineRevision: string;
  animationGroups: readonly AnimationGroup[];
  targetOptions: TelemetryTargetOptions;
  specializedDriver: boolean;
  compiled: CompiledTelemetryMotionBinding | null;
  channelStates: Map<string, ChannelRuntimeState>;
  disabledChannels: Set<string>;
  disabledChannelErrors: Map<string, string>;
  telemetryAnimationGroups: Set<AnimationGroup>;
};

type ChannelRuntimeState = {
  baseline?: Vector3;
  worldBaseline?: Vector3;
  scalingBaseline?: Vector3;
  worldBaselineQuaternion?: Quaternion;
  baselineQuaternion?: Quaternion;
  baselineEuler?: Vector3;
  velocityOffset: number;
  smoothValue: number | null;
  linearFrom: number;
  linearTo: number;
  linearElapsedMs: number;
  lastTarget: number | null;
  lastAction: string | null;
};

type SupportedAnimationAction = 'play' | 'pause' | 'stop' | 'reverse';

type RuntimeMetadata = {
  online: boolean;
  stale: boolean;
  faulted: boolean;
  lastReceivedAt: number | null;
  conflict: boolean;
  errors: string[];
};

/** 通用 Babylon 遥测运动引擎，负责非专用设备的绑定匹配、节点解析和逐帧驱动。 */
export class GenericTelemetryMotionRuntime {
  private readonly models = new Map<string, RuntimeModelEntry>();
  private readonly reportedMessages = new Map<string, number>();
  private readonly telemetryStore: DeviceTelemetryStore;
  private readonly diagnosticsStore: TelemetryRuntimeDiagnosticsStore;
  private readonly pushLog: (message: string) => void;
  private previewActive = false;

  /** 创建通用运动引擎；默认读取全局 deviceTelemetryStore，测试可注入隔离 store。 */
  constructor(private readonly scene: Scene, options: GenericTelemetryMotionRuntimeOptions = {}) {
    this.telemetryStore = options.telemetryStore ?? deviceTelemetryStore;
    this.diagnosticsStore = options.diagnosticsStore ?? telemetryRuntimeDiagnosticsStore;
    this.pushLog = options.pushLog ?? (() => undefined);
  }

  /** 同步一个模型实例的通用遥测绑定；签名变化时重建通道运行态。 */
  syncModel(options: GenericTelemetryModelSyncOptions): void {
    const compiled = options.specializedDriver
      ? null
      : compileTelemetryMotionBinding({
        entityId: options.entityId,
        modelAsset: options.modelAsset,
        binding: options.binding,
        externalDataDrivenConfigs: options.externalDataDrivenConfigs,
      });
    if (!compiled || options.specializedDriver) this.diagnosticsStore.delete(options.entityId);
    const current = this.models.get(options.entityId);
    if (current && current.loadToken === options.loadToken && current.baselineRevision === options.baselineRevision && current.compiled?.signature === compiled?.signature && current.specializedDriver === options.specializedDriver) {
      current.root = options.root;
      current.contentRoot = options.contentRoot;
      current.modelAsset = options.modelAsset;
      current.animationGroups = options.animationGroups;
      current.targetOptions = collectTelemetryTargetOptions(options.contentRoot, options.animationGroups);
      return;
    }

    if (current) this.clearPreviewStateForModel(current, true);

    this.models.set(options.entityId, {
      entityId: options.entityId,
      root: options.root,
      contentRoot: options.contentRoot,
      modelAsset: options.modelAsset,
      loadToken: options.loadToken,
      baselineRevision: options.baselineRevision,
      animationGroups: options.animationGroups,
      targetOptions: collectTelemetryTargetOptions(options.contentRoot, options.animationGroups),
      specializedDriver: options.specializedDriver,
      compiled,
      channelStates: new Map(),
      disabledChannels: new Set(),
      disabledChannelErrors: new Map(),
      telemetryAnimationGroups: new Set(),
    });
  }

  /** 开始一次 MQTT 运行预览，保留已编译绑定和模型注册，仅清理上次预览遗留的运行态。 */
  beginPreview(): void {
    if (this.previewActive) return;
    this.previewActive = true;
  }

  /** 结束 MQTT 运行预览，只停止由遥测触发过的动画组，并清空通道状态、禁用错误、metadata 与诊断。 */
  endPreview(): void {
    if (!this.previewActive && ![...this.models.values()].some((model) => model.telemetryAnimationGroups.size > 0 || model.channelStates.size > 0 || model.disabledChannels.size > 0 || model.disabledChannelErrors.size > 0)) return;
    this.previewActive = false;
    for (const model of this.models.values()) {
      this.clearPreviewStateForModel(model, true);
    }
    this.reportedMessages.clear();
  }

  /** 清理单个模型预览态；可选停止遥测触发动画，但始终保留模型注册和 compiled binding。 */
  private clearPreviewStateForModel(model: RuntimeModelEntry, stopTelemetryAnimations: boolean): void {
    if (stopTelemetryAnimations) {
      for (const animationGroup of model.telemetryAnimationGroups) {
        animationGroup.stop();
      }
    }
    model.telemetryAnimationGroups.clear();
    model.channelStates.clear();
    model.disabledChannels.clear();
    model.disabledChannelErrors.clear();
    this.clearModelMetadata(model);
    this.diagnosticsStore.delete(model.entityId);
  }

  /** 清理指定模型实例的运行态，模型 dispose 时必须调用。 */
  disposeModel(entityId: string): void {
    const model = this.models.get(entityId);
    if (model) this.clearPreviewStateForModel(model, true);
    this.models.delete(entityId);
    this.diagnosticsStore.delete(entityId);
  }

  /** 清理全部模型运行态，SceneRuntime dispose 时调用。 */
  dispose(): void {
    for (const model of this.models.values()) {
      this.clearPreviewStateForModel(model, true);
    }
    this.models.clear();
    this.reportedMessages.clear();
    this.previewActive = false;
    this.diagnosticsStore.clear();
  }

  /** 根据当前遥测快照推进一帧通用运动；冲突、stale 和故障均只写 metadata 不写文档。 */
  applyFrame(deltaSeconds: number, nowMs: number = Date.now()): void {
    const activeModels = [...this.models.values()].filter((model) => model.compiled && !model.specializedDriver);
    const conflictKeys = this.collectConflictKeys(activeModels);
    for (const model of activeModels) {
      const compiled = model.compiled;
      if (!compiled) continue;
      const hasConflict = conflictKeys.has(compiled.key);
      if (hasConflict) {
        this.writeMetadata(model, { online: false, stale: false, faulted: false, lastReceivedAt: null, conflict: true, errors: ['绑定冲突：同一 sourceId/deviceType/assetCode 匹配多个通用模型，已停止驱动。'] });
        this.reportThrottled('generic-conflict:' + compiled.key, '通用遥测绑定冲突，已停止驱动：' + compiled.key, nowMs);
        continue;
      }

      const snapshot = this.telemetryStore.getSnapshot(compiled.binding.assetCode ?? '', compiled.binding.deviceType, compiled.binding.sourceId);
      if (!snapshot) {
        this.writeMetadata(model, { online: false, stale: false, faulted: false, lastReceivedAt: null, conflict: false, errors: [] });
        continue;
      }

      const stale = nowMs - snapshot.receivedAt > compiled.binding.staleAfterMs;
      const errors: string[] = [...model.disabledChannelErrors.values()];
      this.writeMetadata(model, { online: !stale && !snapshot.faulted, stale, faulted: snapshot.faulted, lastReceivedAt: snapshot.receivedAt, conflict: false, errors }, snapshot);
      if (stale) {
        this.pauseContinuousAnimations(model, compiled);
        continue;
      }
      for (const [channelName, channel] of Object.entries(compiled.channels)) {
        if (model.disabledChannels.has(channelName)) continue;
        if (snapshot.faulted && channel.target.kind !== 'animation') continue;
        this.applyChannel(model, compiled, channelName, channel, snapshot, deltaSeconds, errors);
      }
      this.writeMetadata(model, { online: !snapshot.faulted, stale: false, faulted: snapshot.faulted, lastReceivedAt: snapshot.receivedAt, conflict: false, errors }, snapshot);
    }
  }

  /** 找出同一遥测主键下的多模型冲突，冲突时全部停止驱动。 */
  private collectConflictKeys(models: RuntimeModelEntry[]): Set<string> {
    const counts = new Map<string, number>();
    for (const model of models) {
      const key = model.compiled?.key;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  }

  /** 执行单个通道，通道错误只记录 metadata，不影响其他通道。 */
  private applyChannel(
    model: RuntimeModelEntry,
    compiled: CompiledTelemetryMotionBinding,
    channelName: string,
    channel: TelemetryMotionChannel,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
    errors: string[],
  ): void {
    const mappedValue = mapTelemetryMotionValue({ fields: snapshot.fields, channel });
    if (mappedValue === null) return;
    if (channel.target.kind === 'animation') {
      this.applyAnimationChannel(model, channelName, channel, mappedValue, errors);
      return;
    }
    if (typeof mappedValue !== 'number') return;
    const targets = this.resolveTransformTargets(model, channel, errors);
    if (targets.length === 0) return;
    for (const target of targets) {
      this.applyTransformChannel(model, compiled, channelName + ':' + target.uniqueId, channel, target, mappedValue, deltaSeconds);
    }
  }

  /** 解析 root/node/bone 目标，并过滤父子重复节点，避免叠加驱动。 */
  private resolveTransformTargets(model: RuntimeModelEntry, channel: TelemetryMotionChannel, errors: string[]): TransformNode[] {
    if (channel.target.kind === 'root') return [model.root];
    if (channel.target.kind === 'node') {
      const names = [channel.target.selector, ...(channel.target.selectors ?? [])].filter((value): value is string => Boolean(value));
      const exactTargets = this.getModelTransformNodes(model).filter((node) => names.includes(node.name));
      const fallbackTargets = exactTargets.length === 0 && channel.target.fallbackPattern
        ? this.findNodesByPattern(model, channel.target.fallbackPattern, errors)
        : [];
      return filterDescendantTargets([...exactTargets, ...fallbackTargets]);
    }
    if (channel.target.kind === 'bone') return this.resolveBoneTargets(model, channel, errors);
    return [];
  }

  /** 解析骨骼目标，优先使用 Bone.getTransformNode；缺失 linked node 时记录错误。 */
  private resolveBoneTargets(model: RuntimeModelEntry, channel: TelemetryMotionChannel, errors: string[]): TransformNode[] {
    const names = new Set([channel.target.selector, ...(channel.target.selectors ?? [])].filter((value): value is string => Boolean(value)));
    const targets: TransformNode[] = [];
    for (const mesh of model.contentRoot.getChildMeshes(false)) {
      if (!mesh.skeleton) continue;
      for (const bone of mesh.skeleton.bones) {
        if (names.size > 0 && !names.has(bone.name)) continue;
        const transformNode = getBoneTransformNode(bone);
        if (transformNode) targets.push(transformNode);
        else errors.push('骨骼 ' + bone.name + ' 没有关联 TransformNode，通道已跳过。');
      }
    }
    return filterDescendantTargets(targets);
  }

  /** 按显式 fallbackPattern 查找节点，正则非法时仅记录错误。 */
  private findNodesByPattern(model: RuntimeModelEntry, pattern: string, errors: string[]): TransformNode[] {
    try {
      const matcher = new RegExp(pattern);
      return this.getModelTransformNodes(model).filter((node) => matcher.test(node.name));
    } catch {
      errors.push('fallbackPattern 非法：' + pattern);
      return [];
    }
  }

  /** 读取模型内所有 TransformNode，包含 contentRoot 但不包含无关场景节点。 */
  private getModelTransformNodes(model: RuntimeModelEntry): TransformNode[] {
    return [model.contentRoot, ...model.contentRoot.getChildTransformNodes(false)];
  }

  /** 应用 position/rotation/scaling 通道，velocity 使用运行态 offset 防止基线漂移。 */
  private applyTransformChannel(
    model: RuntimeModelEntry,
    compiled: CompiledTelemetryMotionBinding,
    stateKey: string,
    channel: TelemetryMotionChannel,
    target: TransformNode,
    mappedValue: number,
    deltaSeconds: number,
  ): void {
    const state = this.getChannelState(model, stateKey, target);
    const property = channel.property ?? (channel.legacyKind === 'rotate' ? 'rotation' : 'position');
    const axis = channel.axis ?? 'x';
    const targetValue = channel.mode === 'velocity'
      ? this.integrateVelocity(state, mappedValue, channel, deltaSeconds)
      : mappedValue;
    const smoothedValue = channel.mode === 'velocity' ? targetValue : this.smoothValue(state, targetValue, channel, compiled.interpolationMs, deltaSeconds);

    if (property === 'position') {
      this.applyPosition(target, state, axis, smoothedValue, channel.space ?? 'local');
      return;
    }
    if (property === 'rotation') {
      this.applyRotation(target, state, axis, smoothedValue, channel.space ?? 'local');
      return;
    }
    if (property === 'scaling') {
      this.applyScaling(target, state, axis, smoothedValue);
    }
  }

  /** 获取或初始化通道状态，并捕获 position/rotation/scaling 基线。 */
  private getChannelState(model: RuntimeModelEntry, stateKey: string, target: TransformNode): ChannelRuntimeState {
    let state = model.channelStates.get(stateKey);
    if (!state) {
      target.computeWorldMatrix(true);
      const rotationQuaternion = target.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(target.rotation);
      const worldQuaternion = Quaternion.Identity();
      target.getWorldMatrix().decompose(undefined, worldQuaternion);
      state = {
        baseline: target.position.clone(),
        worldBaseline: target.getAbsolutePosition().clone(),
        scalingBaseline: target.scaling.clone(),
        worldBaselineQuaternion: worldQuaternion.clone(),
        baselineQuaternion: rotationQuaternion.clone(),
        baselineEuler: rotationQuaternion.toEulerAngles(),
        velocityOffset: 0,
        smoothValue: null,
        linearFrom: 0,
        linearTo: 0,
        linearElapsedMs: 0,
        lastTarget: null,
        lastAction: null,
      };
      model.channelStates.set(stateKey, state);
    }
    return state;
  }

  /** velocity 模式按秒积分，并对累计 offset 做 min/max 限制。 */
  private integrateVelocity(state: ChannelRuntimeState, mappedValue: number, channel: TelemetryMotionChannel, deltaSeconds: number): number {
    state.velocityOffset = clampTelemetryValue(
      state.velocityOffset + mappedValue * (channel.speed ?? 1) * deltaSeconds,
      channel.min,
      channel.max,
    );
    return state.velocityOffset;
  }

  /** 按 step/linear/ema 三种策略平滑目标值，默认使用模型 interpolationMs。 */
  private smoothValue(
    state: ChannelRuntimeState,
    targetValue: number,
    channel: TelemetryMotionChannel,
    interpolationMs: number,
    deltaSeconds: number,
  ): number {
    if (!channel.smoothing || channel.smoothing.kind === 'step') {
      state.smoothValue = targetValue;
      state.lastTarget = targetValue;
      return targetValue;
    }
    if (channel.smoothing.kind === 'ema') {
      const alpha = channel.smoothing.alpha ?? 0.35;
      state.smoothValue = (state.smoothValue ?? 0) + (targetValue - (state.smoothValue ?? 0)) * alpha;
      state.lastTarget = targetValue;
      return state.smoothValue;
    }
    const durationMs = channel.smoothing.durationMs ?? interpolationMs;
    if (state.lastTarget !== targetValue) {
      state.linearFrom = state.smoothValue ?? 0;
      state.linearTo = targetValue;
      state.linearElapsedMs = 0;
      state.lastTarget = targetValue;
    }
    state.linearElapsedMs += deltaSeconds * 1000;
    const progress = Math.min(1, state.linearElapsedMs / durationMs);
    state.smoothValue = state.linearFrom + (state.linearTo - state.linearFrom) * progress;
    return state.smoothValue;
  }

  /** 应用本地或世界 position，world 模式使用 absolute position。 */
  private applyPosition(target: TransformNode, state: ChannelRuntimeState, axis: 'x' | 'y' | 'z', value: number, space: 'local' | 'world'): void {
    const baseline = space === 'world' ? (state.worldBaseline ?? target.getAbsolutePosition()) : (state.baseline ?? Vector3.Zero());
    const next = baseline.clone();
    next[axis] = baseline[axis] + value;
    if (space === 'world') target.setAbsolutePosition(next);
    else target.position.copyFrom(next);
  }

  /** 应用 quaternion rotation，遥测角度默认按度转弧度。 */
  private applyRotation(target: TransformNode, state: ChannelRuntimeState, axis: 'x' | 'y' | 'z', value: number, space: 'local' | 'world' = 'local'): void {
    const baselineEuler = (space === 'world' ? state.worldBaselineQuaternion?.toEulerAngles() : state.baselineEuler) ?? Vector3.Zero();
    const nextEuler = baselineEuler.clone();
    nextEuler[axis] = baselineEuler[axis] + value * Math.PI / 180;
    const nextQuaternion = Quaternion.FromEulerVector(nextEuler);
    if (space !== 'world' || !target.parent || !(target.parent instanceof TransformNode)) {
      target.rotationQuaternion = nextQuaternion;
      return;
    }
    const parentRotation = Quaternion.Identity();
    target.parent.computeWorldMatrix(true).decompose(undefined, parentRotation);
    target.rotationQuaternion = parentRotation.invert().multiply(nextQuaternion);
  }

  /** 应用基于基线的 scaling 轴向增量。 */
  private applyScaling(target: TransformNode, state: ChannelRuntimeState, axis: 'x' | 'y' | 'z', value: number): void {
    const baseline = state.scalingBaseline ?? target.scaling.clone();
    const next = baseline.clone();
    next[axis] = baseline[axis] + value;
    target.scaling.copyFrom(next);
  }

  /** stale 时暂停正在连续播放的动画，并清除边沿状态以便恢复后续播。 */
  private pauseContinuousAnimations(model: RuntimeModelEntry, compiled: CompiledTelemetryMotionBinding): void {
    for (const [channelName, channel] of Object.entries(compiled.channels)) {
      if (channel.target.kind !== 'animation') continue;
      const state = model.channelStates.get(channelName);
      if (!state || (state.lastAction !== 'play' && state.lastAction !== 'reverse')) continue;
      const selector = channel.target.selector ?? channel.target.selectors?.[0];
      if (!selector) continue;
      const animationGroup = model.animationGroups.find((group) => group.name === selector);
      if (!animationGroup) continue;
      animationGroup.pause();
      state.lastAction = null;
    }
  }

  /** 动画通道只在状态边沿触发，避免每帧重启 AnimationGroup。 */
  private applyAnimationChannel(
    model: RuntimeModelEntry,
    channelName: string,
    channel: TelemetryMotionChannel,
    mappedValue: number | string,
    errors: string[],
  ): void {
    const selector = channel.target.selector ?? channel.target.selectors?.[0];
    if (!selector) return;
    const animationGroup = model.animationGroups.find((group) => group.name === selector) ?? null;
    if (!animationGroup) {
      model.disabledChannels.add(channelName);
      const errorMessage = '找不到动画组 ' + selector + '，通道 ' + channelName + ' 已禁用。';
      model.disabledChannelErrors.set(channelName, errorMessage);
      errors.push(errorMessage);
      return;
    }
    const action = typeof mappedValue === 'string' ? mappedValue : String(mappedValue);
    if (!this.isSupportedAnimationAction(action)) {
      errors.push('未知动画动作 ' + action + '：通道 ' + channelName + ' 仅支持 play/pause/stop/reverse，已跳过该动作且继续处理其他通道。');
      return;
    }
    const state = this.getAnimationChannelState(model, channelName);
    if (state.lastAction === action) return;
    state.lastAction = action;
    if (channel.animation?.speed !== undefined && action !== 'reverse') animationGroup.speedRatio = channel.animation.speed;
    model.telemetryAnimationGroups.add(animationGroup);
    this.invokeAnimationAction(animationGroup, action, channel);
  }

  /** 清除运行时写入的节点 metadata，避免预览状态泄漏回编辑态 Inspector。 */
  private clearModelMetadata(model: RuntimeModelEntry): void {
    for (const node of [model.root, model.contentRoot]) {
      if (!node.metadata || typeof node.metadata !== 'object') continue;
      const metadata = { ...(node.metadata as Record<string, unknown>) };
      delete metadata.telemetryRuntime;
      node.metadata = metadata;
    }
  }

  /** 判断遥测动作是否为运行时支持的动画控制指令，未知动作只记录诊断并跳过。 */
  private isSupportedAnimationAction(action: string): action is SupportedAnimationAction {
    return action === 'play' || action === 'pause' || action === 'stop' || action === 'reverse';
  }

  /** 读取动画通道状态，动画没有 TransformNode 基线，使用空状态保存边沿动作。 */
  private getAnimationChannelState(model: RuntimeModelEntry, channelName: string): ChannelRuntimeState {
    let state = model.channelStates.get(channelName);
    if (!state) {
      state = { velocityOffset: 0, smoothValue: null, linearFrom: 0, linearTo: 0, linearElapsedMs: 0, lastTarget: null, lastAction: null };
      model.channelStates.set(channelName, state);
    }
    return state;
  }

  /** 执行动画 play/pause/stop/reverse；blend 当前安全忽略，仅保留配置兼容。 */
  private invokeAnimationAction(animationGroup: AnimationGroup, action: SupportedAnimationAction, channel: TelemetryMotionChannel): void {
    if (action === 'play') animationGroup.play(channel.animation?.loop ?? false);
    else if (action === 'pause') animationGroup.pause();
    else if (action === 'stop') animationGroup.stop();
    else if (action === 'reverse') {
      const speed = Math.abs(channel.animation?.speed ?? (animationGroup.speedRatio || 1));
      animationGroup.start(channel.animation?.loop ?? false, -speed, animationGroup.to, animationGroup.from);
    }
  }

  /** 写入 root/contentRoot metadata.telemetryRuntime 并同步外部诊断 store，不修改 SceneDocument 或 undo 状态。 */
  private writeMetadata(model: RuntimeModelEntry, metadata: RuntimeMetadata, snapshot?: DeviceTelemetrySnapshot): void {
    for (const node of [model.root, model.contentRoot]) {
      node.metadata = { ...(node.metadata ?? {}), telemetryRuntime: metadata };
    }
    const binding = model.compiled?.binding;
    this.diagnosticsStore.upsert(model.entityId, {
      ...metadata,
      sourceId: snapshot?.sourceId ?? binding?.sourceId ?? null,
      deviceType: snapshot?.deviceType ?? binding?.deviceType ?? null,
      assetCode: snapshot?.assetCode ?? binding?.assetCode ?? null,
      topic: snapshot?.topic ?? null,
      sequence: snapshot?.sequence ?? null,
      sourceTimestamp: snapshot?.sourceTimestamp ?? null,
      fields: snapshot?.fields ?? {},
      message: snapshot?.message ?? '',
      nodeTargets: model.targetOptions.nodeTargets,
      boneTargets: model.targetOptions.boneTargets,
      animationTargets: model.targetOptions.animationTargets,
    });
  }

  /** 中文日志节流，避免冲突或配置错误在每帧刷屏。 */
  private reportThrottled(key: string, message: string, nowMs: number): void {
    const lastReportedAt = this.reportedMessages.get(key) ?? 0;
    if (nowMs - lastReportedAt < 5000) return;
    this.reportedMessages.set(key, nowMs);
    this.pushLog(message);
  }
}

/** 收集当前模型可选节点、骨骼和动画组名称，供 Inspector 提供下拉建议。 */
function collectTelemetryTargetOptions(contentRoot: TransformNode, animationGroups: readonly AnimationGroup[]): TelemetryTargetOptions {
  const nodeTargets = [contentRoot, ...contentRoot.getChildTransformNodes(false)]
    .map((node) => node.name?.trim())
    .filter((name): name is string => Boolean(name));
  const boneTargets = contentRoot.getChildMeshes(false)
    .flatMap((mesh) => mesh.skeleton?.bones.map((bone) => bone.name?.trim()).filter((name): name is string => Boolean(name)) ?? []);
  const animationTargets = animationGroups.map((group) => group.name?.trim()).filter((name): name is string => Boolean(name));
  return {
    nodeTargets: [...new Set(nodeTargets)].sort(),
    boneTargets: [...new Set(boneTargets)].sort(),
    animationTargets: [...new Set(animationTargets)].sort(),
  };
}

/** 判断并调用 Bone.getTransformNode，兼容 Babylon 类型差异。 */
function getBoneTransformNode(bone: Bone): Nullable<TransformNode> {
  return typeof bone.getTransformNode === 'function' ? bone.getTransformNode() : null;
}

/** 去除已经被父级目标覆盖的子节点，防止父子重复驱动。 */
function filterDescendantTargets(targets: TransformNode[]): TransformNode[] {
  const uniqueTargets = [...new Set(targets)];
  return uniqueTargets.filter((target) => {
    let parent = target.parent;
    while (parent) {
      if (parent instanceof TransformNode && uniqueTargets.includes(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });
}
