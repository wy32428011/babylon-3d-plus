export const SCENE_LENGTH_UNIT = 'meter';
export const SCENE_LENGTH_UNIT_SYMBOL = 'm';
export const SCENE_LENGTH_UNIT_LABEL = '米';

export type SceneLengthUnit = typeof SCENE_LENGTH_UNIT;

export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';

export type ModelLengthUnitInfo = {
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
};

export const DEFAULT_MODEL_LENGTH_UNIT_INFO: ModelLengthUnitInfo = {
  lengthUnit: 'meter',
  unitScaleToMeters: 1,
};

const MODEL_LENGTH_UNIT_LABELS: Record<ModelSourceLengthUnit, string> = {
  meter: 'meter',
  centimeter: 'centimeter',
  millimeter: 'millimeter',
};

const MODEL_UNIT_SCALE_TO_METERS: Record<ModelSourceLengthUnit, number> = {
  meter: 1,
  centimeter: 0.01,
  millimeter: 0.001,
};

export function normalizeModelLengthUnitInfo(lengthUnit: unknown, unitScaleToMeters: unknown): ModelLengthUnitInfo {
  if (lengthUnit === undefined && unitScaleToMeters === undefined) return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (lengthUnit !== 'meter' && lengthUnit !== 'centimeter' && lengthUnit !== 'millimeter') {
    throw new Error('模型单位不受支持。');
  }

  const expectedScale = MODEL_UNIT_SCALE_TO_METERS[lengthUnit];
  if (unitScaleToMeters !== expectedScale) {
    throw new Error('模型单位换算系数不匹配。');
  }

  return { lengthUnit, unitScaleToMeters: expectedScale };
}

export function formatModelLengthUnit(lengthUnit: ModelSourceLengthUnit): string {
  return MODEL_LENGTH_UNIT_LABELS[lengthUnit];
}
