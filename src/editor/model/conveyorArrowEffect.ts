import type { ConveyorArrowEffectConfig, ConveyorArrowEffectKind } from './components';

export const CONVEYOR_ARROW_EFFECT_KINDS = [
  'conveyor-arrow-single', 'conveyor-arrow-chevron', 'conveyor-arrow-segmented',
  'conveyor-arrow-ribbon', 'conveyor-arrow-double', 'conveyor-arrow-speed',
] as const satisfies readonly ConveyorArrowEffectKind[];

export function isConveyorArrowEffectKind(value: unknown): value is ConveyorArrowEffectKind {
  return typeof value === 'string' && (CONVEYOR_ARROW_EFFECT_KINDS as readonly string[]).includes(value);
}

export function createDefaultConveyorArrowEffect(kind?: string): ConveyorArrowEffectConfig {
  return { length: 6, width: kind === 'conveyor-arrow-double' ? 2 : kind === 'conveyor-arrow-ribbon' ? 1.8 : 1.4,
    opacity: 0.9, count: 5, reverse: false };
}

export function sanitizeConveyorArrowEffect(value: unknown, kind?: string): ConveyorArrowEffectConfig {
  const defaults = createDefaultConveyorArrowEffect(kind);
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (key: 'length' | 'width' | 'opacity' | 'count', min: number, max: number) => {
    const input = raw[key];
    return typeof input === 'number' && Number.isFinite(input) ? Math.min(max, Math.max(min, input)) : defaults[key];
  };
  return { length: number('length', 0.1, 10000), width: number('width', 0.1, 10000),
    opacity: number('opacity', 0, 1), count: Math.round(number('count', 1, 32)),
    reverse: typeof raw.reverse === 'boolean' ? raw.reverse : defaults.reverse };
}
