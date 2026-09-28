import type { SceneOpeningAnimationSettings } from '../../editor/model/sceneOpeningAnimation.ts';
import { normalizeReferenceOpening, type SceneOpeningStageDurations } from '../../editor/model/sceneOpeningReference.ts';
import { getOpeningPackageProblem, type OpeningPackageBinding } from '../../shared/opening/openingPackage.ts';
import { OpeningPackageAssets } from './openingPackageAssets.ts';
import { createTimelineOpeningVisual, type OpeningControlledVisual, type OpeningVisualControls } from './TimelineOpeningVisual.ts';
import { getPackageTimelineFrame, resolveOpeningStage } from './openingPackageTimeline.ts';
import { createReferenceOpening } from './reference';
import { getReferenceOpeningFrame } from './referenceOpeningTimeline.ts';

type Frame = ReturnType<typeof getReferenceOpeningFrame> | ReturnType<typeof getPackageTimelineFrame>;
export type OpeningVisualPlan = {
  frameAt(seconds: number): Frame;
  reducedStartSeconds: number;
  createVisual(container: HTMLElement, controls: OpeningVisualControls): OpeningControlledVisual;
};

function referenceSettings(settings: SceneOpeningAnimationSettings, binding: OpeningPackageBinding): SceneOpeningAnimationSettings {
  const values = binding.config.values;
  const reference = normalizeReferenceOpening({ ...settings.reference, ...values,
    stageDurations: binding.config.stages.map(stage => stage.durationSeconds) });
  // 验证后的时长精确保留，不经旧配置的补缺省逻辑二次改变。
  reference.stageDurations = binding.config.stages.map(stage => stage.durationSeconds) as SceneOpeningStageDurations;
  for (const [index, originKey, destinationsKey] of [[2, 'worldOrigin', 'worldDestinations'], [5, 'chinaOrigin', 'chinaDestinations']] as const) {
    const stage = binding.config.stages[index];
    if (stage.origin) reference[originKey] = { ...stage.origin };
    if (stage.routes) reference[destinationsKey] = stage.routes.map(route => ({ name: route.name, ...route.to }));
  }
  return { ...settings, reference };
}

/** 只有内置受控渲染器可被包选中；资源及实例参数均经协议验证。 */
export function createOpeningVisualPlan(settings: SceneOpeningAnimationSettings, reducedMotion: boolean): OpeningVisualPlan {
  if (settings.template !== 'package') {
    const frameAt = (seconds: number) => getReferenceOpeningFrame(seconds, settings.reference);
    return {
      frameAt, reducedStartSeconds: Math.max(0, frameAt(0).totalDurationSeconds - 1.2),
      createVisual: (container, controls) => {
        const visual = createReferenceOpening(container, { settings, ...controls });
        return { ready: visual.ready, resize: visual.resize, dispose: visual.dispose,
          renderAt: (seconds, context) => visual.renderAt(reducedMotion ? 61 : frameAt(seconds).referenceSeconds, context) };
      },
    };
  }
  const problem = getOpeningPackageProblem(settings.package);
  if (problem) throw new Error(problem);
  const binding = settings.package!;
  const reference = binding.definition.manifest.renderer === 'reference-huishan';
  const adapted = reference ? referenceSettings(settings, binding) : settings;
  const stages = binding.config.stages;
  const frameAt = (seconds: number): Frame => {
    if (!reference) return getPackageTimelineFrame(seconds, stages, binding.definition.timeline.handoffSeconds);
    const frame = getReferenceOpeningFrame(seconds, adapted.reference);
    return { ...frame, label: frame.phase === 'complete' || frame.phase === 'handoff' ? frame.label : stages[frame.stageIndex].label };
  };
  const total = frameAt(0).totalDurationSeconds;
  const lastDuration = [...stages].reverse().find(stage => stage.durationSeconds > 0)?.durationSeconds ?? 0;
  return {
    frameAt, reducedStartSeconds: Math.max(0, total - Math.min(1.2, lastDuration)),
    createVisual(container, controls) {
      const assets = new OpeningPackageAssets(binding.manifestUrl, binding.definition.manifest.assets.map(asset => {
        const override = binding.config.assetOverrides?.[asset.id];
        return override ? { ...asset, ...override } : asset;
      }));
      let visual: OpeningControlledVisual | null = null;
      let disposed = false;
      const ready = (async () => {
        if (reference) {
          const urls: string[] = [];
          let next = 1;
          await Promise.all(Array.from({ length: 4 }, async () => {
            while (!disposed && next <= 10) { const index = next++; urls[index] = await assets.url(`asset-${index}`); }
          }));
          if (disposed) return;
          const legacy = createReferenceOpening(container, { settings: adapted, ...controls,
            stageOverrides: stages.map(stage => resolveOpeningStage(stage, binding.config.values)),
            assetUrls: { images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, urls[index + 1]])), atlas: urls[10] } });
          visual = { ready: legacy.ready, resize: legacy.resize, dispose: legacy.dispose,
            renderAt: (seconds, context) => legacy.renderAt(reducedMotion ? 61 : getReferenceOpeningFrame(seconds, adapted.reference).referenceSeconds, context) };
        } else {
          visual = createTimelineOpeningVisual(container, { stages, values: binding.config.values, assets,
            allowSkip: settings.allowSkip, reducedMotion, controls });
        }
        await visual.ready;
      })();
      return { ready, renderAt: (seconds, context) => visual?.renderAt(seconds, context), resize: () => visual?.resize(),
        dispose() { if (disposed) return; disposed = true; visual?.dispose(); visual = null; assets.dispose(); } };
    },
  };
}
