export const DEFAULT_MODEL_LENGTH_UNIT_INFO = {
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
};
const MODEL_LENGTH_UNIT_ALIASES = {
    meter: DEFAULT_MODEL_LENGTH_UNIT_INFO,
    m: DEFAULT_MODEL_LENGTH_UNIT_INFO,
    centimeter: { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 },
    cm: { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 },
    millimeter: { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 },
    mm: { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 },
};
export function normalizeModelLengthUnit(value) {
    if (value === undefined)
        return DEFAULT_MODEL_LENGTH_UNIT_INFO;
    if (typeof value !== 'string')
        return null;
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue)
        return DEFAULT_MODEL_LENGTH_UNIT_INFO;
    return MODEL_LENGTH_UNIT_ALIASES[normalizedValue] ?? null;
}
export function isValidModelUnitScaleToMeters(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
