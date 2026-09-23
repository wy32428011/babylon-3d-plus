import { useEffect, useState } from 'react';
import './composition.css';
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
import type { SceneDocument } from '../model/SceneDocument';
import { useEditorStore } from '../store/editorStore';
import { transformComposition, planCompositionUpgrade } from './composition';

/** 编辑状态放在场景标题栏，始终保留退出入口，不覆盖画布操作。 */
export function CompositionEditStatus() {
  const editRoot = useEditorStore(state => state.compositionEditRootId);
  const name = useEditorStore(state => state.compositionEditRootId ? state.scene.entities[state.compositionEditRootId]?.name : undefined);
  const mode = useEditorStore(state => state.runtimeMode);
  const finishEditing = () => {
    const state = useEditorStore.getState(), root = state.compositionEditRootId;
    state.setCompositionEditRoot(null);
    if (root && state.scene.entities[root]) state.selectEntity(root);
  };
  useEffect(() => {
    if (!editRoot || mode !== 'edit') return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) finishEditing();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editRoot, mode]);
  if (mode !== 'edit' || !editRoot || !name) return null;
  return <span className="composition-edit-status">
    <span className="composition-edit-name" title={name}>编辑组合 · {name}</span>
    <button type="button" className="composition-finish-button" title="退出组合内部编辑（Esc）" onClick={finishEditing}>
      完成编辑 <kbd>Esc</kbd>
    </button>
  </span>;
}

export function CompositionInspector({ entityId, readOnly }: { entityId: string; readOnly?: boolean }) {
  const scene = useEditorStore(s => s.scene), root = scene.entities[entityId];
  const [upgrade, setUpgrade] = useState<{before: SceneDocument; plan: ReturnType<typeof planCompositionUpgrade>} | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  async function prepareUpgrade() {
    const state = useEditorStore.getState(), source = state.scene.entities[entityId]?.composition;
    if (!source || loading) return;
    setLoading(true);
    try {
      const summaries = await window.editorApi.listCompositions();
      const candidate = summaries.find(e => e.id === source.libraryId || (!!source.resourceId && e.resourceId === source.resourceId && e.sourceKey === source.sourceKey));
      if (!candidate) throw new Error('当前组合库未找到同源资源，请先同步组合库。');
      const entry = await window.editorApi.loadComposition(candidate.id, candidate.revision);
      if (useEditorStore.getState().scene !== state.scene) throw new Error('场景已变化，请重新预览更新。');
      const plan = planCompositionUpgrade(state.scene, entityId, entry.definition, { libraryId: entry.id, revision: entry.revision,
        resourceId: entry.resourceId, resourceType: 'ENV_MODEL', sourceKey: entry.sourceKey, packagePath: entry.packagePath, contentSha256: entry.contentSha256 });
      plan.scene = deserializeScene(serializeScene(plan.scene)); setUpgrade({before:state.scene,plan}); setMessage('');
    } catch(e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  if (!root?.composition) return null;
  return <fieldset className="transform-fieldset"><legend>组合模型</legend>
    <p className="muted">修改后拖回对应组合卡片即可替换库模型。</p>
    <label className="inspector-row"><span>整体等比缩放</span><input aria-label="组合整体等比缩放" type="number" min="0.0001" step="0.1" disabled={readOnly}
      value={root.components.transform.scale.x} onChange={e => {
        const value = Number(e.target.value); if (!Number.isFinite(value) || value <= 0) return;
        const s = useEditorStore.getState(); try { s.commitCompositionEdit(s.scene, transformComposition(s.scene, entityId,
          { ...root.components.transform, scale: { x: value, y: value, z: value } }), '组合等比缩放'); }
        catch (error) { s.pushLog(error instanceof Error ? error.message : String(error)); }
      }} /></label>
    <button type="button" disabled={readOnly} onClick={() => useEditorStore.getState().setCompositionEditRoot(entityId)}>编辑组合内部</button>
    <button type="button" disabled={readOnly} onClick={() => useEditorStore.getState().ungroupSelectedEntities()}>解除组合</button>
    <button type="button" disabled={readOnly || loading} onClick={() => void prepareUpgrade()}>{loading ? '正在读取库版本…' : '使用库中版本'}</button>
    {message ? <p role="status">{message}</p> : null}
    {upgrade ? <div role="dialog" aria-label="更新组合实例预览">
      <p>保留整体位姿和兼容成员的设备绑定；成员位置、结构和参数采用库中版本。可撤销。</p>
      <p>保留身份 {upgrade.plan.retained} 项；新增：{upgrade.plan.added.join('、') || '无'}；删除：{upgrade.plan.removed.join('、') || '无'}。</p>
      {upgrade.plan.removed.length ? <p>指向删除成员的外部联动需要重新配置。</p> : null}
      <button type="button" disabled={readOnly} onClick={() => { if (useEditorStore.getState().commitCompositionEdit(upgrade.before,upgrade.plan.scene,'更新组合实例')) setUpgrade(null); else setMessage('场景已变化，请取消后重新预览更新。'); }}>确认更新此实例</button>
      <button type="button" onClick={() => setUpgrade(null)}>取消</button>
    </div> : null}
  </fieldset>;
}
