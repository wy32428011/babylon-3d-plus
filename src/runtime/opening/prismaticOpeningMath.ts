import type { OpeningPackageStage } from '../../shared/opening/openingPackage.ts';
import { getPackageTimelineFrame } from './openingPackageTimeline.ts';

/** 动画姿态只由时间轴求值，暂停、重播和拖动到更早时刻均可重建同一帧。 */
export function getPrismaticOpeningState(seconds: number, stages: readonly OpeningPackageStage[], reducedMotion = false) {
  const frame = getPackageTimelineFrame(seconds, stages, 0);
  const phase = reducedMotion ? 'showcase' : frame.stageId;
  const progress = reducedMotion ? 1 : frame.stageProgress;
  const ease = progress * progress * (3 - 2 * progress);
  return {
    phase, progress,
    reveal: phase === 'showcase' ? 1 : phase === 'assembly' ? ease : 0,
    orbit: -.94 + (phase === 'assembly' ? ease * .15 : phase === 'showcase' ? .15 + progress * .36 : 0),
    coreScale: phase === 'core' ? .78 + ease * .5 : 0,
    visualSeconds: reducedMotion ? 18 : frame.elapsedSeconds,
  };
}
