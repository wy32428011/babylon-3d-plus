import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import styles from '../../shared/ui/SceneLoadingMask.module.css';
import { SceneLoadingMask } from '../../shared/ui/SceneLoadingMask';
import { RemoteDownloadDetail } from './RemoteDownloadDetail';
import { sceneRemoteDownloadStore } from './sceneRemoteDownloadProgress';
import { environmentPreparationStore } from './environmentPreparationProgress';
import { useEditorStore } from '../store/editorStore';
import {
  getScenePreparationSnapshot,
  allowScenePreparationEditing,
  isScenePreparationSettled,
  subscribeScenePreparation,
} from './scenePreparationProgress';

/** 覆盖整个编辑器的场景准备蒙版，直到同步、刷新、加载和合批全部落定。 */
export function ScenePreparationOverlay({ onCancel, cancelling = false }: { onCancel: () => void; cancelling?: boolean }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const localScene = useEditorStore(state => state.sceneResourcePolicy !== 'preserve-snapshot');
  const remoteScene = useEditorStore(state => state.sceneResourcePolicy === 'data-platform-refresh');
  const issues = useEditorStore(state => state.sceneResourceIssues);
  const transaction = useEditorStore(state => state.latestSceneResourceTransaction);
  const environmentRecoveryChoice = useEditorStore(state => state.localSceneEnvironmentRecoveryChoice);
  const [copyStatus, setCopyStatus] = useState('');
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const environment = useSyncExternalStore(
    environmentPreparationStore.subscribe,
    environmentPreparationStore.getSnapshot,
    environmentPreparationStore.getSnapshot,
  );
  const downloads = useSyncExternalStore(
    sceneRemoteDownloadStore.subscribe,
    sceneRemoteDownloadStore.getSnapshot,
    sceneRemoteDownloadStore.getSnapshot,
  );
  const state = useSyncExternalStore(
    subscribeScenePreparation,
    getScenePreparationSnapshot,
    getScenePreparationSnapshot,
  );

  useEffect(() => {
    if (isScenePreparationSettled(state) && !transaction) return undefined;
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const cancelButton = overlayRef.current?.querySelector('button');
    if (cancelButton) cancelButton.focus();
    else overlayRef.current?.focus();
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus();
    };
  }, [state.completed, state.sceneSessionId, state.assetRefreshStatus, state.editingAllowed, remoteScene, transaction]);

  const environmentError = environment.sceneSessionId === state.sceneSessionId ? environment.error : null;
  if (remoteScene && !transaction && isScenePreparationSettled(state)) {
    const detail = [...new Set([...issues, ...(environmentError ? [environmentError] : [])])].join('\n');
    if (!detail) return null;
    const noticeKey = JSON.stringify([state.sceneSessionId, state.modelSyncRunId, detail]);
    if (dismissedNotice === noticeKey) return <button type="button" className={styles.resourceNoticeSummary}
      onClick={() => setDismissedNotice(null)} aria-label="查看场景资源问题">资源问题 · 查看详情</button>;
    return <aside className={styles.resourceNotice} aria-label="场景资源状态">
      <button type="button" className={styles.resourceNoticeClose} aria-label="关闭场景资源提示"
        title="关闭提示" onClick={() => setDismissedNotice(noticeKey)}>×</button>
      <strong>{detail ? '场景已打开，部分资源需要处理' : '场景已打开，正在同步最新模型'}</strong>
      <p>{detail ? '可继续编辑和保存，发布前请解决资源问题。' : '保留当前场景参数，同步完成后应用可用模型。'}</p>
      <details><summary>查看详情</summary><pre>{detail || state.detail}</pre></details>
      {detail ? <>
        <button type="button" disabled={environment.retrying}
          onClick={() => {
            if (!environmentError) environmentPreparationStore.fail(state.sceneSessionId, detail);
            void environmentPreparationStore.retry();
          }}>重新同步场景资源</button>
        <button type="button" onClick={() => {
          if (!navigator.clipboard?.writeText) { setCopyStatus('复制不可用，请展开详情手动复制'); return; }
          void navigator.clipboard.writeText(detail).then(() => setCopyStatus('已复制'), () => setCopyStatus('复制失败，请展开详情手动复制'));
        }}>复制详情</button>
        <span role="status">{copyStatus}</span>
      </> : null}
    </aside>;
  }
  if (state.completed && !environmentError) return null;

  return (
    <SceneLoadingMask
      detail={environmentError ?? state.detail}
      label={environmentError ? (localScene ? '场景资源加载失败' : '环境模型加载失败') : state.label}
      percent={state.percent}
      phase={state.phase}
      downloadDetail={<>
        {environmentError && environmentRecoveryChoice ? <section className={styles.environmentRecoveryChoice} aria-label="环境版本恢复确认">
          <strong>{environmentRecoveryChoice.displayName}：原环境版本不可用</strong>
          <p>当前中台有可用的环境版本。确认后仅替换该环境的资源版本，保留场景中的摆放、单位和显示设置。</p>
          <table><thead><tr><th>资源</th><th>版本</th><th>文件大小（字节）</th></tr></thead><tbody>
            <tr><th>原环境</th><td>{environmentRecoveryChoice.previousRevision || '未记录'}</td>
              <td>{environmentRecoveryChoice.previousSize == null ? '未记录' : environmentRecoveryChoice.previousSize.toLocaleString('zh-CN')}</td></tr>
            <tr><th>当前中台环境</th><td>{environmentRecoveryChoice.availableRevision}</td>
              <td>{environmentRecoveryChoice.availableSize.toLocaleString('zh-CN')}</td></tr>
          </tbody></table>
          <details><summary>查看当前版本文件校验值</summary><code>SHA-256：{environmentRecoveryChoice.sha256}</code></details>
        </section> : null}
        {downloads.sceneSessionId === state.sceneSessionId ? <>
          {downloads.model ? <RemoteDownloadDetail label="模型远程下载" download={downloads.model.download} /> : null}
          {downloads.environment ? <RemoteDownloadDetail label="环境模型远程下载" download={downloads.environment.download} /> : null}
        </> : null}
      </>}
      ref={overlayRef}
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}
      action={<>
          {environmentError ? <button disabled={environment.retrying} onClick={() => void environmentPreparationStore.retry()} type="button">{localScene ? '重新同步场景资源' : '重试环境模型同步'}</button> : null}
          {environmentError && environmentRecoveryChoice ? <button data-environment-recovery-accept type="button"
            disabled={environment.retrying || cancelling} onClick={() => {
              if (useEditorStore.getState().acceptLocalSceneEnvironmentRecoveryChoice(state.sceneSessionId, environmentRecoveryChoice)) {
                void environmentPreparationStore.retry();
              }
            }}>使用当前中台环境版本恢复</button> : null}
          {remoteScene && state.runtime.forcedSettled && !transaction ? <button type="button"
            onClick={() => allowScenePreparationEditing(state.sceneSessionId, true)}>保留资源问题并继续编辑</button> : null}
          <button disabled={cancelling} onClick={onCancel} type="button">{cancelling ? '正在请求取消…' : '取消加载并返回首页'}</button>
        </>}
    />
  );
}
