import type { SceneOpeningReferenceSettings } from '../../editor/model/sceneOpeningReference';
import type { OpeningPhase, OpeningSnapshot } from './geographicOpeningMath';
import { REFERENCE_STAGES, REFERENCE_DURATION_SECONDS } from './reference/referenceStages.ts';

const PHASES: OpeningPhase[] = ['globe', 'unfold', 'routes', 'china', 'jiangsu-highlight', 'china-routes', 'jiangsu', 'wuxi', 'huishan'];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function getReferenceStageStart(index: number, settings: SceneOpeningReferenceSettings): number {
  return settings.stageDurations.slice(0, clamp(Math.trunc(index), 0, 9)).reduce((sum, value) => sum + value, 0);
}

/** 可调实际时长映射回用户 HTML 的镜头轴；UV 和镜头路径不因调速而改变。 */
export function getReferenceOpeningFrame(seconds: number, settings: SceneOpeningReferenceSettings): OpeningSnapshot & {
  referenceSeconds: number; stageIndex: number; opacity: number;
} {
  const total = getReferenceStageStart(9, settings);
  const elapsed = clamp(Number.isFinite(seconds) ? seconds : 0, 0, total);
  let start = 0;
  let index = 8;
  for (let i = 0; i < 9; i++) {
    if (elapsed < start + settings.stageDurations[i]) { index = i; break; }
    if (i < 8) start += settings.stageDurations[i];
  }
  const stage = REFERENCE_STAGES[index];
  const stageProgress = settings.stageDurations[index] > 0 ? clamp((elapsed - start) / settings.stageDurations[index], 0, 1) : 1;
  // 原 HTML 的推进跨越章节边界；零秒业务段仍需从完整父图开始推进，不能跳到转场中间。
  const referenceStart = index === 3 && settings.stageDurations[2] === 0 ? 22.8
    : index === 6 && settings.stageDurations[5] === 0 ? 40.2 : stage.start;
  const referenceSeconds = elapsed >= total ? REFERENCE_DURATION_SECONDS : referenceStart + stageProgress * (stage.end - referenceStart);
  // 最后短淡出直接显露同一业务 canvas；不先落到黑色中间页。
  const fadeSeconds = Math.min(.8, settings.stageDurations[8] * .25);
  const fadeProgress = fadeSeconds > 0 ? clamp((elapsed - total + fadeSeconds) / fadeSeconds, 0, 1) : 1;
  const opacity = 1 - fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
  const chinaHoldStart = getReferenceStageStart(5, settings);
  const chinaHoldElapsedSeconds = clamp(elapsed - chinaHoldStart, 0, settings.stageDurations[5]);
  return {
    phase: elapsed >= total ? 'complete' : fadeProgress > 0 ? 'handoff' : PHASES[index],
    label: elapsed >= total ? '场景已就绪' : fadeProgress > 0 ? '进入数字孪生' : stage.label,
    progress: total > 0 ? elapsed / total : 1,
    elapsedSeconds: elapsed, totalDurationSeconds: total, isPaused: false,
    chinaHoldElapsedSeconds,
    chinaHoldProgress: settings.stageDurations[5] > 0 ? chinaHoldElapsedSeconds / settings.stageDurations[5] : 0,
    referenceSeconds, stageIndex: index, opacity,
  };
}
