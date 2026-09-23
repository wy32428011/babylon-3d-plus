import { STACKER_MOTION_ARROW_CHANNELS, type StackerMotionArrowChannel, type StackerMotionArrowsConfig } from '../../../editor/model/stackerMotionArrows';
import { stackerMotionArrowSession } from '../../stackerMotionArrowSession';
import { deviceTelemetryStore } from '../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { stackerMotionArrowKey } from '../effects/StackerMotionArrowRenderer';
import type { ConveyorSurfaceArrowModel } from './ConveyorSurfaceArrowSystem';
import { collectSpecializedTelemetryConflictKeys, resolveSpecializedTelemetryBinding, resolveSpecializedTelemetrySnapshot } from './specializedTelemetryBinding';
import { getStackerMotionFrame } from './stackerMotionState';

export interface StackerMotionArrowVisual {
  update(id: string, model: ModelRuntimeEntry, config: StackerMotionArrowsConfig, channel: StackerMotionArrowChannel,
    direction: 1 | -1 | 0, deltaSeconds: number, visible: boolean): string | null;
  retain(keys: ReadonlySet<string>): void;
  clear(): void;
  dispose(): void;
}

/** 每帧在堆垛机运动完成后更新；有效性门控独立于驱动的断流追赶，防止旧运动状态残留。 */
export class StackerMotionArrowSystem {
  private diagnosticIds = new Set<string>();
  constructor(private readonly renderer: StackerMotionArrowVisual) {}

  tick(models: Iterable<ConveyorSurfaceArrowModel>, running: boolean, deltaSeconds: number, frameId: number, now = Date.now()): void {
    const entries = [...models].map(entry => ({ ...entry, binding: running && entry.deviceType === 'stacker'
      && entry.model.assetHandle && entry.model.stackerTelemetryReady
      ? resolveSpecializedTelemetryBinding({ modelAssetCode: entry.model.assetCode, deviceType: 'stacker', binding: entry.model.telemetryBinding }) : null }));
    const conflicts = running ? collectSpecializedTelemetryConflictKeys(entries.flatMap(entry => entry.binding ? [entry.binding] : [])) : new Set<string>();
    const retained = new Set<string>(), diagnostics = new Set<string>();
    for (const { entityId, model, binding, deviceType, visible } of entries) {
      const config = model.telemetryBinding?.stackerMotionArrows;
      if (!config || (deviceType !== 'stacker' && model.telemetryBinding?.deviceType !== 'stacker')) continue;
      diagnostics.add(entityId);
      const ready = !!model.assetHandle && model.stackerTelemetryReady && !model.root.isDisposed();
      const snapshot = binding ? resolveSpecializedTelemetrySnapshot(deviceTelemetryStore, binding) : null;
      const motion = getStackerMotionFrame(model);
      const invalid = !ready ? '等待堆垛机模型准备完成' : !running ? null : !binding ? '设备绑定无效，箭头隐藏'
        : conflicts.has(binding.key) ? '设备绑定冲突，箭头隐藏' : !snapshot ? '等待设备 MQTT 数据，箭头隐藏'
        : now - snapshot.receivedAt > binding.staleAfterMs ? '设备数据过期，箭头隐藏' : snapshot.faulted ? '设备故障/急停，箭头隐藏'
        : !motion || motion.frameId !== frameId ? '本帧没有有效运动结果，箭头隐藏' : null;
      for (const channel of STACKER_MOTION_ARROW_CHANNELS) {
        if (!config.enabled || !config.channels[channel].enabled) {
          stackerMotionArrowSession.setDiagnostic(entityId, channel, '运动箭头未启用');
          continue;
        }
        if (!ready) { stackerMotionArrowSession.setDiagnostic(entityId, channel, invalid!); continue; }
        retained.add(stackerMotionArrowKey(entityId, channel));
        const preview = running ? null : stackerMotionArrowSession.getPreview(entityId, channel);
        const direction = invalid ? 0 : running ? motion![channel].direction : preview ?? 0;
        const message = invalid ?? (running ? direction ? '运行：沿运动轴' + (direction > 0 ? '正向' : '反向') : '已到位或停止'
          : preview === null ? '编辑状态：可预览正向、反向和停止' : '编辑预览：' + (preview > 0 ? '正向' : preview < 0 ? '反向' : '停止') + '（模拟状态）');
        const issue = this.renderer.update(entityId, model, config, channel, direction, deltaSeconds,
          visible && !invalid && (running || preview !== null));
        stackerMotionArrowSession.setDiagnostic(entityId, channel, issue ? message + '；' + issue : message);
      }
    }
    this.renderer.retain(retained);
    for (const id of this.diagnosticIds) if (!diagnostics.has(id)) stackerMotionArrowSession.remove(id);
    this.diagnosticIds = diagnostics;
  }

  clear(): void {
    this.renderer.clear();
    for (const id of this.diagnosticIds) stackerMotionArrowSession.remove(id);
    this.diagnosticIds.clear();
  }
  dispose(): void { this.clear(); this.renderer.dispose(); }
}
