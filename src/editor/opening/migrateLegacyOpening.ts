import { normalizeSceneOpeningAnimation, type SceneOpeningConfig } from '../model/sceneOpeningAnimation.ts';
import { validateOpeningPackageConfig, type OpeningPackageBinding, type OpeningScalar } from '../../shared/opening/openingPackage.ts';

/** 用户显式迁移到已经导入的参考包；只改变开场，撤销仍由场景命令保存原配置。 */
export function migrateLegacyOpening(config: SceneOpeningConfig, imported: OpeningPackageBinding): SceneOpeningConfig {
  if (config.template === 'package' || imported.definition.manifest.renderer !== 'reference-huishan') throw new Error('旧参考配置只能迁移到已导入的参考开场包。');
  if (config.template !== undefined && !['reference-huishan', 'globe-huishan'].includes(String(config.template))) throw new Error('旧开场类型不受支持，原配置已保留。');
  const legacy = normalizeSceneOpeningAnimation(config), reference = legacy.reference;
  if (reference.legacyUnmappedNames?.length) throw new Error(`旧点位无法自动匹配 UV，迁移未执行：${reference.legacyUnmappedNames.join('、')}。请保留旧配置并手动配置对应点位。`);
  const binding = structuredClone(imported);
  const values: Record<string, OpeningScalar> = {
    brandName: reference.brandName, companyName: reference.companyName,
    heroTitle: reference.heroTitle, heroSubtitle: reference.heroSubtitle, finaleTitle: reference.finaleTitle,
    arrivalDescription: '', quality: reference.quality, showUI: reference.showUI,
    breathingEnabled: legacy.breathingEnabled, breathingIntensity: legacy.breathingIntensity,
    breathingPeriodSeconds: legacy.breathingPeriodSeconds,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(binding.definition.schema.properties, key)) throw new Error(`参考包缺少迁移参数 ${key}，请导入 1.1.0 或支持此参数的新版参考包。`);
    binding.config.values[key] = value;
  }
  binding.config.stages.forEach((stage, index) => { stage.durationSeconds = reference.stageDurations[index]; });
  for (const [index, origin, destinations] of [[2, reference.worldOrigin, reference.worldDestinations], [5, reference.chinaOrigin, reference.chinaDestinations]] as const) {
    const stage = binding.config.stages[index]; stage.origin = { ...origin };
    stage.routes = destinations.map((point, at) => ({ id: `route-${at + 1}`, name: point.name, from: { ...origin }, to: { x: point.x, y: point.y } }));
  }
  validateOpeningPackageConfig(binding.definition, binding.config);
  return { template: 'package', package: binding, enabled: legacy.enabled, allowSkip: legacy.allowSkip, motionPreference: legacy.motionPreference };
}
