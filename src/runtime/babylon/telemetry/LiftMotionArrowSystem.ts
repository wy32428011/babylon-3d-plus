import { LIFT_MOTION_ARROW_CHANNELS, type LiftMotionArrowChannel, type LiftMotionArrowsConfig } from '../../../editor/model/liftMotionArrows';
import { liftMotionArrowSession } from '../../liftMotionArrowSession';
import { deviceTelemetryStore, readIntegerField } from '../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { liftMotionArrowKey } from '../effects/LiftMotionArrowRenderer';
import type { LiftArrowAxis } from '../effects/LiftMotionArrowSurface';
import type { ConveyorSurfaceArrowModel } from './ConveyorSurfaceArrowSystem';
import { collectSpecializedTelemetryConflictKeys, resolveSpecializedTelemetryBinding, resolveSpecializedTelemetrySnapshot } from './specializedTelemetryBinding';
import { getLiftMotionFrame } from './liftMotionState';

export interface LiftMotionArrowVisual {
  update(id: string, model: ModelRuntimeEntry, config: LiftMotionArrowsConfig, channel: LiftMotionArrowChannel,
    direction: 1 | -1 | 0, deltaSeconds: number, visible: boolean, axis?: LiftArrowAxis): string | null;
  retain(keys: ReadonlySet<string>): void;
  clear(): void;
  dispose(): void;
}

function validAxis(axis?: LiftArrowAxis): boolean {
  return !!axis && [axis.x, axis.y, axis.z].every(Number.isFinite)
    && axis.x * axis.x + axis.y * axis.y + axis.z * axis.z > 1e-8;
}

/** 消费 lift / hclift 驱动的本帧真实位移；两类设备共享样式及生命周期，换层提升机只显示升降通道。 */
export class LiftMotionArrowSystem {
  private diagnosticIds = new Set<string>();
  constructor(private readonly renderer: LiftMotionArrowVisual) {}

  tick(models: Iterable<ConveyorSurfaceArrowModel>, running: boolean, deltaSeconds: number, frameId: number, now = Date.now()): void {
    const entries = [...models].map(entry => ({ ...entry, binding: running && (entry.deviceType === 'lift' || entry.deviceType === 'hclift')
      && entry.model.assetHandle && entry.model.stackerTelemetryReady
      ? resolveSpecializedTelemetryBinding({ modelAssetCode: entry.model.assetCode, deviceType: entry.deviceType, binding: entry.model.telemetryBinding }) : null }));
    // 未开启箭头的设备同样参与身份冲突判断，与专用运动驱动保持一致。
    const conflicts = running ? collectSpecializedTelemetryConflictKeys(entries.flatMap(entry => entry.binding ? [entry.binding] : [])) : new Set<string>();
    const retained = new Set<string>(), diagnostics = new Set<string>();
    for (const { entityId, model, binding, deviceType, visible } of entries) {
      const config = model.telemetryBinding?.liftMotionArrows;
      if (!config || (deviceType !== 'lift' && deviceType !== 'hclift')) continue;
      diagnostics.add(entityId);
      const ready = !!model.assetHandle && model.stackerTelemetryReady && !model.root.isDisposed();
      const snapshot = binding ? resolveSpecializedTelemetrySnapshot(deviceTelemetryStore, binding) : null;
      const motion = getLiftMotionFrame(model);
      const invalid = !ready ? '等待提升机模型准备完成' : !running ? null : !binding ? '设备绑定无效，箭头隐藏'
        : conflicts.has(binding.key) ? '设备绑定冲突，箭头隐藏' : !snapshot ? '等待设备 MQTT 数据，箭头隐藏'
        : now - snapshot.receivedAt > binding.staleAfterMs ? '设备数据过期，箭头隐藏'
        : snapshot.faulted || readIntegerField(snapshot.fields, 'work_state') === 10 ? '设备故障/急停，箭头隐藏'
        : !motion || motion.frameId !== frameId ? '本帧没有有效运动结果，箭头隐藏' : null;
      for (const channel of LIFT_MOTION_ARROW_CHANNELS) {
        if (deviceType === 'hclift' && channel !== 'lift') {
          liftMotionArrowSession.setDiagnostic(entityId, channel, '换层提升机仅支持升降运行箭头');
          continue;
        }
        if (!config.enabled || !config.channels[channel].enabled) {
          liftMotionArrowSession.setDiagnostic(entityId, channel, '运动箭头未启用');
          continue;
        }
        if (!ready) { liftMotionArrowSession.setDiagnostic(entityId, channel, invalid!); continue; }
        retained.add(liftMotionArrowKey(entityId, channel));
        const preview = running ? null : liftMotionArrowSession.getPreview(entityId, channel);
        const channelMotion = motion?.[channel];
        const direction = invalid ? 0 : running ? channelMotion!.direction : preview ?? 0;
        const axisIssue = running && direction !== 0 && channel !== 'lift' && !validAxis(channelMotion?.axis)
          ? '本帧没有有效货物运动轴，箭头隐藏' : null;
        const message = invalid ?? axisIssue ?? (!visible ? '模型隐藏，箭头隐藏' : running
          ? direction ? '运行：沿运动轴' + (direction > 0 ? '正向' : '反向') : '已到位、停止或无有效交接方向'
          : preview === null ? '编辑状态：可预览正向、反向和停止' : '编辑预览：' + (preview > 0 ? '正向' : preview < 0 ? '反向' : '停止') + '（模拟状态）');
        const issue = this.renderer.update(entityId, model, config, channel, axisIssue ? 0 : direction, deltaSeconds,
          visible && !invalid && !axisIssue && (running || preview !== null), running ? channelMotion?.axis : undefined);
        liftMotionArrowSession.setDiagnostic(entityId, channel, issue ? message + '；' + issue : message);
      }
    }
    this.renderer.retain(retained);
    for (const id of this.diagnosticIds) if (!diagnostics.has(id)) liftMotionArrowSession.remove(id);
    this.diagnosticIds = diagnostics;
  }

  clear(): void {
    this.renderer.clear();
    for (const id of this.diagnosticIds) liftMotionArrowSession.remove(id);
    this.diagnosticIds.clear();
  }
  dispose(): void { this.clear(); this.renderer.dispose(); }
}
