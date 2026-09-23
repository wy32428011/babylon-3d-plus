import { readNumberField, type DeviceTelemetryFields } from '../../mqtt/deviceTelemetry';

export type ConveyorMotionMapping = { fields: readonly string[]; actionMap: Readonly<Record<string, number>> };

/** 货物与表面箭头共用原有字段优先级及正负数兼容规则；倍率原样交给货物驱动。 */
export function readConveyorMotionSignal(fields: DeviceTelemetryFields, config: ConveyorMotionMapping): {
  field: string | null; value: number | null; direction: number;
} {
  for (const field of config.fields) {
    const value = readNumberField(fields, field);
    if (value === null) continue;
    const mapped = config.actionMap[String(Math.trunc(value))];
    const direction = Number.isFinite(mapped) ? mapped : value === 2 ? -1 : Math.sign(value);
    return { field, value, direction };
  }
  return { field: null, value: null, direction: 0 };
}

/** 正向是模型本地轴；轴错配沿用货物驱动的 +1 回退，避免改变旧场景。 */
export function resolveConveyorTrajectoryForwardSign(direction: string | undefined, axis: 'x' | 'z'): 1 | -1 {
  const configured = direction ?? 'x';
  const negative = configured.startsWith('-');
  return (negative ? configured.slice(1) : configured) === axis && negative ? -1 : 1;
}
