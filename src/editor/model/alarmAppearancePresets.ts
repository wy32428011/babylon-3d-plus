import type { PoiEffectComponent, PoiEffectKind } from './components';
import { createDefaultEffectConfiguration } from './effectConfigurationValidation';
import { createDefaultPoiEffectComponent, sanitizePoiEffectComponent } from './poiEffect';

/** 对应报警参考图的12类外观；配置落在已有EFF组件中，不额外保存预设引用。 */
export const ALARM_APPEARANCE_PRESETS = [
  { id: 'device-color', name: '01 设备变红 / 变橙', effectKind: 'model-color', tintModel: true },
  { id: 'device-flash', name: '02 闪烁高亮', effectKind: 'model-flash', tintModel: true },
  { id: 'breathing-halo', name: '03 呼吸光晕', effectKind: 'breathing-ring', tintModel: false },
  { id: 'outline', name: '04 描边轮廓高亮', effectKind: 'model-outline', tintModel: false },
  { id: 'beacon', name: '05 顶部报警灯', effectKind: 'warning-beacon', tintModel: false },
  { id: 'icon', name: '06 告警图标悬浮', effectKind: 'alarm-icon', tintModel: false },
  { id: 'pillar', name: '07 报警光柱', effectKind: 'light-pillar', tintModel: false },
  { id: 'ripple', name: '08 波纹扩散', effectKind: 'ripple-ring', tintModel: false },
  { id: 'zone', name: '09 地面警戒圈', effectKind: 'alarm-zone', tintModel: false },
  { id: 'label', name: '10 弹窗 / 标签告警', effectKind: 'alarm-label', tintModel: false },
  { id: 'particles', name: '11 烟雾 / 火花 / 粒子', effectKind: 'smoke-plume', tintModel: false },
  { id: 'route', name: '12 路径指引到故障点', effectKind: 'alarm-route', tintModel: false },
] as const satisfies readonly { id: string; name: string; effectKind: PoiEffectKind; tintModel: boolean }[];

export function createAlarmAppearancePreset(id: string): PoiEffectComponent {
  const preset = ALARM_APPEARANCE_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error('未知报警外观样式：' + id);
  const effect = createDefaultPoiEffectComponent(preset.effectKind);
  effect.primaryColor = preset.id === 'route' ? '#22dfff' : preset.id === 'particles' ? '#b8bcc4' : '#ff2424';
  effect.secondaryColor = preset.id === 'route' ? '#b7f7ff' : preset.id === 'particles' ? '#e8ebee' : '#ff7c38';
  effect.intensity = 1.5;
  effect.configuration = createDefaultEffectConfiguration(effect);
  if (id === 'device-color' || id === 'device-flash') {
    effect.intensity = 1;
    Object.assign(effect.configuration.parameters, { originalMix: 0.12, emissiveIntensity: 0.18, glowIntensity: 0.18, glowRadius: 16 });
  }
  if (['breathing-halo', 'ripple', 'zone'].includes(id)) {
    effect.visual!.radius = 2.5;
    effect.visual!.opacity = 0.85;
    effect.configuration.parameters.fitTarget = true;
  }
  if (id === 'ripple') {
    Object.assign(effect.visual!, { radius: 3.2, opacity: 0.95 });
    Object.assign(effect.configuration.parameters, { fadeExponent: 0.2, ringCount: 3 });
    effect.intensity = 2;
  }
  if (id === 'pillar') {
    Object.assign(effect.visual!, { radius: 0.85, height: 6, opacity: 0.75 });
    Object.assign(effect.configuration.parameters, { bottomRadius: 0.65, topRadius: 0.3, showBase: true });
  }
  if (id === 'particles') Object.assign(effect.visual!, { radius: 0.5, height: 2.5, opacity: 0.5 });
  if (id === 'beacon') Object.assign(effect.configuration.parameters, { domeRadius: 0.22, beaconHeight: 0.28, revolutionsPerMinute: 45 });
  return sanitizePoiEffectComponent(effect);
}
