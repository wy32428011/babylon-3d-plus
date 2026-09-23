import type { DeviceTelemetrySnapshot } from '../../mqtt/deviceTelemetry';
import type { ResolvedSpecializedTelemetryBinding } from './specializedTelemetryBinding';
import { readConveyorMotionSignal, resolveConveyorTrajectoryForwardSign, type ConveyorMotionMapping } from './conveyorMotionSignal';
import { getConveyorSurfaceArrowDirectionError, type ConveyorSurfaceArrowDirectionBinding } from '../../../editor/model/conveyorSurfaceArrows';

export type ConveyorSurfaceArrowState = {
  status: 'running' | 'stopped' | 'waiting' | 'unbound' | 'conflict' | 'faulted' | 'stale' | 'missing' | 'invalid' | 'unmatched';
  direction: 1 | -1 | 0;
  message: string;
};

/** 箭头反映新鲜遥测，不使用货物的自驱续行或任务 mode 推断线体运动。 */
export function resolveConveyorSurfaceArrowState(input: {
  binding: ResolvedSpecializedTelemetryBinding | null;
  snapshot: DeviceTelemetrySnapshot | null;
  config: ConveyorMotionMapping & { axis: 'x' | 'z' };
  trajectoryDirection?: string;
  directionBinding?: ConveyorSurfaceArrowDirectionBinding;
  now: number;
  conflict: boolean;
}): ConveyorSurfaceArrowState {
  const hidden = (status: ConveyorSurfaceArrowState['status'], message: string): ConveyorSurfaceArrowState => ({ status, direction: 0, message });
  const { binding, snapshot, config } = input;
  if (!binding) return hidden('unbound', '绑定无效或已禁用，箭头隐藏');
  if (input.conflict) return hidden('conflict', '设备绑定冲突，箭头隐藏');
  if (!snapshot) return hidden('waiting', '等待设备 MQTT 数据，箭头隐藏');
  if (input.now - snapshot.receivedAt > binding.staleAfterMs) return hidden('stale', '设备数据过期，箭头隐藏');
  if (snapshot.faulted) return hidden('faulted', '设备故障，箭头隐藏');
  const custom = input.directionBinding;
  if (custom?.mode === 'point') {
    const issue = getConveyorSurfaceArrowDirectionError(custom);
    if (issue) return hidden('invalid', issue);
    const rawValue = Object.hasOwn(snapshot.fields, custom.field) ? snapshot.fields[custom.field] : undefined;
    if (rawValue == null || !['string', 'number', 'boolean'].includes(typeof rawValue)
      || (typeof rawValue === 'number' && !Number.isFinite(rawValue))) return hidden('missing', `点位缺失或无效：${custom.field}`);
    const value = String(rawValue);
    const signal = value === custom.forwardValue ? 1 : value === custom.reverseValue ? -1 : value === custom.stopValue ? 0 : null;
    const field = `${custom.field}=${value}`;
    if (signal === null) return hidden('unmatched', `${field}，未命中正向、反向或停止值，箭头隐藏`);
    if (signal === 0) return hidden('stopped', `${field}，设备停止，箭头隐藏`);
    const direction = signal * resolveConveyorTrajectoryForwardSign(input.trajectoryDirection, config.axis) as 1 | -1;
    return { status: 'running', direction, message: `${binding.sourceId} / ${binding.assetCode} · ${field} · ${direction > 0 ? '沿轴正向' : '沿轴反向'}` };
  }
  const motion = readConveyorMotionSignal(snapshot.fields, config);
  if (motion.field === null || snapshot.fields[motion.field] == null || snapshot.fields[motion.field] === '') {
    return hidden('missing', `方向字段缺失或无效：${config.fields.join(' / ')}`);
  }
  const direction = Math.sign(motion.direction) * resolveConveyorTrajectoryForwardSign(input.trajectoryDirection, config.axis) as 1 | -1 | 0;
  const field = `${motion.field}=${motion.value}`;
  return direction === 0 ? hidden('stopped', `${field}，设备停止，箭头隐藏`)
    : { status: 'running', direction, message: `${binding.sourceId} / ${binding.assetCode} · ${field} · ${direction > 0 ? '沿轴正向' : '沿轴反向'}` };
}
