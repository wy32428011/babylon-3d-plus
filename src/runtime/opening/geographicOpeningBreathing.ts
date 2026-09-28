export type OpeningBreathingSettings = {
  breathingEnabled: boolean;
  breathingIntensity: number;
  breathingPeriodSeconds: number;
};

export function normalizeOpeningBreathingPeriod(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(10,Math.max(2,value)) : 4;
}

/** 返回以 1 为基线的柔和增益；真实秒与确定性相位保证停留、暂停及寻帧共用一个时钟。 */
export function readOpeningBreathing(elapsedSeconds: number, settings: OpeningBreathingSettings,
  dynamicEnabled = true, phaseOffset = 0): number {
  if (!settings.breathingEnabled || !dynamicEnabled) return 1;
  const intensity = Number.isFinite(settings.breathingIntensity) ? Math.min(1,Math.max(0,settings.breathingIntensity)) : 0;
  if (intensity === 0) return 1;
  const period = normalizeOpeningBreathingPeriod(settings.breathingPeriodSeconds);
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0,elapsedSeconds) : 0;
  const phase = Number.isFinite(phaseOffset) ? phaseOffset % 1 : 0;
  return 1 + Math.sin(Math.PI * 2 * (elapsed % period / period + phase)) * .35 * intensity;
}

/** 扫描起止均置于 UV 外，循环复位时不会在地图内部突然跳线。 */
export function readOpeningScanPosition(elapsedSeconds: number, periodSeconds: number): number {
  const period = normalizeOpeningBreathingPeriod(periodSeconds);
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0,elapsedSeconds) : 0;
  return -.15 + elapsed % period / period * 1.3;
}
