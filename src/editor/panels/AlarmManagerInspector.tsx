import { useEffect, useState, type DragEvent } from 'react';
import type { Entity } from '../model/Entity';
import type { ChartMarkerThemeScreen, ModelGeneratorTarget } from '../model/components';
import { ALARM_MAX_TARGETS, normalizeAlarmManager, resizeAlarmTargets, type AlarmManagerComponent } from '../model/alarmManager';
import { createModelGeneratorTargetFromAsset } from '../model/modelGenerator';
import { decodeModelAssetDragPayload, MODEL_ASSET_DRAG_MIME_TYPE } from '../assets/AssetDatabase';
import { DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE, decodeDataPlatformScreenDragPayload } from '../assets/dataPlatformScreenDrag';
import { useEditorStore } from '../store/editorStore';
import { ChartMarkerInspector } from './ChartMarkerInspector';
import type { DataPlatformChartAssetEntry } from '../assets/dataPlatformChartLibrary';
import '../../styles/alarm-manager.css';

type AlarmChartApi = {
  listDataPlatformCharts?: () => Promise<{ charts: DataPlatformChartAssetEntry[] }>;
  onDataPlatformChartSyncProgress?: (listener: (progress: { phase: string }) => void) => () => void;
};

function ModelSlot({ label, value, disabled, onChange }: { label: string; value: ModelGeneratorTarget | null; disabled: boolean; onChange: (value: ModelGeneratorTarget | null) => void }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); event.stopPropagation(); setOver(false);
    if (disabled) return;
    const asset = decodeModelAssetDragPayload(event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE));
    const target = asset ? createModelGeneratorTargetFromAsset(asset) : null;
    if (!target) { setError('请从模型库拖入普通模型。'); return; }
    setError(''); onChange(target);
  }
  return <div>
    <div className={'alarm-model-slot model-generator-target-slot' + (over ? ' model-generator-target-slot-active' : '')} role="group" aria-label={label}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); const accepted = !disabled && event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE); event.dataTransfer.dropEffect = accepted ? 'copy' : 'none'; setOver(accepted); }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false); }} onDrop={drop}>
      <span className="model-generator-target-text"><strong>{value?.displayName || '从模型库拖入模型'}</strong></span>
      <button className="model-generator-clear-button" type="button" disabled={disabled || !value} aria-label={'清空' + label} onClick={() => onChange(null)}>×</button>
    </div>
    {error ? <p role="alert" className="chart-marker-error">{error}</p> : null}
  </div>;
}

export function AlarmManagerInspector({ entity, disabled }: { entity: Entity; disabled: boolean }) {
  const c = entity.components.alarmManager!;
  const update = useEditorStore(state => state.updateAlarmManager);
  const entities = useEditorStore(state => state.scene.entities);
  const sessionId = useEditorStore(state => state.sceneSessionId);
  const [charts, setCharts] = useState<DataPlatformChartAssetEntry[]>([]);
  const [error, setError] = useState('');
  const [size, setSize] = useState(String(c.targets.length));
  useEffect(() => setSize(String(c.targets.length)), [c.targets.length]);
  useEffect(() => {
    let current = true;
    let generation = 0;
    const api = (window.editorApi ?? {}) as AlarmChartApi;
    const load = async () => {
      const request = ++generation;
      try {
        const result = await api.listDataPlatformCharts?.();
        if (current && generation === request) { setCharts(result?.charts ?? []); setError(''); }
      } catch { if (current && generation === request) setError('图表库读取失败，请在图表库重新同步。'); }
    };
    setCharts([]); void load();
    const unsubscribe = api.onDataPlatformChartSyncProgress?.(progress => { if (progress.phase === 'completed') void load(); });
    return () => { current = false; unsubscribe?.(); };
  }, [sessionId]);
  function commit(patch: Partial<AlarmManagerComponent>) {
    if (disabled) return;
    try { normalizeAlarmManager({ ...c, ...patch }); update(entity.id, patch); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '报警配置无效'); }
  }
  function commitSize() {
    const next = Number(size);
    if (size.trim() && Number.isInteger(next) && next >= 0 && next <= ALARM_MAX_TARGETS) commit({ targets: resizeAlarmTargets(c.targets, next) });
    else { setError('目标 Size 必须为 0–64 的整数。'); setSize(String(c.targets.length)); }
  }
  function themeField(label: string, key: 'theme' | 'warehouseTheme' | 'markerScreen') {
    const selected = c[key];
    const selectedId = selected ? selected.projectId + ':' + selected.screenId : '';
    const available = charts.filter(chart => Boolean(chart.screenUrl));
    const accept = (screen: ChartMarkerThemeScreen | null) => commit({ [key]: screen });
    return <label className="inspector-row" onDragOver={event => { if (!disabled && event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE)) { event.preventDefault(); event.stopPropagation(); } }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation(); if (disabled) return;
        const screen = decodeDataPlatformScreenDragPayload(event.dataTransfer.getData(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE));
        if (!screen?.screenUrl) { setError('请拖入有有效地址的图表库大屏。'); return; }
        accept({ projectId: screen.projectId, screenId: screen.screenId, name: screen.name, screenUrl: screen.screenUrl, ...(screen.thumbnailUrl ? { thumbnailUrl: screen.thumbnailUrl } : {}) });
      }}>
      <span>{label}</span>
      <select aria-label={label} value={selectedId} onChange={event => {
        const chart = available.find(chart => chart.projectId + ':' + chart.screenId === event.target.value);
        accept(chart?.screenUrl ? { projectId: chart.projectId, screenId: chart.screenId, name: chart.name, screenUrl: chart.screenUrl, ...(chart.thumbnailUrl ? { thumbnailUrl: chart.thumbnailUrl } : {}) } : null);
      }}>
        <option value="">无</option>
        {selected && !available.some(chart => chart.projectId + ':' + chart.screenId === selectedId) ? <option value={selectedId}>{selected.name}（已保存）</option> : null}
        {available.map(chart => <option key={chart.id} value={chart.projectId + ':' + chart.screenId}>{chart.name}</option>)}
      </select>
    </label>;
  }
  return <>
    <fieldset className="transform-fieldset model-generator-fieldset alarm-manager-fieldset" disabled={disabled}>
      <legend>POIAlarmSpawnerComponent</legend>
      <label className="inspector-row"><span>监听属性</span><select aria-label="监听属性" value={c.listenProperty} onChange={event => commit({ listenProperty: event.target.value as AlarmManagerComponent['listenProperty'] })}><option>RUNNING STATE</option><option>CUSTOM PROPERTY</option></select></label>
      {c.listenProperty === 'RUNNING STATE' ? <label className="inspector-row"><span>运行状态</span><select aria-label="运行状态" value={c.runningState} onChange={event => commit({ runningState: event.target.value as AlarmManagerComponent['runningState'] })}><option value="offline">离线</option><option value="idle">空闲</option><option value="running">运行</option><option value="alarm">报警</option></select></label> : <>
        <label className="inspector-row"><span>火警属性</span><input value={c.customProperty} maxLength={256} onChange={event => commit({ customProperty: event.target.value })} /></label>
        <label className="inspector-row"><span>触发值</span><input value={c.customValue} maxLength={256} onChange={event => commit({ customValue: event.target.value })} /></label>
      </>}
      <label className="inspector-row"><span>覆盖颜色</span><input type="color" value={c.overrideColor} onChange={event => commit({ overrideColor: event.target.value })} /></label>
      <div className="inspector-row"><span>外观模型</span><ModelSlot label="报警外观模型" value={c.appearanceModel} disabled={disabled} onChange={appearanceModel => commit({ appearanceModel })} /></div>
      <p className="muted">外观模型为空时使用内置火焰；报警解除后自动移除并恢复设备颜色。</p>
      {themeField('告警主题', 'theme')}
      <label className="inspector-row"><span>显示图表立标</span><input type="checkbox" checked={c.showMarker} onChange={event => commit({ showMarker: event.target.checked })} /></label>
      {c.showMarker ? <>
        <label className="inspector-row"><span>立标分类</span><select aria-label="立标分类" value={c.markerCategory} onChange={event => commit({ markerCategory: event.target.value })}>{['人员', '设备', '火警', '仓库'].map(label => <option key={label}>{label}</option>)}</select></label>
        <label className="inspector-row"><span>关联类型</span><select aria-label="关联类型" value={c.associationType} onChange={event => commit({ associationType: event.target.value as AlarmManagerComponent['associationType'] })}><option value="chart">图表库</option><option value="third-party">第三方</option><option value="video">视频</option><option value="builtin">内置样式</option></select></label>
        {c.associationType === 'chart' ? themeField('图表样式', 'markerScreen') : null}
        {c.associationType === 'third-party' || c.associationType === 'video' ? <label className="inspector-row"><span>{c.associationType === 'video' ? '视频地址' : '页面地址'}</span><input key={c.contentUrl} type="url" defaultValue={c.contentUrl} placeholder="https://…" onBlur={event => commit({ contentUrl: event.target.value })} /></label> : null}
        <ChartMarkerInspector entity={entity} disabled={disabled} alarmAppearance />
      </> : null}
      <label className="inspector-row"><span>仓库告警</span><input type="checkbox" checked={c.warehouseAlarm} onChange={event => commit({ warehouseAlarm: event.target.checked })} /></label>
      {c.warehouseAlarm ? themeField('仓库告警主题', 'warehouseTheme') : null}
      <label className="inspector-row"><span>摄像机聚焦</span><input type="checkbox" checked={c.focusCamera} onChange={event => commit({ focusCamera: event.target.checked })} /></label>
      <label className="inspector-row"><span>目标类型</span><select aria-label="目标类型" value={c.targetType} onChange={event => commit({ targetType: event.target.value as AlarmManagerComponent['targetType'] })}><option>ENTITY</option><option>MODEL</option></select></label>
      <details open><summary>目标</summary>
        <label className="inspector-row"><span>Size</span><input aria-label="目标 Size" type="number" min={0} max={ALARM_MAX_TARGETS} step={1} value={size} onChange={event => setSize(event.target.value)} onBlur={commitSize} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        {c.targets.map((slot, index) => <div key={slot.id} className="click-event-binding-event-card">
          <span>设备类型 {index + 1}</span><ModelSlot label={'设备类型 ' + (index + 1)} value={slot.model} disabled={disabled} onChange={model => commit({ targets: c.targets.map(t => t.id === slot.id ? { ...t, model, entityId: '' } : t) })} />
          {c.targetType === 'ENTITY' ? <label className="inspector-row"><span>场景设备</span><select value={slot.entityId} onChange={event => commit({ targets: c.targets.map(t => t.id === slot.id ? { ...t, entityId: event.target.value } : t) })}>
            <option value="">该模型全部实例</option>
            {slot.entityId && !entities[slot.entityId] ? <option value={slot.entityId}>目标已删除</option> : null}
            {Object.values(entities).filter(e => e.components.modelAsset && (!slot.model || slot.model.kind === 'model' && e.components.modelAsset.sourceUrl === slot.model.modelAsset.sourceUrl)).map(e => <option key={e.id} value={e.id}>{e.name} · {e.components.modelAsset?.assetCode}</option>)}
          </select></label> : null}
        </div>)}
      </details>
      <p className="muted">ENTITY 可限定场景设备；MODEL 监听所选模型的全部实例。设备需配置 MQTT 遥测；未收到数据时不触发，离线按设备超时判断。</p>
      {error ? <p role="alert" className="chart-marker-error">{error}</p> : null}
    </fieldset>
  </>;
}
