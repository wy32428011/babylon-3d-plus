import type { OpeningPackageStage, OpeningPoint, OpeningRoute, OpeningScalar } from '../../shared/opening/openingPackage.ts';
import type { OpeningSnapshot } from './geographicOpeningMath.ts';

export type OpeningTimelineFrame = OpeningSnapshot & {
  stageId: string; stageIndex: number; stageElapsedSeconds: number; stageProgress: number; opacity: number;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** 分镜只依赖包声明的顺序和实际秒数，零秒段不占播放时间。 */
export function getPackageTimelineFrame(seconds: number, stages: readonly OpeningPackageStage[], handoffSeconds = .8): OpeningTimelineFrame {
  const total = stages.reduce((sum, stage) => sum + stage.durationSeconds, 0);
  const elapsed = clamp(Number.isFinite(seconds) ? seconds : 0, 0, total);
  let start = 0;
  let index = 0;
  for (let i = stages.length - 1; i >= 0; i--) if (stages[i].durationSeconds > 0) { index = i; break; }
  for (let i = 0; i < stages.length; i++) {
    if (elapsed < start + stages[i].durationSeconds) { index = i; break; }
    if (i < stages.length - 1) start += stages[i].durationSeconds;
  }
  start = stages.slice(0, index).reduce((sum, stage) => sum + stage.durationSeconds, 0);
  const stage = stages[index];
  const duration = stage?.durationSeconds ?? 0;
  const stageElapsedSeconds = clamp(elapsed - start, 0, duration);
  const fadeDuration = Math.min(total, Math.max(0, handoffSeconds));
  const fade = fadeDuration > 0 ? clamp((elapsed - total + fadeDuration) / fadeDuration, 0, 1) : elapsed >= total ? 1 : 0;
  return {
    phase: elapsed >= total ? 'complete' : fade > 0 ? 'handoff' : 'playing',
    label: elapsed >= total ? '场景已就绪' : fade > 0 ? '进入数字孪生' : stage?.label ?? '开场动画',
    stageId: stage?.id ?? '', stageIndex: index, stageElapsedSeconds,
    stageProgress: duration > 0 ? stageElapsedSeconds / duration : 1,
    elapsedSeconds: elapsed, totalDurationSeconds: total, progress: total > 0 ? elapsed / total : 1,
    isPaused: false, chinaHoldElapsedSeconds: 0, chinaHoldProgress: 0,
    opacity: 1 - fade * fade * (3 - 2 * fade),
  };
}

/** 参数引用只读取值，不修改包默认值或其它场景的实例。 */
export function resolveOpeningStage(stage: OpeningPackageStage, values: Record<string, OpeningScalar>): OpeningPackageStage {
  const result = { ...stage };
  for (const [property, key] of [['title', 'titleKey'], ['subtitle', 'subtitleKey'], ['description', 'descriptionKey'],
    ['backgroundAssetId', 'backgroundKey'], ['logoAssetId', 'logoKey']] as const) {
    const source = stage[key];
    if (source && typeof values[source] === 'string') result[property] = values[source] as string;
  }
  return result;
}

export function getOpeningRoutePoint(route: Pick<OpeningRoute, 'from' | 'to' | 'curvature'>, fraction: number): OpeningPoint {
  const t = clamp(fraction, 0, 1), q = 1 - t;
  const distance = Math.hypot(route.to.x - route.from.x, route.to.y - route.from.y);
  const controlX = (route.from.x + route.to.x) / 2;
  const controlY = (route.from.y + route.to.y) / 2 - (route.curvature ?? .2) * distance;
  return { x: q * q * route.from.x + 2 * q * t * controlX + t * t * route.to.x,
    y: q * q * route.from.y + 2 * q * t * controlY + t * t * route.to.y };
}
