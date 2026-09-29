import { createDefaultSceneOpeningAnimation, normalizeSceneOpeningAnimation, type SceneOpeningAnimationSettings } from '../editor/model/sceneOpeningAnimation.ts';
import { normalizeReferenceOpening } from '../editor/model/sceneOpeningReference.ts';
import type { OpeningOptions, OpeningSettings } from './types.ts';

/** 每次返回完整独立副本，调用方可直接编辑再传给 createOpening。 */
export function defaultSettings(): OpeningSettings {
  const settings = createDefaultSceneOpeningAnimation();
  const reference = settings.reference;
  return {
    reference: {
      brandName: reference.brandName, companyName: reference.companyName,
      heroTitle: reference.heroTitle, heroSubtitle: reference.heroSubtitle, finaleTitle: reference.finaleTitle,
      quality: reference.quality, showUI: reference.showUI, stageDurations: reference.stageDurations,
      worldOrigin: reference.worldOrigin, chinaOrigin: reference.chinaOrigin,
      worldDestinations: reference.worldDestinations, chinaDestinations: reference.chinaDestinations,
    },
    allowSkip: settings.allowSkip, breathingEnabled: settings.breathingEnabled,
    breathingIntensity: settings.breathingIntensity, breathingPeriodSeconds: settings.breathingPeriodSeconds,
    motionPreference: settings.motionPreference,
  };
}

/** 只转接公开开场字段，外部对象不能注入编辑器包绑定或业务相机设置。 */
export function normalizeStandaloneSettings(settings: OpeningOptions['settings']): SceneOpeningAnimationSettings {
  return normalizeSceneOpeningAnimation({
    enabled: true, template: 'reference-huishan', afterOpening: 'stay',
    reference: normalizeReferenceOpening(settings?.reference),
    allowSkip: settings?.allowSkip, breathingEnabled: settings?.breathingEnabled,
    breathingIntensity: settings?.breathingIntensity, breathingPeriodSeconds: settings?.breathingPeriodSeconds,
    motionPreference: settings?.motionPreference,
  });
}
