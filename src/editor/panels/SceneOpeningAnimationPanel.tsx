import { OpeningField } from '../opening/OpeningField';
import { OpeningPackagePanel } from '../opening/OpeningPackagePanel';
import {
  normalizeSceneOpeningAnimation, SCENE_OPENING_MIN_BREATHING_PERIOD_SECONDS,
  SCENE_OPENING_MAX_BREATHING_PERIOD_SECONDS, type SceneOpeningAnimationSettings,
} from '../model/sceneOpeningAnimation';
import {
  createDefaultReferenceOpening, getReferenceOpeningDuration, REFERENCE_OPENING_STAGE_LABELS,
  REFERENCE_OPENING_MAX_DESTINATIONS, REFERENCE_OPENING_MAX_STAGE_SECONDS,
  type SceneOpeningReferenceSettings, type SceneOpeningStageDurations, type SceneOpeningVisualDestination,
} from '../model/sceneOpeningReference';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';

type DestinationList = 'worldDestinations' | 'chinaDestinations';

/** 包配置与旧参考模板共用播放控制；各自参数独立保存。 */
export function SceneOpeningAnimationPanel({ readOnly = false }: { readOnly?: boolean }) {
  const stored = useEditorStore(state => state.scene.sceneSettings.openingAnimation);
  const sceneSessionId = useEditorStore(state => state.sceneSessionId);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const update = useEditorStore(state => state.updateSceneOpeningAnimation);
  const requestPreview = useEditorStore(state => state.requestOpeningAnimationPreview);
  const settings = normalizeSceneOpeningAnimation(stored);
  const reference = settings.reference;
  const defaults = createDefaultReferenceOpening();
  const disabled = readOnly || runtimeMode === 'preview';
  const supportsBreathing = settings.template === 'reference-huishan' || settings.package?.definition?.manifest?.renderer === 'reference-huishan';
  const total = Number(getReferenceOpeningDuration(reference).toFixed(3));

  function updateReference(patch: Partial<SceneOpeningReferenceSettings>) {
    const state = useEditorStore.getState();
    if (disabled || state.sceneSessionId !== sceneSessionId) return;
    const current = normalizeSceneOpeningAnimation(state.scene.sceneSettings.openingAnimation);
    update({ reference: { ...current.reference, ...patch } });
  }
  function updateDuration(index: number, seconds: number) {
    const current = normalizeSceneOpeningAnimation(useEditorStore.getState().scene.sceneSettings.openingAnimation).reference;
    updateReference({ stageDurations: current.stageDurations.map((value, at) => at === index ? seconds : value) as SceneOpeningStageDurations });
  }
  function updateLocation(list: DestinationList, index: number, patch: Partial<SceneOpeningVisualDestination>) {
    const current = normalizeSceneOpeningAnimation(useEditorStore.getState().scene.sceneSettings.openingAnimation).reference;
    updateReference({ [list]: current[list].map((location, at) => at === index ? { ...location, ...patch } : location) });
  }
  function addLocation(list: DestinationList, preset?: SceneOpeningVisualDestination) {
    const current = normalizeSceneOpeningAnimation(useEditorStore.getState().scene.sceneSettings.openingAnimation).reference;
    if (current[list].length >= REFERENCE_OPENING_MAX_DESTINATIONS) return;
    const origin = list === 'worldDestinations' ? current.worldOrigin : current.chinaOrigin;
    updateReference({ [list]: [...current[list], preset ?? { name: `自定义地点${current[list].length + 1}`, ...origin }] });
  }
  function removeLocation(list: DestinationList, index: number) {
    const current = normalizeSceneOpeningAnimation(useEditorStore.getState().scene.sceneSettings.openingAnimation).reference;
    updateReference({ [list]: current[list].filter((_, at) => at !== index) });
  }
  function durationField(index: number) {
    const label = index === 2 ? '全球飞线停留（秒）' : index === 5 ? '国内飞线停留（秒）' : `${REFERENCE_OPENING_STAGE_LABELS[index]}（秒）`;
    return <OpeningField key={`${sceneSessionId}:stage:${index}`} label={label} value={reference.stageDurations[index]}
      min={index === 2 || index === 5 ? 0 : .1} max={REFERENCE_OPENING_MAX_STAGE_SECONDS} disabled={disabled}
      onCommit={seconds => updateDuration(index, Number(seconds))} />;
  }
  function locations(list: DestinationList) {
    const world = list === 'worldDestinations';
    const label = world ? '全球' : '国内';
    const originKey = world ? 'worldOrigin' : 'chinaOrigin';
    return <details>
      <summary>{label}参考点位（{reference[list].length}）</summary>
      <p className="muted">UV 是参考画面坐标：左上为 (0,0)，X 向右、Y 向下，范围 0–1。不能填写经纬度。</p>
      {(['x', 'y'] as const).map(axis => <OpeningField key={`${sceneSessionId}:${originKey}:${axis}`}
        label={`${label}起点 UV ${axis.toUpperCase()}`} value={reference[originKey][axis]} min={0} max={1} disabled={disabled}
        onCommit={value => updateReference({ [originKey]: { ...reference[originKey], [axis]: Number(value) } })} />)}
      <label className="inspector-row"><span>添加{label}预置地点</span>
        <select aria-label={`添加${label}预置地点`} value="" disabled={disabled || reference[list].length >= REFERENCE_OPENING_MAX_DESTINATIONS}
          onChange={event => { const preset = defaults[list].find(location => location.name === event.target.value); if (preset) addLocation(list, preset); }}>
          <option value="">选择参考地点</option>
          {defaults[list].map(location => <option key={location.name} value={location.name}
            disabled={reference[list].some(saved => saved.name === location.name)}>{location.name}</option>)}
        </select>
      </label>
      {reference[list].map((location, index) => <details key={`${sceneSessionId}:${list}:${index}`}>
        <summary>{index + 1}. {location.name}</summary>
        <OpeningField label={`${label}地点${index + 1}名称`} value={location.name} required maxLength={80} disabled={disabled}
          onCommit={name => updateLocation(list, index, { name })} />
        {(['x', 'y'] as const).map(axis => <OpeningField key={axis} label={`${label}地点${index + 1} UV ${axis.toUpperCase()}`}
          value={location[axis]} min={0} max={1} disabled={disabled} onCommit={value => updateLocation(list, index, { [axis]: Number(value) })} />)}
        <button type="button" disabled={disabled} aria-label={`删除${label}参考地点 ${location.name}`} onClick={() => removeLocation(list, index)}>删除地点</button>
      </details>)}
      <div className="scene-settings-button-row">
        <button type="button" disabled={disabled || reference[list].length >= REFERENCE_OPENING_MAX_DESTINATIONS}
          onClick={() => addLocation(list)}>添加{label}自定义地点</button>
        <button type="button" disabled={disabled}
          onClick={() => updateReference({ [list]: defaults[list], [originKey]: defaults[originKey] })}>恢复{label}参考点位</button>
      </div>
      <p className="muted">每组最多 {REFERENCE_OPENING_MAX_DESTINATIONS} 个点位，空列表表示不绘制该组飞线。自定义地点初始位于起点，请按参考画面调整 UV。</p>
    </details>;
  }

  return <CollapsibleFieldset title="开场动画" className="scene-opening-animation-panel">
    <label className="inspector-row environment-visible-row"><span>进入场景时播放</span>
      <input type="checkbox" checked={settings.enabled} disabled={disabled} onChange={event => update({ enabled: event.target.checked })} />
    </label>
    <OpeningPackagePanel disabled={disabled} sceneSessionId={sceneSessionId} />
    {settings.template === 'reference-huishan' ? <>
    <p className="muted">参考模板：地球 → 全球业务 → 中国 → 江苏高亮与国内业务 → 无锡 → 惠山 → 已保存的场景视角。</p>
    <p className="muted">参考动画总时长：{total} 秒，共 9 个阶段。阶段时长独立保存，跳过后仍进入同一场景视角。</p>
    {durationField(2)}
    {durationField(5)}
    <details><summary>其它分镜时长</summary>
      {REFERENCE_OPENING_STAGE_LABELS.map((_, index) => index === 2 || index === 5 ? null : durationField(index))}
      <button type="button" disabled={disabled} onClick={() => updateReference({ stageDurations: defaults.stageDurations })}>恢复 62 秒参考节奏</button>
    </details>
    <details><summary>品牌与公司文案</summary>
      <p className="muted">这里修改叠加文字。部分公司名称和地图注记已烘焙在参考底图中，完整更换这些内容还需要替换底图。</p>
      {([
        ['brandName', '品牌名称', 80, false], ['companyName', '公司名称', 160, false],
        ['heroTitle', '开场主标题', 160, true], ['heroSubtitle', '开场副标题', 240, true],
        ['finaleTitle', '抵达惠山标题', 160, true],
      ] as const).map(([key, label, maxLength, multiline]) => <OpeningField key={`${sceneSessionId}:${key}`} label={label}
        value={reference[key]} maxLength={maxLength} multiline={multiline} disabled={disabled} onCommit={value => updateReference({ [key]: value })} />)}
    </details>
    <label className="inspector-row"><span>参考画质</span><select aria-label="参考画质" value={reference.quality} disabled={disabled}
      onChange={event => updateReference({ quality: event.target.value as 'high' | 'low' })}>
      <option value="high">高清</option><option value="low">流畅</option></select></label>
    <label className="inspector-row environment-visible-row"><span>显示开场界面</span>
      <input type="checkbox" checked={reference.showUI} disabled={disabled} onChange={event => updateReference({ showUI: event.target.checked })} /></label>
    </> : null}
    <label className="inspector-row environment-visible-row"><span>允许跳过开场</span>
      <input type="checkbox" checked={settings.allowSkip} disabled={disabled} onChange={event => update({ allowSkip: event.target.checked })} /></label>
    <label className="inspector-row"><span>动效偏好</span><select aria-label="动效偏好" value={settings.motionPreference} disabled={disabled}
      onChange={event => update({ motionPreference: event.target.value as SceneOpeningAnimationSettings['motionPreference'] })}>
      <option value="normal">完整播放</option><option value="reduced">减少动态</option><option value="system">跟随系统</option></select></label>
    {supportsBreathing ? <details><summary>科技呼吸效果</summary>
      <label className="inspector-row environment-visible-row"><span>启用呼吸效果</span>
        <input type="checkbox" aria-label="科技呼吸效果" checked={settings.breathingEnabled} disabled={disabled}
          onChange={event => update({ breathingEnabled: event.target.checked })} /></label>
      <OpeningField key={`${sceneSessionId}:breathing-intensity`} label="呼吸强度（%）" value={Number((settings.breathingIntensity * 100).toFixed(4))}
        min={0} max={100} disabled={disabled || !settings.breathingEnabled} onCommit={percent => update({ breathingIntensity: Number(percent) / 100 })} />
      <OpeningField key={`${sceneSessionId}:breathing-period`} label="呼吸周期（秒）" value={settings.breathingPeriodSeconds}
        min={SCENE_OPENING_MIN_BREATHING_PERIOD_SECONDS} max={SCENE_OPENING_MAX_BREATHING_PERIOD_SECONDS}
        disabled={disabled || !settings.breathingEnabled} onCommit={value => update({ breathingPeriodSeconds: Number(value) })} />
      <p className="muted">关闭或强度为 0 时保留基本飞线运动；减少动态模式停用附加呼吸和扫光。</p>
    </details> : null}
    <label className="inspector-row"><span>结束行为</span><select aria-label="结束行为" value={settings.afterOpening} disabled={disabled}
      onChange={event => update({ afterOpening: event.target.value as SceneOpeningAnimationSettings['afterOpening'] })}>
      <option value="stay">停留最终视角</option><option value="auto-patrol">继续已配置巡检</option></select></label>
    {settings.afterOpening === 'auto-patrol' ? <p className="muted">开场结束后继续已配置为自动启动的巡检；没有该路线时停留最终视角。</p> : null}
    {settings.template === 'reference-huishan' ? <>
    {reference.legacyUnmappedNames?.length ? <div role="status"><p className="muted">以下历史点位无法匹配参考画面，已保留旧经纬度档案，请重新添加并设置 UV：{reference.legacyUnmappedNames.join('、')}</p>
      <button type="button" disabled={disabled} onClick={() => updateReference({ legacyUnmappedNames: undefined })}>清除迁移提示</button></div> : null}
    {locations('worldDestinations')}
    {locations('chinaDestinations')}
    <p className="muted">参考 UV、地图与飞线均为视觉示意，不是实际航班或 GIS 定位。最终衔接使用当前保存的场景相机。</p>
    </> : null}
    <div className="scene-settings-button-row">
      <button type="button" disabled={disabled} onClick={() => requestPreview('play')}>预览开场动画</button>
      <button type="button" onClick={() => requestPreview('stop')}>停止预览</button>
    </div>
    <p className="muted">配置随场景保存、撤销重做和发布；预览不覆盖已保存视角，停止后恢复编辑视角。</p>
  </CollapsibleFieldset>;
}
