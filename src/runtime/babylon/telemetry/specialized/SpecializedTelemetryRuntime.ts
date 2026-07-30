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
import { isConveyorRuntimeModel } from './specializedModelAssets';
import { StackerTelemetryDriver } from './stackerDriver';
import { ConveyorTelemetryDriver } from './conveyorDriver';
import {
  type ConveyorCargoRuntimeEntry,
  createSpecializedTelemetrySharedState,
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
};

/** 专用遥测运行时的门面类：组合各专用 Driver，并承担帧级调度与诊断状态管理。 */
export class SpecializedTelemetryRuntime implements SpecializedTelemetryDriverContext {
  readonly scene: Scene;
  readonly state: SpecializedTelemetrySharedState;
  readonly host: SpecializedTelemetryHost;
  private readonly stackerDriver: StackerTelemetryDriver;
  private readonly conveyorDriver: ConveyorTelemetryDriver;
  /** 驱动注册表，数组顺序即无实例绑定时的默认优先级（Stacker 优先）。 */
  private readonly drivers: readonly SpecializedDriverRegistration[];

  constructor(scene: Scene, host: SpecializedTelemetryHost) {
    this.scene = scene;
    this.host = host;
    this.state = createSpecializedTelemetrySharedState();
    this.stackerDriver = new StackerTelemetryDriver(this);
    this.conveyorDriver = new ConveyorTelemetryDriver(this);
    this.drivers = [
      {
        deviceType: 'stacker',
        isCapable: (model) => model.stackerCapable,
        apply: (model, snapshot, deltaSeconds) => this.stackerDriver.applyToModel(model, snapshot as StackerTelemetrySnapshot, deltaSeconds),
      },
      {
        deviceType: 'conveyor',
        isCapable: isConveyorRuntimeModel,
        apply: (model, snapshot, deltaSeconds) => this.conveyorDriver.applyToModel(model, snapshot, deltaSeconds),
      },
    ];
  }

  /** 每帧把最新 MQTT 专用遥测应用到完整主键匹配且无冲突的模型实例。 */
  applyFrame(deltaSeconds: number): void {
    const nowMs = Date.now();
    for (const driver of this.drivers) {
      const candidates = this.collectSpecializedTelemetryModels(driver.deviceType);
      const conflictKeys = collectSpecializedTelemetryConflictKeys(
        candidates.map((candidate) => candidate.binding),
      );
      for (const candidate of candidates) {
        const snapshot = this.resolveSpecializedTelemetryFrameSnapshot(candidate, conflictKeys, nowMs);
        const preparedArrayHost = this.host.updateExternalScriptContext(
          candidate.model,
          snapshot ? this.createExternalScriptTelemetrySnapshot(snapshot) : null,
        );
        if (snapshot) {
          driver.apply(candidate.model, snapshot, deltaSeconds);
        }
        if (preparedArrayHost) {
          this.host.refreshModelArrayRepresentation(candidate.model);
        }
      }
    }
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
    telemetryRuntimeDiagnosticsStore.clear();
  }

  /** 清理所有专用 Stacker/Conveyor 运行时货物，保证结束预览不污染编辑态场景。 */
  disposeAllCargo(): void {
    for (const cargo of this.state.stackerCargoMeshes.values()) {
      this.disposeStackerCargo(cargo);
    }
    this.state.stackerCargoMeshes.clear();
    for (const cargo of this.state.conveyorCargoMeshes.values()) {
      this.disposeConveyorCargo(cargo);
    }
    this.state.conveyorCargoMeshes.clear();
  }

  /** 删除指定资产编号下的全部专用运行时货物。 */
  disposeCargoForAssetCode(assetCode: string): void {
    this.stackerDriver.disposeStackerCargoForAssetCode(assetCode);
    this.conveyorDriver.disposeConveyorCargoForAssetCode(assetCode);
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

  /** 解析当前帧专用快照，并统一处理冲突、离线、断流和诊断状态。 */
  private resolveSpecializedTelemetryFrameSnapshot(
    candidate: SpecializedTelemetryRuntimeEntry,
    conflictKeys: ReadonlySet<string>,
    nowMs: number,
  ): DeviceTelemetrySnapshot | null {
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
    return stale ? null : snapshot;
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
