import { useEffect, useMemo, useRef, useState } from 'react';
import { getSceneLightingBakeSignature, requiresSceneLightingBake, type LightingBakeEngineStatus } from '../../../electron/shared/sceneLightingBakeContract';
import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig';
import { useEditorStore } from '../store/editorStore';
import type { LightingManagerTab } from '../store/lightingManagementState';
import { LightingBakeManagerOverview } from './LightingBakeManagerOverview';
import { LightingBakeManagerRules } from './LightingBakeManagerRules';
import { LightingBakeManagerObjects } from './LightingBakeManagerObjects';
import { LightingBakeManagerResources } from './LightingBakeManagerResources';
import { LightingBakeManagerChanges } from './LightingBakeManagerChanges';
import { LightingBakeEngineDialog } from './LightingBakeEngineDialog';
import { LightingBakeManagerTaskTools } from './LightingBakeManagerTaskTools';
import { GLB_STANDARD_PREVIEW_PRESET_ID } from '../../../electron/shared/glbStandardPreview';
import {
  applyLightingManagerPreset, buildLightingManagerDiagnostics, createLightingManagerRowsSelector, createLightingManagerDraft, getLightingManagerChangeSummary, getLightingManagerEntities, getLightingManagerImpact, getLightingManagerPolicy,
  isLightingManagerDraftDirty, stageLightingManagerExceptions, type LightingManagerBulkValues, type LightingManagerSelection,
} from './lightingBakeManagerModel';
import { LightingManagerIcon, LIGHTING_MANAGER_PHASE_LABELS } from './LightingBakeManagerWidgets';
import './lighting-bake-manager.css';

const TABS: Array<{ id: LightingManagerTab; label: string }> = [
  { id: 'overview', label: '总览与烘焙' }, { id: 'rules', label: '分类规则' },
  { id: 'objects', label: '对象与部件' }, { id: 'resources', label: '任务与资源' },
];

/** 全局宿主与 Inspector 选择无关；场景会话变化后不会把旧草稿套入新场景。 */
export function LightingBakeManager() {
  const open = useEditorStore(state => state.lightingManagerOpen);
  const sessionId = useEditorStore(state => state.sceneSessionId);
  return open ? <LightingBakeManagerSession key={sessionId} /> : null;
}

function LightingBakeManagerSession() {
  const scene = useEditorStore(state => state.scene);
  const sessionId = useEditorStore(state => state.sceneSessionId);
  const tab = useEditorStore(state => state.lightingManagerTab);
  const focus = useEditorStore(state => state.lightingManagerFocus);
  const preview = useEditorStore(state => state.lightingManagerPreview);
  const previewError = useEditorStore(state => state.lightingManagerPreviewError);
  const classification = useEditorStore(state => state.lightingClassification);
  const request = useEditorStore(state => state.lightingBakeRequest);
  const status = useEditorStore(state => state.lightingBakeStatus);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  const debug = useEditorStore(state => state.lightingDebugVisible);
  const comparison = useEditorStore(state => state.lightingComparisonEnabled);
  const draftPreview = useEditorStore(state => state.lightingDraftPreview);
  const preflight = useEditorStore(state => state.lightingBakePreflight);
  const costs = useEditorStore(state => state.lightingShadowCosts);
  const taskHistory = useEditorStore(state => state.lightingBakeTaskHistory);
  const taskHistoryError = useEditorStore(state => state.lightingBakeTaskHistoryError);
  const runtimeDiagnostic = useEditorStore(state => state.lightingRuntimeDiagnostic);
  const [draft, setDraft] = useState(() => createLightingManagerDraft(scene, sessionId));
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [confirmation, setConfirmation] = useState<'close' | 'reload' | null>(null);
  const [visitedTabs, setVisitedTabs] = useState(() => new Set<LightingManagerTab>([tab]));
  const [engineStatus, setEngineStatus] = useState<LightingBakeEngineStatus | null>(null);
  const [engineStatusLoading, setEngineStatusLoading] = useState(false);
  const [engineConfigurationOpen, setEngineConfigurationOpen] = useState(false);
  const engineStatusGeneration = useRef(0);
  const [ruleFocus, setRuleFocus] = useState<{ ruleId: string; sequence: number }>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialSession = useRef(sessionId);
  const initialPreview = useRef({ debug, comparison });
  const ownedPreview = useRef<{ debug?: boolean; comparison?: boolean }>({});
  const changingPreview = useRef(false);
  const dirty = useMemo(() => isLightingManagerDraftDirty(draft), [draft]);
  const staleDraft = scene !== draft.baseScene && dirty;
  const busy = Boolean(request);
  const editingDisabled = busy || runtimeMode === 'preview';
  const selectRows = useMemo(createLightingManagerRowsSelector, []);
  const rows = selectRows(draft, classification);
  const changes = useMemo(() => getLightingManagerChangeSummary(draft), [draft]);
  const impact = useMemo(() => getLightingManagerImpact(rows), [rows]);
  const policy = useMemo(() => getLightingManagerPolicy(draft.lighting.policy), [draft.lighting.policy]);
  const counts = useMemo(() => rows.reduce((value, row) => {
    const mobility = row.effective?.settings.mobility ?? row.entry.mobility;
    if (!row.entry.unmatchedOverride) value[mobility]++;
    return value;
  }, { static: 0, dynamic: 0 }), [rows]);
  const sourceCount = useMemo(() => getLightingManagerEntities(scene).length, [scene]);
  const signature = useMemo(() => getSceneLightingBakeSignature(scene), [scene]);
  const result = useMemo(() => getSceneLightingConfig(scene).result ?? null, [scene]);
  const resultStale = Boolean(result && result.signature !== signature);
  const resultLabel = busy ? LIGHTING_MANAGER_PHASE_LABELS[status.phase] : !requiresSceneLightingBake(scene) ? '无需静态烘焙'
    : resultStale ? '已过期' : status.phase === 'error' ? '更新失败' : result ? '可用' : '未烘焙';
  const diagnostics = useMemo(() => {
    const runtimeRow = runtimeDiagnostic?.entityId ? rows.find(row => row.entityId === runtimeDiagnostic.entityId && (!runtimeDiagnostic.nodeKey || row.nodeKey === runtimeDiagnostic.nodeKey)) : undefined;
    return buildLightingManagerDiagnostics(rows, [
      ...(runtimeDiagnostic ? [{ ...runtimeDiagnostic, id: 'runtime-resource:' + (runtimeDiagnostic.assetId ?? runtimeDiagnostic.kind), severity: 'warning' as const,
        ownerEntityId: runtimeRow?.ownerEntityId, entityName: runtimeRow?.entityName, runtimeNodeKey: runtimeDiagnostic.nodeKey,
        locatable: Boolean(runtimeRow && !runtimeRow.entry.unmatchedOverride), action: 'retry-preflight' as const }] : []),
      ...(status.phase === 'error' && status.message && (status.source !== 'runtime' || !runtimeDiagnostic)
        ? [{ id: 'current-task', kind: status.source === 'runtime' ? 'runtime' : 'task', severity: 'warning' as const, message: status.message, action: 'retry-preflight' as const }] : []),
    ]);
  }, [status, rows, runtimeDiagnostic]);
  useEffect(() => { setVisitedTabs(previous => previous.has(tab) ? previous : new Set([...previous, tab])); }, [tab]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const owned = ownedPreview.current, originals = initialPreview.current, mountedSession = initialSession.current;
    dialog.showModal();
    const unsubscribe = useEditorStore.subscribe((current, before) => {
      if (changingPreview.current) return;
      if (current.lightingDebugVisible !== before.lightingDebugVisible) delete owned.debug;
      if (current.lightingComparisonEnabled !== before.lightingComparisonEnabled) delete owned.comparison;
    });
    return () => {
      unsubscribe();
      const current = useEditorStore.getState();
      if (current.sceneSessionId === mountedSession) {
        if (owned.debug !== undefined && current.lightingDebugVisible === owned.debug) current.setLightingDebugVisible(originals.debug);
        if (owned.comparison !== undefined && current.lightingComparisonEnabled === owned.comparison) current.setLightingComparisonEnabled(originals.comparison);
      }
      dialog.close();
      if (current.sceneSessionId === mountedSession && previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    // 没有草稿时可跟随后台任务提交；已有草稿始终保留，并要求用户处理版本冲突。
    if (!dirty && scene !== draft.baseScene) setDraft(createLightingManagerDraft(scene, sessionId));
  }, [scene, sessionId, dirty, draft.baseScene]);
  function setTab(next: LightingManagerTab) {
    setVisitedTabs(previous => previous.has(next) ? previous : new Set([...previous, next]));
    useEditorStore.getState().setLightingManagerTab(next);
  }
  function reload() {
    const current = useEditorStore.getState();
    setDraft(createLightingManagerDraft(current.scene, current.sceneSessionId)); setNotice(null); setConfirmation(null);
  }
  function close() {
    if (dirty) setConfirmation('close');
    else useEditorStore.getState().closeLightingManager();
  }
  function apply() {
    if (editingDisabled) return false;
    const response = useEditorStore.getState().applyLightingManagementDraft(draft);
    setNotice(response.message ?? (response.ok ? '配置已应用，可统一撤销。' : '配置未能应用。'));
    setNoticeIsError(!response.ok);
    if (response.ok) {
      const current = useEditorStore.getState();
      setDraft(createLightingManagerDraft(current.scene, current.sceneSessionId));
    }
    return response.ok;
  }
  function bake() {
    if (editingDisabled || draftPreview || (dirty && !apply())) return;
    const current = useEditorStore.getState();
    if (!requiresSceneLightingBake(current.scene)) { setNotice('当前没有静态接收表面，无需启动烘焙。'); setNoticeIsError(false); return; }
    current.requestLightingBake();
    setTab('resources');
  }
  async function refreshDevices() {
    const generation = ++engineStatusGeneration.current;
    setEngineStatusLoading(true);
    try {
      if (!window.editorApi?.getLightingBakeEngineStatus) throw new Error('当前环境不支持检查烘焙引擎。');
      const value = await window.editorApi.getLightingBakeEngineStatus();
      if (generation === engineStatusGeneration.current) setEngineStatus(value);
    } catch (error) { if (generation === engineStatusGeneration.current) setEngineStatus({ available: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { if (generation === engineStatusGeneration.current) setEngineStatusLoading(false); }
  }
  function invalidateEngineStatus() { engineStatusGeneration.current++; }
  useEffect(() => { void refreshDevices(); return invalidateEngineStatus; }, []);
  function check() {
    if (editingDisabled || draftPreview || (dirty && !apply())) return;
    void refreshDevices(); useEditorStore.getState().requestLightingBakePreflight(); setTab('resources');
  }
  function previewDraft() {
    const current = useEditorStore.getState();
    const response = current.setLightingDraftPreview(current.lightingDraftPreview ? null : draft);
    setNotice(response.ok ? (current.lightingDraftPreview ? '已恢复当前应用配置。' : '临时预览照明与显示，关闭或恢复后归还原配置。') : response.message ?? '无法预览草稿。');
    setNoticeIsError(!response.ok);
    current.refreshLightingManagerPreview();
  }
  useEffect(() => {
    const current = useEditorStore.getState();
    if (current.lightingDraftPreview) {
      const response = current.setLightingDraftPreview(draft);
      if (!response.ok) { current.setLightingDraftPreview(null); setNotice(response.message ?? '草稿预览已结束。'); setNoticeIsError(true); }
    }
  }, [draft]);
  useEffect(() => { if (tab === 'resources') void useEditorStore.getState().refreshLightingBakeTaskHistory(); }, [tab, status.phase]);
  function previewSetting(kind: 'debug' | 'comparison', value: boolean) {
    changingPreview.current = true;
    ownedPreview.current[kind] = value;
    try {
      const current = useEditorStore.getState();
      if (kind === 'debug') current.setLightingDebugVisible(value); else current.setLightingComparisonEnabled(value);
      current.refreshLightingManagerPreview();
    } finally { changingPreview.current = false; }
  }
  function previewMotion() {
    const current = useEditorStore.getState();
    if (current.runtimeMode === 'preview') { current.stopRuntimePreview(); setNotice(null); return; }
    if (dirty) { setNotice('请先应用草稿，再进行运动预览。'); setNoticeIsError(true); return; }
    const ready = current.startRuntimePreview();
    setNotice(ready.ok ? null : ready.message);
    setNoticeIsError(!ready.ok);
    current.refreshLightingManagerPreview();
  }
  function stage(selection: LightingManagerSelection[], values: LightingManagerBulkValues, reset: boolean) {
    if (editingDisabled) return { ok: false, message: '请等待任务结束或停止运行预览后编辑。' };
    const next = stageLightingManagerExceptions(draft, rows, selection, values, reset);
    if (!next.ok) return next;
    setDraft(previous => ({ ...previous, entityLighting: next.entityLighting })); setNotice(null);
    return { ok: true };
  }
  function focusSelection(selection: LightingManagerSelection) {
    const row = selection.kind === 'node' ? rows.find(item => item.key === selection.key)
      : rows.find(item => item.ownerEntityId === selection.entityId && !item.entry.unmatchedOverride);
    if (!row) { setNotice('当前对象尚无可定位的运行时部件。'); setNoticeIsError(true); return; }
    setNotice(null);
    useEditorStore.getState().focusLightingNode(row.entityId, row.nodeKey);
    useEditorStore.getState().refreshLightingManagerPreview();
  }
  const checkedBlocked = !dirty && preflight.phase === 'blocked' && preflight.signature === signature;
  const bakeDisabled = editingDisabled || engineStatusLoading || engineStatus?.available === false || Boolean(draftPreview) || preflight.phase === 'checking' || checkedBlocked || staleDraft || !draft.lighting.bake.enabled || (!dirty && !requiresSceneLightingBake(scene));
  const applyLabel = tab === 'rules' ? '应用规则' : '应用配置';
  const footerWarning = dirty || Boolean(notice && noticeIsError) || status.phase === 'error';
  return <><dialog ref={dialogRef} className="lighting-manager" role="dialog" aria-labelledby="lighting-manager-title"
    onCancel={event => { event.preventDefault(); if (confirmation) setConfirmation(null); else close(); }}
    onKeyDown={event => event.stopPropagation()}>
    <header className="lighting-manager-header"><div><h2 id="lighting-manager-title">光照与烘焙管理器</h2><p>当前场景：<strong>{scene.name}</strong></p></div>
      <button type="button" className="lighting-manager-close" aria-label="关闭光照与烘焙管理器" onClick={close}><LightingManagerIcon name="close" size={23} /></button>
    </header>
    <nav className="lighting-manager-tabs" role="tablist" aria-label="光照管理页签">
      {TABS.map((item, index) => <button type="button" role="tab" key={item.id} id={`lighting-tab-${item.id}`} aria-controls={`lighting-page-${item.id}`}
        aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
          setTab(TABS[next].id); document.getElementById(`lighting-tab-${TABS[next].id}`)?.focus();
        }}>{item.label}</button>)}
    </nav>
    <div className="lighting-manager-content">
      {staleDraft && <div className="lighting-manager-conflict" role="alert"><span>场景已在其他操作中更新。当前草稿已保留，重新载入后才能应用。</span>
        <button type="button" onClick={() => setConfirmation('reload')}>重新载入当前配置</button></div>}
      {dirty && <LightingBakeManagerChanges summary={changes} impact={impact} />}
      {editingDisabled && <p className="lighting-manager-banner"><LightingManagerIcon name="warning" size={18} />{runtimeMode === 'preview' ? '运行预览中，配置只读；可在总览停止预览。' : '烘焙任务正在进行，配置只读；可在任务页取消或查看进度。'}</p>}
      <section id="lighting-page-overview" role="tabpanel" aria-labelledby="lighting-tab-overview" hidden={tab !== 'overview'}>
        <div className="lighting-manager-metrics">
          {[{ icon: 'cube' as const, label: '场景对象', value: sourceCount, tone: '' },
            { icon: 'layers' as const, label: '静态部件', value: counts.static, tone: 'is-static' },
            { icon: 'motion' as const, label: '动态部件', value: counts.dynamic, tone: 'is-dynamic' },
            { icon: 'warning' as const, label: '待检查', value: impact.mismatchCount + impact.conflictCount, tone: 'is-warning' }].map(metric =>
            <div key={metric.label} className={metric.tone}><LightingManagerIcon name={metric.icon} size={35} /><span>{metric.label}<strong>{metric.value.toLocaleString()}</strong></span></div>)}
        </div>
        <LightingBakeManagerOverview scene={draft.baseScene} lighting={draft.lighting} appearance={draft.appearance} result={result} resultLabel={resultLabel}
          disabled={editingDisabled} dirty={dirty} engineStatus={engineStatus} engineStatusLoading={engineStatusLoading} onRefreshDevices={() => void refreshDevices()} onConfigureEngine={() => setEngineConfigurationOpen(true)} probeBounds={preflight.report?.bounds} previewDraftActive={Boolean(draftPreview)} previewDraftSuppressed={draftPreview?.suppressIndirect ?? false} previewDraftRules={changes.rulesChanged || changes.exceptionsChanged} preflightBusy={preflight.phase === 'checking'} onPreviewDraft={previewDraft} onCheck={check} preview={preview} debug={debug} comparison={comparison} motionPreview={runtimeMode === 'preview'} busy={busy}
          onLightingChange={lighting => { setDraft(previous => ({ ...previous, lighting })); setNotice(null); }}
          onAppearanceChange={appearance => { setDraft(previous => ({ ...previous, appearance })); setNotice(null); }}
          onPreset={(id, target) => { setDraft(previous => applyLightingManagerPreset(previous, id, target)); setNotice(id === GLB_STANDARD_PREVIEW_PRESET_ID ? 'GLB 标准预览已同时暂存照明与显示，应用配置后生效，可一次撤销。' : '预设已暂存，应用配置后生效。'); setNoticeIsError(false); }}
          onDebug={value => previewSetting('debug', value)} onComparison={value => previewSetting('comparison', value)}
          onMotion={previewMotion} onRefresh={() => useEditorStore.getState().refreshLightingManagerPreview()} />
        {previewError && <p className="lighting-manager-warning" role="status">{previewError}</p>}
      </section>
      <section id="lighting-page-rules" role="tabpanel" aria-labelledby="lighting-tab-rules" hidden={tab !== 'rules'}>
        {visitedTabs.has('rules') && <LightingBakeManagerRules active={tab === 'rules'} ruleFocus={ruleFocus} scene={draft.baseScene} policy={policy} rows={rows} disabled={editingDisabled}
          onChange={policy => { setDraft(previous => ({ ...previous, lighting: { ...previous.lighting, policy } })); setNotice(null); }}
          onInspect={entityIds => useEditorStore.getState().openLightingManager({ tab: 'objects', entityIds })} />}
      </section>
      <section id="lighting-page-objects" role="tabpanel" aria-labelledby="lighting-tab-objects" hidden={tab !== 'objects'}>
        {visitedTabs.has('objects') && <LightingBakeManagerObjects active={tab === 'objects'} scene={draft.baseScene} rows={rows} focus={focus} disabled={editingDisabled} onStage={stage}
          onFocus={focusSelection} onRules={() => setTab('rules')} />}
      </section>
      <section id="lighting-page-resources" role="tabpanel" aria-labelledby="lighting-tab-resources" hidden={tab !== 'resources'}>
        <LightingBakeManagerResources result={result} status={status} resultLabel={resultLabel} busy={busy}
          disabled={editingDisabled || Boolean(draftPreview)} dirty={dirty} onCancel={() => useEditorStore.getState().cancelLightingBake()}
          onClear={() => { useEditorStore.getState().clearLightingBake(); reload(); }} issues={diagnostics}
          onInspect={issue => { if (issue.entityId) useEditorStore.getState().openLightingManager({ tab: 'objects', entityIds: [issue.ownerEntityId ?? issue.entityId], ...(issue.locatable ? { nodeKey: issue.runtimeNodeKey ?? issue.nodeKey } : {}) }); }}
          onFocus={issue => { if (issue.entityId) { useEditorStore.getState().focusLightingNode(issue.entityId, issue.runtimeNodeKey ?? issue.nodeKey ?? ''); useEditorStore.getState().refreshLightingManagerPreview(); setTab('overview'); } }}
          onRule={issue => { if (issue.ruleId && policy.rules.some(rule => rule.id === issue.ruleId)) { setRuleFocus(previous => ({ ruleId: issue.ruleId!, sequence: (previous?.sequence ?? 0) + 1 })); setTab('rules'); } else { setNotice('该规则已不存在，请重新检查当前配置。'); setNoticeIsError(true); } }}
          onRetry={check}>
          {visitedTabs.has('resources') && <LightingBakeManagerTaskTools active={tab === 'resources'} preflight={preflight} currentSignature={signature}
            costs={costs} history={taskHistory} historyError={taskHistoryError} disabled={editingDisabled || Boolean(draftPreview)} dirty={dirty}
            onCheck={check} onRefreshHistory={() => useEditorStore.getState().refreshLightingBakeTaskHistory()}
            onCleanup={ids => useEditorStore.getState().cleanupLightingBakeTasks(ids)}
            onReadLog={async id => { if (!window.editorApi?.readLightingBakeTaskLog) throw new Error('当前环境不支持读取本机任务日志。'); return window.editorApi.readLightingBakeTaskLog(id); }} />}
        </LightingBakeManagerResources>
      </section>
    </div>
    <footer className="lighting-manager-footer">
      {confirmation ? <div className="lighting-manager-confirm" role="alert"><span>放弃尚未应用的更改并{confirmation === 'reload' ? '重新载入' : '关闭'}？已运行的后台任务会继续。</span>
        <button type="button" onClick={() => setConfirmation(null)}>继续编辑</button>
        <button type="button" className="lighting-manager-danger" onClick={() => confirmation === 'reload' ? reload() : useEditorStore.getState().closeLightingManager()}>
          {confirmation === 'reload' ? '放弃更改并载入' : '放弃更改并关闭'}</button></div>
        : <>
          <div className={`lighting-manager-footer-status${footerWarning ? ' is-warning' : ''}`} role={notice && noticeIsError ? 'alert' : 'status'}><LightingManagerIcon name={footerWarning ? 'warning' : 'check'} size={21} />
            <span>{notice ?? (dirty ? '有未应用更改' : `配置已应用 · ${resultLabel}`)}
              <small>{dirty ? changes.categories.join(' · ')
                : impact.pendingCount ? `${impact.pendingCount} 项正在等待完整分类事实` : '当前规则作用于已有及新增的匹配对象'}</small></span>
          </div>
          <div className="lighting-manager-footer-actions"><button type="button" onClick={close}>{dirty ? '取消' : '关闭'}</button>
            {dirty && <button type="button" className={tab === 'overview' ? '' : 'lighting-manager-primary'} disabled={editingDisabled || staleDraft} onClick={apply}>{applyLabel}</button>}
            {(tab === 'overview' || (!dirty && tab === 'resources')) && <button type="button" className="lighting-manager-primary"
              disabled={bakeDisabled} onClick={bake}>{dirty ? '应用并烘焙' : !requiresSceneLightingBake(scene) ? '无需静态烘焙' : result ? '重新烘焙' : '开始烘焙'}</button>}
            {busy && <button type="button" onClick={() => setTab('resources')}>查看任务</button>}
          </div>
        </>}
    </footer>
  </dialog><LightingBakeEngineDialog open={engineConfigurationOpen} disabled={busy} onClose={() => setEngineConfigurationOpen(false)}
    onSaved={configuration => { invalidateEngineStatus(); setEngineStatus(configuration.engine); setEngineStatusLoading(false); }} /></>;
}
