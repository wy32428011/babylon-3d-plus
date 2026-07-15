import type { CadReferenceUnitDetection } from '../model/components';

/** CAD 无法识别源单位时采用的工业图纸兼容值：1 图纸单位按 1 毫米解释。 */
export const CAD_REFERENCE_FALLBACK_UNIT_SCALE_TO_METERS = 0.001;

/** CAD 单位解析结果，所有长度最终都通过 unitScaleToMeters 转换为米。 */
export type CadReferenceUnitInfo = {
  sourceUnitCode: number | null;
  sourceUnitName: string;
  unitScaleToMeters: number;
  unitDetection: CadReferenceUnitDetection;
};

type DxfInsUnitsDefinition = {
  name: string;
  scaleToMeters: number;
};

/** AutoCAD DXF `$INSUNITS` 1–24 的完整米制换算表；0 表示未指定单位。 */
const DXF_INSUNITS_TO_METERS: Readonly<Record<number, DxfInsUnitsDefinition>> = {
  1: { name: 'inch', scaleToMeters: 0.0254 },
  2: { name: 'foot', scaleToMeters: 0.3048 },
  3: { name: 'mile', scaleToMeters: 1609.344 },
  4: { name: 'millimeter', scaleToMeters: 0.001 },
  5: { name: 'centimeter', scaleToMeters: 0.01 },
  6: { name: 'meter', scaleToMeters: 1 },
  7: { name: 'kilometer', scaleToMeters: 1000 },
  8: { name: 'microinch', scaleToMeters: 0.0000000254 },
  9: { name: 'mil', scaleToMeters: 0.0000254 },
  10: { name: 'yard', scaleToMeters: 0.9144 },
  11: { name: 'angstrom', scaleToMeters: 1e-10 },
  12: { name: 'nanometer', scaleToMeters: 1e-9 },
  13: { name: 'micrometer', scaleToMeters: 1e-6 },
  14: { name: 'decimeter', scaleToMeters: 0.1 },
  15: { name: 'decameter', scaleToMeters: 10 },
  16: { name: 'hectometer', scaleToMeters: 100 },
  17: { name: 'gigameter', scaleToMeters: 1e9 },
  18: { name: 'astronomical-unit', scaleToMeters: 149_597_870_700 },
  19: { name: 'light-year', scaleToMeters: 9_460_730_472_580_800 },
  20: { name: 'parsec', scaleToMeters: 30_856_775_814_913_673 },
  21: { name: 'us-survey-foot', scaleToMeters: 1200 / 3937 },
  22: { name: 'us-survey-inch', scaleToMeters: 100 / 3937 },
  23: { name: 'us-survey-yard', scaleToMeters: 3600 / 3937 },
  24: { name: 'us-survey-mile', scaleToMeters: 6_336_000 / 3937 },
};

/** 从 DXF HEADER 解析源单位；无单位时参考 `$MEASUREMENT`，最终明确回退为毫米。 */
export function resolveDxfUnitInfo(header: unknown): CadReferenceUnitInfo {
  const insUnits = readHeaderNumber(header, '$INSUNITS') ?? readHeaderNumber(header, 'INSUNITS');
  const normalizedInsUnits = Number.isInteger(insUnits) ? insUnits : null;
  const definition = normalizedInsUnits === null ? undefined : DXF_INSUNITS_TO_METERS[normalizedInsUnits];

  if (definition) {
    return {
      sourceUnitCode: normalizedInsUnits,
      sourceUnitName: definition.name,
      unitScaleToMeters: definition.scaleToMeters,
      unitDetection: 'insunits',
    };
  }

  const measurement = readHeaderNumber(header, '$MEASUREMENT') ?? readHeaderNumber(header, 'MEASUREMENT');
  if (measurement === 0) {
    return {
      sourceUnitCode: normalizedInsUnits === 0 ? 0 : null,
      sourceUnitName: 'inch',
      unitScaleToMeters: DXF_INSUNITS_TO_METERS[1].scaleToMeters,
      unitDetection: 'measurement',
    };
  }
  if (measurement === 1) {
    return {
      sourceUnitCode: normalizedInsUnits === 0 ? 0 : null,
      sourceUnitName: 'millimeter',
      unitScaleToMeters: DXF_INSUNITS_TO_METERS[4].scaleToMeters,
      unitDetection: 'measurement',
    };
  }

  return {
    sourceUnitCode: null,
    sourceUnitName: 'millimeter',
    unitScaleToMeters: CAD_REFERENCE_FALLBACK_UNIT_SCALE_TO_METERS,
    unitDetection: 'fallback',
  };
}

/** 为旧场景 CAD 组件补充审计元数据，不改变其已经持久化的换算系数。 */
export function createLegacyCadReferenceUnitInfo(unitScaleToMeters: number): CadReferenceUnitInfo {
  return {
    sourceUnitCode: null,
    sourceUnitName: 'legacy',
    unitScaleToMeters,
    unitDetection: 'legacy',
  };
}

/** 严格校验场景文件中的 CAD 单位审计字段，防止代码、名称和换算系数互相矛盾。 */
export function normalizeCadReferenceUnitInfo(
  sourceUnitCode: unknown,
  sourceUnitName: unknown,
  unitDetection: unknown,
  unitScaleToMeters: number,
): CadReferenceUnitInfo {
  if (!Number.isFinite(unitScaleToMeters) || unitScaleToMeters <= 0) {
    throw new Error('CAD 单位换算系数无效。');
  }
  if (unitDetection !== 'insunits' && unitDetection !== 'measurement' && unitDetection !== 'fallback' && unitDetection !== 'legacy') {
    throw new Error('CAD 单位判定来源无效。');
  }
  if (typeof sourceUnitName !== 'string' || !sourceUnitName.trim()) {
    throw new Error('CAD 源单位名称无效。');
  }

  const normalizedName = sourceUnitName.trim();
  if (sourceUnitCode !== null && (typeof sourceUnitCode !== 'number' || !Number.isInteger(sourceUnitCode))) {
    throw new Error('CAD 源单位代码无效。');
  }
  const normalizedCode = sourceUnitCode;

  if (unitDetection === 'legacy') {
    if (normalizedCode !== null || normalizedName !== 'legacy') throw new Error('CAD 旧场景单位元数据无效。');
    return createLegacyCadReferenceUnitInfo(unitScaleToMeters);
  }

  if (unitDetection === 'fallback') {
    if (normalizedCode !== null || normalizedName !== 'millimeter' || !areUnitScalesEqual(unitScaleToMeters, CAD_REFERENCE_FALLBACK_UNIT_SCALE_TO_METERS)) {
      throw new Error('CAD fallback 单位元数据无效。');
    }
    return {
      sourceUnitCode: null,
      sourceUnitName: 'millimeter',
      unitScaleToMeters: CAD_REFERENCE_FALLBACK_UNIT_SCALE_TO_METERS,
      unitDetection: 'fallback',
    };
  }

  if (unitDetection === 'measurement') {
    const expectedScale = normalizedName === 'inch'
      ? DXF_INSUNITS_TO_METERS[1].scaleToMeters
      : normalizedName === 'millimeter'
        ? DXF_INSUNITS_TO_METERS[4].scaleToMeters
        : null;
    if ((normalizedCode !== null && normalizedCode !== 0) || expectedScale === null || !areUnitScalesEqual(unitScaleToMeters, expectedScale)) {
      throw new Error('CAD MEASUREMENT 单位元数据无效。');
    }
    return {
      sourceUnitCode: normalizedCode,
      sourceUnitName: normalizedName,
      unitScaleToMeters: expectedScale,
      unitDetection: 'measurement',
    };
  }

  const definition = normalizedCode === null ? undefined : DXF_INSUNITS_TO_METERS[normalizedCode];
  if (!definition || definition.name !== normalizedName || !areUnitScalesEqual(unitScaleToMeters, definition.scaleToMeters)) {
    throw new Error('CAD INSUNITS 单位元数据无效。');
  }

  return {
    sourceUnitCode: normalizedCode,
    sourceUnitName: definition.name,
    unitScaleToMeters: definition.scaleToMeters,
    unitDetection: 'insunits',
  };
}

/** 生成人类可读的 CAD 源单位说明，供 Inspector 和导入日志复用。 */
export function formatCadReferenceUnitSummary(info: Pick<CadReferenceUnitInfo, 'sourceUnitCode' | 'sourceUnitName' | 'unitScaleToMeters' | 'unitDetection'>): string {
  if (info.unitDetection === 'legacy') {
    return `旧场景单位元数据 → m（×${formatUnitScale(info.unitScaleToMeters)}）`;
  }
  if (info.unitDetection === 'fallback') {
    return `未声明单位，按 millimeter 兜底 → m（×${formatUnitScale(info.unitScaleToMeters)}）`;
  }
  if (info.unitDetection === 'measurement') {
    return `${info.sourceUnitName}（$MEASUREMENT 推断）→ m（×${formatUnitScale(info.unitScaleToMeters)}）`;
  }

  return `${info.sourceUnitName}（$INSUNITS=${info.sourceUnitCode}）→ m（×${formatUnitScale(info.unitScaleToMeters)}）`;
}

/** 从 DXF header 兼容读取不同解析器可能输出的字段名。 */
function readHeaderNumber(header: unknown, key: string): number | null {
  if (!isRecord(header)) return null;

  const directValue = header[key];
  if (typeof directValue === 'number' && Number.isFinite(directValue)) return directValue;

  const normalizedKey = key.replace(/^\$/, '').toLowerCase();
  for (const [entryKey, value] of Object.entries(header)) {
    if (entryKey.replace(/^\$/, '').toLowerCase() !== normalizedKey) continue;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }

  return null;
}

/** 判断未知值是否为可安全读取的记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 使用相对误差比较单位系数，兼容 survey 单位等除法常量的浮点表示。 */
function areUnitScalesEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-12);
}

/** 把极大/极小换算系数格式化为简洁字符串。 */
function formatUnitScale(value: number): string {
  if (value !== 0 && (Math.abs(value) >= 1e9 || Math.abs(value) < 1e-6)) return value.toExponential(6);
  return String(Number(value.toPrecision(12)));
}
