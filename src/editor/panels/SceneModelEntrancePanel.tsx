import { normalizeSceneModelEntranceSettings, SCENE_MODEL_ENTRANCE_EFFECTS, type SceneModelEntranceSettings } from '../model/sceneModelEntrance';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';
import { ENVIRONMENT_EFFECT_TARGET_ID } from '../model/environmentBuildingEffect';

const EFFECT_LABELS = { fade: '柔和渐显', scan: '蓝光扫描', dissolve: '溶解生成', hologram: '线框转实体',
  particles: '粒子聚合', assembly: '部件归位', radial: '波纹扩散', stagger: '分区依次出现' };
type NumberKey = { [K in keyof SceneModelEntranceSettings]: SceneModelEntranceSettings[K] extends number ? K : never }[keyof SceneModelEntranceSettings];

export function SceneModelEntrancePanel({ readOnly = false }: { readOnly?: boolean }) {
  const scene = useEditorStore(state => state.scene);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const update = useEditorStore(state => state.updateSceneModelEntranceSettings);
  const settings = normalizeSceneModelEntranceSettings(scene.sceneSettings.modelEntrance);
  const disabled = readOnly || runtimeMode === 'preview';
  const targets = [
    ...(scene.sceneSettings.environment ? [{ id: ENVIRONMENT_EFFECT_TARGET_ID, name: '环境模型：' + (scene.sceneSettings.environment.displayName || '当前环境') }] : []),
    ...scene.entityIds.map(id => scene.entities[id]).filter(entity => entity
      && !entity.components.modelArrayInstance && (entity.components.modelAsset || entity.components.meshRenderer))
      .map(entity => ({ id: entity.id, name: entity.name })),
  ];
  const directional = ['scan', 'dissolve', 'hologram', 'assembly', 'stagger'].includes(settings.effect);
  const colored = ['scan', 'dissolve', 'hologram', 'particles', 'radial'].includes(settings.effect);
  function change(patch: Partial<SceneModelEntranceSettings>) {
    if (!disabled) update(patch);
  }
  function numberRow(key: NumberKey, label: string, min: number, max: number, step = 0.1) {
    return <label className="inspector-row" key={key}><span>{label}</span>
      <input key={`${key}-${settings[key]}`} type="number" min={min} max={max} step={step}
        defaultValue={settings[key]} disabled={disabled || !settings.enabled}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        onBlur={event => {
          const value = event.currentTarget.value.trim() === '' ? NaN : Number(event.currentTarget.value);
          if (Number.isFinite(value)) {
            change({ [key]: value });
            event.currentTarget.value = String(normalizeSceneModelEntranceSettings({ ...settings, [key]: value })[key]);
          }
          else event.currentTarget.value = String(settings[key]);
        }} /></label>;
  }
  return <CollapsibleFieldset title="模型入场动画" className="scene-model-entrance-panel">
    <label className="inspector-row"><span>启用入场动画</span><input type="checkbox" checked={settings.enabled}
      disabled={disabled} onChange={event => change({ enabled: event.target.checked })} /></label>
    <p className="muted">进入运行态及打开发布场景时播放；等待模型加载与开场动画结束后开始。关闭循环时每次进入只播放一次。</p>
    <label className="inspector-row"><span>动画效果</span><select value={settings.effect} disabled={disabled || !settings.enabled}
      onChange={event => change({ effect: event.target.value as SceneModelEntranceSettings['effect'] })}>
      {SCENE_MODEL_ENTRANCE_EFFECTS.map(effect => <option key={effect} value={effect}>{EFFECT_LABELS[effect]}</option>)}
    </select></label>
    {numberRow('durationSeconds', '播放时长（秒）', 0.2, 30)}
    {numberRow('delaySeconds', '开始延迟（秒）', 0, 30)}
    {colored && <><label className="inspector-row"><span>特效颜色</span><input type="color" value={settings.color}
      disabled={disabled || !settings.enabled} onChange={event => change({ color: event.target.value })} /></label>
      {numberRow('intensity', '特效强度', 0, 5)}</>}
    {directional && <><label className="inspector-row"><span>动画方向</span><select value={settings.axis}
      disabled={disabled || !settings.enabled} onChange={event => change({ axis: event.target.value as SceneModelEntranceSettings['axis'] })}>
      <option value="x">X 轴</option><option value="y">Y 轴</option><option value="z">Z 轴</option></select></label>
      <label className="inspector-row"><span>反向播放</span><input type="checkbox" checked={settings.reverse}
        disabled={disabled || !settings.enabled} onChange={event => change({ reverse: event.target.checked })} /></label></>}
    {settings.effect === 'stagger' && numberRow('staggerSeconds', '模型间隔（秒）', 0, 5)}
    {settings.effect === 'particles' && <>{numberRow('particleCount', '粒子数量', 50, 5000, 1)}
      {numberRow('particleSize', '粒子大小', 1, 12, 0.5)}{numberRow('spreadMeters', '聚合范围（米）', 0, 30)}</>}
    {settings.effect === 'assembly' && <>{numberRow('assemblyDistanceMeters', '归位距离（米）', 0, 30)}
      <p className="muted">以模型中的可绘制部件归位；单网格模型表现为整体归位。</p></>}
    <label className="inspector-row"><span>循环播放</span><input type="checkbox" checked={settings.loop}
      disabled={disabled || !settings.enabled} onChange={event => change({ loop: event.target.checked })} /></label>
    {settings.loop && numberRow('loopIntervalSeconds', '循环间隔（秒）', 0, 30)}
    <label className="inspector-row"><span>作用范围</span><select value={settings.scope} disabled={disabled || !settings.enabled}
      onChange={event => change({ scope: event.target.value as SceneModelEntranceSettings['scope'] })}>
      <option value="all">全部模型（含环境）</option><option value="selected">指定模型</option></select></label>
    {settings.scope === 'selected' && <><div className="inspector-row"><span>指定模型</span>
      <select aria-label="入场动画指定模型" multiple size={Math.min(6, Math.max(2, targets.length))}
        value={settings.targetEntityIds} disabled={disabled || !settings.enabled}
        onChange={event => change({ targetEntityIds: Array.from(event.currentTarget.selectedOptions, option => option.value) })}>
        {targets.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
        {settings.targetEntityIds.filter(id => !targets.some(entity => entity.id === id)).map(id => <option key={id} value={id}>已缺失模型：{id}</option>)}
      </select></div><p className="muted">按住 Ctrl 可多选；没有指定模型时不播放。</p></>}
    <p className="muted">全部模型包含可见环境；也可指定环境单独播放。天空盒、灯光和标注保持原样。模型阵列按来源模型整组播放，运行中新增设备不重播。</p>
  </CollapsibleFieldset>;
}
