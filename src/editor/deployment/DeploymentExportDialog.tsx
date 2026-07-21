import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  createDefaultDeploymentProjectName,
  createDeploymentSceneSummary,
  formatDeploymentByteCount,
  getDeploymentProjectNameError,
  getDeploymentStageLabel,
  type DeploymentExportOutputType,
  type DeploymentExportStatus,
} from './deploymentExport';
import type { DeploymentExportController } from './useDeploymentExport';

type DeploymentExportDialogProps = {
  open: boolean;
  controller: DeploymentExportController;
  onClose: () => void;
};

const DEPLOYMENT_STATUS_MESSAGES: Record<DeploymentExportStatus, string> = {
  idle: '确认工程名称和输出形式后开始导出。',
  preparing: '正在捕获场景快照并等待系统输出位置。',
  exporting: '正在生成独立 Viewer、复制资源并发布结果。',
  success: '部署工程已生成，可打开结果位置继续部署。',
  error: '部署工程导出失败，请检查错误后重试。',
  canceled: '本次导出已取消，临时产物将由 worker 清理。',
};

/** 合并进度与完成结果中的警告，保持原有顺序并移除重复项。 */
function collectWarnings(controller: DeploymentExportController): string[] {
  const warnings = [
    ...(controller.state.progress?.warnings ?? []),
    ...(controller.state.result?.warnings ?? []),
  ];
  return Array.from(new Set(warnings));
}

/** 将文件进度格式化为“已完成/总数”，未知总数时只展示已完成数量。 */
function formatFileProgress(completedFiles: number, totalFiles: number): string {
  if (totalFiles > 0) return `${completedFiles} / ${totalFiles}`;
  return completedFiles > 0 ? `${completedFiles}` : '—';
}

/** 将字节进度格式化为“已完成/总量”，总量未知时保留当前已写入量。 */
function formatByteProgress(completedBytes: number, totalBytes: number | null): string {
  if (totalBytes !== null && totalBytes > 0) {
    return `${formatDeploymentByteCount(completedBytes)} / ${formatDeploymentByteCount(totalBytes)}`;
  }
  return completedBytes > 0 ? formatDeploymentByteCount(completedBytes) : '—';
}

/** 独立部署导出对话框，负责表单、场景摘要、进度、警告和终态操作。 */
export function DeploymentExportDialog(props: DeploymentExportDialogProps) {
  const scene = useEditorStore((state) => state.scene);
  const liveSummary = useMemo(() => createDeploymentSceneSummary(scene), [scene]);
  const [projectName, setProjectName] = useState(() => createDefaultDeploymentProjectName(scene.name));
  const [outputType, setOutputType] = useState<DeploymentExportOutputType>('directory');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isCancelPending, setCancelPending] = useState(false);
  const [isRevealPending, setRevealPending] = useState(false);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const progressLabelId = useId();
  const warningsTitleId = useId();
  const resultTitleId = useId();
  const { controller } = props;
  const { state } = controller;
  const isBusy = controller.isBusy;

  useEffect(() => {
    const justOpened = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!justOpened) return;

    setProjectName(createDefaultDeploymentProjectName(scene.name));
    setOutputType('directory');
    setValidationError(null);
    setCancelPending(false);
    setRevealPending(false);

    const focusFrame = window.requestAnimationFrame(() => projectNameInputRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.open, scene.name]);

  useEffect(() => {
    if (!props.open) return;

    /** Esc 仅关闭非活动对话框，导出中必须显式取消以保持 worker 状态可见。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || isBusy) return;
      event.preventDefault();
      controller.reset();
      props.onClose();
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [controller, isBusy, props]);

  if (!props.open) return null;

  const summary = state.snapshot?.summary ?? liveSummary;
  const progress = state.progress;
  const result = state.result;
  const warnings = collectWarnings(controller);
  const stageLabel = getDeploymentStageLabel(progress?.stage ?? '', state.status);
  const percent = state.status === 'success' ? 100 : progress?.percent ?? 0;
  const completedFiles = result?.fileCount ?? progress?.completedFiles ?? 0;
  const totalFiles = result?.fileCount ?? progress?.totalFiles ?? 0;
  const completedBytes = result?.totalBytes ?? progress?.completedBytes ?? 0;
  const totalBytes = result?.totalBytes ?? progress?.totalBytes ?? null;
  const visibleError = validationError ?? state.error;
  const submitLabel = state.status === 'idle' ? '开始导出' : state.status === 'success' ? '再次导出' : '重试';

  /** 校验表单并启动一次全新的当前场景快照导出。 */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isBusy) return;

    const projectNameError = getDeploymentProjectNameError(projectName);
    if (projectNameError) {
      setValidationError(projectNameError);
      projectNameInputRef.current?.focus();
      return;
    }

    setValidationError(null);
    setRevealPending(false);
    await controller.start({ projectName: projectName.trim(), outputType });
  }

  /** 请求取消活动导出，并在 IPC 返回前锁定重复点击。 */
  async function handleCancel(): Promise<void> {
    if (!isBusy || isCancelPending) return;
    setCancelPending(true);
    await controller.cancel();
    setCancelPending(false);
  }

  /** 打开完成结果所在位置，并避免用户重复触发系统文件管理器。 */
  async function handleReveal(): Promise<void> {
    if (!result?.outputPath || isRevealPending) return;
    setRevealPending(true);
    await controller.reveal();
    setRevealPending(false);
  }

  /** 关闭非活动对话框并清空终态，下一次打开重新读取当前场景。 */
  function handleClose(): void {
    if (isBusy) return;
    controller.reset();
    props.onClose();
  }

  return (
    <div
      className="deployment-export-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <form
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="deployment-export-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void handleSubmit(event)}
        role="dialog"
      >
        <div className="deployment-export-dialog-header">
          <div>
            <h2 id={titleId}>导出部署工程</h2>
            <p id={descriptionId}>生成不包含编辑器与 Electron 的独立静态 Web Viewer。</p>
          </div>
          <button
            aria-label="关闭导出部署工程对话框"
            className="deployment-export-dialog-close"
            disabled={isBusy}
            onClick={handleClose}
            title={isBusy ? '请先取消当前导出' : '关闭'}
            type="button"
          >
            ×
          </button>
        </div>

        <section className="deployment-export-dialog-section" aria-label="导出设置">
          <label className="deployment-export-dialog-field">
            <span>工程名称</span>
            <input
              aria-invalid={Boolean(validationError)}
              disabled={isBusy}
              maxLength={120}
              onChange={(event) => {
                setProjectName(event.target.value);
                if (validationError) setValidationError(null);
              }}
              ref={projectNameInputRef}
              spellCheck={false}
              value={projectName}
            />
          </label>

          <fieldset className="deployment-export-output-options" disabled={isBusy}>
            <legend>输出形式</legend>
            <label className={outputType === 'directory' ? 'deployment-export-output-option selected' : 'deployment-export-output-option'}>
              <input
                checked={outputType === 'directory'}
                name="deployment-output-type"
                onChange={() => setOutputType('directory')}
                type="radio"
                value="directory"
              />
              <span><strong>部署目录</strong><small>直接生成可上传到静态服务器的工程目录</small></span>
            </label>
            <label className={outputType === 'zip' ? 'deployment-export-output-option selected' : 'deployment-export-output-option'}>
              <input
                checked={outputType === 'zip'}
                name="deployment-output-type"
                onChange={() => setOutputType('zip')}
                type="radio"
                value="zip"
              />
              <span><strong>ZIP 压缩包</strong><small>生成便于传输和归档的单个压缩文件</small></span>
            </label>
          </fieldset>
        </section>

        <section className="deployment-export-dialog-section" aria-labelledby={`${titleId}-summary`}>
          <div className="deployment-export-section-heading">
            <h3 id={`${titleId}-summary`}>场景快照摘要</h3>
            <span>{state.snapshot ? '已捕获' : '当前场景'}</span>
          </div>
          <div className="deployment-export-summary-grid">
            <div><strong>{summary.entityCount}</strong><span>场景实体</span></div>
            <div><strong>{summary.resourceCount}</strong><span>唯一资源</span></div>
          </div>
          <p className="deployment-export-resource-detail">
            模型 {summary.modelCount} · 环境 {summary.environmentCount} · CAD {summary.cadCount} · 脚本 {summary.scriptCount}
          </p>
        </section>

        <section className={`deployment-export-dialog-section deployment-export-status deployment-export-status-${state.status}`} aria-labelledby={progressLabelId}>
          <div className="deployment-export-section-heading">
            <h3 id={progressLabelId}>导出进度</h3>
            <span aria-live="polite" role="status">{DEPLOYMENT_STATUS_MESSAGES[state.status]}</span>
          </div>
          <div className="deployment-export-progress-heading">
            <strong>{stageLabel}</strong>
            <span>{percent}%</span>
          </div>
          <div
            aria-label={`部署导出进度：${stageLabel}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            aria-valuetext={`${stageLabel}，${percent}%`}
            className="deployment-export-progress-track"
            role="progressbar"
          >
            <div className="deployment-export-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <dl className="deployment-export-progress-metrics">
            <div><dt>文件</dt><dd>{formatFileProgress(completedFiles, totalFiles)}</dd></div>
            <div><dt>字节</dt><dd>{formatByteProgress(completedBytes, totalBytes)}</dd></div>
            {result ? <div><dt>外部资源包</dt><dd>{result.externalAssetCount}</dd></div> : null}
          </dl>
          <p className="deployment-export-progress-message">{progress?.message || DEPLOYMENT_STATUS_MESSAGES[state.status]}</p>
          {progress?.currentFile ? <p className="deployment-export-current-file" title={progress.currentFile}>{progress.currentFile}</p> : null}
        </section>

        {warnings.length > 0 ? (
          <section className="deployment-export-dialog-section deployment-export-warnings" aria-labelledby={warningsTitleId}>
            <h3 id={warningsTitleId}>警告（{warnings.length}）</h3>
            <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </section>
        ) : null}

        {result?.outputPath ? (
          <section className="deployment-export-dialog-section deployment-export-result" aria-labelledby={resultTitleId}>
            <h3 id={resultTitleId}>结果路径</h3>
            <output title={result.outputPath}>{result.outputPath}</output>
          </section>
        ) : null}

        {visibleError ? <p className="deployment-export-error" role="alert">{visibleError}</p> : null}

        <div className="deployment-export-dialog-actions">
          <button disabled={isBusy} onClick={handleClose} type="button">关闭</button>
          {isBusy ? (
            <button
              className="deployment-export-danger-button"
              disabled={isCancelPending}
              onClick={() => void handleCancel()}
              type="button"
            >
              {isCancelPending ? '正在取消…' : '取消导出'}
            </button>
          ) : null}
          {state.status === 'success' && result?.outputPath ? (
            <button
              disabled={isRevealPending}
              onClick={() => void handleReveal()}
              type="button"
            >
              {isRevealPending ? '正在打开…' : '打开位置'}
            </button>
          ) : null}
          {!isBusy ? <button className="deployment-export-primary-button" type="submit">{submitLabel}</button> : null}
        </div>
      </form>
    </div>
  );
}
