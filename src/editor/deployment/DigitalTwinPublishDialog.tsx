import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { createDeploymentSceneSummary } from './deploymentExport';
import type { DigitalTwinPublishController } from './useDigitalTwinPublish';
import { useEditorStore } from '../store/editorStore';

export type DigitalTwinPublishDialogProps = {
  open: boolean;
  controller: DigitalTwinPublishController;
  onClose: () => void;
};

/** 展示目标工程、版本与资源修订，并承接覆盖和缺失资源关联二次确认。 */
export function DigitalTwinPublishDialog(props: DigitalTwinPublishDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const scene = useEditorStore((state) => state.scene);
  const summary = useMemo(() => createDeploymentSceneSummary(scene), [scene]);
  const [publishName, setPublishName] = useState('');
  const [remark, setRemark] = useState('');
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [confirmResourceBindings, setConfirmResourceBindings] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const { state, isBusy } = props.controller;
  const context = state.context;
  const missingBindings = useMemo(() => readMissingBindings(state.result?.errorData), [state.result?.errorData]);
  const requiresOverwriteConfirmation = Boolean(
    context?.overwriteConfirmationRequired
    || state.result?.errorCode === 'DIGITAL_TWIN_OVERWRITE_CONFIRM_REQUIRED',
  );
  const requiresResourceConfirmation = state.result?.errorCode === 'DIGITAL_TWIN_RESOURCE_BINDING_CONFIRM_REQUIRED';

  useEffect(() => {
    if (!props.open) return;
    void props.controller.loadContext();
  }, [props.controller.loadContext, props.open]);

  useEffect(() => {
    if (!props.open || publishName || !context?.projectName) return;
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    setPublishName(`${context.projectName} · ${timestamp}`.slice(0, 256));
  }, [context?.projectName, props.open, publishName]);

  useEffect(() => {
    if (context?.overwriteConfirmationRequired) setOverwriteExisting(false);
  }, [context?.overwriteConfirmationRequired]);

  if (!props.open) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!context?.available) {
      setValidationError('当前工程未绑定数据中台业务项目。');
      return;
    }
    if (context.versionConflict) {
      setValidationError('远端已经产生新版本，请重新打开最新工程后再发布。');
      return;
    }
    const normalizedName = publishName.trim();
    if (!normalizedName || normalizedName.length > 256) {
      setValidationError('发布名称必须是 1 到 256 个字符。');
      return;
    }
    if (requiresOverwriteConfirmation && !overwriteExisting) {
      setValidationError('目标项目已有当前数字孪生工程，请先确认覆盖。');
      return;
    }
    if (requiresResourceConfirmation && !confirmResourceBindings) {
      setValidationError('请确认仅补充缺失的项目资源关联。');
      return;
    }
    setValidationError(null);
    await props.controller.start({
      publishName: normalizedName,
      remark,
      overwriteExisting,
      confirmResourceBindings,
    });
  }

  function handleClose(): void {
    if (isBusy) return;
    props.controller.reset();
    setPublishName('');
    setRemark('');
    setOverwriteExisting(false);
    setConfirmResourceBindings(false);
    setValidationError(null);
    props.onClose();
  }

  const progress = state.progress;
  const progressPercent = Math.round(progress?.percent ?? 0);
  const completed = state.result?.status === 'completed';

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
        className="deployment-export-dialog digital-twin-publish-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void handleSubmit(event)}
        role="dialog"
      >
        <div className="deployment-export-dialog-header">
          <div>
            <h2 id={titleId}>发布到数据中台</h2>
            <p id={descriptionId}>保存源工程，并发布不可变、自包含的数字孪生 Viewer 快照。</p>
          </div>
          <button
            aria-label="关闭发布到数据中台对话框"
            className="deployment-export-dialog-close"
            disabled={isBusy}
            onClick={handleClose}
            type="button"
          >
            ×
          </button>
        </div>

        {state.status === 'loading-context' ? <p className="digital-twin-publish-message">正在读取项目绑定与远端版本…</p> : null}

        <section className="deployment-export-dialog-section" aria-label="发布目标">
          <div className="deployment-export-section-heading">
            <h3>发布目标</h3>
            <span>{context?.available ? context.projectId : '未绑定'}</span>
          </div>
          <dl className="digital-twin-publish-context-grid">
            <div><dt>业务项目</dt><dd>{context?.projectName ?? '当前工程未绑定数据中台项目'}</dd></div>
            <div><dt>本地基础版本</dt><dd>{context?.baseVersionNumber ? `v${context.baseVersionNumber}` : '首次发布'}</dd></div>
            <div><dt>远端最新版本</dt><dd>{context?.remoteLatestVersionNumber ? `v${context.remoteLatestVersionNumber}` : '暂无'}</dd></div>
            <div><dt>资源修订</dt><dd>{context?.resourceRevision ?? '-'}</dd></div>
            <div className="digital-twin-publish-context-wide"><dt>入口场景</dt><dd>{context?.entryScenePath ?? `${scene.name}.scene.json（发布时创建）`}</dd></div>
          </dl>
          {context?.versionConflict ? (
            <p className="deployment-export-error" role="alert">远端工程已产生新版本，禁止覆盖发布。请重新打开最新工程；当前发布尝试会保留冲突副本。</p>
          ) : null}
        </section>

        <section className="deployment-export-dialog-section" aria-label="工程包摘要">
          <div className="deployment-export-section-heading">
            <h3>工程包摘要</h3>
            <span>{summary.entityCount} 个实体</span>
          </div>
          <div className="deployment-export-summary-grid">
            <div><strong>{summary.resourceCount}</strong><span>当前场景资源</span></div>
            <div><strong>{summary.modelCount + summary.environmentCount}</strong><span>模型与环境</span></div>
          </div>
          <p className="deployment-export-resource-detail">
            源工程 ZIP：项目全部场景及实际引用资源（跳过 CAD/DXF）；dist ZIP：当前入口场景、自包含 Viewer 与 SHA-256 清单。
          </p>
        </section>

        <section className="deployment-export-dialog-section" aria-label="发布设置">
          <label className="deployment-export-dialog-field">
            <span>发布名称</span>
            <input
              disabled={isBusy}
              maxLength={256}
              onChange={(event) => {
                setPublishName(event.target.value);
                setValidationError(null);
              }}
              value={publishName}
            />
          </label>
          <label className="deployment-export-dialog-field">
            <span>备注</span>
            <input disabled={isBusy} maxLength={512} onChange={(event) => setRemark(event.target.value)} value={remark} />
          </label>
          {requiresOverwriteConfirmation ? (
            <label className="digital-twin-publish-confirmation">
              <input
                checked={overwriteExisting}
                disabled={isBusy}
                onChange={(event) => {
                  setOverwriteExisting(event.target.checked);
                  setValidationError(null);
                }}
                type="checkbox"
              />
              <span><strong>确认覆盖目标项目当前数字孪生工程</strong><small>沿用原 Editor 工程创建下一版本，不删除历史版本。</small></span>
            </label>
          ) : null}
          {requiresResourceConfirmation ? (
            <label className="digital-twin-publish-confirmation digital-twin-publish-confirmation-warning">
              <input
                checked={confirmResourceBindings}
                disabled={isBusy}
                onChange={(event) => {
                  setConfirmResourceBindings(event.target.checked);
                  setValidationError(null);
                }}
                type="checkbox"
              />
              <span>
                <strong>确认补充缺失的项目资源关联</strong>
                <small>{formatMissingBindings(missingBindings)}；不会自动解绑任何已有关系。</small>
              </span>
            </label>
          ) : null}
        </section>

        {progress ? (
          <section className="deployment-export-dialog-section deployment-export-status" aria-label="发布进度">
            <div className="deployment-export-section-heading">
              <h3>{progress.detail}</h3>
              <span>{progressPercent}%</span>
            </div>
            <div className="deployment-export-progress-track"><span className="deployment-export-progress-fill" style={{ width: `${progressPercent}%` }} /></div>
            {progress.totalBytes > 0 ? <p>{formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)}</p> : null}
          </section>
        ) : null}

        {state.result?.message && state.result.status !== 'completed' ? (
          <p className={state.result.status === 'conflict' ? 'deployment-export-error' : 'digital-twin-publish-message'} role="status">
            {state.result.message}
            {state.result.conflictCopyPath ? ` 冲突副本：${state.result.conflictCopyPath}` : ''}
          </p>
        ) : null}
        {state.error || validationError ? <p className="deployment-export-error" role="alert">{validationError ?? state.error}</p> : null}
        {state.result?.warnings.length ? (
          <section className="deployment-export-dialog-section deployment-export-warnings" aria-label="发布提示">
            <h3>发布提示</h3>
            <ul>{state.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </section>
        ) : null}
        {completed ? (
          <section className="deployment-export-dialog-section deployment-export-result" aria-label="发布结果">
            <h3>发布完成</h3>
            <p>工程版本：{state.result?.editorProjectVersionNumber ? `v${state.result.editorProjectVersionNumber}` : state.result?.editorProjectVersionId}</p>
            <p>稳定地址：{state.result?.stableUrl ?? '-'}</p>
            <p>历史地址：{state.result?.releaseUrl ?? '-'}</p>
          </section>
        ) : null}

        <div className="deployment-export-dialog-actions">
          {state.status === 'publishing' ? (
            <button className="deployment-export-danger-button" onClick={() => void props.controller.cancel()} type="button">取消发布</button>
          ) : (
            <button onClick={handleClose} type="button">{completed ? '关闭' : '取消'}</button>
          )}
          {!completed ? (
            <button
              className="deployment-export-primary-button"
              disabled={isBusy || !context?.available || Boolean(context.versionConflict)}
              type="submit"
            >
              {state.status === 'publishing' ? '发布中…' : requiresResourceConfirmation ? '确认关联并重试发布' : '确认发布'}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

type MissingBindings = { modelIds: string[]; envModelIds: string[]; comboModelIds: string[] };

function readMissingBindings(value: unknown): MissingBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { modelIds: [], envModelIds: [], comboModelIds: [] };
  const source = value as Record<string, unknown>;
  const read = (key: string): string[] => Array.isArray(source[key])
    ? source[key].map(String).filter((item) => /^\d+$/.test(item))
    : [];
  return { modelIds: read('modelIds'), envModelIds: read('envModelIds'), comboModelIds: read('comboModelIds') };
}

function formatMissingBindings(value: MissingBindings): string {
  const parts = [
    value.modelIds.length ? `模型 ${value.modelIds.length} 个` : '',
    value.envModelIds.length ? `环境模型 ${value.envModelIds.length} 个` : '',
    value.comboModelIds.length ? `组合模型 ${value.comboModelIds.length} 个` : '',
  ].filter(Boolean);
  return parts.length ? `缺失关联：${parts.join('、')}` : '服务端检测到缺失资源关联';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
