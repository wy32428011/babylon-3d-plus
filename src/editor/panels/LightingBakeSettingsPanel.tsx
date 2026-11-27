import { useMemo } from 'react';
import { getSceneLightingBakeSignatureCached, requiresSceneLightingBake } from '../../../electron/shared/sceneLightingBakeContract';
import { getSceneAppearanceConfig, getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig';
import {
  applyWarehouseLightingPreset,
  applyWarehouseQualityTier,
  detectWarehouseQualityTier,
  WAREHOUSE_LIGHTING_PRESETS,
  WAREHOUSE_QUALITY_TIERS,
} from '../../../electron/shared/warehouseLightingPresets';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';
import { LightingManagerBadge } from './LightingBakeManagerWidgets';
import './lighting-bake-manager.css';

/** 日常实时光照与仓储阴影快捷面板；离线烘焙与复杂规则保留在高级管理器中。 */
export function LightingBakeSettingsPanel({ readOnly = false }: { readOnly?: boolean }) {
  const scene = useEditorStore(state => state.scene);
  const status = useEditorStore(state => state.lightingBakeStatus);
  const request = useEditorStore(state => state.lightingBakeRequest);
  const open = useEditorStore(state => state.openLightingManager);
  const applyQuickLightingUpdate = useEditorStore(state => state.applyQuickLightingUpdate);

  const lighting = useMemo(() => getSceneLightingConfig(scene), [scene]);
  const appearance = useMemo(() => getSceneAppearanceConfig(scene), [scene]);
  const signature = useMemo(() => getSceneLightingBakeSignatureCached(scene), [scene]);
  const qualityTier = useMemo(() => detectWarehouseQualityTier(lighting, appearance), [lighting, appearance]);

  const disabled = readOnly || Boolean(request);
  const result = lighting.result;
  const label = request ? '任务进行中'
    : !lighting.bake.enabled ? '零 Blender 实时'
      : !requiresSceneLightingBake(scene) ? '无需静态烘焙'
        : result && result.signature !== signature ? '已过期'
          : status.phase === 'error' ? '更新失败'
            : result ? '可用' : '未烘焙';
  const tone = !lighting.bake.enabled || label === '可用' ? 'success'
    : label === '已过期' || label === '更新失败' ? 'warning' : 'neutral';

  const { shadows, main } = lighting;
  const ssaoEnabled = appearance.ssaoMode === 'balanced' || appearance.ssaoMode === 'high';
  const groundOnly = shadows.managementMode === 'automatic' && shadows.receiverScope === 'ground-only';
  const skipCargoAndSmall = Boolean(shadows.skipGeneratedCargoCasters || (shadows.skipSmallCastersMeters ?? 0) > 0);
  const darknessPercent = Math.round((1 - shadows.darkness) * 100);

  return (
    <CollapsibleFieldset title="光照与阴影" className="lighting-manager-summary lighting-quick-panel">
      <div className="lighting-quick-section">
        <div className="lighting-quick-header">
          <span>一键仓储氛围</span>
          <LightingManagerBadge tone={tone}>{label}</LightingManagerBadge>
        </div>
        <div className="lighting-quick-preset-grid">
          {WAREHOUSE_LIGHTING_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              title={preset.subtitle}
              disabled={disabled}
              className="lighting-quick-preset-btn"
              onClick={() => applyQuickLightingUpdate(
                `应用仓储预设：${preset.name}`,
                ({ lighting: currentLighting, appearance: currentAppearance }) => applyWarehouseLightingPreset(currentLighting, currentAppearance, preset.id),
              )}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      <div className="lighting-quick-section">
        <div className="lighting-quick-header">
          <span>性能画质档</span>
          {qualityTier === 'custom' && <small className="lighting-quick-muted">自定义</small>}
        </div>
        <div className="lighting-quick-tier-group" role="group" aria-label="仓储画质档位">
          {WAREHOUSE_QUALITY_TIERS.map(tier => (
            <button
              key={tier.id}
              type="button"
              title={tier.subtitle}
              disabled={disabled}
              aria-pressed={qualityTier === tier.id}
              className={qualityTier === tier.id ? 'lighting-quick-tier-btn is-active' : 'lighting-quick-tier-btn'}
              onClick={() => applyQuickLightingUpdate(
                `切换画质：${tier.name}`,
                ({ lighting: currentLighting, appearance: currentAppearance }) => applyWarehouseQualityTier(currentLighting, currentAppearance, tier.id),
              )}
            >
              {tier.name}
            </button>
          ))}
        </div>
      </div>

      <div className="lighting-quick-toggles">
        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={shadows.enabled}
            disabled={disabled}
            onChange={event => {
              const enabled = event.target.checked;
              applyQuickLightingUpdate(enabled ? '启用阴影' : '关闭阴影', ({ lighting: current }) => ({
                lighting: {
                  ...current,
                  shadows: {
                    ...current.shadows,
                    enabled,
                    ...(enabled && !current.shadows.managementMode ? { managementMode: 'automatic', respectEntityShadowOverrides: true } : {}),
                  },
                  main: enabled && current.environment?.source === 'sandbox' && current.main.source === 'managed' && (!current.main.enabled || current.main.intensity <= 0)
                    ? { ...current.main, enabled: true, intensity: 1.05 }
                    : current.main,
                },
              }));
            }}
          />
          <span>启用实时阴影</span>
        </label>

        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={ssaoEnabled}
            disabled={disabled}
            onChange={event => {
              const checked = event.target.checked;
              applyQuickLightingUpdate(checked ? '开启接触暗影' : '关闭接触暗影', ({ appearance: current }) => {
                const next = { ...current };
                if (checked) next.ssaoMode = 'balanced';
                else delete next.ssaoMode;
                return { appearance: next };
              });
            }}
          />
          <span>接触暗影（SSAO）</span>
        </label>

        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={groundOnly}
            disabled={disabled || !shadows.enabled}
            onChange={event => {
              const checked = event.target.checked;
              applyQuickLightingUpdate(checked ? '仅地面接收阴影' : '全场接收阴影', ({ lighting: current }) => {
                const nextShadows = {
                  ...current.shadows,
                  ...(checked ? { managementMode: 'automatic' as const, respectEntityShadowOverrides: true } : {}),
                };
                if (checked) nextShadows.receiverScope = 'ground-only';
                else delete nextShadows.receiverScope;
                return { lighting: { ...current, shadows: nextShadows } };
              });
            }}
          />
          <span>仅地面接收阴影（大库提速）</span>
        </label>

        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={skipCargoAndSmall}
            disabled={disabled || !shadows.enabled}
            onChange={event => {
              const checked = event.target.checked;
              applyQuickLightingUpdate(checked ? '开启跳过小货物投影' : '关闭跳过小货物投影', ({ lighting: current }) => {
                const nextShadows = {
                  ...current.shadows,
                  ...(checked ? { managementMode: 'automatic' as const, respectEntityShadowOverrides: true } : {}),
                };
                if (checked) {
                  nextShadows.skipGeneratedCargoCasters = true;
                  nextShadows.skipSmallCastersMeters = 0.8;
                } else {
                  delete nextShadows.skipGeneratedCargoCasters;
                  delete nextShadows.skipSmallCastersMeters;
                }
                return { lighting: { ...current, shadows: nextShadows } };
              });
            }}
          />
          <span>跳过小货物与细件投影</span>
        </label>

        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={shadows.mobileBlobShadows === true}
            disabled={disabled}
            onChange={event => {
              const checked = event.target.checked;
              applyQuickLightingUpdate(checked ? '开启移动设备底盘软影' : '关闭移动设备底盘软影', ({ lighting: current }) => {
                const nextShadows = { ...current.shadows };
                if (checked) nextShadows.mobileBlobShadows = true;
                else delete nextShadows.mobileBlobShadows;
                return { lighting: { ...current, shadows: nextShadows } };
              });
            }}
          />
          <span>移动设备底盘软影（AGV/叉车）</span>
        </label>
      </div>

      <div className="lighting-quick-sliders">
        <label className="scene-slider-row">
          <span>光线方位</span>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            disabled={disabled || main.source !== 'managed'}
            value={main.azimuthDegrees}
            onChange={event => {
              const azimuthDegrees = Number(event.target.value);
              if (!Number.isFinite(azimuthDegrees)) return;
              applyQuickLightingUpdate('调整光线方位', ({ lighting: current }) => ({
                lighting: { ...current, main: { ...current.main, azimuthDegrees } },
              }));
            }}
          />
          <output>{Math.round(main.azimuthDegrees)}°</output>
        </label>

        <label className="scene-slider-row">
          <span>光线高度</span>
          <input
            type="range"
            min={5}
            max={89}
            step={1}
            disabled={disabled || main.source !== 'managed'}
            value={main.elevationDegrees}
            onChange={event => {
              const elevationDegrees = Number(event.target.value);
              if (!Number.isFinite(elevationDegrees)) return;
              applyQuickLightingUpdate('调整光线高度', ({ lighting: current }) => ({
                lighting: { ...current, main: { ...current.main, elevationDegrees } },
              }));
            }}
          />
          <output>{Math.round(main.elevationDegrees)}°</output>
        </label>

        <label className="scene-slider-row">
          <span>阴影深浅</span>
          <input
            type="range"
            min={15}
            max={100}
            step={1}
            disabled={disabled || !shadows.enabled}
            value={darknessPercent}
            onChange={event => {
              const percent = Number(event.target.value);
              if (!Number.isFinite(percent)) return;
              const darkness = Math.round((1 - percent / 100) * 10000) / 10000;
              applyQuickLightingUpdate('调整阴影深浅', ({ lighting: current }) => ({
                lighting: { ...current, shadows: { ...current.shadows, darkness } },
              }));
            }}
          />
          <output>{darknessPercent}%</output>
        </label>

        <label className="scene-slider-row">
          <span>画面亮度</span>
          <input
            type="range"
            min={0.2}
            max={2.5}
            step={0.05}
            disabled={disabled}
            value={appearance.exposure}
            onChange={event => {
              const exposure = Number(event.target.value);
              if (!Number.isFinite(exposure)) return;
              applyQuickLightingUpdate('调整画面亮度', ({ appearance: current }) => ({
                appearance: { ...current, exposure },
              }));
            }}
          />
          <output>{appearance.exposure.toFixed(2)}</output>
        </label>
      </div>

      <button type="button" className="lighting-manager-open-button" onClick={() => open({ tab: 'overview' })}>
        高级光照与离线烘焙（Blender）…
      </button>
      {readOnly && <p>运行预览中，可查看配置或停止预览。</p>}
    </CollapsibleFieldset>
  );
}
