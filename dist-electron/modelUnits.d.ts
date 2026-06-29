import type { ModelSourceLengthUnit } from './types.js';
export type ModelLengthUnitInfo = {
    lengthUnit: ModelSourceLengthUnit;
    unitScaleToMeters: number;
};
export declare const DEFAULT_MODEL_LENGTH_UNIT_INFO: ModelLengthUnitInfo;
export declare function normalizeModelLengthUnit(value: unknown): ModelLengthUnitInfo | null;
export declare function isValidModelUnitScaleToMeters(value: unknown): value is number;
