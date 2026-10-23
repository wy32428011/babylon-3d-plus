import type { SceneAppearanceConfig } from '../../../electron/shared/sceneLightingConfig';
import { SCENE_THEME_PRESETS, type SceneThemePresetId } from '../model/sceneTheme';
import { LightingManagerColorField, LightingManagerNumberField, LightingManagerToggle } from './LightingBakeManagerWidgets';

export function LightingBakeManagerAppearance({ appearance, disabled, onChange, onPreset }: {
  appearance: SceneAppearanceConfig; disabled: boolean;
  onChange: (appearance: SceneAppearanceConfig) => void; onPreset: (id: SceneThemePresetId) => void;
}) {
  const patch = (value: Partial<SceneAppearanceConfig>) => onChange({ ...appearance, ...value });
  return <details className="lighting-manager-card lighting-manager-config-section">
    <summary>显示效果<span>背景、曝光与雾</span></summary>
    <label className="lighting-manager-field"><span>显示预设</span><select aria-label="显示预设" value="" disabled={disabled}
      onChange={event => { if (event.target.value) onPreset(event.target.value as SceneThemePresetId); }}>
      <option value="">选择后暂存到草稿</option>{SCENE_THEME_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
    </select></label>
    <p className="lighting-manager-note">显示设置在应用配置后生效；曝光、背景和雾的调整不改变已烘焙照明。</p>
    <LightingManagerColorField label="背景颜色" value={appearance.backgroundColor} disabled={disabled} onChange={backgroundColor => patch({ backgroundColor })} />
    <LightingManagerToggle label="显示天空盒" checked={appearance.skyboxVisible} disabled={disabled} onChange={skyboxVisible => patch({ skyboxVisible })} />
    <p className="lighting-manager-note">隐藏天空盒仍保留已配置环境贴图提供的照明与反射。</p>
    <LightingManagerNumberField label="曝光" value={appearance.exposure} min={0.1} max={4} step={0.05} disabled={disabled} onChange={exposure => patch({ exposure })} />
    <LightingManagerToggle label="色调映射" checked={appearance.toneMappingEnabled} disabled={disabled} onChange={toneMappingEnabled => patch({ toneMappingEnabled })} />
    <LightingManagerNumberField label="对比度" value={appearance.contrast} min={0.1} max={3} step={0.05} disabled={disabled} onChange={contrast => patch({ contrast })} />
    <LightingManagerNumberField label="特效光晕" value={appearance.glowIntensity} min={0} max={3} step={0.05} disabled={disabled} onChange={glowIntensity => patch({ glowIntensity })} />
    <LightingManagerToggle label="柔和泛光" checked={appearance.bloomEnabled} disabled={disabled} onChange={bloomEnabled => patch({ bloomEnabled })} />
    <LightingManagerNumberField label="泛光强度" value={appearance.bloomWeight} min={0} max={1} step={0.05} disabled={disabled || !appearance.bloomEnabled}
      onChange={bloomWeight => patch({ bloomWeight })} />
    <LightingManagerToggle label="距离雾" checked={appearance.fogEnabled} disabled={disabled} onChange={fogEnabled => patch({ fogEnabled })} />
    <LightingManagerColorField label="雾颜色" value={appearance.fogColor} disabled={disabled || !appearance.fogEnabled} onChange={fogColor => patch({ fogColor })} />
    <LightingManagerNumberField label="起雾距离" value={appearance.fogStart} min={0} max={Math.min(100000, appearance.fogEnd - 1)} unit="米"
      disabled={disabled || !appearance.fogEnabled} onChange={fogStart => patch({ fogStart })} />
    <LightingManagerNumberField label="最远雾距离" value={appearance.fogEnd} min={appearance.fogStart + 1} max={200000} unit="米"
      disabled={disabled || !appearance.fogEnabled} onChange={fogEnd => patch({ fogEnd })} />
  </details>;
}
