export type TelemetryPerformanceStages = {
  candidatesMs: number;
  contextMs: number;
  driverMs: number;
  arrayRefreshMs: number;
  externalCargoMs: number;
  diagnosticsMs: number;
  baselineMs: number;
  alarmsMs: number;
};

export function createTelemetryPerformanceStages(): TelemetryPerformanceStages {
  return { candidatesMs: 0, contextMs: 0, driverMs: 0, arrayRefreshMs: 0, externalCargoMs: 0,
    diagnosticsMs: 0, baselineMs: 0, alarmsMs: 0 };
}

/** 只复制固定的数值字段，性能报告不携带模型、遥测点位或任意附加属性。 */
export function copyTelemetryPerformanceStages(value: TelemetryPerformanceStages): TelemetryPerformanceStages {
  const result = createTelemetryPerformanceStages();
  for (const key of Object.keys(result) as Array<keyof TelemetryPerformanceStages>) {
    const metric = value[key];
    result[key] = typeof metric === 'number' && Number.isFinite(metric) && metric >= 0 ? metric : 0;
  }
  return result;
}
