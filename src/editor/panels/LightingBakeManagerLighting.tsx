import { useMemo } from 'react';
import type { SceneLightingConfig } from '../../../electron/shared/sceneLightingConfig';
import { getSceneSkyboxSettings, type SceneDocument } from '../model/SceneDocument';
import { isEntityEffectivelyVisible } from '../model/entityHierarchy';
import { SCENE_THEME_PRESETS } from '../model/sceneTheme';
import { GLB_STANDARD_PREVIEW_PRESET_ID, createGlbStandardPreviewLightingConfig } from '../../../electron/shared/glbStandardPreview';
import type { LightingManagerPresetId } from './lightingBakeManagerModel';
import { LightingManagerColorField, LightingManagerNumberField, LightingManagerToggle } from './LightingBakeManagerWidgets';

export function LightingBakeManagerLighting({ scene, lighting, disabled, onChange, onPreset }: {
  scene: SceneDocument; lighting: SceneLightingConfig; disabled: boolean;
  onChange: (lighting: SceneLightingConfig) => void; onPreset: (id: LightingManagerPresetId) => void;
}) {
  const sceneLights = useMemo(() => scene.entityIds.map(id => scene.entities[id]).filter(entity => entity?.components.light), [scene]);
  const disabledLightIds = useMemo(() => new Set(lighting.disabledLightIds), [lighting.disabledLightIds]);
  const managed = lighting.main.source === 'managed';
  const environmentSource = lighting.environment?.source ?? 'scene';
  const sceneSkybox = getSceneSkyboxSettings(scene);
  const changeEnvironmentSource = (source: 'scene' | 'sandbox') => onChange({ ...lighting, environment: { ...lighting.environment, source,
    rotationDegrees: source === 'sandbox' ? createGlbStandardPreviewLightingConfig(lighting).environment!.rotationDegrees
      : lighting.environment?.rotationDegrees ?? 0 } });
  const changeMain = (patch: Partial<SceneLightingConfig['main']>) => onChange({ ...lighting, main: { ...lighting.main, ...patch } });
  const changeFill = (patch: Partial<SceneLightingConfig['fill']>) => onChange({ ...lighting, fill: { ...lighting.fill, ...patch } });
  const lightLabels = { directional: '方向光', hemispheric: '半球光', point: '点光源', spot: '聚光灯', rectArea: '矩形面光' };
  return <details className="lighting-manager-card lighting-manager-config-section">
    <summary>场景照明<span>{managed ? '统一主光' : '场景方向光'}</span></summary>
    <label className="lighting-manager-field"><span>光照预设</span><select aria-label="光照预设" value="" disabled={disabled}
      onChange={event => { if (event.target.value) onPreset(event.target.value as LightingManagerPresetId); }}>
      <option value="">选择后暂存到草稿</option>
      <option value={GLB_STANDARD_PREVIEW_PRESET_ID}>GLB 标准预览（对齐 Sandbox）</option>{SCENE_THEME_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
    </select></label>
    <p className="lighting-manager-note">GLB 标准预览会同时暂存照明与显示配置，关闭场景灯、阴影、显示调色和烘焙应用，保留天空盒显隐及已有烘焙结果；其他预设只调整照明。应用配置后生效，可一次撤销。</p>
    <label className="lighting-manager-field"><span>主光来源</span><select aria-label="主光来源" value={lighting.main.source} disabled={disabled}
      onChange={event => changeMain({ source: event.target.value as SceneLightingConfig['main']['source'] })}>
      <option value="managed">统一主光</option><option value="scene">场景方向光</option>
    </select></label>
    <LightingManagerToggle label="启用主光" checked={lighting.main.enabled} disabled={disabled || !managed} onChange={enabled => changeMain({ enabled })} />
    <LightingManagerColorField label="主光颜色" value={lighting.main.color} disabled={disabled || !managed || !lighting.main.enabled} onChange={color => changeMain({ color })} />
    <LightingManagerNumberField label="主光强度" value={lighting.main.intensity} min={0} max={20} step={0.05}
      disabled={disabled || !managed || !lighting.main.enabled} onChange={intensity => changeMain({ intensity })} />
    <LightingManagerNumberField label="主光方位" value={lighting.main.azimuthDegrees} min={0} max={360} unit="°"
      disabled={disabled || !managed || !lighting.main.enabled} onChange={azimuthDegrees => changeMain({ azimuthDegrees })} />
    <LightingManagerNumberField label="主光高度" value={lighting.main.elevationDegrees} min={-90} max={90} unit="°"
      disabled={disabled || !managed || !lighting.main.enabled} onChange={elevationDegrees => changeMain({ elevationDegrees })} />
    {!managed && <p className="lighting-manager-note">主光沿用可用场景方向光的位置、颜色和强度。下方可控制各场景灯是否参与照明。</p>}
    <LightingManagerColorField label="补光颜色" value={lighting.fill.color} disabled={disabled} onChange={color => changeFill({ color })} />
    <LightingManagerColorField label="地面方向颜色" value={lighting.fill.groundColor} disabled={disabled} onChange={groundColor => changeFill({ groundColor })} />
    <LightingManagerNumberField label="补光强度" value={lighting.fill.intensity} min={0} max={4} step={0.05} disabled={disabled}
      onChange={intensity => changeFill({ intensity })} />
    <label className="lighting-manager-field"><span>环境照明来源</span><select aria-label="环境照明来源" value={environmentSource} disabled={disabled}
      onChange={event => changeEnvironmentSource(event.target.value as 'scene' | 'sandbox')}>
      <option value="scene">场景天空盒</option><option value="sandbox">GLB 标准环境</option>
    </select></label>
    {environmentSource === 'sandbox' ? <>
      <LightingManagerNumberField label="环境旋转" value={lighting.environment?.rotationDegrees ?? 0} min={0} max={360} step={0.1} unit="°" disabled={disabled}
        onChange={rotationDegrees => onChange({ ...lighting, environment: { ...lighting.environment, source: 'sandbox', rotationDegrees } })} />
      <p className="lighting-manager-note">当前选择：GLB 标准环境。应用后使用标准环境照明与反射；场景天空盒可在显示效果中单独开启，作为背景而不提供照明。</p>
    </> : <p className="lighting-manager-note">{sceneSkybox?.sourceUrl
      ? '当前选择：场景天空盒。环境资源与旋转沿用场景天空盒配置。'
      : '当前选择：场景天空盒，但未配置场景天空盒，环境照明与反射尚无贴图来源。'}</p>}
    <LightingManagerNumberField label="环境照明与反射强度" value={lighting.environmentIntensity} min={0} max={5} step={0.05} disabled={disabled}
      onChange={environmentIntensity => onChange({ ...lighting, environmentIntensity })} />
    <LightingManagerToggle label="允许昼夜循环控制光照" checked={lighting.allowDayNightCycle} disabled={disabled}
      onChange={allowDayNightCycle => onChange({ ...lighting, allowDayNightCycle })} />
    <p className="lighting-manager-note">启用的昼夜循环会改变烘焙输入，开始烘焙前需暂停。</p>
    <details className="lighting-manager-advanced"><summary>场景灯光（{sceneLights.length}）</summary>
      {sceneLights.length ? <div className="lighting-manager-scene-lights">{sceneLights.map(entity => {
        const light = entity.components.light!;
        const visible = isEntityEffectivelyVisible(scene.entities, entity);
        return <LightingManagerToggle key={entity.id} label={`参与照明：${entity.name}`} checked={!disabledLightIds.has(entity.id)} disabled={disabled}
          description={`${lightLabels[light.lightKind]} · ${visible ? '可见' : '层级中已隐藏'}`}
          onChange={enabled => onChange({ ...lighting, disabledLightIds: enabled ? lighting.disabledLightIds.filter(id => id !== entity.id)
            : [...lighting.disabledLightIds.filter(id => id !== entity.id), entity.id] })} />;
      })}</div> : <p className="lighting-manager-note">场景内尚未放置灯光对象。</p>}
      <p className="lighting-manager-note">这里控制场景灯是否参与照明；隐藏对象仍保持隐藏，灯光位置与组件参数继续在对象属性中编辑。</p>
    </details>
  </details>;
}
