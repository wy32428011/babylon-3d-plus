import { useEffect, useMemo, useRef, useState } from 'react';
import { matchesLightingPolicyTarget, type LightingPolicyField } from '../../../electron/shared/sceneLightingPolicy';
import type { SceneDocument } from '../model/SceneDocument';
import { isEntityEffectivelyLocked } from '../model/entityHierarchy';
import type { LightingManagerFocus } from '../store/lightingManagementState';
import {
  EMPTY_LIGHTING_BULK_VALUES, getLightingManagerEntities, getLightingManagerResources, LIGHTING_FIELD_LABELS,
  lightingDeviceTypeLabel, type LightingManagerBulkValues, type LightingManagerRow, type LightingManagerSelection,
} from './lightingBakeManagerModel';
import { LightingManagerBadge, LightingManagerIcon } from './LightingBakeManagerWidgets';

type Props = {
  scene: SceneDocument; rows: LightingManagerRow[]; focus: LightingManagerFocus | null; disabled: boolean;
  onStage: (selection: LightingManagerSelection[], values: LightingManagerBulkValues, reset: boolean) => { ok: boolean; message?: string };
  onFocus: (selection: LightingManagerSelection) => void; onRules: () => void;
};
type ObjectGroup = { id: string; name: string; rows: LightingManagerRow[]; locked: boolean; stored: boolean };
type TableItem = { key: string; group: ObjectGroup; row?: LightingManagerRow; selection: LightingManagerSelection };
const BOOL_FIELDS = ['castShadows', 'receiveShadows', 'bakeIndirect'] as const;

function hasIssues(row: LightingManagerRow) {
  return row.entry.unmatchedOverride || Boolean(row.effective?.conflicts.length || row.effective?.mismatches.length);
}
function rowMobility(row: LightingManagerRow) { return row.effective?.settings.mobility ?? row.entry.mobility; }
function partLabel(row: LightingManagerRow) {
  const ordinal = /\/(?:thin|instance):(\d+)$/.exec(row.nodeKey);
  return ordinal ? `${row.name} · 实例 ${Number(ordinal[1]) + 1}` : row.name;
}
function sourceSummary(row: LightingManagerRow) {
  if (!row.effective) return '等待规则解析';
  const sources = new Set(Object.values(row.effective.fieldSources).map(source => source.label));
  const primary = row.effective.fieldSources.mobility.label;
  return sources.size > 1 ? `${primary} · ${sources.size} 类来源` : primary;
}
function groupMobility(group: ObjectGroup) {
  const values = new Set(group.rows.map(rowMobility));
  return values.size > 1 ? 'mixed' : values.values().next().value ?? 'pending';
}
function fieldText(items: LightingManagerRow[], field: LightingPolicyField) {
  const values = new Set(items.map(row => row.effective?.settings[field] ?? row.entry[field]));
  if (values.size !== 1) return '—';
  const value = values.values().next().value;
  if (field === 'mobility') return value === 'static' ? '静态' : '动态';
  return value ? '开启' : '关闭';
}

/** 对象页只暂存显式例外；树列表展示纯解析器返回的有效值和来源。 */
export function LightingBakeManagerObjects({ scene, rows, focus, disabled, onStage, onFocus, onRules }: Props) {
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const [mobility, setMobility] = useState('all');
  const [source, setSource] = useState('all');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [values, setValues] = useState<LightingManagerBulkValues>({ ...EMPTY_LIGHTING_BULK_VALUES });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [message, setMessage] = useState<string | null>(null);
  const lastFocus = useRef<LightingManagerFocus | null>(null);
  const resources = useMemo(() => getLightingManagerResources(rows), [rows]);
  const groups = useMemo(() => {
    const result = new Map<string, ObjectGroup>();
    for (const entity of getLightingManagerEntities(scene)) result.set(entity.id, { id: entity.id, name: entity.name, rows: [], locked: isEntityEffectivelyLocked(scene.entities, entity), stored: true });
    for (const row of rows) {
      let group = result.get(row.ownerEntityId);
      if (!group) { group = { id: row.ownerEntityId, name: row.entityName, rows: [], locked: row.locked, stored: Boolean(scene.entities[row.ownerEntityId]) }; result.set(group.id, group); }
      group.rows.push(row); group.locked ||= row.locked;
    }
    return [...result.values()];
  }, [scene, rows]);
  const folders = useMemo(() => scene.entityIds.map(id => scene.entities[id]).filter(entity => entity?.isFolder), [scene]);
  const deviceTypes = useMemo(() => [...new Set(rows.map(row => row.context?.deviceType).filter((value): value is string => Boolean(value)))].sort(), [rows]);
  useEffect(() => {
    if (focus === lastFocus.current) return;
    const ids = new Set(focus?.entityIds ?? []);
    const matching = rows.filter(row => ids.has(row.ownerEntityId) || ids.has(row.entityId));
    if (focus?.nodeKey && !matching.length) return;
    lastFocus.current = focus;
    setScope(ids.size ? 'focus' : 'all'); setSearch(''); setMobility('all'); setSource('all'); setOnlyIssues(false); setPage(0);
    setExpanded(previous => new Set([...previous, ...matching.map(row => row.ownerEntityId)]));
    const node = focus?.nodeKey ? matching.find(row => row.nodeKey === focus.nodeKey || row.partKey === focus.nodeKey) : null;
    setSelected(new Set(node ? ['node:' + node.key] : [...ids].map(id => 'entity:' + id)));
  }, [focus, rows]);
  useEffect(() => { setPage(0); }, [scope, search, mobility, source, onlyIssues, pageSize]);

  const belongsToFolder = (row: LightingManagerRow, folderId: string) => {
    if (row.context?.ancestorIds?.includes(folderId)) return true;
    const visited = new Set<string>();
    for (let id = scene.entities[row.ownerEntityId]?.parentId; id && !visited.has(id); id = scene.entities[id]?.parentId) {
      if (id === folderId) return true;
      visited.add(id);
    }
    return false;
  };
  const rowMatchesScope = (row: LightingManagerRow) => {
    if (scope === 'all') return true;
    if (scope === 'environment') return row.ownerEntityId === '$environment';
    if (scope === 'exceptions') return Boolean(row.effective?.preservedExceptionFields.length);
    if (scope === 'issues') return hasIssues(row);
    if (scope === 'focus') return Boolean(focus?.entityIds.some(id => id === row.ownerEntityId || id === row.entityId));
    if (scope.startsWith('group:')) return belongsToFolder(row, scope.slice(6));
    if (scope.startsWith('type:')) return row.context?.deviceType === scope.slice(5);
    if (scope.startsWith('resource:')) {
      const option = resources.find(resource => resource.key === scope.slice(9));
      if (!option) return false;
      return Boolean(row.context && matchesLightingPolicyTarget({ kind: 'resource', model: option.reference }, row.context));
    }
    return true;
  };
  const query = search.trim().toLocaleLowerCase();
  const filtering = scope !== 'all' || Boolean(query) || mobility !== 'all' || source !== 'all' || onlyIssues;
  const matchingGroups = groups.map(group => {
    const filtered = group.rows.filter(row => {
      if (!rowMatchesScope(row) || (onlyIssues && !hasIssues(row))) return false;
      if (mobility !== 'all' && rowMobility(row) !== mobility) return false;
      if (query && !`${group.name} ${partLabel(row)} ${row.nodeKey}`.toLocaleLowerCase().includes(query)) return false;
      if (source !== 'all') {
        const kinds = Object.values(row.effective?.fieldSources ?? {}).map(item => item.kind);
        if (source === 'rules' && !kinds.some(kind => kind === 'rule' || kind === 'node-rule')) return false;
        if (source === 'exceptions' && !kinds.some(kind => kind === 'entity' || kind === 'node-override')) return false;
        if (source !== 'rules' && source !== 'exceptions' && !kinds.includes(source as typeof kinds[number])) return false;
      }
      return true;
    });
    const unloadedMatches = !group.rows.length && scope === 'all' && mobility === 'all' && source === 'all' && !onlyIssues && (!query || group.name.toLocaleLowerCase().includes(query));
    return { group, filtered, visible: filtered.length > 0 || unloadedMatches };
  }).filter(item => item.visible);
  const items: TableItem[] = matchingGroups.flatMap(({ group, filtered }) => [
    { key: 'entity:' + group.id, group, selection: { kind: 'entity' as const, entityId: group.id } },
    ...((expanded.has(group.id) || filtering) ? filtered.map(row => ({ key: 'node:' + row.key, group, row, selection: { kind: 'node' as const, key: row.key } })) : []),
  ]);
  const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1), currentPage = Math.min(page, lastPage);
  const shown = items.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selectionItems: TableItem[] = groups.flatMap(group => [
    { key: 'entity:' + group.id, group, selection: { kind: 'entity' as const, entityId: group.id } },
    ...group.rows.map(row => ({ key: 'node:' + row.key, group, row, selection: { kind: 'node' as const, key: row.key } })),
  ]).filter(item => selected.has(item.key));
  const selectedNodes = selectionItems.filter(item => item.row).length, selectedEntities = selectionItems.length - selectedNodes;
  const selectedRows = selectionItems.flatMap(item => item.row ? [item.row] : item.group.rows);
  const canReset = selectionItems.length > 0 && !disabled && selectionItems.every(item => item.group.stored && !item.group.locked
    && (!item.row || Boolean(scene.entities[item.row.entityId] && !scene.entities[item.row.entityId].isFolder)));
  const canStage = canReset && selectionItems.every(item => !item.row?.entry.unmatchedOverride);
  const selectedPage = shown.filter(item => selected.has(item.key)).length;
  const hasStaticConstraint = selectedRows.some(row => row.entry.parentDynamic);
  const hasGeneratedNode = selectionItems.some(item => item.row && item.row.entityId !== '$environment' && !Object.hasOwn(scene.entities, item.row.entityId));
  const selectedSources = [...new Set(selectedRows.map(row => row.effective?.sourceLabel ?? '等待分类'))];
  const selectedSourceSummaries = [...new Set(selectedRows.map(sourceSummary))];
  const selectionLabel = `${selectedEntities} 个对象 · ${selectedNodes} 个部件`;
  function toggle(key: string, checked: boolean) {
    setSelected(previous => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next; });
    setMessage(null);
  }
  function stage(reset: boolean) {
    const result = onStage(selectionItems.map(item => item.selection), values, reset);
    setMessage(result.ok ? `${selectionLabel} 已暂存${reset ? '恢复继承' : '例外设置'}，应用后生效。` : result.message ?? '无法更新所选对象。');
  }
  function countScope(test: (row: LightingManagerRow) => boolean) { return new Set(rows.filter(test).map(row => row.ownerEntityId)).size; }

  return <div className="lighting-manager-object-columns">
    <aside className="lighting-manager-card lighting-manager-scopes" aria-label="对象管理范围">
      <h3>管理范围</h3>
      <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}><LightingManagerIcon name="cube" /><span>全部对象</span><b>{groups.length}</b></button>
      {rows.some(row => row.ownerEntityId === '$environment') && <button type="button" aria-pressed={scope === 'environment'} onClick={() => setScope('environment')}><LightingManagerIcon name="layers" /><span>场景环境</span><b>1</b></button>}
      {scope === 'focus' && <button type="button" aria-pressed onClick={() => setScope('focus')}><LightingManagerIcon name="focus" /><span>当前定位对象</span><b>{focus?.entityIds.length ?? 0}</b></button>}
      {folders.length > 0 && <details open><summary>场景分组</summary>{folders.map(folder => <button type="button" key={folder.id} aria-pressed={scope === 'group:' + folder.id} onClick={() => setScope('group:' + folder.id)}>
        <LightingManagerIcon name="folder" size={17} /><span>{folder.name}</span><b>{countScope(row => belongsToFolder(row, folder.id))}</b></button>)}</details>}
      {deviceTypes.length > 0 && <details open><summary>设备类型</summary>{deviceTypes.map(type => <button type="button" key={type} aria-pressed={scope === 'type:' + type} onClick={() => setScope('type:' + type)}>
        <LightingManagerIcon name="motion" size={17} /><span>{lightingDeviceTypeLabel(type)}</span><b>{countScope(row => row.context?.deviceType === type)}</b></button>)}</details>}
      {resources.length > 0 && <details open={resources.length <= 8}><summary>模型资源</summary>{resources.map(resource => <button type="button" key={resource.key}
        aria-pressed={scope === 'resource:' + resource.key} onClick={() => setScope('resource:' + resource.key)}><LightingManagerIcon name="cube" size={17} /><span>{resource.name}</span><b>{resource.count}</b></button>)}</details>}
      <div className="lighting-manager-scope-shortcuts"><button type="button" aria-pressed={scope === 'exceptions'} onClick={() => setScope('exceptions')}>
        <LightingManagerIcon name="rule" size={17} /><span>集中例外</span><b>{countScope(row => Boolean(row.effective?.preservedExceptionFields.length))}</b></button>
        <button type="button" aria-pressed={scope === 'issues'} onClick={() => setScope('issues')}><LightingManagerIcon name="warning" size={17} /><span>需要检查</span><b>{countScope(hasIssues)}</b></button></div>
    </aside>
    <section className="lighting-manager-card lighting-manager-object-table">
      <div className="lighting-manager-object-filters">
        <label className="lighting-manager-search"><LightingManagerIcon name="search" size={16} /><input type="search" aria-label="搜索模型或部件" placeholder="搜索模型或部件…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select aria-label="筛选有效分类" value={mobility} onChange={event => setMobility(event.target.value)}><option value="all">全部分类</option><option value="static">静态</option><option value="dynamic">动态</option></select>
        <select aria-label="筛选配置来源" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部来源</option><option value="rules">场景规则</option>
          <option value="exceptions">集中例外</option><option value="scene-default">场景默认</option><option value="automatic">自动识别</option><option value="ancestor">动态祖先</option></select>
        <label className="lighting-manager-inline-check"><input type="checkbox" checked={onlyIssues} onChange={event => setOnlyIssues(event.target.checked)} />仅异常</label>
      </div>
      <div className="lighting-manager-table-scroll"><table className="lighting-manager-table" aria-label="对象与部件有效配置">
        <thead><tr><th><input type="checkbox" aria-label="选择当前页对象与部件" checked={shown.length > 0 && selectedPage === shown.length}
          ref={input => { if (input) input.indeterminate = selectedPage > 0 && selectedPage < shown.length; }} disabled={!shown.length}
          onChange={event => setSelected(previous => { const next = new Set(previous); for (const item of shown) if (event.target.checked) next.add(item.key); else next.delete(item.key); return next; })} /></th>
          <th>对象 / 部件</th><th>有效分类</th><th>配置来源</th><th>投射</th><th>接收</th><th>间接光</th></tr></thead>
        <tbody>{shown.map(item => {
          const relevant = item.row ? [item.row] : item.group.rows;
          const effectiveMobility = item.row ? rowMobility(item.row) : groupMobility(item.group);
          const rowLabel = item.row ? `${item.group.name} / ${partLabel(item.row)}` : `${item.group.name} 对象`;
          const issue = relevant.some(hasIssues);
          return <tr key={item.key} className={`${selected.has(item.key) ? 'is-selected ' : ''}${item.row ? 'is-node' : 'is-entity'}`} aria-label={rowLabel}>
            <td><input type="checkbox" aria-label={`选择 ${rowLabel}`} checked={selected.has(item.key)}
              onChange={event => toggle(item.key, event.target.checked)} /></td>
            <td><div className="lighting-manager-object-name">
              {!item.row && item.group.rows.length > 0 ? <button type="button" className="lighting-manager-expand" aria-label={`${expanded.has(item.group.id) ? '收起' : '展开'} ${item.group.name} 的部件`}
                aria-expanded={expanded.has(item.group.id) || filtering} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(item.group.id)) next.delete(item.group.id); else next.add(item.group.id); return next; })}>
                <LightingManagerIcon name="arrow" size={14} /></button> : <span className="lighting-manager-tree-indent" />}
              <span><strong title={item.row?.nodeKey ?? item.group.name}>{item.row ? partLabel(item.row) : item.group.name}</strong><small>{item.row ? item.group.name : item.group.rows.length ? `${item.group.rows.length} 个部件${item.group.locked ? ' · 已锁定' : ''}` : '等待模型加载'}</small></span>
              {issue && <span title={relevant.flatMap(row => [...(row.effective?.mismatches.map(value => value.message) ?? []), ...(row.effective?.conflicts.map(value => value.reason) ?? [])]).join('；')}><LightingManagerIcon name="warning" size={15} /></span>}
            </div></td>
            <td><LightingManagerBadge tone={effectiveMobility === 'static' ? 'static' : effectiveMobility === 'dynamic' ? 'dynamic' : 'neutral'}>
              {effectiveMobility === 'static' ? '静态' : effectiveMobility === 'dynamic' ? '动态' : effectiveMobility === 'mixed' ? '混合' : '待加载'}
            </LightingManagerBadge></td>
            <td title={relevant.map(row => row.effective?.sourceLabel ?? row.entry.reason).join('；')}>{item.row ? sourceSummary(item.row) : '展开查看部件'}</td>
            {BOOL_FIELDS.map(field => <td key={field}>{field === 'bakeIndirect' && fieldText(relevant, field) === '开启'
              ? effectiveMobility === 'static' ? '光照图' : effectiveMobility === 'dynamic' ? '探针' : '按部件'
              : fieldText(relevant, field)}</td>)}
          </tr>;
        })}</tbody>
      </table>
      {!items.length && <div className="lighting-manager-empty"><LightingManagerIcon name="search" size={30} /><p>没有符合筛选条件的对象或部件</p>
        <button type="button" onClick={() => { setScope('all'); setSearch(''); setMobility('all'); setSource('all'); setOnlyIssues(false); }}>清除筛选</button></div>}</div>
      <div className="lighting-manager-pagination"><span>已选 {selectionLabel}</span><div>
        <button type="button" aria-label="上一页" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><LightingManagerIcon name="back" size={13} /></button><span>{currentPage + 1} / {lastPage + 1}</span>
        <button type="button" aria-label="下一页" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><LightingManagerIcon name="arrow" size={13} /></button>
        <select aria-label="每页显示数量" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[20, 50, 100].map(value => <option key={value} value={value}>{value} 条 / 页</option>)}</select><span>共 {items.length} 行</span>
      </div></div>
    </section>
    <aside className="lighting-manager-card lighting-manager-bulk" aria-labelledby="lighting-bulk-title">
      <h3 id="lighting-bulk-title">批量设置</h3><p className="lighting-manager-selected-count">当前选择：{selectionLabel}</p>
      {(Object.keys(EMPTY_LIGHTING_BULK_VALUES) as LightingPolicyField[]).map(field => <label key={field} className="lighting-manager-bulk-field"><span>{LIGHTING_FIELD_LABELS[field]}</span>
        <select aria-label={`批量${LIGHTING_FIELD_LABELS[field]}`} disabled={!canStage} value={values[field]} onChange={event => setValues(previous => ({ ...previous, [field]: event.target.value }))}>
          <option value="unchanged">保持原设置</option><option value="inherit">继承规则</option>
          {field === 'mobility' ? <><option value="auto">自动识别</option><option value="static" disabled={hasStaticConstraint}>静态</option><option value="dynamic">动态</option></>
            : <><option value="true">开启</option><option value="false">关闭</option></>}
        </select>
      </label>)}
      <div className="lighting-manager-bulk-actions"><button type="button" disabled={!canStage || Object.values(values).every(value => value === 'unchanged')} onClick={() => stage(false)}>暂存例外设置</button>
        <button type="button" disabled={!canReset} onClick={() => stage(true)}>恢复规则</button></div>
      <p className="lighting-manager-note">仅编辑当前选择；未修改的字段和其他对象例外继续保留。页脚会应用所有待应用草稿。</p>
      {message && <p className="lighting-manager-warning" role="status">{message}</p>}
      {selectionItems.some(item => item.group.locked) && <p className="lighting-manager-note">选择中包含锁定对象，只能查看；解锁后再编辑例外。</p>}
      {hasGeneratedNode && <p className="lighting-manager-warning" role="status">生成部件请使用模型资源或类型规则。临时部件可查看和定位，不写入宿主对象例外。</p>}
      <div className="lighting-manager-selected-source"><strong>当前配置来源</strong><p title={selectedSources.join('；')}>
        {selectedSourceSummaries.length ? selectedSourceSummaries.slice(0, 2).join('；') + (selectedSourceSummaries.length > 2 ? `；另有 ${selectedSourceSummaries.length - 2} 项` : '') : '先选择对象或部件'}</p>
        {selectionItems.length === 1 && selectedRows[0]?.effective && <dl>{Object.entries(selectedRows[0].effective.fieldSources).map(([field, source]) => <div key={field}><dt>{LIGHTING_FIELD_LABELS[field as LightingPolicyField]}</dt><dd>{source.label}</dd></div>)}</dl>}
      </div>
      <button type="button" className="lighting-manager-focus-button" disabled={!selectionItems.length || !selectedRows.some(row => !row.entry.unmatchedOverride)}
        title={selectionItems[0]?.row ? '定位所选部件' : '定位该对象首个可见部件'} onClick={() => onFocus(selectionItems[0].selection)}><LightingManagerIcon name="focus" size={18} />在场景中定位</button>
      {(hasStaticConstraint || selectionItems.some(item => !item.group.stored)) && <p className="lighting-manager-warning with-icon"><LightingManagerIcon name="warning" size={17} />
        {hasStaticConstraint ? '实际动态祖先约束保留，不能用静态例外抵消运动。' : '环境部件请通过集中分类规则设置。'}</p>}
      <button type="button" className="lighting-manager-text-button" onClick={onRules}>管理可复用分类规则 <LightingManagerIcon name="arrow" size={14} /></button>
    </aside>
  </div>;
}
