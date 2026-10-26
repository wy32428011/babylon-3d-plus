import type { LightingBakeEngineStatus, SceneLightingBakeSettings, SceneLightingBakeSnapshot } from '../../../electron/shared/sceneLightingBakeContract';
import type { SceneAppearanceConfig, SceneLightingConfig } from '../../../electron/shared/sceneLightingConfig';
import type { SceneDocument } from '../model/SceneDocument';
import type { LightingManagerPresetId } from './lightingBakeManagerModel';
import type { GpuCapabilityProfile } from '../../runtime/babylon/gpuCapabilityProfile';
import type { LightingProbeBounds } from '../../../electron/shared/sceneLightingProbeVolumes';
import { LightingBakeManagerProbeVolumes } from './LightingBakeManagerProbeVolumes';
import { LightingBakeManagerAppearance } from './LightingBakeManagerAppearance';
import { LightingBakeManagerLighting } from './LightingBakeManagerLighting';
import { LightingManagerBadge, LightingManagerIcon, LightingManagerNumberField, LightingManagerToggle, formatLightingBytes } from './LightingBakeManagerWidgets';

export type LightingBakeManagerOverviewProps = {
  scene: SceneDocument;
  lighting: SceneLightingConfig;
  appearance: SceneAppearanceConfig;
  result: SceneLightingBakeSnapshot | null;
  resultLabel: string;
  disabled: boolean;
  dirty: boolean;
  previewDraftActive: boolean;
  previewDraftSuppressed: boolean;
  previewDraftRules: boolean;
  preflightBusy: boolean;
  probeBounds?: LightingProbeBounds;
  engineStatus: LightingBakeEngineStatus | null;
  engineStatusLoading: boolean;
  gpuProfile: GpuCapabilityProfile | null;
  onRefreshDevices: () => void;
  onConfigureEngine: () => void;
  onPreviewDraft: () => void;
  onCheck: () => void;
  preview: string | null;
  debug: boolean;
  comparison: boolean;
  motionPreview: boolean;
  busy: boolean;
  onLightingChange: (lighting: SceneLightingConfig) => void;
  onAppearanceChange: (appearance: SceneAppearanceConfig) => void;
  onPreset: (id: LightingManagerPresetId, target: 'lighting' | 'appearance') => void;
  onDebug: (value: boolean) => void;
  onComparison: (value: boolean) => void;
  onMotion: () => void;
  onRefresh: () => void;
};

/** 总览只编辑本地草稿；真实视口由宿主提供，照明与显示分别保存。 */
export function LightingBakeManagerOverview(props: LightingBakeManagerOverviewProps) {
  const { lighting, disabled, onLightingChange } = props;
  const { bake, shadows } = lighting;
  const onBakeChange = (patch: Partial<SceneLightingBakeSettings>) => onLightingChange({ ...lighting,
    version: patch.lightmapEncoding === 'rgbm-gamma' || patch.lightmapMipLevels ? 3 : lighting.version, bake: { ...bake, ...patch } });
  const onShadowChange = (patch: Partial<SceneLightingConfig['shadows']>) => onLightingChange({ ...lighting, shadows: { ...shadows, ...patch } });
  return <div className="lighting-manager-overview">
    <div className="lighting-manager-overview-settings">
      <section className="lighting-manager-card" aria-labelledby="lighting-overview-gpu-title">
        <h3 id="lighting-overview-gpu-title">本机图形能力</h3>
        <p className="lighting-manager-note" role="status" aria-live="polite">{props.gpuProfile?.status === 'measured'
          ? <>建议档位 <strong>{props.gpuProfile.tier}</strong> · {props.gpuProfile.source === 'cache' ? '已读取本机缓存' : '已完成本机检测'}</>
          : props.gpuProfile?.status === 'unavailable' ? '本机检测不可用，增强效果建议保留默认。' : '尚无本机检测结果，增强效果建议保留默认。'}</p>
        {props.gpuProfile?.driver && <p className="lighting-manager-note">{props.gpuProfile.driver.renderer}</p>}
        <p className="lighting-manager-note">{props.gpuProfile?.tier === 'T2' ? '可按场景需要手动尝试增强阴影与高质量间接光。'
          : props.gpuProfile?.tier === 'T1' ? '建议先使用标准效果，再按场景需要手动尝试增强项。' : '建议保持现有画质，增强项按实际场景手动选择。'} 当前设置未作任何调整。</p>
        <details className="lighting-manager-advanced"><summary>检测范围与建议说明</summary>
          {props.gpuProfile?.measurement && <p className="lighting-manager-note">固定离屏负载：3 帧预热、12 帧测量；中位 {props.gpuProfile.measurement.medianMs.toFixed(2)} ms，P95 {props.gpuProfile.measurement.p95Ms.toFixed(2)} ms。</p>}
          <p className="lighting-manager-note">计时包含 CPU 提交与同步等待，不是 GPU 计时器或整场景帧率。建议阈值尚未跨显卡校准，不会自动降低或切换画质。</p>
          {props.gpuProfile?.reason && <p className="lighting-manager-note">{props.gpuProfile.reason}</p>}
        </details>
      </section>
      <section className="lighting-manager-card" aria-labelledby="lighting-overview-shadow-title">
        <h3 id="lighting-overview-shadow-title">光照与阴影</h3>
        <LightingManagerToggle label="启用阴影" checked={shadows.enabled} disabled={disabled} onChange={enabled => onShadowChange({ enabled })} />
        <LightingManagerToggle label="静态阴影缓存" description="固定遮挡重复使用，动态设备保持更新" checked={bake.cacheStaticShadows}
          disabled={disabled || !shadows.enabled} onChange={cacheStaticShadows => onBakeChange({ cacheStaticShadows })} />
        <LightingManagerToggle label="动态阴影更新" description="运动部件继续产生实时遮挡" checked={bake.dynamicShadows}
          disabled={disabled || !shadows.enabled} onChange={dynamicShadows => onBakeChange({ dynamicShadows })} />
        <LightingManagerToggle label="间接光烘焙" description="静态间接光与环境漫反射写入独立资产" checked={bake.enabled}
          disabled={disabled} onChange={enabled => onBakeChange({ enabled })} />
        <p className="lighting-manager-note with-icon"><LightingManagerIcon name="check" size={16} />直射光、高光与反射保持实时</p>
      </section>
      <section className="lighting-manager-card" aria-labelledby="lighting-overview-bake-title">
        <h3 id="lighting-overview-bake-title">烘焙参数</h3>
        <div className="lighting-manager-engine-summary"><div><strong>本机烘焙引擎</strong><LightingManagerBadge tone={props.engineStatus?.available ? 'success' : 'warning'}>
          {props.engineStatusLoading ? '正在检测…' : props.engineStatus?.available ? `Blender ${props.engineStatus.version ?? ''} · 已就绪` : '未找到可用 Blender'}
        </LightingManagerBadge></div><button type="button" className="lighting-manager-primary" disabled={props.busy} onClick={props.onConfigureEngine}>配置引擎…</button></div>
        <label className="lighting-manager-field"><span>质量</span><select aria-label="烘焙质量" value={bake.quality} disabled={disabled}
          onChange={event => onBakeChange({ quality: event.target.value as SceneLightingBakeSettings['quality'] })}>
          <option value="preview">快速预览</option><option value="standard">标准</option><option value="high">高质量</option>
        </select></label>
        <LightingManagerToggle label="暗部精度（Gamma RGBM）" description="可选新编码，需要重新烘焙；启用后保存为光照配置 v3，旧版本编辑器无法打开"
          checked={bake.lightmapEncoding === 'rgbm-gamma'} disabled={disabled}
          onChange={enabled => onBakeChange({ lightmapEncoding: enabled ? 'rgbm-gamma' : 'rgbm' })} />
        <label className="lighting-manager-field"><span>远距离抗闪烁（有限Mip）</span><select aria-label="光照贴图Mip层级" value={bake.lightmapMipLevels ?? 0} disabled={disabled}
          onChange={event => {
            const levels = Number(event.target.value), next = { ...bake };
            if (levels === 0) delete next.lightmapMipLevels; else next.lightmapMipLevels = levels as SceneLightingBakeSettings['lightmapMipLevels'];
            onLightingChange({ ...lighting, version: levels ? 3 : lighting.version, bake: next });
          }}>
          <option value={0}>关闭（原单级贴图）</option>{[1, 2, 3, 4].map(level => <option key={level} value={level}>额外 {level} 级 LOD</option>)}
        </select></label>
        <p className="lighting-manager-note">显式启用需光照配置 v3 并重新烘焙；增加纹理内存。UV 间隔不足时会明确拒绝，保留旧结果。</p>
        <label className="lighting-manager-field"><span>计算设备</span><select aria-label="烘焙计算设备" value={bake.device ?? 'cpu'} disabled={disabled}
          onChange={event => onBakeChange({ device: event.target.value as SceneLightingBakeSettings['device'] })}>
          <option value="cpu">CPU</option><option value="auto">自动选择可用设备（新场景默认）</option><option value="gpu">GPU（需要可用设备）</option>
        </select></label>
        <div className="lighting-manager-device-status"><p className="lighting-manager-note">{props.engineStatusLoading ? '正在检测烘焙引擎与设备…' : props.engineStatus?.available
          ? (props.engineStatus.devices?.length ? props.engineStatus.devices.map(device => device.type + ' · ' + device.name + ' (' + device.backend + ')').join('；') : '引擎可用，尚未提供设备清单。')
          : props.engineStatus?.message ?? '尚未检测本机烘焙设备。'}</p>
          <button type="button" disabled={props.engineStatusLoading || props.busy} onClick={props.onRefreshDevices}>检测设备</button></div>
        <p className="lighting-manager-note">设备选择不影响已有 GI 有效性；GPU 需要可用设备，自动模式可回退 CPU。实际设备及回退原因记录在任务日志中。</p>
        <label className="lighting-manager-field"><span>图集尺寸</span><select aria-label="图集尺寸" value={bake.atlasSize} disabled={disabled}
          onChange={event => onBakeChange({ atlasSize: Number(event.target.value) as SceneLightingBakeSettings['atlasSize'] })}>
          {[1024, 2048, 4096].map(value => <option key={value} value={value}>{value} × {value}</option>)}
        </select></label>
        <LightingManagerNumberField label="纹理密度" value={bake.texelsPerMeter} unit="像素 / 米" min={4} max={256} step={4} disabled={disabled}
          onChange={texelsPerMeter => onBakeChange({ texelsPerMeter })} />
        <LightingManagerNumberField label="探针间距" value={bake.probeSpacing} unit="米" min={0.5} max={100} step={0.5} disabled={disabled}
          onChange={probeSpacing => onBakeChange({ probeSpacing })} />
        <LightingManagerNumberField label="贴图预算" value={bake.maxTextureMiB} unit="MiB" min={16} max={4096} step={16} disabled={disabled}
          onChange={maxTextureMiB => onBakeChange({ maxTextureMiB })} />
        <LightingBakeManagerProbeVolumes volumes={bake.probeVolumes} bounds={props.probeBounds} disabled={disabled} onChange={probeVolumes => onBakeChange({ probeVolumes })} />
        <details className="lighting-manager-advanced"><summary>高级阴影设置</summary>
          <label className="lighting-manager-field"><span>阴影质量</span><select aria-label="阴影质量" value={shadows.quality}
            disabled={disabled || !shadows.enabled} onChange={event => onShadowChange({ quality: event.target.value as SceneLightingConfig['shadows']['quality'] })}>
            <option value="performance">性能</option><option value="balanced">均衡</option><option value="quality">高质量</option>
          </select></label>
          <LightingManagerNumberField label="阴影浓度" value={Math.round((1 - shadows.darkness) * 100)} unit="%" min={15} max={100}
            disabled={disabled || !shadows.enabled} onChange={value => onShadowChange({ darkness: Math.round((1 - value / 100) * 10000) / 10000 })} />
          <LightingManagerNumberField label="阴影距离" value={shadows.distanceMeters} min={0} max={800} step={10} unit="米"
            disabled={disabled || !shadows.enabled} onChange={distanceMeters => onShadowChange({ distanceMeters })} />
          <LightingManagerNumberField label="阴影偏移" value={shadows.bias} min={0} max={0.02} step={0.001}
            disabled={disabled || !shadows.enabled} onChange={bias => onShadowChange({ bias })} />
          <LightingManagerNumberField label="法线偏移" value={shadows.normalBias} min={0} max={0.2} step={0.005}
            disabled={disabled || !shadows.enabled} onChange={normalBias => onShadowChange({ normalBias })} />
          <p className="lighting-manager-note">阴影距离为 0 时按相机自动计算。</p>
        </details>
      </section>
      <LightingBakeManagerLighting scene={props.scene} lighting={lighting} disabled={disabled}
        onChange={onLightingChange} onPreset={id => props.onPreset(id, 'lighting')} />
      <LightingBakeManagerAppearance appearance={props.appearance} disabled={disabled}
        onChange={props.onAppearanceChange} onPreset={id => props.onPreset(id, 'appearance')} />
    </div>
    <section className="lighting-manager-preview-card" aria-labelledby="lighting-overview-preview-title">
      <div className="lighting-manager-card-heading"><h3 id="lighting-overview-preview-title">场景预览</h3>
        <div className="lighting-manager-segment" role="group" aria-label="预览显示">
          <button type="button" aria-pressed={!props.debug} onClick={() => props.onDebug(false)}>正常材质</button>
          <button type="button" aria-pressed={props.debug} onClick={() => props.onDebug(true)}>分类预览</button>
        </div>
      </div>
      <div className="lighting-manager-preview">
        {props.preview ? <img src={props.preview} alt="当前场景的真实视口快照" draggable={false} />
          : <div className="lighting-manager-empty"><LightingManagerIcon name="cube" size={38} /><p>正在读取当前场景画面</p>
            <button type="button" onClick={props.onRefresh}>刷新场景预览</button></div>}
        <div className="lighting-manager-preview-actions">
          <button type="button" disabled={props.busy || props.motionPreview || props.preflightBusy || (!props.dirty && !props.previewDraftActive)} aria-pressed={props.previewDraftActive} onClick={props.onPreviewDraft}>{props.previewDraftActive ? '恢复已应用配置' : '临时预览草稿'}</button>
          <button type="button" aria-label="刷新场景预览" title="刷新场景预览" onClick={props.onRefresh}><LightingManagerIcon name="refresh" size={16} /></button>
          <button type="button" disabled={props.busy || props.previewDraftActive || props.preflightBusy || (props.dirty && !props.motionPreview)} onClick={props.onMotion}>
            <LightingManagerIcon name="motion" size={15} />{props.motionPreview ? '停止运动预览' : '运动预览'}
          </button>
        </div>
      </div>
      <div className="lighting-manager-preview-result">
        <div><h4>上次结果 <LightingManagerBadge tone={props.resultLabel === '可用' ? 'success' : 'warning'}>{props.resultLabel}</LightingManagerBadge></h4>
          {props.result ? <p>{props.result.statistics.atlasCount} 张图集<span>·</span>{props.result.statistics.probeCount} 个探针<span>·</span>{formatLightingBytes(props.result.statistics.textureBytes)}</p>
            : <p>尚无已保存的间接光结果</p>}
        </div>
        <button type="button" aria-pressed={props.comparison} disabled={props.busy || props.previewDraftActive || !props.result || (props.resultLabel !== '可用' && !props.comparison)}
          onClick={() => props.onComparison(!props.comparison)}>{props.comparison ? '恢复烘焙效果' : '查看烘焙前'}</button>
      </div>
      <p className="lighting-manager-preview-caption">{props.previewDraftActive ? '正在临时预览照明与显示，尚未应用。' : props.dirty ? '画面为当前已应用配置；可临时预览或应用草稿。' : '当前场景真实画面'}{props.motionPreview ? ' · 运动预览中' : ''}</p>
      {props.previewDraftActive && props.previewDraftSuppressed && <p className="lighting-manager-warning">草稿改变 GI 输入，临时预览期间停用旧间接光；恢复后重新校验已有结果。</p>}
      {props.previewDraftActive && props.previewDraftRules && <p className="lighting-manager-note">分类规则和对象例外只在列表中推演；临时画面仅预览照明与显示。</p>}
      <button type="button" disabled={props.disabled || props.previewDraftActive || props.preflightBusy} onClick={props.onCheck}>{props.preflightBusy ? '正在检查…' : props.dirty ? '应用并进行烘焙前检查' : '烘焙前检查'}</button>
    </section>
  </div>;
}
