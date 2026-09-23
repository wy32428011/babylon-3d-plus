import type { DeviceTelemetrySnapshot } from '../../mqtt/deviceTelemetry';
import type { ResolvedSpecializedTelemetryBinding } from './specializedTelemetryBinding';
import { readConveyorMotionSignal, resolveConveyorTrajectoryForwardSign, type ConveyorMotionMapping } from './conveyorMotionSignal';

export type ConveyorSurfaceArrowState = {
  status: 'running' | 'stopped' | 'waiting' | 'unbound' | 'conflict' | 'faulted' | 'stale' | 'missing';
  direction: 1 | -1 | 0;
  message: string;
};

/** 箭头反映新鲜遥测，不使用货物的自驱续行或任务 mode 推断线体运动。 */
export function resolveConveyorSurfaceArrowState(input: {
  binding: ResolvedSpecializedTelemetryBinding | null;
  snapshot: DeviceTelemetrySnapshot | null;
  config: ConveyorMotionMapping & { axis: 'x' | 'z' };
  trajectoryDirection?: string;
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
  const motion = readConveyorMotionSignal(snapshot.fields, config);
  if (motion.field === null || snapshot.fields[motion.field] == null || snapshot.fields[motion.field] === '') {
    return hidden('missing', `方向字段缺失或无效：${config.fields.join(' / ')}`);
  }
  const direction = Math.sign(motion.direction) * resolveConveyorTrajectoryForwardSign(input.trajectoryDirection, config.axis) as 1 | -1 | 0;
  const field = `${motion.field}=${motion.value}`;
  return direction === 0 ? hidden('stopped', `${field}，设备停止，箭头隐藏`)
    : { status: 'running', direction, message: `${binding.sourceId} / ${binding.assetCode} · ${field} · ${direction > 0 ? '沿轴正向' : '沿轴反向'}` };
}
