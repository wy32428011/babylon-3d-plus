import type { ModelSourceLengthUnit } from './types.js';

export type ModelLengthUnitInfo = {
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
};

export const DEFAULT_MODEL_LENGTH_UNIT_INFO: ModelLengthUnitInfo = {
  lengthUnit: 'meter',
  unitScaleToMeters: 1,
};

/** 新导入的环境模型在缺失显式元数据时默认按厘米解释，普通模型仍保持米制默认值。 */
export const DEFAULT_ENVIRONMENT_MODEL_LENGTH_UNIT_INFO: ModelLengthUnitInfo = {
  lengthUnit: 'centimeter',
  unitScaleToMeters: 0.01,
};

const MODEL_LENGTH_UNIT_ALIASES: Record<string, ModelLengthUnitInfo> = {
  meter: DEFAULT_MODEL_LENGTH_UNIT_INFO,
  m: DEFAULT_MODEL_LENGTH_UNIT_INFO,
  centimeter: DEFAULT_ENVIRONMENT_MODEL_LENGTH_UNIT_INFO,
  cm: DEFAULT_ENVIRONMENT_MODEL_LENGTH_UNIT_INFO,
  millimeter: { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 },
  mm: { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 },
};

export function normalizeModelLengthUnit(value: unknown): ModelLengthUnitInfo | null {
  if (value === undefined) return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (typeof value !== 'string') return null;

  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) return DEFAULT_MODEL_LENGTH_UNIT_INFO;

  return MODEL_LENGTH_UNIT_ALIASES[normalizedValue] ?? null;
}

export function isValidModelUnitScaleToMeters(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
