import { useEffect, useState, type DragEvent } from 'react';
import { MAX_REGION_VIEW_NAME_LENGTH, MAX_SCENE_REGION_VIEWS, type SceneRegionView } from '../model/sceneRegionViews';
import { useEditorStore } from '../store/editorStore';

const REGION_VIEW_DRAG_TYPE = 'application/x-zending-region-view';
type DropTarget = { id: string; position: 'before' | 'after' };

function dropPosition(event: DragEvent<HTMLDivElement>): DropTarget['position'] {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

function RegionViewRow({ view, disabled, isFirst, isLast, onDragStart }: {
  view: SceneRegionView; disabled: boolean; isFirst: boolean; isLast: boolean;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
}) {
  const [name, setName] = useState(view.name);
  const rename = useEditorStore(state => state.renameRegionView);
  const request = useEditorStore(state => state.requestRegionView);
  const remove = useEditorStore(state => state.deleteRegionView);
  const move = useEditorStore(state => state.moveRegionView);
  useEffect(() => setName(view.name), [view.name]);
  return (
    <div style={{ display: 'grid', gap: 6, padding: '8px 0', borderBottom: '1px solid var(--border-color, #39424c)' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" aria-label={`拖拽排序：${view.name}`} title="按住拖拽调整顺序"
          disabled={disabled || (isFirst && isLast)} draggable={!disabled && !(isFirst && isLast)}
          onDragStart={onDragStart} style={{ cursor: disabled || (isFirst && isLast) ? 'default' : 'grab', padding: '2px 5px', flexShrink: 0 }}>
          <svg width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M3 4h8M3 8h8M3 12h8" strokeWidth="2" />
          </svg>
        </button>
        <input aria-label={`区域视角名称：${view.name}`} value={name} maxLength={MAX_REGION_VIEW_NAME_LENGTH}
          disabled={disabled} onChange={event => setName(event.target.value)} style={{ minWidth: 0, flex: 1 }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); rename(view.id, name); } }} />
        <button type="button" disabled={disabled || name.trim() === view.name} onClick={() => rename(view.id, name)}>重命名</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" disabled={disabled} onClick={() => request('apply', '', view.id)}>定位</button>
        <button type="button" disabled={disabled} onClick={() => request('save', '', view.id)}>更新为当前视角</button>
        <button type="button" aria-label={`上移区域视角：${view.name}`} disabled={disabled || isFirst}
          onClick={() => move(view.id, 'up')}>上移</button>
        <button type="button" aria-label={`下移区域视角：${view.name}`} disabled={disabled || isLast}
          onClick={() => move(view.id, 'down')}>下移</button>
        <button type="button" disabled={disabled} onClick={() => remove(view.id)}>删除</button>
      </div>
    </div>
  );
}

export function RegionViewsPanel({ readOnly = false }: { readOnly?: boolean }) {
  const views = useEditorStore(state => state.scene.sceneSettings.regionViews);
  const sessionId = useEditorStore(state => state.sceneSessionId);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const pending = useEditorStore(state => state.regionViewRequest);
  const message = useEditorStore(state => state.regionViewMessage);
  const request = useEditorStore(state => state.requestRegionView);
  const reorder = useEditorStore(state => state.reorderRegionView);
  const [name, setName] = useState('');
  const [dragged, setDragged] = useState<{ id: string; sessionId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  useEffect(() => setName(''), [sessionId]);
  const disabled = readOnly || runtimeMode !== 'edit' || Boolean(pending);
  useEffect(() => {
    if (disabled || (dragged && (dragged.sessionId !== sessionId || !views.some(view => view.id === dragged.id)))) {
      setDragged(null);
      setDropTarget(null);
    }
  }, [disabled, sessionId, views, dragged]);
  const clearDrag = () => { setDragged(null); setDropTarget(null); };
  const acceptsDrag = (event: DragEvent<HTMLDivElement>) => !disabled && dragged
    && dragged.sessionId === useEditorStore.getState().sceneSessionId
    && event.dataTransfer.types.includes(REGION_VIEW_DRAG_TYPE);
  return (
    <fieldset className="transform-fieldset">
      <legend>区域视角（{views.length}）</legend>
      <div style={{ display: 'flex', gap: 6 }}>
        <input aria-label="新区域视角名称" placeholder="输入区域名称" value={name} maxLength={MAX_REGION_VIEW_NAME_LENGTH}
          disabled={disabled} onChange={event => setName(event.target.value)} style={{ minWidth: 0, flex: 1 }} />
        <button type="button" disabled={disabled || !name.trim() || views.length >= MAX_SCENE_REGION_VIEWS}
          onClick={() => request('save', name)}>保存当前视角</button>
      </div>
      <p style={{ fontSize: 12, opacity: 0.7 }}>拖动名称左侧手柄调整顺序，也可使用“上移 / 下移”。定位并调整相机后点击“更新为当前视角”。修改后请保存场景并重新发布。</p>
      {views.length === 0 && <p>尚未保存区域视角</p>}
      <div style={{ maxHeight: 420, overflowY: 'auto' }} onDragEnd={clearDrag}
        onDragLeave={event => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
        }}>
        {views.map((view, index) => <div key={`${sessionId}:${view.id}`}
          style={{ position: 'relative', opacity: dragged?.id === view.id ? 0.5 : 1 }}
          onDragOver={event => {
            if (!acceptsDrag(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            const position = dropPosition(event);
            setDropTarget(current => dragged?.id === view.id ? null
              : current?.id === view.id && current.position === position ? current : { id: view.id, position });
          }}
          onDrop={event => {
            if (!acceptsDrag(event)) return;
            event.preventDefault();
            event.stopPropagation();
            // 仅接收当前场景内手柄发起的拖拽，避免外部文本或旧场景拖拽修改列表。
            if (dragged && event.dataTransfer.getData(REGION_VIEW_DRAG_TYPE) === dragged.id) {
              reorder(dragged.id, view.id, dropPosition(event));
            }
            clearDrag();
          }}>
          {dropTarget?.id === view.id && <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0,
            height: 2, background: 'var(--accent-color, #4da3ff)', pointerEvents: 'none', zIndex: 1,
            ...(dropTarget.position === 'before' ? { top: 0 } : { bottom: 0 }) }} />}
          <RegionViewRow view={view} disabled={disabled} isFirst={index === 0} isLast={index === views.length - 1}
            onDragStart={event => {
              if (disabled || views.length < 2) { event.preventDefault(); return; }
              event.stopPropagation();
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(REGION_VIEW_DRAG_TYPE, view.id);
              setDragged({ id: view.id, sessionId });
              setDropTarget(null);
            }} />
        </div>)}
      </div>
      {message && <p role="status" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{message}</p>}
    </fieldset>
  );
}
