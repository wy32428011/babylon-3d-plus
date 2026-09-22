import { useEffect, useState } from 'react';
import { isTechBlueNightThemeAdjusted, type SceneThemeSettings } from '../model/sceneTheme';
import { useEditorStore } from '../store/editorStore';
import './SceneThemePanel.css';

type ThemeColorKey = 'backgroundColor' | 'fillColor' | 'groundColor' | 'mainColor' | 'fogColor';
type ThemeNumberKey = 'environmentIntensity' | 'exposure' | 'contrast' | 'glowIntensity' | 'bloomWeight' | 'fogStart' | 'fogEnd';

function ThemeNumberField({ label, value, min, max, step = 0.05, disabled, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    if (disabled) { setDraft(String(value)); return; }
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="inspector-row">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} disabled={disabled} value={draft}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); setDraft(String(value)); }
        }} />
    </label>
  );
}

/** 主题管理全局氛围；场景灯具和业务特效仍保留独立的位置、配色与业务状态。 */
export function SceneThemePanel({ readOnly = false }: { readOnly?: boolean }) {
  const theme = useEditorStore(state => state.scene.sceneSettings.theme);
  const shadows = useEditorStore(state => state.scene.sceneSettings.shadows);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const shadowBakePhase = useEditorStore(state => state.shadowBakeStatus.phase);
  const applyTheme = useEditorStore(state => state.applySceneTheme);
  const updateTheme = useEditorStore(state => state.updateSceneTheme);
  const clearTheme = useEditorStore(state => state.clearSceneTheme);
  const disabled = readOnly || runtimeMode === 'preview' || shadowBakePhase === 'baking';
  const adjusted = theme ? isTechBlueNightThemeAdjusted(theme, shadows) : false;

  function renderColor(key: ThemeColorKey, label: string) {
    if (!theme) return null;
    return (
      <label className="inspector-row scene-theme-color-row" key={key}>
        <span>{label}</span>
        <span className="scene-theme-color-value">
          <input type="color" aria-label={label} value={theme[key]}
            onChange={event => updateTheme({ [key]: event.target.value })} />
          <code>{theme[key]}</code>
        </span>
      </label>
    );
  }

  function renderNumber(key: ThemeNumberKey, label: string, min: number, max: number, step = 0.05, fieldDisabled = false) {
    if (!theme) return null;
    return <ThemeNumberField key={key} label={label} value={theme[key]} min={min} max={max} step={step}
      disabled={disabled || fieldDisabled} onCommit={value => updateTheme({ [key]: value })} />;
  }

  return (
    <fieldset className="transform-fieldset scene-theme-panel" disabled={disabled}>
      <legend>场景主题</legend>
      <div className="scene-theme-heading">
        <strong>{theme ? '科技蓝夜景' : '保持当前配置'}</strong>
        {theme ? <span className="scene-theme-state">{adjusted ? '已调整' : '当前使用'}</span> : null}
      </div>
      {!theme ? (
        <p className="muted">从主题库点击“科技蓝夜景”，或将主题卡片拖入场景，即可应用冷蓝底光与夜景氛围。</p>
      ) : (
        <>
          <div className="scene-settings-button-row">
            <button type="button" onClick={applyTheme}>恢复主题默认值</button>
            <button type="button" onClick={clearTheme}>停用主题</button>
          </div>
          <p className="muted">参数随场景保存。主光方向、强度、补光强度和阴影浓度在下方“阴影”中调整；主题接管半球光与方向光，点光源保持独立。</p>
          <details className="scene-theme-group" open>
            <summary>背景与底光</summary>
            <label className="inspector-row">
              <span>环境受光</span>
              <select aria-label="环境受光" value={theme.environmentLighting}
                onChange={event => updateTheme({ environmentLighting: event.target.value as SceneThemeSettings['environmentLighting'] })}>
                <option value="scene">接受场景照明</option>
                <option value="original">保持原貌</option>
              </select>
            </label>
            {renderColor('backgroundColor', '背景颜色')}
            {renderColor('fillColor', '底光颜色')}
            {renderColor('groundColor', '地面方向颜色')}
            {renderColor('mainColor', '主光颜色')}
            {renderNumber('environmentIntensity', '环境反射强度', 0, 4)}
            <label className="inspector-row environment-visible-row">
              <span>显示天空盒</span>
              <input type="checkbox" checked={theme.skyboxVisible}
                onChange={event => updateTheme({ skyboxVisible: event.target.checked })} />
            </label>
            <p className="muted">隐藏天空盒时仍保留已配置天空盒的环境照明与反射。</p>
          </details>
          <details className="scene-theme-group">
            <summary>画面与光晕</summary>
            {renderNumber('exposure', '曝光', 0.1, 4)}
            {renderNumber('contrast', '对比度', 0.1, 3)}
            {renderNumber('glowIntensity', '特效光晕', 0, 3)}
            <label className="inspector-row environment-visible-row">
              <span>柔和泛光</span>
              <input type="checkbox" checked={theme.bloomEnabled}
                onChange={event => updateTheme({ bloomEnabled: event.target.checked })} />
            </label>
            {renderNumber('bloomWeight', '泛光强度', 0, 1, 0.05, !theme.bloomEnabled)}
          </details>
          <details className="scene-theme-group">
            <summary>远景层次</summary>
            <label className="inspector-row environment-visible-row">
              <span>距离雾</span>
              <input type="checkbox" checked={theme.fogEnabled}
                onChange={event => updateTheme({ fogEnabled: event.target.checked })} />
            </label>
            {renderColor('fogColor', '雾颜色')}
            {renderNumber('fogStart', '起雾距离（m）', 0, Math.min(100000, Math.max(0, theme.fogEnd - 1)), 1, !theme.fogEnabled)}
            {renderNumber('fogEnd', '最远雾距离（m）', theme.fogStart + 1, 200000, 1, !theme.fogEnabled)}
          </details>
          <p className="muted">门口、装卸区等暖色照明，请从模型库放置灯光并调整位置；业务特效和告警颜色由对应组件控制。</p>
        </>
      )}
    </fieldset>
  );
}
