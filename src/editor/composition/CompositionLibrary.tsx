import { captureCompositionPreview } from './compositionPreview';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { CompositionLibraryApi, CompositionLibrarySummary } from '../../../electron/shared/compositionTypes';
import { useEditorStore } from '../store/editorStore';
import { captureComposition, COMPOSITION_DRAG, COMPOSITION_SELECTION_DRAG } from './composition';
import { associateComposition, placeComposition } from './compositionActions';
import './composition.css';

const api = () => window.editorApi as unknown as CompositionLibraryApi | undefined;
const status = { local: '本地', pending: '待同步', synced: '已同步', failed: '同步失败', conflict: '版本冲突' };
export function CompositionLibrary({ readOnly = false, search = '', onSearchChange }: {
  readOnly?: boolean; search?: string; onSearchChange: (value: string) => void;
}) {
  const selection = useEditorStore(state => state.hierarchySelectionIds);
  const selected = useEditorStore(state => state.scene.selectedEntityId);
  const mode = useEditorStore(state => state.runtimeMode);
  const hasSelection = selection.length > 0 || !!selected;
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const closeNameForm = () => { setPendingIds(null); saveButtonRef.current?.focus(); };
  const [entries, setEntries] = useState<CompositionLibrarySummary[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string | null>(null), [draftName, setDraftName] = useState(''), [pendingIds, setPendingIds] = useState<string[] | null>(null);
  const session = useEditorStore(s => s.sceneSessionId), generation = useRef(0), saving = useRef(false);
  useEffect(() => { const clear = () => setTarget(null); window.addEventListener('dragend', clear); return () => window.removeEventListener('dragend', clear); }, []);
  useEffect(() => { const token = ++generation.current; setPendingIds(null); setEntries([]);
    if (!api()?.listCompositions) { setMessage('当前运行环境未提供组合资源库，请使用新版桌面编辑器。'); return; }
    void api()!.listCompositions().then(e => { if (token === generation.current) { setEntries(e); if (!readOnly) void sync(); } }).catch(e => { if (token === generation.current) setMessage(String(e.message ?? e)); });
    return () => { generation.current++; };
  }, [session]);
  const report = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); setMessage(m); useEditorStore.getState().pushLog(m); };
  const saveRequest = useEditorStore(state => state.compositionSaveRequest);
  useEffect(() => {
    if (!saveRequest) return;
    try {
      const state = useEditorStore.getState();
      if (state.sceneSessionId !== saveRequest.sceneSessionId) return;
      captureComposition(state.scene, saveRequest.ids, '新组合'); setPendingIds(saveRequest.ids); setDraftName('新组合');
    } catch (error) { report(error); }
    finally { useEditorStore.setState(current => current.compositionSaveRequest?.id === saveRequest.id ? { compositionSaveRequest: null } : {}); }
  }, [saveRequest]);
  async function sync() {
    if (!api()?.syncCompositions || saving.current) return;
    const token = generation.current; saving.current = true; setBusy(true); setMessage('正在同步组合模型…');
    try { const items = await api()!.syncCompositions(); if (token === generation.current) { setEntries(items);
        const state = useEditorStore.getState(), entities = { ...state.scene.entities }; let changed = false;
        const byId = new Map(items.filter(e => e.syncStatus === 'synced').map(e => [e.id,e]));
        for (const entity of Object.values(entities)) {
          const current = entity.composition;
          const entry = current ? byId.get(current.libraryId) : undefined;
          if (entry && current && (current.resourceId !== entry.resourceId || current.sourceKey !== entry.sourceKey)) {
            entities[entity.id] = { ...entities[entity.id], composition: { ...current, resourceType: 'ENV_MODEL', resourceId: entry.resourceId, sourceKey: entry.sourceKey } }; changed = true;
          }
          const asset = entity.components.modelAsset, reference = asset?.sourceSnapshot?.compositionResource;
          const resource = reference ? byId.get(reference.libraryId) : undefined;
          if (asset && reference && resource && (reference.resourceId !== resource.resourceId || reference.sourceKey !== resource.sourceKey)) {
            entities[entity.id] = { ...entities[entity.id], components: { ...entity.components, modelAsset: { ...asset, sourceSnapshot: { ...asset.sourceSnapshot!, compositionResource: { ...reference, resourceId: resource.resourceId, sourceKey: resource.sourceKey } } } } }; changed = true;
          }
        }
        if (changed) useEditorStore.setState(current => current.scene === state.scene ? { scene: { ...state.scene, entities } } : {});
        setMessage(items.some(e => e.syncStatus === 'failed' || e.syncStatus === 'conflict') ? '部分组合同步失败，请查看卡片提示后重试。' : items.some(e => e.syncStatus === 'pending') ? '已同步已提交版本，仍有本地修改待同步。' : '组合库同步完成。'); } }
    catch (e) { if (token === generation.current) report(e); }
    finally { saving.current = false; setBusy(false); }
  }
  async function save(ids: string[], entry?: CompositionLibrarySummary, name?: string) {
    if (readOnly || saving.current || !api()?.saveComposition) return;
    const state = useEditorStore.getState(), token = generation.current;
    try {
      const spatial = state.selectedGroupSpatialInfo;
      const anchor = spatial?.status === 'ready' ? { ...spatial.center, y: spatial.center.y - spatial.sizeMeters.y / 2 } : undefined;
      const capture = captureComposition(state.scene, ids, entry?.name ?? name ?? '新组合', anchor);
      saving.current = true; setBusy(true); setMessage(entry ? `正在替换“${entry.name}”…` : '正在保存组合…');
      let thumbnailDataUrl: string | undefined, previewGlb: Uint8Array | undefined;
      try { ({ thumbnailDataUrl, previewGlb } = await captureCompositionPreview(capture.sourceIds.filter(id => {
        const entity = state.scene.entities[id]; if (entity.isFolder) return false;
        for (let current: typeof entity | undefined = entity; current; current = current.parentId ? state.scene.entities[current.parentId] : undefined) if (current.visible === false) return false;
        return true;
      }))); }
      catch (error) { capture.warnings.push(`预览生成失败：${error instanceof Error ? error.message : String(error)}。可编辑模型内容仍会保存。`); }
      if (thumbnailDataUrl && thumbnailDataUrl.length > 4 * 1024 * 1024) thumbnailDataUrl = undefined;
      if (token !== generation.current) return;
      const saved = await api()!.saveComposition({ definition: capture.definition, targetId: entry?.id, expectedRevision: entry?.revision, thumbnailDataUrl, previewGlb });
      if (token !== generation.current) return;
      setEntries(old => old.some(e => e.id === saved.id) ? old.map(e => e.id === saved.id ? saved : e) : [...old, saved]); setPendingIds(null);
      associateComposition(state.scene, capture, saved);
      setMessage(`${entry ? '已替换' : '已保存'}“${saved.name}”，待同步中台。${capture.warnings.join(' ')}`);
      capture.warnings.forEach(w => useEditorStore.getState().pushLog(w));
    } catch (e) { if (token === generation.current) report(e); }
    finally { saving.current = false; setBusy(false); }
    if (token === generation.current) void sync();
  }
  function drop(e: DragEvent, entry?: CompositionLibrarySummary) {
    if (!e.dataTransfer.types.includes(COMPOSITION_SELECTION_DRAG)) return;
    e.preventDefault(); e.stopPropagation(); setTarget(null);
    if (busy || readOnly) return;
    try {
      const payload = JSON.parse(e.dataTransfer.getData(COMPOSITION_SELECTION_DRAG));
      if (payload.sessionId !== useEditorStore.getState().sceneSessionId || !Array.isArray(payload.ids) || !payload.ids.every((id: unknown) => typeof id === 'string')) throw new Error('拖拽来源场景已变化，请重新拖拽。');
      if (entry) void save(payload.ids, entry);
      else { captureComposition(useEditorStore.getState().scene, payload.ids, '新组合'); setPendingIds(payload.ids); setDraftName('新组合'); }
    } catch (error) { report(error); }
  }
  function over(e: DragEvent, id = 'new') { if (!readOnly && !busy && e.dataTransfer.types.includes(COMPOSITION_SELECTION_DRAG)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setTarget(id); } }
  return <section className="composition-library" aria-label="组合模型库" onDragOver={e => over(e)} onDrop={e => drop(e)}>
    <div className="library-filter-row composition-toolbar">
      <label className="library-filter-label" htmlFor="composition-library-search">组合名称</label>
      <input className="library-filter-input" id="composition-library-search" type="search" placeholder="搜索组合…"
        value={search} onChange={event => onSearchChange(event.target.value)} />
      <button ref={saveButtonRef} type="button" className="composition-save-button" aria-label="保存选中模型为组合"
        disabled={busy || readOnly || mode !== 'edit' || !hasSelection}
        draggable={!busy && !readOnly && mode === 'edit' && hasSelection}
        title={hasSelection ? '点击新建组合；拖到空白处新建，拖到已有卡片替换' : '请先在场景中选择至少两个模型，或选择一个组合'}
        onDragStart={event => {
          const state = useEditorStore.getState();
          if (busy || readOnly || state.runtimeMode !== 'edit') { event.preventDefault(); return; }
          const ids = state.hierarchySelectionIds.length ? state.hierarchySelectionIds : state.scene.selectedEntityId ? [state.scene.selectedEntityId] : [];
          if (!ids.length) { event.preventDefault(); return; }
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData(COMPOSITION_SELECTION_DRAG, JSON.stringify({ sessionId: state.sceneSessionId, ids }));
        }}
        onClick={() => {
          const state = useEditorStore.getState(), ids = state.hierarchySelectionIds.length ? state.hierarchySelectionIds : state.scene.selectedEntityId ? [state.scene.selectedEntityId] : [];
          try { captureComposition(state.scene, ids, '新组合'); setPendingIds(ids); setDraftName('新组合'); } catch (error) { report(error); }
        }}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="9" height="9" rx="1" /><rect x="8" y="8" width="9" height="9" rx="1" /></svg>
        <span>保存组合</span>
        <svg className="composition-drag-grip" viewBox="0 0 10 20" aria-hidden="true"><path d="M3 5h.01M7 5h.01M3 10h.01M7 10h.01M3 15h.01M7 15h.01" /></svg>
      </button>
      <button type="button" className="composition-tool-button" aria-label="同步中台 / 重试" title="同步组合模型到数据中台，或重试失败的同步"
        disabled={busy || readOnly} onClick={() => void sync()}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6.5 6.5 0 0 0-11-2L3 7m0-4v4h4M4 13a6.5 6.5 0 0 0 11 2l2-2m0 4v-4h-4" /></svg>
        <span className="composition-secondary-label">{busy ? '处理中…' : '同步中台'}</span>
      </button>
      {busy ? <button type="button" className="composition-tool-button" onClick={() => void api()!.cancelCompositionSync().catch(report)}>取消</button> : null}
      <button type="button" className="composition-tool-button" aria-label="导入组合包" title="导入组合包" disabled={busy || readOnly}
        onClick={async () => { try { const entry = await api()!.importCompositionPackage(); if (entry) { setEntries(old => [...old, entry]); void sync(); } } catch(error) { report(error); } }}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 12v5h14v-5" /></svg>
        <span className="composition-secondary-label">导入组合包</span>
      </button>
      {pendingIds ? <form className="composition-save-form" aria-label="新建组合" onSubmit={event => { event.preventDefault(); void save(pendingIds, undefined, draftName); }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeNameForm(); } }}>
        <label htmlFor="composition-draft-name">新建组合</label>
        <input id="composition-draft-name" aria-label="组合名称" maxLength={100} value={draftName} onChange={event => setDraftName(event.target.value)} autoFocus />
        <button className="composition-save-button" disabled={busy || !draftName.trim()}>保存组合</button>
        <button className="composition-tool-button" type="button" onClick={closeNameForm}>取消</button>
      </form> : null}
    </div>
    <div className="composition-library-content">
      <div className="composition-library-help">
        <span>{hasSelection ? '点击保存新建 · 拖到卡片替换' : '选择至少两个模型，或一个已有组合'}</span>
        <span role="status" title={message}>{message}</span>
      </div>
    <div className="composition-cards" onWheel={event => { event.currentTarget.scrollLeft += event.deltaY; }}>
      {entries.filter(e => e.name.toLowerCase().includes(search.toLowerCase())).map(entry => <div key={entry.id} className={`composition-card ${target === entry.id ? 'composition-drop-target' : ''}`}
        onDragOver={e => over(e, entry.id)} onDrop={e => drop(e, entry)}>
        <button type="button" className="composition-card-main" disabled={readOnly} draggable={!readOnly}
          onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(COMPOSITION_DRAG, JSON.stringify({id:entry.id,revision:entry.revision})); }}
          onClick={async () => { try { const token = generation.current; const loaded = await api()!.loadComposition(entry.id, entry.revision); if (token === generation.current) placeComposition(loaded); } catch (e) { report(e); } }} title={entry.syncError ?? `点击或拖入场景；将场景组合拖到这里可替换“${entry.name}”`}>
          {entry.thumbnailUrl ? <img src={entry.thumbnailUrl} alt="" draggable={false} /> : <span className="composition-preview">▧</span>}
          <strong>{entry.name}</strong><small>{entry.memberCount} 个成员 · {status[entry.syncStatus]}</small>
          {target === entry.id ? <b>替换“{entry.name}”</b> : null}
        </button>
        <button type="button" disabled={busy} onClick={() => void api()!.exportCompositionPackage(entry.id).catch(report)}>导出组合包</button>
        <button type="button" disabled={readOnly || busy} onClick={async () => { try { const restored = await api()!.restoreComposition(entry.id, entry.revision); setEntries(old => old.map(e => e.id === restored.id ? restored : e)); void sync(); } catch (e) { report(e); } }}>恢复上一版本</button>
      </div>)}
      <div className={`composition-new ${target === 'new' ? 'composition-drop-target' : ''}`}><span className="composition-new-icon" aria-hidden="true">＋</span><strong>新建组合</strong><span>拖入选中的模型</span></div>
    </div>
    </div>
  </section>;
}
