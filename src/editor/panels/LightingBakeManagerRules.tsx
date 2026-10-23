import { memo, useEffect, useMemo, useState } from 'react';
import {
  LIGHTING_POLICY_FIELDS, matchesLightingPolicyTarget, type LightingPolicyNodeRule, type LightingPolicyRule,
  type LightingPolicyValues, type SceneLightingPolicy,
} from '../../../electron/shared/sceneLightingPolicy';
import type { SceneDocument } from '../model/SceneDocument';
import { areLightingManagerPagePropsEqual, getLightingManagerResources, LIGHTING_FIELD_LABELS, lightingDeviceTypeLabel, lightingModelReferenceKey, type LightingManagerRow } from './lightingBakeManagerModel';
import { LightingManagerIcon } from './LightingBakeManagerWidgets';

type Props = {
  scene: SceneDocument; policy: SceneLightingPolicy; rows: LightingManagerRow[]; disabled: boolean; active?: boolean; ruleFocus?: { ruleId: string; sequence: number };
  onChange: (policy: SceneLightingPolicy) => void; onInspect: (entityIds: string[]) => void;
};
function valueSelect(value: LightingPolicyValues[keyof LightingPolicyValues] | undefined) {
  return value === undefined ? 'inherit' : String(value);
}
function nodeBindingKey(nodeKey: string, resourceIdentity: string | undefined) { return JSON.stringify([nodeKey, resourceIdentity ?? '']); }
function updateValue(values: LightingPolicyValues, field: keyof LightingPolicyValues, value: string): LightingPolicyValues {
  const next = { ...values };
  if (value === 'inherit') delete next[field];
  else if (field === 'mobility') next.mobility = value as LightingPolicyValues['mobility'];
  else next[field] = value === 'true';
  return next;
}

export function LightingPolicyFields({ values, disabled, onChange, prefix, compact = false }: {
  values: LightingPolicyValues; disabled: boolean; onChange: (values: LightingPolicyValues) => void; prefix: string; compact?: boolean;
}) {
  return <div className={compact ? 'lighting-manager-policy-fields is-compact' : 'lighting-manager-policy-fields'}>
    {LIGHTING_POLICY_FIELDS.map(field => <label key={field}>
      <span>{LIGHTING_FIELD_LABELS[field]}</span>
      <select aria-label={`${prefix} ${LIGHTING_FIELD_LABELS[field]}`} value={valueSelect(values[field])} disabled={disabled}
        onChange={event => onChange(updateValue(values, field, event.target.value))}>
        <option value="inherit">继承</option>
        {field === 'mobility' ? <><option value="auto">自动识别</option><option value="static">静态</option><option value="dynamic">动态</option></>
          : <><option value="true">开启</option><option value="false">关闭</option></>}
      </select>
    </label>)}
  </div>;
}

/** 规则保存在场景中，排序和编辑只改变草稿，现有与后续实例共用同一份规则。 */
function LightingBakeManagerRulesPage({ scene, policy, rows, disabled, onChange, onInspect, ruleFocus }: Props) {
  const [selectedId, setSelectedId] = useState<string>('defaults');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  useEffect(() => { if (ruleFocus) setSelectedId(ruleFocus.ruleId); }, [ruleFocus]);
  const resources = useMemo(() => getLightingManagerResources(rows), [rows]);
  const deviceTypes = useMemo(() => [...new Set(rows.map(row => row.context?.deviceType).filter((value): value is string => Boolean(value)))].sort(), [rows]);
  const folders = scene.entityIds.map(id => scene.entities[id]).filter(entity => entity?.isFolder);
  const selected = policy.rules.find(rule => rule.id === selectedId);
  const isDefault = !selected;
  const matched = useMemo(() => selected ? rows.filter(row => row.context && matchesLightingPolicyTarget(selected.target, row.context)) : rows, [rows, selected]);
  const matchedOwners = [...new Set(matched.map(row => row.ownerEntityId))];
  const issues = [...new Set(matched.flatMap(row => [
    ...(row.effective?.mismatches.map(issue => issue.message) ?? []),
    ...(row.effective?.conflicts.map(issue => issue.reason) ?? []),
  ]))];
  const nodeOptions = useMemo(() => {
    const seen = new Set<string>();
    return matched.filter(row => {
      const identity = row.context?.resourceIdentity ?? row.entry.resourceIdentity;
      const key = `${row.partKey}\0${identity ?? ''}`;
      if (!identity || seen.has(key) || row.entry.unmatchedOverride) return false;
      seen.add(key); return true;
    });
  }, [matched]);

  function changeRule(patch: Partial<LightingPolicyRule>) {
    if (!selected || disabled) return;
    onChange({ ...policy, rules: policy.rules.map(rule => rule.id === selected.id ? { ...rule, ...patch } : rule) });
  }
  function moveRule(id: string, nextIndex: number) {
    if (disabled) return;
    const currentIndex = policy.rules.findIndex(rule => rule.id === id);
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= policy.rules.length) return;
    const rules = [...policy.rules], [item] = rules.splice(currentIndex, 1);
    rules.splice(nextIndex, 0, item); onChange({ ...policy, rules });
  }
  function addRule() {
    const rule: LightingPolicyRule = { id: crypto.randomUUID(), name: '新建场景规则', enabled: true, target: { kind: 'all' }, values: {} };
    onChange({ ...policy, rules: [...policy.rules, rule] }); setSelectedId(rule.id);
  }
  function targetLabel(rule: LightingPolicyRule) {
    if (rule.target.kind === 'all') return '全场景';
    if (rule.target.kind === 'group') return '场景分组 · ' + (scene.entities[rule.target.folderId]?.name ?? '分组已移除');
    if (rule.target.kind === 'type') return '设备类型 · ' + lightingDeviceTypeLabel(rule.target.deviceType);
    const key = lightingModelReferenceKey(rule.target.model);
    return '模型资源 · ' + (resources.find(resource => resource.key === key)?.name ?? '已保存资源');
  }
  function setTarget(kind: LightingPolicyRule['target']['kind']) {
    if (kind === 'all') changeRule({ target: { kind } });
    if (kind === 'group' && folders[0]) changeRule({ target: { kind, folderId: folders[0].id } });
    if (kind === 'type' && deviceTypes[0]) changeRule({ target: { kind, deviceType: deviceTypes[0] } });
    if (kind === 'resource' && resources[0]) changeRule({ target: { kind, model: resources[0].reference } });
  }
  function updateNode(id: string, patch: Partial<LightingPolicyNodeRule>) {
    changeRule({ nodeRules: selected?.nodeRules?.map(rule => rule.id === id ? { ...rule, ...patch } : rule) });
  }
  function addNode(kind: 'fixed' | 'moving' | 'node') {
    if (!selected) return;
    const first = nodeOptions[0];
    if (kind === 'node' && !first) return;
    const node: LightingPolicyNodeRule = { id: crypto.randomUUID(), enabled: true,
      name: kind === 'fixed' ? '固定结构' : kind === 'moving' ? '运动部件' : first.name,
      target: kind === 'node' ? { kind: 'node', nodeKey: first.partKey, resourceIdentity: (first.context?.resourceIdentity ?? first.entry.resourceIdentity)! }
        : { kind: 'motion', role: kind },
      values: kind === 'node' ? {} : { mobility: kind === 'fixed' ? 'static' : 'dynamic' },
    };
    changeRule({ nodeRules: [...(selected.nodeRules ?? []), node] });
  }
  function moveNode(id: string, direction: number) {
    const nodes = [...(selected?.nodeRules ?? [])], index = nodes.findIndex(node => node.id === id), next = index + direction;
    if (index < 0 || next < 0 || next >= nodes.length) return;
    [nodes[index], nodes[next]] = [nodes[next], nodes[index]];
    changeRule({ nodeRules: nodes });
  }

  return <div className="lighting-manager-rule-page">
    <p className="lighting-manager-banner"><LightingManagerIcon name="rule" size={20} />
      同一模型资源配置一次，当前场景已有及新增实例自动继承；已有对象例外保留。</p>
    <div className="lighting-manager-rule-columns">
      <section className="lighting-manager-card lighting-manager-rule-list" aria-labelledby="lighting-rule-list-title">
        <div className="lighting-manager-card-heading"><h3 id="lighting-rule-list-title">场景规则</h3>
          <button type="button" disabled={disabled} onClick={addRule}><LightingManagerIcon name="plus" size={14} />新建规则</button></div>
        <p className="lighting-manager-note">上方规则按字段优先；“继承”字段继续寻找下方规则。</p>
        <ol>
          {policy.rules.map((rule, index) => <li key={rule.id} className={selected?.id === rule.id ? 'is-selected' : ''}
            draggable={!disabled} onDragStart={() => setDraggedId(rule.id)} onDragEnd={() => setDraggedId(null)}
            onDragOver={event => { if (!disabled && draggedId) event.preventDefault(); }}
            onDrop={event => { event.preventDefault(); if (draggedId) moveRule(draggedId, index); setDraggedId(null); }}>
            <input type="checkbox" aria-label={`启用规则 ${rule.name ?? index + 1}`} checked={rule.enabled} disabled={disabled}
              onChange={event => onChange({ ...policy, rules: policy.rules.map(item => item.id === rule.id ? { ...item, enabled: event.target.checked } : item) })} />
            <button type="button" className="lighting-manager-rule-select" aria-pressed={selected?.id === rule.id} onClick={() => setSelectedId(rule.id)}>
              <strong>{rule.name || `规则 ${index + 1}`}</strong><small>{targetLabel(rule)}</small>
            </button>
            <span className="lighting-manager-order-buttons">
              <button type="button" aria-label={`上移规则 ${rule.name ?? index + 1}`} disabled={disabled || index === 0} onClick={() => moveRule(rule.id, index - 1)}><LightingManagerIcon name="up" size={14} /></button>
              <button type="button" aria-label={`下移规则 ${rule.name ?? index + 1}`} disabled={disabled || index === policy.rules.length - 1} onClick={() => moveRule(rule.id, index + 1)}><LightingManagerIcon name="down" size={14} /></button>
            </span>
          </li>)}
        </ol>
        {!policy.rules.length && <p className="lighting-manager-note">尚未添加场景规则。可先用自动识别，再为同型号或分组建立规则。</p>}
        <button type="button" className={`lighting-manager-default-rule${isDefault ? ' is-selected' : ''}`} aria-pressed={isDefault} onClick={() => setSelectedId('defaults')}>
          <LightingManagerIcon name="rule" /><span><strong>场景默认</strong><small>未被规则或例外覆盖时使用</small></span>
        </button>
      </section>
      <section className="lighting-manager-card lighting-manager-rule-editor" aria-labelledby="lighting-rule-editor-title">
        <div className="lighting-manager-card-heading"><h3 id="lighting-rule-editor-title">{selected?.name || (isDefault ? '场景默认策略' : '规则设置')}</h3>
          {selected && <button type="button" className="lighting-manager-text-danger" disabled={disabled}
            onClick={() => { onChange({ ...policy, rules: policy.rules.filter(rule => rule.id !== selected.id) }); setSelectedId('defaults'); }}>删除规则</button>}
        </div>
        {selected && <>
          <label className="lighting-manager-field"><span>规则名称</span><input aria-label="规则名称" maxLength={80} value={selected.name ?? ''} disabled={disabled}
            onChange={event => changeRule({ name: event.target.value })} /></label>
          <div className="lighting-manager-target-fields">
            <label><span>作用范围</span><select aria-label="规则作用范围" value={selected.target.kind} disabled={disabled}
              onChange={event => setTarget(event.target.value as LightingPolicyRule['target']['kind'])}>
              <option value="all">全场景</option><option value="resource" disabled={!resources.length}>模型资源</option>
              <option value="type" disabled={!deviceTypes.length}>设备类型</option><option value="group" disabled={!folders.length}>场景分组</option>
            </select></label>
            {selected.target.kind === 'resource' && <label><span>资源</span><select aria-label="规则模型资源" disabled={disabled} value={lightingModelReferenceKey(selected.target.model)}
              onChange={event => { const resource = resources.find(item => item.key === event.target.value); if (resource) changeRule({ target: { kind: 'resource', model: resource.reference } }); }}>
              {!resources.some(item => item.key === lightingModelReferenceKey(selected.target.kind === 'resource' ? selected.target.model : {})) && <option value={lightingModelReferenceKey(selected.target.model)}>已保存资源（当前未加载）</option>}
              {resources.map(resource => <option key={resource.key} value={resource.key}>{resource.name} · {resource.count} 个实例</option>)}
            </select></label>}
            {selected.target.kind === 'type' && <label><span>类型</span><select aria-label="规则设备类型" value={selected.target.deviceType} disabled={disabled}
              onChange={event => changeRule({ target: { kind: 'type', deviceType: event.target.value } })}>
              {!deviceTypes.includes(selected.target.deviceType) && <option value={selected.target.deviceType}>{selected.target.deviceType}（当前未匹配）</option>}
              {deviceTypes.map(type => <option key={type} value={type}>{lightingDeviceTypeLabel(type)}</option>)}
            </select></label>}
            {selected.target.kind === 'group' && <label><span>分组</span><select aria-label="规则场景分组" value={selected.target.folderId} disabled={disabled}
              onChange={event => changeRule({ target: { kind: 'group', folderId: event.target.value } })}>
              {!scene.entities[selected.target.folderId]?.isFolder
                && <option value={selected.target.folderId}>已移除的分组</option>}
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select></label>}
          </div>
        </>}
        <p className="lighting-manager-scope-note">匹配当前场景 <strong>{matchedOwners.length}</strong> 个对象、{matched.length} 个部件{selected?.enabled === false ? '；当前规则已停用。' : '；后续匹配对象自动继承。'}</p>
        <h4>{isDefault ? '默认值' : '对象默认策略'}</h4>
        <LightingPolicyFields prefix={selected?.name ?? '场景默认'} values={selected?.values ?? policy.defaults} disabled={disabled}
          onChange={values => selected ? changeRule({ values }) : onChange({ ...policy, defaults: values })} />
        <p className="lighting-manager-note">间接光开启后：静态部件使用光照图，动态部件采样探针。真实动态祖先约束始终保留。</p>
        {selected && <>
          <div className="lighting-manager-card-heading lighting-manager-node-heading"><h4>部件策略</h4>
            <span className="lighting-manager-add-parts"><button type="button" disabled={disabled} onClick={() => addNode('fixed')}><LightingManagerIcon name="plus" size={13} />固定结构</button>
              <button type="button" disabled={disabled} onClick={() => addNode('moving')}><LightingManagerIcon name="plus" size={13} />运动部件</button>
              <button type="button" disabled={disabled || !nodeOptions.length} onClick={() => addNode('node')}><LightingManagerIcon name="plus" size={13} />稳定节点</button></span></div>
          <div className="lighting-manager-node-rules">
            {(selected.nodeRules ?? []).map((node, index) => <article key={node.id} className="lighting-manager-node-rule">
              <div className="lighting-manager-node-rule-heading"><input type="checkbox" aria-label={`启用部件策略 ${node.name ?? index + 1}`}
                checked={node.enabled} disabled={disabled} onChange={event => updateNode(node.id, { enabled: event.target.checked })} />
                <strong>{node.target.kind === 'motion' ? node.target.role === 'fixed' ? '固定结构' : '运动部件' : node.name ?? '稳定节点'}</strong>
                <span><button type="button" aria-label={`上移部件策略 ${index + 1}`} disabled={disabled || index === 0} onClick={() => moveNode(node.id, -1)}><LightingManagerIcon name="up" size={13} /></button>
                  <button type="button" aria-label={`下移部件策略 ${index + 1}`} disabled={disabled || index === (selected.nodeRules?.length ?? 0) - 1} onClick={() => moveNode(node.id, 1)}><LightingManagerIcon name="down" size={13} /></button>
                  <button type="button" aria-label={`删除部件策略 ${index + 1}`} disabled={disabled}
                    onClick={() => changeRule({ nodeRules: selected.nodeRules?.filter(item => item.id !== node.id) })}><LightingManagerIcon name="close" size={14} /></button></span>
              </div>
              {node.target.kind === 'node' && <label className="lighting-manager-field"><span>绑定节点</span><select aria-label={`部件策略 ${index + 1} 绑定节点`}
                value={nodeBindingKey(node.target.nodeKey, node.target.resourceIdentity)} disabled={disabled}
                onChange={event => { const row = nodeOptions.find(item => nodeBindingKey(item.partKey, item.context?.resourceIdentity ?? item.entry.resourceIdentity) === event.target.value);
                  if (row) updateNode(node.id, { name: row.name, target: { kind: 'node', nodeKey: row.partKey, resourceIdentity: (row.context?.resourceIdentity ?? row.entry.resourceIdentity)! } }); }}>
                <option value={nodeBindingKey(node.target.nodeKey, node.target.resourceIdentity)}>{node.name ?? node.target.nodeKey}</option>
                {nodeOptions.map(row => <option key={`${row.partKey}:${row.context?.resourceIdentity ?? row.entry.resourceIdentity}`}
                  value={nodeBindingKey(row.partKey, row.context?.resourceIdentity ?? row.entry.resourceIdentity)}>{row.entityName} / {row.name}</option>)}
              </select></label>}
              <LightingPolicyFields compact prefix={`部件策略 ${index + 1}`} values={node.values} disabled={disabled} onChange={values => updateNode(node.id, { values })} />
            </article>)}
            {!selected.nodeRules?.length && <p className="lighting-manager-note">可按实际驱动的固定/运动角色设置，也可绑定当前资源中的稳定节点。不会按部件名称猜测运动。</p>}
          </div>
        </>}
        <div className="lighting-manager-rule-impact"><div><strong>影响预览</strong><p>{matchedOwners.length} 个对象 · {matched.length} 个部件 · 保留 {new Set(matched.filter(row => row.effective?.preservedExceptionFields.length).map(row => row.ownerEntityId)).size} 个对象的例外</p></div>
          <button type="button" onClick={() => onInspect(matchedOwners)}>查看影响对象 <LightingManagerIcon name="arrow" size={14} /></button></div>
        {issues.length > 0 && <ul className="lighting-manager-diagnostics">{issues.slice(0, 6).map(issue => <li key={issue}><LightingManagerIcon name="warning" size={15} /><span>{issue}</span></li>)}
          {issues.length > 6 && <li>另有 {issues.length - 6} 项，请在对象页集中检查。</li>}</ul>}
      </section>
    </div>
  </div>;
}

export const LightingBakeManagerRules = memo(LightingBakeManagerRulesPage, areLightingManagerPagePropsEqual);
