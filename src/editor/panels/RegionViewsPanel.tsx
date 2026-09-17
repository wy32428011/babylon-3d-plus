import { useEffect, useState } from 'react';
import { MAX_REGION_VIEW_NAME_LENGTH, MAX_SCENE_REGION_VIEWS, type SceneRegionView } from '../model/sceneRegionViews';
import { useEditorStore } from '../store/editorStore';

function RegionViewRow({ view, disabled }: { view: SceneRegionView; disabled: boolean }) {
  const [name, setName] = useState(view.name);
  const rename = useEditorStore(state => state.renameRegionView);
  const request = useEditorStore(state => state.requestRegionView);
  const remove = useEditorStore(state => state.deleteRegionView);
  useEffect(() => setName(view.name), [view.name]);
  return (
    <div style={{ display: 'grid', gap: 6, padding: '8px 0', borderBottom: '1px solid var(--border-color, #39424c)' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input aria-label={`区域视角名称：${view.name}`} value={name} maxLength={MAX_REGION_VIEW_NAME_LENGTH}
          disabled={disabled} onChange={event => setName(event.target.value)} style={{ minWidth: 0, flex: 1 }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); rename(view.id, name); } }} />
        <button type="button" disabled={disabled || name.trim() === view.name} onClick={() => rename(view.id, name)}>重命名</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" disabled={disabled} onClick={() => request('apply', '', view.id)}>定位</button>
        <button type="button" disabled={disabled} onClick={() => request('save', '', view.id)}>更新为当前视角</button>
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
  const [name, setName] = useState('');
  useEffect(() => setName(''), [sessionId]);
  const disabled = readOnly || runtimeMode !== 'edit' || Boolean(pending);
  return (
    <fieldset className="transform-fieldset">
      <legend>区域视角（{views.length}）</legend>
      <div style={{ display: 'flex', gap: 6 }}>
        <input aria-label="新区域视角名称" placeholder="输入区域名称" value={name} maxLength={MAX_REGION_VIEW_NAME_LENGTH}
          disabled={disabled} onChange={event => setName(event.target.value)} style={{ minWidth: 0, flex: 1 }} />
        <button type="button" disabled={disabled || !name.trim() || views.length >= MAX_SCENE_REGION_VIEWS}
          onClick={() => request('save', name)}>保存当前视角</button>
      </div>
      <p style={{ fontSize: 12, opacity: 0.7 }}>定位后调整相机，再点击“更新为当前视角”。修改后请保存场景并重新发布。</p>
      {views.length === 0 && <p>尚未保存区域视角</p>}
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {views.map(view => <RegionViewRow key={`${sessionId}:${view.id}`} view={view} disabled={disabled} />)}
      </div>
      {message && <p role="status" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{message}</p>}
    </fieldset>
  );
}
