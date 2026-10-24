import { useEffect, useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';
import { LightingManagerBadge } from './LightingBakeManagerWidgets';
import './lighting-bake-manager.css';

/** 对象 Inspector 显示真实生效摘要，编辑入口始终定位到集中管理器。 */
export function LightingBakeInspector({ entityIds, disabled = false }: { entityIds: string[]; disabled?: boolean }) {
  const scene = useEditorStore(state => state.scene);
  const entries = useEditorStore(state => state.lightingInspectorClassification);
  const stale = useEditorStore(state => state.lightingInspectorClassificationStale);
  const setEntityIds = useEditorStore(state => state.setLightingInspectorEntityIds);
  const open = useEditorStore(state => state.openLightingManager);
  const entities = entityIds.map(id => scene.entities[id]).filter(entity => entity && !entity.isFolder
    && (entity.components.modelAsset || entity.components.meshRenderer || entity.components.modelGenerator || entity.components.deviceSpawner));
  const ids = entities.map(entity => entity.id), selection = ids.join('\0');
  useEffect(() => {
    const requested = selection ? selection.split('\0') : [];
    setEntityIds(requested);
    return () => {
      if (useEditorStore.getState().lightingInspectorEntityIds === requested) setEntityIds([]);
    };
  }, [selection, setEntityIds]);
  const selected = useMemo(() => {
    const chosen = new Set(selection.split('\0'));
    return entries.filter(entry => chosen.has(entry.policyContext?.ownerEntityId ?? entry.entityId));
  }, [entries, selection]);
  if (!entities.length) return null;
  const count = selected.reduce((value, entry) => {
    if (entry.unmatchedOverride || entry.policyMismatches?.length || entry.policyConflicts?.length) value.issues++;
    if (!entry.unmatchedOverride) value[entry.mobility]++;
    return value;
  }, { static: 0, dynamic: 0, issues: 0 });
  const sources = [...new Set(selected.map(entry => entry.sourceLabel).filter(Boolean))];
  return <CollapsibleFieldset title="烘焙与阴影" className="lighting-manager-summary">
    <div className="lighting-manager-summary-counts"><LightingManagerBadge tone="static">静态 {count.static}</LightingManagerBadge>
      <LightingManagerBadge tone="dynamic">动态 {count.dynamic}</LightingManagerBadge>
      {count.issues > 0 && <LightingManagerBadge tone="warning">待检查 {count.issues}</LightingManagerBadge>}</div>
    {stale && <p role="status">分类待刷新；打开管理器可立即刷新。</p>}
    <p>{sources.length ? `来源：${sources.slice(0, 2).join('、')}${sources.length > 2 ? ' 等' : ''}` : '等待模型加载和分类。'}</p>
    {disabled && <p>当前对象只读，仍可在管理器中查看规则。</p>}
    <button type="button" className="lighting-manager-open-button" onClick={() => open({ tab: 'objects', entityIds: ids })}>在管理器中定位</button>
  </CollapsibleFieldset>;
}
