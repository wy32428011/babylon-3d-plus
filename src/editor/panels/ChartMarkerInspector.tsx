import { useState, type DragEvent } from 'react';
import type { Entity } from '../model/Entity';
import { useEditorStore } from '../store/editorStore';
import { DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE, decodeDataPlatformScreenDragPayload } from '../assets/dataPlatformScreenDrag';
import { CHART_MARKER_REFRESH_EVENT } from '../../shared/chartMarkerEmbed';
import '../../styles/chart-marker.css';

export function ChartMarkerInspector({ entity, disabled }: { entity: Entity; disabled: boolean }) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const bind = useEditorStore((state) => state.bindChartMarkerScreen);
  const screen = entity.components.dataPlatformScreen;

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    if (disabled) return;
    const source = decodeDataPlatformScreenDragPayload(event.dataTransfer.getData(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE));
    if (!source || !bind(entity.id, source)) {
      setError('请拖入图表库中具有有效页面地址的大屏。');
      return;
    }
    setError('');
  }

  return (
    <fieldset className="transform-fieldset" disabled={disabled}>
      <legend>图表立标 · 大屏内容</legend>
      <div
        className={`chart-marker-screen-slot${dragOver ? ' is-drag-over' : ''}`}
        aria-label="图表立标大屏槽位"
        aria-disabled={disabled}
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <strong>{screen ? entity.components.chartMarker?.screenName || '已绑定大屏' : '将图表库大屏拖到这里'}</strong>
        <span>{screen ? '拖入其他大屏可替换内容' : '也可直接拖到场景中的立标上'}</span>
      </div>
      {screen ? (
        <div className="chart-marker-actions">
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(CHART_MARKER_REFRESH_EVENT, { detail: entity.id }))}>刷新内容</button>
          <button type="button" onClick={() => { bind(entity.id, null); setError(''); }}>清空大屏</button>
        </div>
      ) : null}
      <p className="muted">大屏按自身数据源配置实时刷新。修改大屏设计后可点击“刷新内容”重新加载。</p>
      {error ? <p className="chart-marker-error" role="alert">{error}</p> : null}
    </fieldset>
  );
}
