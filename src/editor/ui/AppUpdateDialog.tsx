import { useEffect, useRef } from 'react';
import { formatUpdateBytes, type AppUpdateState } from '../../../electron/shared/appUpdate';
import './AppUpdateDialog.css';

type AppUpdateDialogProps = {
  open: boolean;
  state: AppUpdateState;
  installing: boolean;
  onClose: () => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
};

function formatReleaseDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 全局应用更新对话框，展示检查、下载进度、更新说明与重启安装操作。 */
export function AppUpdateDialog({
  open,
  state,
  installing,
  onClose,
  onCheck,
  onDownload,
  onInstall,
}: AppUpdateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!dialog.open) dialog.showModal();
      return () => {
        if (dialog.open) dialog.close();
        if (previous?.isConnected) previous.focus();
      };
    }
    if (dialog.open) dialog.close();
    return undefined;
  }, [open]);

  if (!open) return null;

  const formattedDate = formatReleaseDate(state.releaseDate);
  const percent = state.progress ? Math.round(state.progress.percent) : 0;

  return (
    <dialog
      ref={dialogRef}
      className="app-update-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-update-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!installing) onClose();
      }}
    >
      <div className="app-update-header">
        <h2 id="app-update-title">检查软件更新</h2>
        <span className="app-update-version-badge">当前 v{state.currentVersion}</span>
      </div>

      {state.stage === 'checking' ? (
        <p className="app-update-summary">正在从 GitHub Releases 检查新版本，请稍候…</p>
      ) : null}

      {state.stage === 'available' ? (
        <>
          <p className="app-update-summary">
            发现新版本 <strong>v{state.availableVersion}</strong>
            {formattedDate ? `（发布于 ${formattedDate}）` : ''}，可下载并安装更新。
          </p>
          {state.releaseNotes ? (
            <pre className="app-update-notes" aria-label="版本更新说明">{state.releaseNotes}</pre>
          ) : null}
        </>
      ) : null}

      {state.stage === 'downloading' ? (
        <>
          <p className="app-update-summary">
            正在下载新版本 <strong>v{state.availableVersion ?? ''}</strong> 安装包…
          </p>
          <div className="app-update-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="app-update-progress-track">
              <div className="app-update-progress-bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="app-update-progress-meta">
              <span>
                {percent}%
                {state.progress && state.progress.total > 0
                  ? `（${formatUpdateBytes(state.progress.transferred)} / ${formatUpdateBytes(state.progress.total)}）`
                  : ''}
              </span>
              <span>
                {state.progress && state.progress.bytesPerSecond > 0
                  ? `${formatUpdateBytes(state.progress.bytesPerSecond)}/s`
                  : ''}
              </span>
            </div>
          </div>
        </>
      ) : null}

      {state.stage === 'downloaded' ? (
        <>
          <p className="app-update-summary">
            新版本 <strong>v{state.availableVersion ?? ''}</strong> 已下载完成。点击“立即重启并安装”将退出编辑器并启动安装程序。
          </p>
          {state.releaseNotes ? (
            <pre className="app-update-notes" aria-label="版本更新说明">{state.releaseNotes}</pre>
          ) : null}
        </>
      ) : null}

      {state.stage === 'not-available' ? (
        <p className="app-update-summary">当前已是最新版本（v{state.currentVersion}），无需更新。</p>
      ) : null}

      {state.stage === 'unsupported' ? (
        <p className="app-update-summary">{state.errorMessage || '当前运行环境不支持自动更新。'}</p>
      ) : null}

      {state.stage === 'idle' ? (
        <p className="app-update-summary">点击下方按钮可从 GitHub Releases 检测是否存在新版本。</p>
      ) : null}

      {state.stage === 'error' ? (
        <p className="app-update-error" role="alert">
          {state.errorMessage || '检查或下载更新失败，请稍后重试。'}
        </p>
      ) : null}

      <div className="app-update-actions">
        {state.stage === 'available' ? (
          <>
            <button type="button" onClick={onClose}>稍后再说</button>
            <button className="app-update-primary" type="button" onClick={onDownload}>立即下载</button>
          </>
        ) : null}

        {state.stage === 'downloading' ? (
          <button type="button" onClick={onClose}>后台下载</button>
        ) : null}

        {state.stage === 'downloaded' ? (
          <>
            <button disabled={installing} type="button" onClick={onClose}>稍后退出时安装</button>
            <button className="app-update-primary" disabled={installing} type="button" onClick={onInstall}>
              {installing ? '正在准备重启…' : '立即重启并安装'}
            </button>
          </>
        ) : null}

        {state.stage === 'checking' ? (
          <button type="button" onClick={onClose}>隐藏</button>
        ) : null}

        {state.stage === 'not-available' || state.stage === 'idle' ? (
          <>
            <button type="button" onClick={onCheck}>重新检查</button>
            <button className="app-update-primary" type="button" onClick={onClose}>关闭</button>
          </>
        ) : null}

        {state.stage === 'unsupported' ? (
          <button className="app-update-primary" type="button" onClick={onClose}>知道了</button>
        ) : null}

        {state.stage === 'error' ? (
          <>
            <button type="button" onClick={onClose}>关闭</button>
            {state.availableVersion ? (
              <button className="app-update-primary" type="button" onClick={onDownload}>重新下载</button>
            ) : (
              <button className="app-update-primary" type="button" onClick={onCheck}>重试检查</button>
            )}
          </>
        ) : null}
      </div>
    </dialog>
  );
}
