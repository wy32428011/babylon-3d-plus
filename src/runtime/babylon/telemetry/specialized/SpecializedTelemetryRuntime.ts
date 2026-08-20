import type { Scene } from '@babylonjs/core';
import type { ExternalModelScriptTelemetrySnapshot } from '../../ExternalModelScriptRuntime';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import {
  deviceTelemetryStore,
  type DeviceTelemetrySnapshot,
  type StackerTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore, type TelemetryRuntimeDiagnosticStatus } from '../../../mqtt/telemetryRuntimeDiagnostics';
import {
  collectSpecializedTelemetryConflictKeys,
  resolveSpecializedTelemetryBinding,
  resolveSpecializedTelemetrySnapshot,
  type ResolvedSpecializedTelemetryBinding,
  type SpecializedTelemetryDeviceType,
} from '../specializedTelemetryBinding';
import { isConveyorRuntimeModel, isRgvRuntimeModel } from './specializedModelAssets';
import { StackerTelemetryDriver } from './stackerDriver';
import { ConveyorTelemetryDriver } from './conveyorDriver';
import { RgvTelemetryDriver } from './rgvDriver';
import {
  type ConveyorCargoRuntimeEntry,
  createSpecializedTelemetrySharedState,
  type GeneratedCargoRuntimeEntry,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetryRuntimeEntry,
  type SpecializedTelemetrySharedState,
  type StackerCargoRuntimeEntry,
  type StackerForkSide,
} from './types';

/** 专用设备驱动注册项：新增设备类型时追加一行注册即可接入帧调度。 */
type SpecializedDriverRegistration = {
  readonly deviceType: SpecializedTelemetryDeviceType;
  readonly isCapable: (model: ModelRuntimeEntry) => boolean;
  readonly apply: (model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number) => void;
  /** 快照断流（stale）时仍要求帧级驱动的判定（如输送线接管货物后的自驱走行）。 */
  readonly applyWhenStale?: (model: ModelRuntimeEntry) => boolean;
};

/** 专用遥测运行时的门面类：组合各专用 Driver，并承担帧级调度与诊断状态管理。 */
export class SpecializedTelemetryRuntime implements SpecializedTelemetryDriverContext {
  readonly scene: Scene;
  readonly state: SpecializedTelemetrySharedState;
  readonly host: SpecializedTelemetryHost;
  private readonly stackerDriver: StackerTelemetryDriver;
  private readonly conveyorDriver: ConveyorTelemetryDriver;
  private readonly rgvDriver: RgvTelemetryDriver;
  /** 驱动注册表，数组顺序即无实例绑定时的默认优先级（Stacker 优先）。 */
  private readonly drivers: readonly SpecializedDriverRegistration[];

  constructor(scene: Scene, host: SpecializedTelemetryHost) {
    this.scene = scene;
    this.host = host;
    this.state = createSpecializedTelemetrySharedState();
    this.stackerDriver = new StackerTelemetryDriver(this);
    this.conveyorDriver = new ConveyorTelemetryDriver(this);
    this.rgvDriver = new RgvTelemetryDriver(this);
    this.drivers = [
      {
        deviceType: 'stacker',
        isCapable: (model) => model.stackerCapable,
        apply: (model, snapshot, deltaSeconds) => this.stackerDriver.applyToModel(model, snapshot as StackerTelemetrySnapshot, deltaSeconds),
        // 断流时继续朝最后已知库位做确定性插值，避免推送间隔超过 staleAfterMs 时整机停在半途；故障帧仍由 faulted 检查冻结
        applyWhenStale: () => true,
      },
      {
        deviceType: 'conveyor',
        isCapable: isConveyorRuntimeModel,
        apply: (model, snapshot, deltaSeconds) => this.conveyorDriver.applyToModel(model, snapshot, deltaSeconds),
        applyWhenStale: (model) => (model.conveyorTelemetry?.selfDriveDirection ?? 0) !== 0,
      },
      {
        deviceType: 'rgv',
        isCapable: isRgvRuntimeModel,
        apply: (model, snapshot, deltaSeconds) => this.rgvDriver.applyToModel(model, snapshot, deltaSeconds),
      },
    ];
  }

  /** 每帧把最新 MQTT 专用遥测应用到完整主键匹配且无冲突的模型实例；断流设备默认停摆，仅驱动声明 applyWhenStale 的例外（输送线接管自驱）。 */
  applyFrame(deltaSeconds: number): void {
    const nowMs = Date.now();
    for (const driver of this.drivers) {
      const candidates = this.collectSpecializedTelemetryModels(driver.deviceType);
      const conflictKeys = collectSpecializedTelemetryConflictKeys(
        candidates.map((candidate) => candidate.binding),
      );
      for (const candidate of candidates) {
        const frame = this.resolveSpecializedTelemetryFrameSnapshot(candidate, conflictKeys, nowMs);
        // 断流快照默认不驱动；驱动声明 applyWhenStale（如输送线接管自驱）时仍用缓存快照推进。
        const snapshot = frame && (!frame.stale || (driver.applyWhenStale?.(candidate.model) ?? false))
          ? frame.snapshot
          : null;
        const context = snapshot ? this.createExternalScriptTelemetrySnapshot(snapshot) : null;
        // 上下文不含 receivedAt：字段未变即签名不变。签名不变时跳过注入与阵列刷新（含阵列批次重建），
        // 避免非断流设备每帧全量执行脚本 onUpdate/阵列刷新——设备全部在线时该成本随设备数线性增长直至卡死；
        // driver.apply 不受门控，货物走行/自驱仍按帧推进。
        const contextSignature = context ? JSON.stringify(context) : null;
        const scriptRuntime = candidate.model.externalScriptRuntime;
        const lastContext = this.state.lastInjectedScriptContexts.get(candidate.entityId);
        const contextUnchanged = lastContext?.signature === contextSignature && lastContext?.runtime === scriptRuntime;
        if (!snapshot && contextUnchanged) {
          continue;
        }
        const preparedArrayHost = contextUnchanged
          ? false
          : this.host.updateExternalScriptContext(candidate.model, context);
        if (!contextUnchanged) {
          this.state.lastInjectedScriptContexts.set(candidate.entityId, { signature: contextSignature, runtime: scriptRuntime });
        }
        if (snapshot) {
          driver.apply(candidate.model, snapshot, deltaSeconds);
        }
        if (preparedArrayHost) {
          this.host.refreshModelArrayRepresentation(candidate.model);
        }
      }
    }
    // 帧尾统一执行外部持货拉取：与快照新旧无关，conveyor 间流转已由链路协议事件驱动，
    // 仅 stacker/RGV 等无链路能力设备的持货需要扫描登记目标后代交付。
    this.conveyorDriver.pullExternalHolderCargo();
  }

  /** 清理已不存在有效专用绑定的模型诊断，避免 Inspector 展示过期状态。 */
  clearInactiveDiagnostics(): void {
    this.clearInactiveSpecializedTelemetryDiagnostics();
  }

  /** 为同时命中多种专用能力的模型选择唯一驱动类型，实例绑定优先、无绑定时按注册表顺序。 */
  resolveDeviceType(model: ModelRuntimeEntry): SpecializedTelemetryDeviceType | null {
    return this.resolveSpecializedTelemetryDeviceType(model);
  }

  /** 预计算并缓存堆垛机货叉参考位置，供首个驱动帧前捕获基线使用。 */
  primeStackerTargetReference(model: ModelRuntimeEntry): void {
    this.stackerDriver.getStackerTargetReferencePosition(model);
  }

  /** 预热输送线行程规划与双向探测邻居缓存，避免首个货物事件的级联把全场景几何扫描挤在一帧。 */
  primeConveyorLinkCaches(model: ModelRuntimeEntry): void {
    this.conveyorDriver.primeLinkCaches(model);
  }

  /** 清除模型 root/contentRoot 上的遥测运行态 metadata，避免预览状态泄漏到编辑态 Inspector。 */
  clearDiagnosticsForModel(model: ModelRuntimeEntry): void {
    this.clearSpecializedTelemetryDiagnosticsForModel(model);
  }

  /** 清空 SceneRuntime 级别的预览诊断、metadata 和已上报状态，不影响模型注册或编译绑定。 */
  clearReportedState(): void {
    this.state.reportedMissingTargets.clear();
    this.state.reportedFaults.clear();
    this.state.reportedStatuses.clear();
    this.state.reportedInvalidStackerBoxTargets.clear();
    this.state.lastReportedStackerTargetSignatures.clear();
    this.state.lastInjectedScriptContexts.clear();
    telemetryRuntimeDiagnosticsStore.clear();
  }

  /** 清理所有专用 Stacker/Conveyor/RGV 运行时货物，保证结束预览不污染编辑态场景。 */
  disposeAllCargo(): void {
    for (const cargo of this.state.stackerCargoMeshes.values()) {
      this.disposeStackerCargo(cargo);
    }
    this.state.stackerCargoMeshes.clear();
    for (const cargo of this.state.conveyorCargoMeshes.values()) {
      this.disposeConveyorCargo(cargo);
    }
    this.state.conveyorCargoMeshes.clear();
    for (const cargo of this.state.rgvCargoMeshes.values()) {
      this.host.disposeGeneratedCargo(cargo);
    }
    this.state.rgvCargoMeshes.clear();
  }

  /** 删除指定资产编号下的全部专用运行时货物。 */
  disposeCargoForAssetCode(assetCode: string): void {
    this.stackerDriver.disposeStackerCargoForAssetCode(assetCode);
    this.conveyorDriver.disposeConveyorCargoForAssetCode(assetCode);
    this.rgvDriver.disposeRgvCargoForAssetCode(assetCode);
  }

  /** 释放指定生成器提供模板的全部运行时货箱。 */
  disposeCargoForGenerator(generatorEntityId: string): void {
    for (const [key, cargo] of this.state.conveyorCargoMeshes.entries()) {
      if (cargo.generatorEntityId !== generatorEntityId) continue;
      this.disposeConveyorCargo(cargo);
      this.state.conveyorCargoMeshes.delete(key);
    }
    for (const [key, cargo] of this.state.stackerCargoMeshes.entries()) {
      if (cargo.generatorEntityId !== generatorEntityId) continue;
      this.disposeStackerCargo(cargo);
      this.state.stackerCargoMeshes.delete(key);
    }
    for (const [key, cargo] of this.state.rgvCargoMeshes.entries()) {
      if (cargo.generatorEntityId !== generatorEntityId) continue;
      this.host.disposeGeneratedCargo(cargo);
      this.state.rgvCargoMeshes.delete(key);
    }
  }

  /** 按 key 释放单个堆垛机保留货箱（如 fetch 单排同步后的清理）。 */
  disposeStackerCargoByKey(key: string): void {
    const cargo = this.state.stackerCargoMeshes.get(key);
    if (!cargo) return;
    this.disposeStackerCargo(cargo);
    this.state.stackerCargoMeshes.delete(key);
  }

  /** 释放门面持有的全部运行时资源。 */
  dispose(): void {
    this.disposeAllCargo();
  }

  // ===== SpecializedTelemetryDriverContext 实现 =====

  disposeStackerCargo(cargo: StackerCargoRuntimeEntry): void {
    this.host.disposeGeneratedCargo(cargo);
  }

  disposeConveyorCargo(cargo: ConveyorCargoRuntimeEntry): void {
    this.host.disposeGeneratedCargo(cargo);
  }

  getOrCreateStackerCargo(assetCode: string, side: StackerForkSide): StackerCargoRuntimeEntry {
    return this.stackerDriver.getOrCreateStackerCargo(assetCode, side);
  }

  getOrCreateConveyorCargo(assetCode: string, containerCode: string): ConveyorCargoRuntimeEntry {
    return this.conveyorDriver.getOrCreateConveyorCargo(assetCode, containerCode);
  }

  /**
   * 按 task 全局接管货物实例：三张货物表即注册表，找到其他设备持有的同 task 货箱时
   * 由其 driver 清理遥测引用并取出条目（不销毁，视觉连续）返回；空 task 不参与，返回 null。
   */
  adoptGlobalCargoByTask(task: string, claimingCargoKey: string): GeneratedCargoRuntimeEntry | null {
    if (!task) return null;
    for (const [key, cargo] of [...this.state.stackerCargoMeshes]) {
      if (key !== claimingCargoKey && cargo.task === task) {
        return this.stackerDriver.detachClaimedCargoByKey(key);
      }
    }
    for (const [key, cargo] of [...this.state.conveyorCargoMeshes]) {
      if (key !== claimingCargoKey && cargo.task === task) {
        return this.conveyorDriver.detachClaimedCargoByKey(key);
      }
    }
    for (const [key, cargo] of [...this.state.rgvCargoMeshes]) {
      if (key !== claimingCargoKey && cargo.task === task) {
        return this.rgvDriver.detachClaimedCargoByKey(key);
      }
    }
    return null;
  }

  /** 按货物实例引用摘除（不销毁）：扫三张货物表定位所属条目，交由对应 driver 清理遥测引用后取出。 */
  detachClaimedCargoByReference(cargo: GeneratedCargoRuntimeEntry): GeneratedCargoRuntimeEntry | null {
    for (const [key, entry] of [...this.state.stackerCargoMeshes]) {
      if (entry === cargo) return this.stackerDriver.detachClaimedCargoByKey(key);
    }
    for (const [key, entry] of [...this.state.conveyorCargoMeshes]) {
      if (entry === cargo) return this.conveyorDriver.detachClaimedCargoByKey(key);
    }
    for (const [key, entry] of [...this.state.rgvCargoMeshes]) {
      if (entry === cargo) return this.rgvDriver.detachClaimedCargoByKey(key);
    }
    return null;
  }

  /** stacker 从 conveyor 站台取货：解析货格宿主为 conveyor 后无视 task 接管其当前持货。 */
  adoptConveyorPlatformCargo(locatorEntityId: string, stackerAssetCode: string): GeneratedCargoRuntimeEntry | null {
    const resolved = this.host.resolveBuiltInSlotHost(locatorEntityId);
    if (!resolved || !isConveyorRuntimeModel(resolved.model)) return null;
    return this.conveyorDriver.adoptPlatformCargoForStacker(resolved.model, stackerAssetCode);
  }

  /** stacker 向 conveyor 站台放货完成：取出货物交接给该 conveyor；失败时货物放回原表，由调用方走原销毁路径。 */
  placeCargoIntoConveyorPlatform(locatorEntityId: string, cargoKey: string): boolean {
    const resolved = this.host.resolveBuiltInSlotHost(locatorEntityId);
    if (!resolved || !isConveyorRuntimeModel(resolved.model)) return false;
    // 先预检再拆引用：拒绝时 stacker 侧货物状态保持完好，回退到 command 5 销毁路径
    if (!this.conveyorDriver.canAcceptPlatformPlacedCargo(resolved.model, resolved.locator)) return false;
    const cargo = this.stackerDriver.detachClaimedCargoByKey(cargoKey);
    if (!cargo) return false;
    if (!this.conveyorDriver.acceptPlatformPlacedCargo(resolved.model, resolved.locator, cargo)) {
      this.state.stackerCargoMeshes.set(cargoKey, cargo);
      return false;
    }
    return true;
  }

  // ===== 帧内私有方法 =====

  /** 收集最终选择当前专用类型的模型，并把实例绑定归一成完整遥测主键。 */
  private collectSpecializedTelemetryModels(
    deviceType: SpecializedTelemetryDeviceType,
  ): SpecializedTelemetryRuntimeEntry[] {
    const candidates: SpecializedTelemetryRuntimeEntry[] = [];
    const appendCandidate = (entityId: string, model: ModelRuntimeEntry): void => {
      if (!model.assetHandle || !model.stackerTelemetryReady) return;
      if (this.resolveSpecializedTelemetryDeviceType(model) !== deviceType) return;
      const binding = resolveSpecializedTelemetryBinding({
        modelAssetCode: model.assetCode,
        deviceType,
        binding: model.telemetryBinding,
      });
      if (binding) candidates.push({ entityId, model, binding });
    };

    for (const { entityId, model } of this.host.collectModels()) {
      appendCandidate(entityId, model);
    }
    return candidates;
  }

  /** 为同时命中多种专用能力的模型选择唯一驱动类型，实例绑定优先、无绑定时按注册表顺序取首个可用驱动。 */
  private resolveSpecializedTelemetryDeviceType(model: ModelRuntimeEntry): SpecializedTelemetryDeviceType | null {
    if (model.telemetryBinding?.enabled === false) return null;
    const configuredDeviceType = model.telemetryBinding?.deviceType.trim().toLowerCase();
    if (configuredDeviceType) {
      const matched = this.drivers.find(
        (driver) => driver.deviceType === configuredDeviceType && driver.isCapable(model),
      );
      return matched ? matched.deviceType : null;
    }
    return this.drivers.find((driver) => driver.isCapable(model))?.deviceType ?? null;
  }

  /** 仅在模型没有任何有效专用绑定时清理诊断，避免另一专用类型遍历覆盖有效状态。 */
  private clearInactiveSpecializedTelemetryDiagnostics(): void {
    for (const { entityId, model } of this.host.collectModels()) {
      if (!model.assetHandle || !model.stackerTelemetryReady) continue;
      const isSpecialized = this.drivers.some((driver) => driver.isCapable(model));
      if (!isSpecialized || this.resolveSpecializedTelemetryDeviceType(model)) continue;
      this.clearSpecializedTelemetryDiagnostics(entityId, model);
    }
  }

  /** 解析当前帧专用快照，并统一处理冲突、离线、断流和诊断状态；冲突/无快照返回 null，否则返回快照与断流标记。 */
  private resolveSpecializedTelemetryFrameSnapshot(
    candidate: SpecializedTelemetryRuntimeEntry,
    conflictKeys: ReadonlySet<string>,
    nowMs: number,
  ): { snapshot: DeviceTelemetrySnapshot; stale: boolean } | null {
    const { entityId, model, binding } = candidate;
    const snapshot = resolveSpecializedTelemetrySnapshot(deviceTelemetryStore, binding);
    const conflictReportKey = `specialized-conflict:${binding.key}`;

    if (conflictKeys.has(binding.key)) {
      const errors = ['绑定冲突：同一 sourceId/deviceType/assetCode 匹配多个专用模型，已停止驱动。'];
      this.writeSpecializedTelemetryDiagnostics(entityId, model, binding, {
        online: false,
        stale: false,
        faulted: snapshot?.faulted ?? false,
        conflict: true,
        lastReceivedAt: snapshot?.receivedAt ?? null,
        errors,
      }, snapshot ?? undefined);
      if (this.state.reportedStatuses.get(conflictReportKey) !== 'conflict') {
        this.state.reportedStatuses.set(conflictReportKey, 'conflict');
        this.host.pushLog(
          `专用遥测绑定冲突，已停止驱动：sourceId=${binding.sourceId}，deviceType=${binding.deviceType}，assetCode=${binding.assetCode}`,
        );
      }
      return null;
    }

    this.state.reportedStatuses.delete(conflictReportKey);
    if (!snapshot) {
      this.writeSpecializedTelemetryDiagnostics(entityId, model, binding, {
        online: false,
        stale: false,
        faulted: false,
        conflict: false,
        lastReceivedAt: null,
        errors: [],
      });
      return null;
    }

    const stale = nowMs - snapshot.receivedAt > binding.staleAfterMs;
    this.writeSpecializedTelemetryDiagnostics(entityId, model, binding, {
      online: !stale && !snapshot.faulted,
      stale,
      faulted: snapshot.faulted,
      conflict: false,
      lastReceivedAt: snapshot.receivedAt,
      errors: [],
    }, snapshot);
    return { snapshot, stale };
  }

  /** 把专用驱动诊断写入 Babylon metadata 和只读外部 store，不进入场景文档或撤销历史。 */
  private writeSpecializedTelemetryDiagnostics(
    entityId: string,
    model: ModelRuntimeEntry,
    binding: ResolvedSpecializedTelemetryBinding,
    status: TelemetryRuntimeDiagnosticStatus,
    snapshot?: DeviceTelemetrySnapshot,
  ): void {
    const runtimeMetadata = { ...status, errors: [...status.errors] };
    for (const node of [model.root, model.contentRoot]) {
      node.metadata = { ...(node.metadata ?? {}), telemetryRuntime: runtimeMetadata };
    }
    telemetryRuntimeDiagnosticsStore.upsert(entityId, {
      ...runtimeMetadata,
      sourceId: snapshot?.sourceId ?? binding.sourceId,
      deviceType: snapshot?.deviceType ?? binding.deviceType,
      assetCode: snapshot?.assetCode ?? binding.assetCode,
      topic: snapshot?.topic ?? null,
      sequence: snapshot?.sequence ?? null,
      sourceTimestamp: snapshot?.sourceTimestamp ?? null,
      fields: snapshot?.fields ?? {},
      message: snapshot?.message ?? '',
      nodeTargets: [],
      boneTargets: [],
      animationTargets: [],
    });
  }

  /** 清理禁用或类型错配的专用绑定诊断，避免 Inspector 展示过期状态。 */
  private clearSpecializedTelemetryDiagnostics(entityId: string, model: ModelRuntimeEntry): void {
    telemetryRuntimeDiagnosticsStore.delete(entityId);
    for (const node of [model.root, model.contentRoot]) {
      if (!node.metadata || typeof node.metadata !== 'object') continue;
      const metadata = { ...(node.metadata as Record<string, unknown>) };
      delete metadata.telemetryRuntime;
      node.metadata = metadata;
    }
  }

  /** 清除模型 root/contentRoot 上的遥测运行态 metadata，避免预览状态泄漏到编辑态 Inspector。 */
  private clearSpecializedTelemetryDiagnosticsForModel(model: ModelRuntimeEntry): void {
    for (const node of [model.root, model.contentRoot]) {
      if (!node.metadata || typeof node.metadata !== 'object') continue;
      const metadata = { ...(node.metadata as Record<string, unknown>) };
      delete metadata.telemetryRuntime;
      delete metadata.telemetry;
      delete metadata.stackerTelemetry;
      delete metadata.conveyorTelemetry;
      node.metadata = metadata;
    }
  }

  /** 从设备遥测快照提取外置脚本可消费的最小上下文，避免泄漏可变 store 对象。 */
  private createExternalScriptTelemetrySnapshot(snapshot: DeviceTelemetrySnapshot): ExternalModelScriptTelemetrySnapshot {
    return {
      deviceType: snapshot.deviceType,
      assetCode: snapshot.assetCode,
      faulted: snapshot.faulted,
      fields: { ...snapshot.fields },
    };
  }
}
