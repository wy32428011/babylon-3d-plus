import {
  OPENING_PACKAGE_MAX_STAGES, type OpeningPackageBinding, type OpeningPackageConfig, type OpeningPackageStage, type OpeningTextStyle, type OpeningPackageAsset,
} from '../../shared/opening/openingPackage';
import { OpeningField, openingColorInputValue } from './OpeningField';
import { OpeningRouteEditor } from './OpeningRouteEditor';
import { resolveOpeningAssetUrl } from '../../runtime/opening/openingPackageAssets';

export function openingPackageAssetUrl(binding: OpeningPackageBinding, assetId?: string): string | undefined {
  if (!assetId) return undefined;
  const replacement = binding.config.assetOverrides?.[assetId];
  if (replacement) return replacement.assetUrl;
  const asset = binding.definition.manifest.assets.find(entry => entry.id === assetId);
  if (!asset) return undefined;
  try { return resolveOpeningAssetUrl(binding.manifestUrl, asset.path); }
  catch { return undefined; }
}

function TextStyleEditor({ value, disabled, label, assets, onChange }: {
  value?: OpeningTextStyle; disabled: boolean; label: string; assets: OpeningPackageAsset[]; onChange: (value: OpeningTextStyle) => void;
}) {
  const style = value ?? {};
  const defaults = label === '标题' ? { color: '#eff8ff', fontSize: 64, x: .07, y: .16 } : { color: '#84d7ff', fontSize: 25, x: .07, y: .32 };
  return <details><summary>{label}样式</summary>
    <label className="inspector-row"><span>{label}颜色</span><input type="color" aria-label={`${label}颜色`} disabled={disabled} value={openingColorInputValue(style.color ?? defaults.color)}
      onChange={event => onChange({ ...style, color: event.target.value })} /></label>
    <OpeningField label={`${label}字号`} value={style.fontSize ?? defaults.fontSize} min={8} max={240} disabled={disabled} onCommit={value => onChange({ ...style, fontSize: Number(value) })} />
    {(['x', 'y'] as const).map(axis => <OpeningField key={axis} label={`${label}位置 ${axis.toUpperCase()}`} value={style[axis] ?? defaults[axis]}
      min={0} max={1} disabled={disabled} onCommit={value => onChange({ ...style, [axis]: Number(value) })} />)}
    <label className="inspector-row"><span>{label}对齐</span><select aria-label={`${label}对齐`} value={style.align ?? 'left'} disabled={disabled}
      onChange={event => onChange({ ...style, align: event.target.value as OpeningTextStyle['align'] })}>
      <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
    </select></label>
    {assets.some(asset => asset.type === 'font') ? <label className="inspector-row"><span>{label}字体</span><select aria-label={`${label}字体`} value={style.fontAssetId ?? ''} disabled={disabled}
      onChange={event => { const next = { ...style }; if (event.target.value) next.fontAssetId = event.target.value; else delete next.fontAssetId; onChange(next); }}>
      <option value="">系统字体</option>{assets.filter(asset => asset.type === 'font').map(asset => <option key={asset.id} value={asset.id}>{asset.id}</option>)}
    </select></label> : null}
  </details>;
}

export function OpeningStageEditor({ binding, disabled, onChange }: {
  binding: OpeningPackageBinding; disabled: boolean; onChange: (config: OpeningPackageConfig) => void;
}) {
  const { config, definition } = binding;
  const generic = definition.manifest.renderer === 'timeline';
  const updateStage = (id: string, patch: Partial<OpeningPackageStage>) => onChange({ ...config, stages: config.stages.map(stage => {
    if (stage.id !== id) return stage;
    // 删除可选字段使用缺省键，避免 undefined 混入可持久化的 JSON 配置。
    return Object.fromEntries(Object.entries({ ...stage, ...patch }).filter(([, value]) => value !== undefined)) as OpeningPackageStage;
  }) });
  const move = (index: number, delta: number) => {
    const stages = [...config.stages], other = index + delta;
    if (other < 0 || other >= stages.length) return;
    [stages[index], stages[other]] = [stages[other], stages[index]]; onChange({ ...config, stages });
  };
  function assetSelect(stage: OpeningPackageStage, property: 'backgroundAssetId' | 'logoAssetId', label: string) {
    const bindingKey = property === 'backgroundAssetId' ? stage.backgroundKey : stage.logoKey;
    const selected = bindingKey ? String(config.values[bindingKey] ?? '') : stage[property] ?? '';
    return <label className="inspector-row"><span>{label}</span><select aria-label={label} value={selected} disabled={disabled} onChange={event => {
      if (bindingKey) onChange({ ...config, values: { ...config.values, [bindingKey]: event.target.value } });
      else updateStage(stage.id, { [property]: event.target.value || undefined });
    }}><option value="">不使用素材</option>{definition.manifest.assets.filter(asset => asset.type === 'image').map(asset => <option key={asset.id} value={asset.id}>{asset.id}</option>)}</select></label>;
  }
  return <div className="opening-package-stages">
    <p className="muted">共 {config.stages.length} 个分镜，总时长 {Number(config.stages.reduce((sum, stage) => sum + stage.durationSeconds, 0).toFixed(3))} 秒。{generic ? '时长为 0 的分镜直接跳过。' : '全球和国内停留允许设置为 0 秒。'}</p>
    {config.stages.map((stage, index) => <details key={stage.id}>
      <summary>{index + 1}. {stage.label}（{stage.durationSeconds} 秒）</summary>
      <OpeningField label="分镜名称" value={stage.label} maxLength={160} disabled={disabled} onCommit={label => updateStage(stage.id, { label })} />
      <OpeningField label="分镜时长（秒）" value={stage.durationSeconds} min={generic || index === 2 || index === 5 ? 0 : .1} max={300} disabled={disabled} onCommit={value => updateStage(stage.id, { durationSeconds: Number(value) })} />
        {(['title', 'subtitle', 'description'] as const).map((key, at) => {
          const keyField = `${key}Key` as 'titleKey' | 'subtitleKey' | 'descriptionKey';
          const parameter = stage[keyField];
          return <OpeningField key={key} label={['分镜标题', '分镜副标题', '分镜说明'][at]}
            value={parameter ? String(config.values[parameter] ?? '') : stage[key] ?? ''} multiline maxLength={8192} disabled={disabled}
            onCommit={text => parameter ? onChange({ ...config, values: { ...config.values, [parameter]: text } }) : updateStage(stage.id, { [key]: text })} />;
        })}
      {generic ? <>
        {assetSelect(stage, 'backgroundAssetId', '分镜底图')}{assetSelect(stage, 'logoAssetId', '分镜 Logo')}
        <label className="inspector-row"><span>背景颜色</span><input type="color" aria-label="背景颜色" value={openingColorInputValue(stage.backgroundColor ?? '#020813')} disabled={disabled}
          onChange={event => updateStage(stage.id, { backgroundColor: event.target.value })} /></label>
        <TextStyleEditor label="标题" value={stage.textStyle} assets={definition.manifest.assets} disabled={disabled} onChange={textStyle => updateStage(stage.id, { textStyle })} />
        <TextStyleEditor label="副标题" value={stage.subtitleStyle} assets={definition.manifest.assets} disabled={disabled} onChange={subtitleStyle => updateStage(stage.id, { subtitleStyle })} />
        <details><summary>镜头与转场</summary>{([
          ['zoomFrom', '起始缩放', 1, .1, 8], ['zoomTo', '结束缩放', 1, .1, 8], ['panX', '水平平移', 0, -1, 1],
          ['panY', '垂直平移', 0, -1, 1], ['transitionSeconds', '淡入时长（秒）', .6, 0, 10],
        ] as const).map(([key, label, fallback, min, max]) => <OpeningField key={key} label={label} value={stage[key] ?? fallback} min={min} max={max} disabled={disabled}
          onCommit={value => updateStage(stage.id, { [key]: Number(value) })} />)}</details>
      </> : null}
      {(generic || stage.routes !== undefined) ? <details><summary>飞线与点位（{stage.routes?.length ?? 0}）</summary>
        <OpeningRouteEditor key={stage.id} routes={stage.routes ?? []} style={stage.routeStyle} origin={stage.origin} disabled={disabled} imageCoordinates={!generic}
          backgroundUrl={openingPackageAssetUrl(binding, stage.backgroundKey ? String(config.values[stage.backgroundKey] ?? '') : stage.backgroundAssetId)}
          onChange={routes => updateStage(stage.id, { routes })} />
      </details> : null}
      {generic ? <div className="scene-settings-button-row">
        <button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)}>上移分镜</button>
        <button type="button" disabled={disabled || index === config.stages.length - 1} onClick={() => move(index, 1)}>下移分镜</button>
        <button type="button" disabled={disabled || config.stages.length >= OPENING_PACKAGE_MAX_STAGES} onClick={() => {
          const stages = [...config.stages]; stages.splice(index + 1, 0, { ...structuredClone(stage), id: `stage-${crypto.randomUUID()}`, label: `${stage.label.slice(0, 150)} 副本` });
          onChange({ ...config, stages });
        }}>复制分镜</button>
        <button type="button" disabled={disabled || config.stages.length <= 1} onClick={() => onChange({ ...config, stages: config.stages.filter(item => item.id !== stage.id) })}>删除分镜</button>
      </div> : null}
    </details>)}
    <div className="scene-settings-button-row">
      {generic ? <button type="button" disabled={disabled || config.stages.length >= OPENING_PACKAGE_MAX_STAGES} onClick={() => onChange({ ...config,
        stages: [...config.stages, { id: `stage-${crypto.randomUUID()}`, label: '新分镜', durationSeconds: 5, title: '新分镜', routes: [] }] })}>添加分镜</button> : null}
      <button type="button" disabled={disabled} onClick={() => onChange({ ...config, stages: structuredClone(definition.timeline.stages) })}>恢复包默认分镜</button>
    </div>
    {!generic ? <p className="muted">参考包固定为九阶段；分镜时长、飞线和上方品牌参数独立保存。</p> : null}
  </div>;
}
