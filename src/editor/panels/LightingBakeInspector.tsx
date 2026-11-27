import { useEffect, useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';
import { LightingManagerBadge } from './LightingBakeManagerWidgets';
import './lighting-bake-manager.css';

function resolveEffectiveShadowValue(
  entity: ReturnType<typeof useEditorStore.getState>['scene']['entities'][string],
  entriesByEntity: Map<string, { castShadows: boolean; receiveShadows: boolean }>,
  field: 'castShadows' | 'receiveShadows',
): boolean {
  const lighting = entity.components.lighting;
  if (lighting && !lighting.inheritPolicy?.includes(field) && typeof lighting[field] === 'boolean') {
    return lighting[field];
  }
  const runtimeEntry = entriesByEntity.get(entity.id);
  if (runtimeEntry) return runtimeEntry[field];
  return lighting?.[field] ?? true;
}

/** 对象 Inspector 提供直观的投射/接收阴影快捷开关与分类摘要，细粒度规则定位到高级管理器。 */
export function LightingBakeInspector({ entityIds, disabled = false }: { entityIds: string[]; disabled?: boolean }) {
  const scene = useEditorStore(state => state.scene);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const entries = useEditorStore(state => state.lightingInspectorClassification);
  const stale = useEditorStore(state => state.lightingInspectorClassificationStale);
  const setEntityIds = useEditorStore(state => state.setLightingInspectorEntityIds);
  const open = useEditorStore(state => state.openLightingManager);
  const updateEntityQuickShadowOverride = useEditorStore(state => state.updateEntityQuickShadowOverride);

  const entities = entityIds.map(id => scene.entities[id]).filter(entity => entity && !entity.isFolder
    && (entity.components.modelAsset || entity.components.meshRenderer || entity.components.modelGenerator || entity.components.deviceSpawner));
  const ids = entities.map(entity => entity.id);
  const selection = ids.join('\0');

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

  const entriesByEntity = useMemo(() => {
    const map = new Map<string, { castShadows: boolean; receiveShadows: boolean }>();
    for (const entry of selected) {
      const ownerId = entry.policyContext?.ownerEntityId ?? entry.entityId;
      const existing = map.get(ownerId);
      map.set(ownerId, {
        castShadows: existing ? existing.castShadows || entry.castShadows : entry.castShadows,
        receiveShadows: existing ? existing.receiveShadows || entry.receiveShadows : entry.receiveShadows,
      });
    }
    return map;
  }, [selected]);

  if (!entities.length) return null;

  const castValues = entities.map(entity => resolveEffectiveShadowValue(entity, entriesByEntity, 'castShadows'));
  const receiveValues = entities.map(entity => resolveEffectiveShadowValue(entity, entriesByEntity, 'receiveShadows'));
  const allCast = castValues.every(Boolean);
  const mixedCast = !allCast && castValues.some(Boolean);
  const allReceive = receiveValues.every(Boolean);
  const mixedReceive = !allReceive && receiveValues.some(Boolean);

  const count = selected.reduce((value, entry) => {
    if (entry.unmatchedOverride || entry.policyMismatches?.length || entry.policyConflicts?.length) value.issues++;
    if (!entry.unmatchedOverride) value[entry.mobility]++;
    return value;
  }, { static: 0, dynamic: 0, issues: 0 });
  const sources = [...new Set(selected.map(entry => entry.sourceLabel).filter(Boolean))];
  const toggleDisabled = disabled || runtimeMode === 'preview';

  return (
    <CollapsibleFieldset title="阴影与光照" className="lighting-manager-summary">
      <div className="lighting-inspector-shadow-toggles">
        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={allCast}
            ref={node => { if (node) node.indeterminate = mixedCast; }}
            disabled={toggleDisabled}
            onChange={event => updateEntityQuickShadowOverride(ids, 'castShadows', event.target.checked)}
          />
          <span>投射阴影</span>
        </label>
        <label className="lighting-quick-check">
          <input
            type="checkbox"
            checked={allReceive}
            ref={node => { if (node) node.indeterminate = mixedReceive; }}
            disabled={toggleDisabled}
            onChange={event => updateEntityQuickShadowOverride(ids, 'receiveShadows', event.target.checked)}
          />
          <span>接收阴影</span>
        </label>
      </div>
      <div className="lighting-manager-summary-counts">
        <LightingManagerBadge tone="static">静态 {count.static}</LightingManagerBadge>
        <LightingManagerBadge tone="dynamic">动态 {count.dynamic}</LightingManagerBadge>
        {count.issues > 0 && <LightingManagerBadge tone="warning">待检查 {count.issues}</LightingManagerBadge>}
      </div>
      {stale && <p role="status">分类待刷新；打开高级管理器可立即刷新。</p>}
      <p>{sources.length ? `来源：${sources.slice(0, 2).join('、')}${sources.length > 2 ? ' 等' : ''}` : '等待模型加载和分类。'}</p>
      {disabled && <p>当前对象只读，仍可在高级管理器中查看规则。</p>}
      <button type="button" className="lighting-manager-open-button" onClick={() => open({ tab: 'objects', entityIds: ids })}>
        在高级管理器中定位
      </button>
    </CollapsibleFieldset>
  );
}
