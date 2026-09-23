import { RGV_MOTION_ARROW_CHANNELS, type RgvMotionArrowChannel, type RgvMotionArrowsConfig } from '../../../editor/model/rgvMotionArrows';
import { rgvMotionArrowSession } from '../../rgvMotionArrowSession';
import { deviceTelemetryStore } from '../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { rgvMotionArrowKey } from '../effects/RgvMotionArrowRenderer';
import type { ConveyorSurfaceArrowModel } from './ConveyorSurfaceArrowSystem';
import { collectSpecializedTelemetryConflictKeys, resolveSpecializedTelemetryBinding, resolveSpecializedTelemetrySnapshot } from './specializedTelemetryBinding';
import { getRgvMotionFrame } from './rgvMotionState';

export interface RgvMotionArrowVisual {
  update(id: string, model: ModelRuntimeEntry, config: RgvMotionArrowsConfig, channel: RgvMotionArrowChannel,
    direction: 1 | -1 | 0, deltaSeconds: number, visible: boolean): string | null;
  retain(keys: ReadonlySet<string>): void;
  clear(): void;
  dispose(): void;
}

/** 在设备驱动之后消费本帧三路结果；失效立即隐藏，停止保留绘制器的短淡出。 */
export class RgvMotionArrowSystem {
  private diagnosticIds = new Set<string>();
  constructor(private readonly renderer: RgvMotionArrowVisual) {}

  tick(models: Iterable<ConveyorSurfaceArrowModel>, running: boolean, deltaSeconds: number, frameId: number, now = Date.now()): void {
    const entries = [...models].map(entry => ({ ...entry, binding: running && entry.deviceType === 'rgv'
      && entry.model.assetHandle && entry.model.stackerTelemetryReady
      ? resolveSpecializedTelemetryBinding({ modelAssetCode: entry.model.assetCode, deviceType: 'rgv', binding: entry.model.telemetryBinding }) : null }));
    // 未开启箭头的设备同样参与身份冲突判定，与实际专用驱动保持一致。
    const conflicts = running ? collectSpecializedTelemetryConflictKeys(entries.flatMap(entry => entry.binding ? [entry.binding] : [])) : new Set<string>();
    const retained = new Set<string>(), diagnostics = new Set<string>();
    for (const { entityId, model, binding, deviceType, visible } of entries) {
      const config = model.telemetryBinding?.rgvMotionArrows;
      if (!config || deviceType !== 'rgv') continue;
      diagnostics.add(entityId);
      const ready = !!model.assetHandle && model.stackerTelemetryReady && !model.root.isDisposed();
      const snapshot = binding ? resolveSpecializedTelemetrySnapshot(deviceTelemetryStore, binding) : null;
      const motion = getRgvMotionFrame(model);
      const invalid = !ready ? '等待 RGV 模型准备完成' : !running ? null : !binding ? '设备绑定无效，箭头隐藏'
        : conflicts.has(binding.key) ? '设备绑定冲突，箭头隐藏' : !snapshot ? '等待设备 MQTT 数据，箭头隐藏'
        : now - snapshot.receivedAt > binding.staleAfterMs ? '设备数据过期，箭头隐藏' : snapshot.faulted ? '设备故障/急停，箭头隐藏'
        : !motion || motion.frameId !== frameId ? '本帧没有有效运动结果，箭头隐藏' : null;
      for (const channel of RGV_MOTION_ARROW_CHANNELS) {
        if (!config.enabled || !config.channels[channel].enabled) {
          rgvMotionArrowSession.setDiagnostic(entityId, channel, '运动箭头未启用');
          continue;
        }
        if (!ready) { rgvMotionArrowSession.setDiagnostic(entityId, channel, invalid!); continue; }
        retained.add(rgvMotionArrowKey(entityId, channel));
        const preview = running ? null : rgvMotionArrowSession.getPreview(entityId, channel);
        const direction = invalid ? 0 : running ? motion![channel].direction : preview ?? 0;
        const message = invalid ?? (!visible ? '模型隐藏，箭头隐藏' : running
          ? direction ? '运行：沿运动轴' + (direction > 0 ? '正向' : '反向') : '已到位、停止或无有效交接方向'
          : preview === null ? '编辑状态：可预览正向、反向和停止' : '编辑预览：' + (preview > 0 ? '正向' : preview < 0 ? '反向' : '停止') + '（模拟状态）');
        const issue = this.renderer.update(entityId, model, config, channel, direction, deltaSeconds,
          visible && !invalid && (running || preview !== null));
        rgvMotionArrowSession.setDiagnostic(entityId, channel, issue ? message + '；' + issue : message);
      }
    }
    this.renderer.retain(retained);
    for (const id of this.diagnosticIds) if (!diagnostics.has(id)) rgvMotionArrowSession.remove(id);
    this.diagnosticIds = diagnostics;
  }

  clear(): void {
    this.renderer.clear();
    for (const id of this.diagnosticIds) rgvMotionArrowSession.remove(id);
    this.diagnosticIds.clear();
  }
  dispose(): void { this.clear(); this.renderer.dispose(); }
}
