export type OpeningPhase = 'playing' | 'globe' | 'unfold' | 'routes' | 'china' | 'jiangsu-highlight' | 'china-routes' | 'jiangsu' | 'wuxi' | 'huishan' | 'handoff' | 'complete';
export type OpeningSnapshot = {
  phase: OpeningPhase;
  label: string;
  progress: number;
  elapsedSeconds: number;
  totalDurationSeconds: number;
  chinaHoldElapsedSeconds: number;
  chinaHoldProgress: number;
  isPaused: boolean;
};
export type GeographicPoint = [number, number, number];
const RAD = Math.PI / 180;
// 亚洲居中的展示投影：欧洲位于中国左侧，美洲位于右侧；所有图层与飞线共用该经度。
export const MAP_CENTER_LONGITUDE = 150;
export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const smooth = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };

/** 同一经纬网在球面与平面之间连续展开；切缝避开中国及主要飞线出发区域。 */
export function projectGeographicPoint(longitude: number, latitude: number, unfold: number, rotation = 0): GeographicPoint {
  const longitudeDelta = ((longitude - MAP_CENTER_LONGITUDE + 540) % 360 - 180) * RAD;
  const phi = latitude * RAD;
  const mix = clamp01(unfold);
  const theta = longitudeDelta + rotation;
  return [
    Math.cos(phi) * Math.sin(theta) * (1 - mix) + longitudeDelta * mix,
    Math.sin(phi) * (1 - mix) + phi * mix,
    mix === 1 ? 0 : -Math.cos(phi) * Math.cos(theta) * (1 - mix),
  ];
}

export function getRoutePoint(origin: [number, number], destination: [number, number], fraction: number): GeographicPoint {
  const a = projectGeographicPoint(...origin, 1, 0);
  const b = projectGeographicPoint(...destination, 1, 0);
  const t = clamp01(fraction);
  if (t === 0) return a;
  if (t === 1) return b;
  const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + Math.sin(Math.PI * t) * distance * 0.13,
    -Math.sin(Math.PI * t) * Math.min(0.72, distance * 0.23)];
}

const STAGES: [number, OpeningPhase, string][] = [
  [3, 'globe', '连接世界 · 数字启航'], [5, 'unfold', '展开全球视野'],
  [8, 'routes', '立足中国 · 链接全球'], [10, 'china', '中国'],
  [12, 'jiangsu', '江苏省'], [14, 'wuxi', '无锡市'],
  [16, 'huishan', '惠山区'], [18, 'handoff', '进入数字孪生'],
];

/** 中国完整构图的停留独立采用实际秒；基础镜头轴仍为 0..18，停留期间固定在 10。 */
export function getOpeningFrame(elapsedSeconds: number, durationSeconds: number, chinaHoldSeconds = 0) {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 18;
  const hold = Number.isFinite(chinaHoldSeconds) && chinaHoldSeconds >= 0 ? chinaHoldSeconds : 0;
  const totalDurationSeconds = duration + hold;
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const progress = clamp01(elapsed / totalDurationSeconds);
  const clippedElapsed = Math.min(elapsed,totalDurationSeconds);
  const chinaHoldStartSeconds = duration * 10 / 18;
  const chinaHoldElapsedSeconds = Math.min(hold,Math.max(0,clippedElapsed-chinaHoldStartSeconds));
  const isChinaHolding = hold > 0 && clippedElapsed >= chinaHoldStartSeconds && clippedElapsed < chinaHoldStartSeconds + hold;
  const time = progress === 1 ? 18 : isChinaHolding ? 10 : clamp01((clippedElapsed-chinaHoldElapsedSeconds)/duration)*18;
  const stage = STAGES.find(([end]) => time < end);
  return {
    phase: isChinaHolding ? 'china-routes' as OpeningPhase : stage?.[1] ?? 'complete' as OpeningPhase,
    label: isChinaHolding ? '中国业务网络' : stage?.[2] ?? '场景已就绪', progress,
    elapsedSeconds: clippedElapsed, isPaused: false,
    baseDurationSeconds: duration, totalDurationSeconds, chinaHoldSeconds: hold,
    chinaHoldElapsedSeconds, chinaHoldProgress: hold > 0 ? chinaHoldElapsedSeconds / hold : 0,
    time, unfold: smooth((time - 3) / 2),
    rotation: (MAP_CENTER_LONGITUDE - 120) * RAD - 0.65 + smooth(time / 3) * 0.65,
    opacity: 1 - smooth((time - 16) / 2),
  };
}
