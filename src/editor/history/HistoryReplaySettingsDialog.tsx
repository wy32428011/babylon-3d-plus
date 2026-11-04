import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  HistoryAccessStatus, HistoryEffectiveConfiguration, HistoryJsonObject, HistoryOperationResult,
  HistoryProjectContext, HistoryPublishedVersion, HistoryServiceCapabilities, HistorySourceDetail, HistorySourceSummary, HistoryValidationResult,
} from '../../../electron/shared/historyServiceContract';
import {
  HISTORY_REPLAY_SPEEDS, normalizeHistoryReplaySettings, type HistoryReplaySettings,
  type HistorySourceReference, type HistorySourceRole,
} from '../../runtime/history/historyReplayContract';
import { useEditorStore } from '../store/editorStore';
import { createHistoryRequestId, HistoryServiceError, invokeHistoryService, isHistoryRequestCancelled } from './historyServiceClient';
import { HISTORY_KIND_LABELS, HISTORY_ROLE_LABELS, HistorySourcePanel } from './HistorySourcePanel';
import { HistoryOperationView } from './HistoryOperationView';
import './historyReplaySettings.css';

type Tab = 'bindings' | 'sources' | 'activation';
type ValidationTicket = { value: HistoryValidationResult; settings: string; policyRevision: string; bindingRevision: string; publishedVersionId: string };
const PHASES = { 'not-configured': '未配置', initializing: '准备中', collecting: '持续采集中', ready: '已就绪', paused: '采集已暂停', failed: '失败' } as const;
const COMPLETENESS = { uninitialized: '尚无完整基线', incomplete: '存在未恢复缺口', complete: '完整' } as const;
const ROLES = Object.keys(HISTORY_ROLE_LABELS) as HistorySourceRole[];
function refKey(ref: HistorySourceReference | null): string { return ref ? JSON.stringify([ref.sourceId, ref.revision]) : ''; }
function sourceRef(source: HistorySourceSummary): HistorySourceReference { return { sourceId: source.sourceId, revision: source.revision }; }
function timeLabel(value: number | null): string { return value === null ? '未建立' : new Date(value).toISOString(); }

function SourceReferenceSelect({ label, value, sources, onChange }: {
  label: string; value: HistorySourceReference | null; sources: readonly HistorySourceSummary[];
  onChange: (value: HistorySourceReference | null) => void;
}) {
  const selectedKey = refKey(value);
  return <label className="history-settings-field"><span>{label}</span><select value={selectedKey} onChange={event => {
    const source = sources.find(item => refKey(sourceRef(item)) === event.target.value); onChange(source ? sourceRef(source) : null);
  }}><option value="">未绑定（可保存草稿）</option>
    {value && !sources.some(source => refKey(sourceRef(source)) === selectedKey) && <option value={selectedKey}>{value.sourceId} / {value.revision}（保留的精确引用）</option>}
    {sources.map(source => <option value={refKey(sourceRef(source))} key={refKey(sourceRef(source))} disabled={source.status === 'disabled' || source.status === 'retired'}>{source.name} / {source.revision}</option>)}
  </select></label>;
}

/** 场景草稿、服务器来源保存与显式生效是三个独立操作，关闭不会暂停后台采集。 */
export function HistoryReplaySettingsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openedSession = useRef(useEditorStore.getState().sceneSessionId);
  const titleId = useId();
  const [draft, setDraft] = useState(() => normalizeHistoryReplaySettings(useEditorStore.getState().scene.sceneSettings.historyReplay));
  const [tab, setTab] = useState<Tab>('bindings');
  const [context, setContext] = useState<HistoryProjectContext | null>(null);
  const [access, setAccess] = useState<HistoryAccessStatus | null>(null);
  const [accessSecret, setAccessSecret] = useState('');
  const [accessBusy, setAccessBusy] = useState(false);
  const [sources, setSources] = useState<HistorySourceSummary[]>([]);
  const [totalSources, setTotalSources] = useState(0);
  const [capabilities, setCapabilities] = useState<HistoryServiceCapabilities | null>(null);
  const [effective, setEffective] = useState<HistoryEffectiveConfiguration | null>(null);
  const [publishedVersionId, setPublishedVersionId] = useState('');
  const [publishedVersions, setPublishedVersions] = useState<HistoryPublishedVersion[]>([]);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [publishedVersionTotal, setPublishedVersionTotal] = useState(0);
  const [recentOperations, setRecentOperations] = useState<HistoryOperationResult[]>([]);
  const [operationRequestId, setOperationRequestId] = useState('');
  const [validation, setValidation] = useState<ValidationTicket | null>(null);
  const [operation, setOperation] = useState<HistoryOperationResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [retentionConfirmed, setRetentionConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remoteReady, setRemoteReady] = useState(false);
  const [inputSourceId, setInputSourceId] = useState('');
  const controllers = useRef(new Set<AbortController>());
  const lifecycle = useRef(0);
  const pending = useRef(false);
  const retry = useRef<{ signature: string; requestId: string } | null>(null);
  const canManage = Boolean(context?.platformOrigin && access?.configured && remoteReady && window.editorApi?.invokeHistoryService);

  const refresh = useCallback(async (project: HistoryProjectContext, signal?: AbortSignal) => {
    const [directory, state, caps, publications] = await Promise.allSettled([
      invokeHistoryService(project.projectId, 'querySources', { offset: 0, limit: 100 }, { signal }),
      invokeHistoryService(project.projectId, 'captureStatus', {}, { signal }),
      invokeHistoryService(project.projectId, 'capabilities', {}, { signal }),
      invokeHistoryService(project.projectId, 'queryPublishedVersions', { offset: 0, limit: 100 }, { signal }),
    ]);
    if (signal?.aborted) return;
    if (directory.status !== 'fulfilled') throw directory.reason;
    if (state.status !== 'fulfilled') throw state.reason;
    if (caps.status !== 'fulfilled') throw caps.reason;
    setSources(directory.value.items); setTotalSources(directory.value.total); setEffective(state.value); setCapabilities(caps.value); setRemoteReady(true);
    setRecentOperations(state.value.operations);
    setPublishedVersionId(previous => previous || state.value.publishedVersionId || '');
    if (publications.status === 'fulfilled') { setPublishedVersions(publications.value.items); setPublishedVersionTotal(publications.value.total); setPublicationError(null); }
    else setPublicationError('暂时无法读取正式发布版本目录；来源草稿仍可管理。');
  }, []);

  const refreshCurrent = useCallback(() => {
    if (!context || !access?.configured) return;
    const controller = new AbortController(); controllers.current.add(controller);
    void refresh(context, controller.signal).catch(reason => {
      if (!isHistoryRequestCancelled(reason)) { setError(reason instanceof Error ? reason.message : '无法刷新历史配置。'); setRemoteReady(false); }
    }).finally(() => controllers.current.delete(controller));
  }, [context, access?.configured, refresh]);

  useEffect(() => {
    const generation = ++lifecycle.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    const controller = new AbortController(); controllers.current.add(controller);
    void (async () => {
      if (!window.editorApi?.getHistoryProjectContext || !window.editorApi.getHistoryAccessStatus) {
        setNotice('当前为浏览器或离线编辑：可以应用无密钥场景草稿，服务器来源管理不可用。'); return;
      }
      const project = await window.editorApi.getHistoryProjectContext();
      if (controller.signal.aborted || lifecycle.current !== generation) return;
      setContext(project);
      if (!project) { setNotice('当前工程未绑定数据中台。可编辑场景草稿；绑定项目后再注册来源和预检。'); return; }
      if (!project.platformOrigin) { setNotice('项目已绑定，但历史管理需要 HTTPS；本机隔离环境可使用 HTTP。'); return; }
      const status = await window.editorApi.getHistoryAccessStatus(project.projectId);
      if (controller.signal.aborted || lifecycle.current !== generation) return;
      setAccess(status);
      if (status.configured) await refresh(project, controller.signal);
    })().catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof HistoryServiceError ? reason.message : '未能读取当前项目的历史管理状态，请检查本机凭据和项目绑定。');
    }).finally(() => controllers.current.delete(controller));
    return () => { ++lifecycle.current; for (const item of controllers.current) item.abort(); controllers.current.clear(); controller.abort(); dialog?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [refresh]);

  useEffect(() => { if (operation?.status === 'succeeded') refreshCurrent(); }, [operation?.operationId, operation?.status, refreshCurrent]);

  function updateDraft(value: HistoryReplaySettings): void { setDraft(value); setValidation(null); setConfirmed(false); setRetentionConfirmed(false); setNotice(null); }
  function acceptSource(source: HistorySourceDetail): void {
    setSources(previous => previous.some(item => item.sourceId === source.sourceId) ? previous.map(item => item.sourceId === source.sourceId ? source : item) : [source, ...previous]);
    setValidation(null); setConfirmed(false);
    // 精确场景引用不会自动追随来源的新修订。
  }
  function applyToScene(): void {
    try {
      const current = useEditorStore.getState();
      if (current.sceneSessionId !== openedSession.current || current.runtimeMode === 'preview') throw new Error('场景会话已切换或正在预览，请关闭后重新打开设置。');
      current.updateHistoryReplaySettings(normalizeHistoryReplaySettings(draft));
      setNotice('已应用到场景草稿，可一次撤销。尚未写盘；关闭后使用“保存场景”保存。服务器有效配置保持不变。'); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '场景草稿未应用。'); }
  }
  async function updateAccess(operation: 'replace' | 'clear'): Promise<void> {
    if (!context || !window.editorApi?.updateHistoryAccess || accessBusy) return;
    const generation = lifecycle.current;
    setAccessBusy(true); setError(null); setRemoteReady(false);
    const secret = accessSecret; setAccessSecret('');
    for (const item of controllers.current) item.abort();
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const result = await window.editorApi.updateHistoryAccess({ projectId: context.projectId, operation, ...(operation === 'replace' ? { secret } : {}) });
      if (generation !== lifecycle.current || controller.signal.aborted) return;
      setAccess(result); setValidation(null);
      if (result.configured) await refresh(context, controller.signal);
      else { setSources([]); setTotalSources(0); setEffective(null); setNotice('已清除本机管理访问键；未暂停采集，也未撤销服务端授权。'); }
    } catch (reason) { if (generation === lifecycle.current && !controller.signal.aborted) setError(reason instanceof HistoryServiceError ? reason.message : '未能保存或使用本机访问键。请检查系统安全存储、项目绑定和密钥格式。'); }
    finally { controllers.current.delete(controller); if (generation === lifecycle.current) setAccessBusy(false); }
  }

  async function runControl(action: 'validateConfig' | 'activateProvider' | 'applyCapturePolicy' | 'pauseCapture' | 'resumeCapture'): Promise<void> {
    if (!context || !effective || !canManage || pending.current) return;
    pending.current = true; setBusy(action); setError(null);
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const normalized = normalizeHistoryReplaySettings(draft);
      const fingerprint = JSON.stringify(normalized);
      const revisions = { policyRevision: effective.policyRevision, bindingRevision: effective.bindingRevision };
      let body: HistoryJsonObject;
      if (action === 'validateConfig') body = { settings: normalized, ...revisions, ...(publishedVersionId ? { publishedVersionId } : {}) };
      else if (action === 'pauseCapture' || action === 'resumeCapture') {
        if (!confirmed) throw new Error('请先确认共享场景影响。');
        body = { ...revisions, confirmAffected: true };
      } else {
        if (!confirmed || !validation || !validation.value.canActivate || validation.settings !== fingerprint
          || validation.policyRevision !== effective.policyRevision || validation.bindingRevision !== effective.bindingRevision
          || validation.publishedVersionId !== publishedVersionId || validation.value.expiresAt <= Date.now()
          || !validation.value.contractId || !validation.value.digest || !publishedVersionId) throw new Error('预检或发布身份已失效，请重新预检后再应用。');
        body = { validationId: validation.value.validationId, contractId: validation.value.contractId, digest: validation.value.digest, publishedVersionId, ...revisions, ...(retentionConfirmed ? { confirmRetentionReduction: true } : {}) };
      }
      const signature = JSON.stringify([action, body]);
      const requestId = retry.current?.signature === signature ? retry.current.requestId : createHistoryRequestId();
      retry.current = { signature, requestId };
      if (action === 'validateConfig') {
        const value = await invokeHistoryService(context.projectId, action, body, { requestId, signal: controller.signal });
        setValidation({ value, settings: fingerprint, ...revisions, publishedVersionId }); setConfirmed(false);
      } else {
        setOperation(await invokeHistoryService(context.projectId, action, body, { requestId, signal: controller.signal }));
        setValidation(null); setConfirmed(false);
      }
      retry.current = null;
    } catch (reason) {
      if (!isHistoryRequestCancelled(reason)) setError(`${reason instanceof Error ? reason.message : '管理操作未完成。'}${reason instanceof HistoryServiceError ? ` 请求标识：${reason.requestId}。相同内容重试沿用此标识。` : ''}`);
    } finally { controllers.current.delete(controller); pending.current = false; setBusy(null); }
  }

  const providerSources = sources.filter(source => source.kind === (draft.providerKind === 'platform' ? 'platform' : 'external-http'));
  const inputSources = sources.filter(source => (source.kind === 'mqtt' || source.kind === 'http') && source.roles.some(role => role !== 'baseline'));
  const baselineSources = sources.filter(source => source.roles.includes('baseline'));
  const validTicket = validation?.value.canActivate === true && validation.value.expiresAt > Date.now()
    && Boolean(validation.value.contractId && validation.value.digest && publishedVersionId)
    && validation.settings === JSON.stringify(draft) && validation.publishedVersionId === publishedVersionId
    && validation.policyRevision === effective?.policyRevision && validation.bindingRevision === effective?.bindingRevision;
  const reducesRetention = effective?.retentionDays != null && draft.requestedPolicy.retentionDays < effective.retentionDays;

  return <dialog ref={dialogRef} className="history-settings-dialog" aria-labelledby={titleId} aria-modal="true" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="history-settings-header"><div><h2 id={titleId}>时光回溯设置</h2><p>{context ? `${context.projectName} · 项目 ${context.projectId}` : '无密钥场景草稿'}<span>关闭编辑器不会停止已激活的后台采集。</span></p></div><button type="button" onClick={onClose} aria-label="关闭时光回溯设置">×</button></header>
    <nav className="history-settings-tabs" aria-label="时光回溯设置分类">{([['bindings', '场景引用'], ['sources', '数据源'], ['activation', '预检与生效']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} className={tab === key ? 'active' : undefined} disabled={Boolean(busy)} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <div className="history-settings-content">
      {notice && <p role="status" className="history-settings-notice">{notice}</p>}
      {error && <p role="alert" className="history-settings-error">{error}</p>}
      {context && <details className="history-settings-access" open={!access?.configured}><summary>项目管理访问：{access?.configured ? '本机已配置' : '未配置'}</summary>
        <p>访问键只保存在操作系统加密存储，按平台和项目隔离。不使用匿名登录或发布下载票据。</p>
        <div className="history-settings-row"><input type="password" aria-label="项目历史管理访问键" autoComplete="new-password" value={accessSecret} onChange={event => setAccessSecret(event.target.value)} placeholder="输入管理访问键（不回显）" maxLength={4096} />
          <button type="button" disabled={accessBusy || !context.platformOrigin || access?.encryptionAvailable === false || accessSecret.length < 16} onClick={() => { void updateAccess('replace'); }}>加密保存访问键</button>
          <button type="button" disabled={accessBusy || !access?.configured} onClick={() => { void updateAccess('clear'); }}>清除本机访问键</button>
          <button type="button" disabled={accessBusy || !access?.configured} onClick={refreshCurrent}>重新连接</button>
        </div>{access?.encryptionAvailable === false && <p className="history-settings-error">当前系统安全存储不可用，不会降级为明文保存。</p>}
      </details>}
      <section hidden={tab !== 'bindings'} aria-label="场景来源引用">
        <label className="history-settings-check history-settings-enable"><input type="checkbox" checked={draft.enabled} onChange={event => updateDraft({ ...draft, enabled: event.target.checked })} />为发布的 Viewer 启用时光回溯</label>
        <p className="history-settings-note">这里只保存来源 ID、精确修订和展示偏好。启用声明不等于采集或历史已就绪。</p>
        <div className="history-settings-grid">
          <label className="history-settings-field"><span>历史提供方</span><select value={draft.providerKind} onChange={event => updateDraft({ ...draft, providerKind: event.target.value as 'platform' | 'external-http', historyProviderRef: null, baselineSourceRef: null, sourceBindingRefs: [] })}><option value="platform">本平台持续采集的历史</option><option value="external-http">外部业务系统历史接口</option></select></label>
          <SourceReferenceSelect label="提供方来源与修订" value={draft.historyProviderRef} sources={providerSources} onChange={historyProviderRef => updateDraft({ ...draft, historyProviderRef })} />
          <SourceReferenceSelect label="完整初态 / 基线来源" value={draft.baselineSourceRef} sources={baselineSources} onChange={baselineSourceRef => updateDraft({ ...draft, baselineSourceRef })} />
          <label className="history-settings-field"><span>请求保留天数</span><input type="number" min={1} max={capabilities?.maxRetentionDays ?? 36500} value={Number.isFinite(draft.requestedPolicy.retentionDays) ? draft.requestedPolicy.retentionDays : ''} onChange={event => updateDraft({ ...draft, requestedPolicy: { retentionDays: event.currentTarget.valueAsNumber } })} /><small>须经服务器预算批准；外部历史仍受上游保留范围限制。</small></label>
        </div>
        {draft.providerKind === 'external-http' && <p className="history-settings-notice">选择外部提供方只改变回放绑定，不会自动暂停或删除已有平台采集。返回实时仍需当前 canonical 全态握手。</p>}
        {draft.providerKind === 'platform' && <fieldset><legend>持续采集输入（稳定绑定 ID）</legend>
          {draft.sourceBindingRefs.map(binding => <div key={binding.bindingId} className="history-settings-binding"><strong>{sources.find(source => source.sourceId === binding.sourceRef.sourceId)?.name ?? binding.sourceRef.sourceId}</strong><small>{binding.bindingId} / 修订 {binding.sourceRef.revision}</small>
            <div className="history-settings-roles">{ROLES.filter(role => role !== 'baseline').map(role => <label key={role}><input type="checkbox" checked={binding.roles.includes(role)} onChange={event => updateDraft({ ...draft, sourceBindingRefs: draft.sourceBindingRefs.map(item => item.bindingId === binding.bindingId ? { ...item, roles: event.target.checked ? [...item.roles, role] : item.roles.filter(value => value !== role) } : item) })} />{HISTORY_ROLE_LABELS[role]}</label>)}</div>
            <button type="button" onClick={() => updateDraft({ ...draft, sourceBindingRefs: draft.sourceBindingRefs.filter(item => item.bindingId !== binding.bindingId) })}>从草稿移除绑定</button>
          </div>)}
          <div className="history-settings-row"><select aria-label="待添加的采集来源" value={inputSourceId} onChange={event => setInputSourceId(event.target.value)}><option value="">选择已注册来源…</option>{inputSources.map(source => <option key={source.sourceId} value={source.sourceId} disabled={source.status === 'disabled' || source.status === 'retired'}>{source.name}（{HISTORY_KIND_LABELS[source.kind]}）</option>)}</select>
            <button type="button" disabled={!inputSourceId || draft.sourceBindingRefs.length >= (capabilities?.maxSourceBindings ?? 128)} onClick={() => { const source = sources.find(item => item.sourceId === inputSourceId); if (!source) return; const roles = source.roles.filter(role => role !== 'baseline'); updateDraft({ ...draft, sourceBindingRefs: [...draft.sourceBindingRefs, { bindingId: createHistoryRequestId(), sourceRef: sourceRef(source), roles: roles.length ? roles : ['inventory'] }] }); setInputSourceId(''); }}>添加输入绑定</button>
          </div>
        </fieldset>}
        <fieldset><legend>Viewer 默认展示</legend><div className="history-settings-grid">
          <label className="history-settings-field"><span>默认倍速</span><select value={draft.viewerDefaults.speed} onChange={event => updateDraft({ ...draft, viewerDefaults: { ...draft.viewerDefaults, speed: Number(event.target.value) as HistoryReplaySettings['viewerDefaults']['speed'] } })}>{HISTORY_REPLAY_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
          <label className="history-settings-field"><span>默认时间窗口（分钟）</span><input type="number" min={1} max={525600} value={Number.isFinite(draft.viewerDefaults.rangeMinutes) ? draft.viewerDefaults.rangeMinutes : ''} onChange={event => updateDraft({ ...draft, viewerDefaults: { ...draft.viewerDefaults, rangeMinutes: event.currentTarget.valueAsNumber } })} /></label>
        </div><label className="history-settings-check"><input type="checkbox" checked={draft.viewerDefaults.showEvents} onChange={event => updateDraft({ ...draft, viewerDefaults: { ...draft.viewerDefaults, showEvents: event.target.checked } })} />展示关键事件</label></fieldset>
      </section>
      <section hidden={tab !== 'sources'}><HistorySourcePanel projectId={context?.projectId ?? null} canManage={canManage} sources={sources} total={totalSources} onRefresh={refreshCurrent} onSaved={acceptSource} onLoadMore={() => {
        if (!context || !canManage) return;
        const controller = new AbortController(); controllers.current.add(controller);
        void invokeHistoryService(context.projectId, 'querySources', { offset: sources.length, limit: 100 }, { signal: controller.signal }).then(value => { setSources(previous => { const ids = new Set(previous.map(item => item.sourceId)); return [...previous, ...value.items.filter(item => !ids.has(item.sourceId))]; }); setTotalSources(value.total); }).catch(reason => { if (!isHistoryRequestCancelled(reason)) setError(reason instanceof Error ? reason.message : '读取目录失败。'); }).finally(() => controllers.current.delete(controller));
      }} /></section>
      <section hidden={tab !== 'activation'} aria-label="历史服务预检与生效">
        <h3>服务器有效状态</h3>
        {effective ? <dl className="history-settings-status"><dt>阶段 / 完整性</dt><dd>{PHASES[effective.phase]} / {COMPLETENESS[effective.completeness]}</dd><dt>策略 / 绑定修订</dt><dd>{effective.policyRevision} / {effective.bindingRevision}</dd><dt>有效发布版本</dt><dd>{effective.publishedVersionId ?? '未激活'}</dd><dt>有效保留 / 请求保留</dt><dd>{effective.retentionDays ?? '未配置'} / {draft.requestedPolicy.retentionDays} 天</dd><dt>采集到 / 可查询到</dt><dd>{timeLabel(effective.capturedThrough)} / {timeLabel(effective.queryableThrough)}</dd></dl> : <p>尚未取得服务器有效状态；本地草稿不代表后台已启用。</p>}
        {effective?.message && <p>{effective.message}</p>}
        <button type="button" onClick={refreshCurrent} disabled={!access?.configured}>刷新有效状态</button>
        <label className="history-settings-field"><span>正式发布版本</span><select disabled={Boolean(busy)} value={publishedVersionId} onChange={event => { setPublishedVersionId(event.target.value); setValidation(null); setConfirmed(false); }}><option value="">仅预检草稿（尚未选择发布版）</option>{publishedVersionId && !publishedVersions.some(item => item.publishedVersionId === publishedVersionId) && <option value={publishedVersionId}>{publishedVersionId}（当前绑定版本）</option>}{publishedVersions.map(item => <option key={item.publishedVersionId} value={item.publishedVersionId} disabled={!item.historyPackageAvailable}>V{item.versionNumber} / {item.publishedVersionId}{item.historyPackageAvailable ? '' : '（无回溯包）'}</option>)}</select><small>只使用服务器的正式版本记录；激活前还会核对包身份、场景和来源合同。</small></label>
        {publicationError && <p className="history-settings-error">{publicationError}</p>}
        {publishedVersions.length < publishedVersionTotal && <button type="button" disabled={!canManage || Boolean(busy)} onClick={() => {
          if (!context) return;
          const controller = new AbortController(); controllers.current.add(controller);
          void invokeHistoryService(context.projectId, 'queryPublishedVersions', { offset: publishedVersions.length, limit: 100 }, { signal: controller.signal }).then(value => {
            setPublishedVersions(previous => { const ids = new Set(previous.map(item => item.publishedVersionId)); return [...previous, ...value.items.filter(item => !ids.has(item.publishedVersionId))]; }); setPublishedVersionTotal(value.total); setPublicationError(null);
          }).catch(reason => { if (!isHistoryRequestCancelled(reason)) setPublicationError(reason instanceof Error ? reason.message : '无法读取更多发布版本。'); }).finally(() => controllers.current.delete(controller));
        }}>加载更多发布版本（{publishedVersions.length}/{publishedVersionTotal}）</button>}
        <button type="button" className="history-settings-primary" disabled={!canManage || Boolean(busy)} onClick={() => { void runControl('validateConfig'); }}>预检当前草稿</button>
        {validation && <section className="history-settings-validation" aria-label="来源配置预检结果"><strong>{validation.value.canActivate ? '预检允许申请生效' : '未满足生效条件'}</strong><p>合同：{validation.value.contractId ?? '尚未建立'}；有效期至 {new Date(validation.value.expiresAt).toLocaleString()}</p>
          <ul>{validation.value.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity === 'error' ? 'history-settings-error' : undefined}>{issue.severity === 'error' ? '阻塞' : '提示'}：{issue.message}</li>)}</ul>
        </section>}
        <label className="history-settings-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已确认共享场景影响；暂停采集会产生缺口，恢复连接不会自动恢复完整性</label>
        {reducesRetention && <label className="history-settings-check"><input type="checkbox" checked={retentionConfirmed} onChange={event => setRetentionConfirmed(event.target.checked)} />单独确认将留存从 {effective?.retentionDays} 天缩短到 {draft.requestedPolicy.retentionDays} 天；窗口外数据可能无法恢复</label>}
        <div className="history-settings-row"><button type="button" disabled={!canManage || Boolean(busy) || !validTicket || !confirmed || reducesRetention && !retentionConfirmed} onClick={() => { void runControl('activateProvider'); }}>显式激活已发布提供方</button>
          {draft.providerKind === 'platform' && <><button type="button" disabled={!canManage || Boolean(busy) || !validTicket || !confirmed || reducesRetention && !retentionConfirmed} onClick={() => { void runControl('applyCapturePolicy'); }}>应用采集策略</button><button type="button" disabled={!canManage || Boolean(busy) || !confirmed || !effective || !['collecting', 'ready'].includes(effective.phase)} onClick={() => { void runControl('pauseCapture'); }}>暂停后台采集</button><button type="button" disabled={!canManage || Boolean(busy) || !confirmed || effective?.phase !== 'paused'} onClick={() => { void runControl('resumeCapture'); }}>恢复后台采集</button></>}
        </div>
        {busy && <p role="status">正在提交管理请求…</p>}
        <details><summary>恢复后台任务（最近 20 条）</summary><div className="history-settings-row"><input aria-label="待查询的原请求标识" value={operationRequestId} onChange={event => setOperationRequestId(event.target.value)} maxLength={128} placeholder="输入之前的 requestId" /><button type="button" disabled={!canManage || !operationRequestId || Boolean(busy)} onClick={() => {
          if (!context) return;
          const controller = new AbortController(); controllers.current.add(controller);
          void invokeHistoryService(context.projectId, 'getOperation', { operationRequestId }, { signal: controller.signal }).then(setOperation).catch(reason => { if (!isHistoryRequestCancelled(reason)) setError(reason instanceof Error ? reason.message : '未能找到原任务。'); }).finally(() => controllers.current.delete(controller));
        }}>按请求标识查询</button></div>{recentOperations.map(item => <button className="history-settings-task-link" type="button" key={item.operationId} onClick={() => setOperation(item)}>{item.requestId} / {item.status}</button>)}</details>
        {operation && context && <HistoryOperationView projectId={context.projectId} operation={operation} onChange={setOperation} />}
      </section>
    </div>
    <footer className="history-settings-footer"><small>取消未应用的本地编辑不会删除已保存的远端来源；场景撤销不会回滚服务器生效状态。</small><div className="history-settings-row"><button type="button" onClick={onClose}>关闭</button><button type="button" className="history-settings-primary" onClick={applyToScene} disabled={Boolean(busy)}>应用到场景草稿</button></div></footer>
  </dialog>;
}
