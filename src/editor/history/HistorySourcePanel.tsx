import { useCallback, useEffect, useRef, useState } from 'react';
import { createHistorySourceConfig, type HistorySourceConfig, type HistorySourceCredential } from '../../../electron/shared/historySourceConfig';
import type { HistoryJsonObject, HistoryOperationResult, HistoryServiceAction, HistorySourceDetail, HistorySourceKind, HistorySourceSummary } from '../../../electron/shared/historyServiceContract';
import type { HistorySourceRole } from '../../runtime/history/historyReplayContract';
import { createHistoryRequestId, HistoryServiceError, invokeHistoryService, isHistoryRequestCancelled, type HistoryServiceResponse, type HistoryImportCandidate, type HistorySourceUsage } from './historyServiceClient';
import { HistoryCredentialFields, HistoryJsonField, HistorySourceFields } from './HistorySourceFields';
import { HistoryOperationView } from './HistoryOperationView';
import { HistorySourceSamplePreview } from './HistorySourceSamplePreview';

export const HISTORY_ROLE_LABELS: Record<HistorySourceRole, string> = { telemetry: '设备遥测', inventory: '库存/库位', cargo: '货物/流转', alarm: '告警', baseline: '完整初态', 'historical-events': '历史事件' };
export const HISTORY_KIND_LABELS: Record<HistorySourceKind, string> = { platform: '本平台历史', mqtt: 'MQTT 采集', http: '只读 HTTP', 'external-http': '外部历史接口' };
const STATUS_LABELS = { draft: '草稿', ready: '已就绪', retired: '停止新绑定', disabled: '访问已撤销' } as const;
const ROLES = Object.keys(HISTORY_ROLE_LABELS) as HistorySourceRole[];
const DEFAULT_ROLES: Record<HistorySourceKind, HistorySourceRole[]> = { platform: ['historical-events'], mqtt: ['telemetry'], http: ['inventory'], 'external-http': ['baseline', 'historical-events'] };

export function HistorySourcePanel(props: {
  projectId: string | null; canManage: boolean; sources: readonly HistorySourceSummary[]; total: number;
  onLoadMore: () => void; onRefresh: () => void; onSaved: (source: HistorySourceDetail) => void;
}) {
  const [selected, setSelected] = useState<HistorySourceDetail | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<HistorySourceKind>('mqtt');
  const [roles, setRoles] = useState<HistorySourceRole[]>(['telemetry']);
  const [config, setConfig] = useState<HistorySourceConfig>(() => createHistorySourceConfig('mqtt'));
  const [credential, setCredential] = useState<HistorySourceCredential>({ type: 'none' });
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<HistoryOperationResult | null>(null);
  const [usage, setUsage] = useState<HistorySourceUsage | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [probeOperation, setProbeOperation] = useState('latest');
  const [probeParameters, setProbeParameters] = useState<HistoryJsonObject>({ limit: 5 });
  const [candidates, setCandidates] = useState<HistoryImportCandidate[] | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [importLogicalId, setImportLogicalId] = useState('');
  const [importScope, setImportScope] = useState('');
  const [importCredential, setImportCredential] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const retryRef = useRef<{ signature: string; requestId: string } | null>(null);
  const pendingRef = useRef(false);
  useEffect(() => () => { controllerRef.current?.abort(); }, []);
  useEffect(() => {
    if (!selected) return;
    const current = props.sources.find(item => item.sourceId === selected.sourceId && item.revision === selected.revision);
    if (current && current.status !== selected.status) setSelected({ ...selected, status: current.status });
  }, [props.sources, selected]);
  const onOperationChange = useCallback((value: HistoryOperationResult) => {
    setOperation(value);
    if (value.status === 'succeeded') props.onRefresh();
  }, [props.onRefresh]);
  const onInvalid = useCallback((field: string, problem: string | null) => setInvalid(previous => {
    if (previous[field] === problem || !problem && !previous[field]) return previous;
    const next = { ...previous }; if (problem) next[field] = problem; else delete next[field]; return next;
  }), []);

  function load(source: HistorySourceDetail | null, sourceKind: HistorySourceKind = 'mqtt'): void {
    setSelected(source); setName(source?.name ?? ''); setKind(source?.kind ?? sourceKind);
    setRoles(source?.roles ?? [...DEFAULT_ROLES[sourceKind]]);
    setConfig(source ? source.config as HistorySourceConfig : createHistorySourceConfig(sourceKind));
    setCredential({ type: 'none' }); setInvalid({}); setUsage(null); setConfirmed(false); setError(null); setMessage(null);
    setProbeOperation((source?.kind ?? sourceKind) === 'external-http' ? 'coverage' : 'latest');
    setOperation(null); retryRef.current = null;
  }

  async function run<A extends HistoryServiceAction>(action: A, body: HistoryJsonObject, done: (value: HistoryServiceResponse<A>) => void): Promise<void> {
    if (!props.projectId || !props.canManage || pendingRef.current) return;
    pendingRef.current = true; setBusy(action); setError(null); setMessage(null);
    const signature = JSON.stringify([action, body]);
    const requestId = retryRef.current?.signature === signature ? retryRef.current.requestId : createHistoryRequestId();
    retryRef.current = { signature, requestId };
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const result = await invokeHistoryService(props.projectId, action, body, { requestId, signal: controller.signal });
      if (!controller.signal.aborted) { retryRef.current = null; done(result); }
    } catch (reason) {
      if (!isHistoryRequestCancelled(reason)) setError(`${reason instanceof Error ? reason.message : '请求未完成。'}${reason instanceof HistoryServiceError ? ` 请求标识：${reason.requestId}。再次提交相同内容会沿用该标识。` : ''}`);
      else setMessage('已取消本机等待；请刷新目录或按请求标识确认远端结果，不能据此认定未保存。');
    } finally { pendingRef.current = false; setBusy(null); if (controllerRef.current === controller) controllerRef.current = null; }
  }
  function saved(source: HistorySourceDetail): void { props.onSaved(source); load(source); setMessage('已保存服务器来源；场景引用、正式发布和采集状态尚未改变。'); }
  const editable = !selected || !['retired', 'disabled'].includes(selected.status);
  const canSubmit = props.canManage && !busy && editable && Object.keys(invalid).length === 0;

  return <div className="history-settings-source-layout">
    <aside className="history-settings-source-list" aria-label="项目历史来源目录">
      <div className="history-settings-row"><strong>来源目录</strong><button type="button" onClick={props.onRefresh} disabled={!props.canManage || Boolean(busy)}>刷新</button></div>
      {!props.sources.length && <p className="history-settings-note">尚未读取到项目来源。可先编辑连接草稿；创建服务器来源需要管理访问。</p>}
      {props.sources.map(source => <button type="button" key={source.sourceId} className={selected?.sourceId === source.sourceId ? 'history-settings-source selected' : 'history-settings-source'} disabled={Boolean(busy)} onClick={() => { void run('getSource', { sourceId: source.sourceId, sourceRevision: source.revision }, load); }}>
        <strong>{source.name}</strong><small>{HISTORY_KIND_LABELS[source.kind]} · {STATUS_LABELS[source.status]}</small><small>修订 {source.revision}</small>
      </button>)}
      {props.sources.length < props.total && <button type="button" onClick={props.onLoadMore} disabled={Boolean(busy)}>加载更多（{props.sources.length}/{props.total}）</button>}
      <button type="button" onClick={() => load(null)} disabled={Boolean(busy)}>新建来源</button>
      <button type="button" disabled={!selected || Boolean(busy)} onClick={() => { if (!selected) return; const original = selected; load(null, original.kind); setName(`${original.name} 副本`); setRoles([...original.roles]); setConfig(structuredClone(original.config) as HistorySourceConfig); }}>复制配置，不复制凭据</button>
      <details><summary>导入已授权 HTTP 来源</summary>
        <button type="button" disabled={!props.canManage || Boolean(busy)} onClick={() => { void run('queryImportCandidates', { offset: 0, limit: 100 }, value => { setCandidates(value.items); setCandidateTotal(value.total); }); }}>读取授权目录</button>
        {candidates && <>
          {candidates.length < candidateTotal && <button type="button" disabled={Boolean(busy) || !props.canManage} onClick={() => { void run('queryImportCandidates', { offset: candidates.length, limit: 100 }, value => { setCandidates(previous => [...(previous ?? []), ...value.items]); setCandidateTotal(value.total); }); }}>加载更多授权来源（{candidates.length}/{candidateTotal}）</button>}
          <label className="history-settings-field"><span>已有来源</span><select value={candidateId} onChange={event => { setCandidateId(event.target.value); setImportCredential(false); }}><option value="">选择…</option>{candidates.map(item => <option key={item.dataSourceId} value={item.dataSourceId} disabled={!item.importAllowed}>{item.name}{item.importAllowed ? '' : '（旧旁路未保护）'}</option>)}</select></label>
          <label className="history-settings-field"><span>逻辑来源 ID</span><input value={importLogicalId} onChange={event => setImportLogicalId(event.target.value)} /></label>
          <label className="history-settings-field"><span>权威业务域</span><input value={importScope} onChange={event => setImportScope(event.target.value)} /></label>
          <label className="history-settings-check"><input type="checkbox" checked={importCredential} onChange={event => setImportCredential(event.target.checked)} />明确复制既有凭据到受控历史域</label>
          <small>按当前右侧用途导入；不清除旧场景密钥，也不启用采集。</small>
          <button type="button" disabled={!candidateId || !importLogicalId || !importScope || !roles.length || !props.canManage || Boolean(busy)} onClick={() => { const candidate = candidates.find(item => item.dataSourceId === candidateId); if (candidate) void run('importSource', { dataSourceId: candidate.dataSourceId, expectedRevision: candidate.revision, roles, logicalSourceId: importLogicalId, authorityScope: importScope, importCredential }, saved); }}>导入为历史来源草稿</button>
        </>}
      </details>
    </aside>
    <section className="history-settings-source-editor" aria-label="来源详情">
      <h3>{selected ? `编辑 ${selected.name}` : '新建来源草稿'}</h3>
      {selected && <p className="history-settings-note">{selected.sourceId} · 来源修订 {selected.revision} · 访问修订 {selected.accessRevision} · {selected.credentialConfigured ? '已托管凭据' : '未配置凭据'}</p>}
      {error && <p role="alert" className="history-settings-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <form onSubmit={event => {
        event.preventDefault(); if (!canSubmit) return;
        void run('saveSourceDraft', { name, kind, roles, config,
          ...(selected ? { sourceId: selected.sourceId, expectedRevision: selected.revision, credentialOperation: 'keep' }
            : credential.type === 'none' ? { credentialOperation: 'keep' } : { credentialOperation: 'replace', credential }),
        }, saved);
      }}>
        <fieldset disabled={Boolean(busy) || !editable} className="history-settings-unframed">
          <div className="history-settings-grid">
            <label className="history-settings-field"><span>来源名称</span><input value={name} onChange={event => setName(event.target.value)} required maxLength={160} /></label>
            <label className="history-settings-field"><span>来源类型</span><select value={kind} disabled={Boolean(selected)} onChange={event => load(null, event.target.value as HistorySourceKind)}>{Object.entries(HISTORY_KIND_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          <fieldset><legend>提供的数据用途</legend><div className="history-settings-roles">{ROLES.map(role => <label key={role}><input type="checkbox" checked={roles.includes(role)} onChange={event => setRoles(previous => event.target.checked ? [...previous, role] : previous.filter(item => item !== role))} />{HISTORY_ROLE_LABELS[role]}</label>)}</div></fieldset>
          <HistorySourceFields kind={kind} config={config} onChange={setConfig} onInvalid={onInvalid} identityLocked={Boolean(selected)} />
          <HistorySourceSamplePreview key={`${selected?.sourceId ?? 'new'}-${kind}`} kind={kind} config={config} disabled={Boolean(busy) || Object.keys(invalid).length > 0} />
          {!selected && kind !== 'platform' && <HistoryCredentialFields kind={kind} value={credential} onChange={setCredential} />}
          <div className="history-settings-row"><button type="submit" className="history-settings-primary" disabled={!canSubmit || !roles.length}>保存服务器来源草稿</button><small>保存不启用采集，也不更新已有场景绑定。</small></div>
        </fieldset>
      </form>
      {selected && <>
        <details><summary>只读连接 / 样例探测</summary>
          <p className="history-settings-note">仅在点击后访问上游；HTTP 200 或 MQTT 到达不等于完整回放通过。</p>
          {selected.kind !== 'mqtt' && selected.kind !== 'platform' && <>
            <label className="history-settings-field"><span>探测接口</span><select value={probeOperation} onChange={event => setProbeOperation(event.target.value)}>{Object.keys((selected.config as unknown as { operations: Record<string, unknown> }).operations ?? {}).map(value => <option key={value}>{value}</option>)}</select></label>
            <HistoryJsonField field="probe.parameters" label="探测参数（时间使用 UTC 毫秒）" value={probeParameters} kind="object" onInvalid={onInvalid} onChange={value => setProbeParameters(value as HistoryJsonObject)} hint="按接口填写 from、to、at、cursor、limit、snapshotRevision、publishedVersionId；不会自动填补业务事实。" />
          </>}
          <button type="button" disabled={!props.canManage || Boolean(busy) || selected.status === 'disabled' || Boolean(invalid['probe.parameters'])} onClick={() => { void run('probeSource', { sourceId: selected.sourceId, sourceRevision: selected.revision, ...(selected.kind === 'http' || selected.kind === 'external-http' ? { operation: probeOperation, parameters: probeParameters } : {}) }, setOperation); }}>开始受限只读探测</button>
        </details>
        <details><summary>凭据轮换与来源生命周期</summary>
          <button type="button" disabled={!props.canManage || Boolean(busy)} onClick={() => { void run('sourceUsage', { sourceId: selected.sourceId }, setUsage); }}>查看共享引用影响</button>
          {usage && <p>有效绑定 {usage.activeBindingCount} · 保留合同 {usage.retainedContractCount} · 授权项目 {usage.grantedProjectCount}</p>}
          <label className="history-settings-check"><input type="checkbox" checked={confirmed} disabled={!usage} onChange={event => setConfirmed(event.target.checked)} />已查看影响，确认操作可能影响共享引用</label>
          {selected.kind !== 'platform' && <>
            <HistoryCredentialFields kind={selected.kind} value={credential} onChange={setCredential} disabled={Boolean(busy) || selected.status === 'disabled'} />
            <button type="button" disabled={!confirmed || !props.canManage || Boolean(busy) || selected.status === 'disabled'} onClick={() => { void run('updateSourceCredential', { sourceId: selected.sourceId, expectedAccessRevision: selected.accessRevision, credentialOperation: credential.type === 'none' ? 'clear' : 'replace', ...(credential.type === 'none' ? {} : { credential }) }, source => { props.onSaved(source); load(source); setMessage('已更新当前访问凭据；业务修订不变。若数据租户或权威业务域改变，必须新建来源身份并发布新合同。'); }); }}>应用凭据轮换 / 清除</button>
          </>}
          <div className="history-settings-row">
            <button type="button" disabled={!confirmed || !props.canManage || Boolean(busy) || selected.status !== 'draft' && selected.status !== 'ready'} onClick={() => { void run('retireSource', { sourceId: selected.sourceId, expectedRevision: selected.revision, mode: 'retire', confirmAffected: true }, value => { setOperation(value); setMessage('已提交停止新绑定请求，请等待服务器任务确认；不会硬删除历史。'); }); }}>停止新绑定</button>
            <button type="button" disabled={!confirmed || !props.canManage || Boolean(busy) || selected.status === 'disabled'} onClick={() => { void run('retireSource', { sourceId: selected.sourceId, expectedRevision: selected.revision, mode: 'revoke-access', confirmAffected: true }, value => { setOperation(value); setMessage('已提交撤销连接访问请求，请等待服务器确认；既有采集或查询可能受影响。'); }); }}>撤销连接访问</button>
          </div>
        </details>
      </>}
      {busy && <p role="status">正在处理… <button type="button" onClick={() => controllerRef.current?.abort()}>取消本机等待</button></p>}
      {operation && props.projectId && <HistoryOperationView projectId={props.projectId} operation={operation} onChange={onOperationChange} />}
    </section>
  </div>;
}
