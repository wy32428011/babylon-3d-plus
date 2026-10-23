import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LightingBakeEngineConfiguration } from '../../../electron/shared/lightingBakeEngineConfiguration';
import type { LightingBakeEngineStatus } from '../../../electron/shared/sceneLightingBakeContract';
import { LightingManagerIcon } from './LightingBakeManagerWidgets';
import './lighting-bake-manager.css';
import './lighting-bake-engine.css';

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved?: (configuration: LightingBakeEngineConfiguration) => void;
  disabled?: boolean;
};
type Action = 'loading' | 'choosing' | 'detecting' | 'saving' | null;
const SOURCE_LABELS = { environment: '环境变量', configuration: '本机手动配置', installation: '自动查找' };

/** 独立本机设置使用顶层原生模态窗口，保存不进入场景草稿和撤销历史。 */
export function LightingBakeEngineDialog({ open, ...props }: Props) {
  if (!open) return null;
  const dialog = <LightingBakeEngineDialogSession {...props} />;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function LightingBakeEngineDialogSession({ onClose, onSaved, disabled = false }: Omit<Props, 'open'>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const titleId = useId(), descriptionId = useId(), pathId = useId();
  const [configuration, setConfiguration] = useState<LightingBakeEngineConfiguration | null>(null);
  const [candidate, setCandidate] = useState('');
  const [action, setAction] = useState<Action>('loading');
  const [checked, setChecked] = useState<LightingBakeEngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const readonly = disabled || Boolean(configuration?.busy);
  const busy = action !== null;
  const closingBlocked = action === 'saving' || action === 'choosing';
  const draftChanged = configuration !== null && candidate.trim() !== (configuration.configuredPath ?? '');
  const status = checked ?? (draftChanged ? null : configuration?.engine);

  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { mounted.current = false; dialog?.close(); };
  }, []);

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        if (!window.editorApi?.getLightingBakeEngineConfiguration) throw new Error('当前编辑器不支持配置本机烘焙引擎，请更新编辑器。');
        const value = await window.editorApi.getLightingBakeEngineConfiguration();
        if (!current) return;
        setConfiguration(value); setCandidate(value.configuredPath ?? '');
        setError(value.configurationError ?? null);
      } catch (reason) { if (current) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (current) { setAction(null); inputRef.current?.focus(); } }
    }
    void load();
    return () => { current = false; };
  }, []);

  function changeCandidate(value: string) {
    setCandidate(value); setChecked(null); setError(null); setNotice(null);
  }
  async function choose() {
    if (busy || readonly) return;
    setAction('choosing'); setError(null);
    try {
      if (!window.editorApi?.chooseLightingBakeEnginePath) throw new Error('当前环境不支持选择 Blender 可执行文件。');
      const selected = await window.editorApi.chooseLightingBakeEnginePath();
      if (mounted.current && selected !== null) changeCandidate(selected);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setAction(null); }
  }
  async function detect() {
    if (busy || !candidate.trim()) return;
    setAction('detecting'); setError(null); setNotice(null); setChecked(null);
    try {
      if (!window.editorApi?.detectLightingBakeEnginePath) throw new Error('当前环境不支持检测指定的 Blender 路径。');
      const value = await window.editorApi.detectLightingBakeEnginePath(candidate.trim());
      if (mounted.current) setChecked(value);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setAction(null); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.stopPropagation();
    if (busy || readonly || !configuration) return;
    setAction('saving'); setError(null); setNotice(null);
    try {
      if (!window.editorApi?.saveLightingBakeEngineConfiguration) throw new Error('当前环境不支持保存本机烘焙引擎配置。');
      // 主进程重新检测所选路径；界面此前的检测结果不能作为写入许可。
      const value = await window.editorApi.saveLightingBakeEngineConfiguration(candidate.trim() || null);
      if (!mounted.current) return;
      setConfiguration(value); onSaved?.(value); onClose();
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setAction(null); }
  }
  const statusTitle = action === 'loading' ? '正在读取本机配置…'
    : action === 'detecting' || action === 'saving' ? '正在检测引擎与设备…'
      : status?.available ? `Blender ${status.version ?? ''} · ${checked ? '路径检测通过' : '已就绪'}`
        : status?.message ?? (draftChanged ? '路径尚未检测' : '未找到可用的 Blender');
  const devices = status?.devices?.map(device => `${device.name} (${device.backend})`).join('；');
  return <dialog ref={dialogRef} className="lighting-manager lighting-engine-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!closingBlocked) onClose(); }}
    onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <form onSubmit={event => void save(event)}>
      <header className="lighting-manager-header"><div><h2 id={titleId}>本机烘焙引擎</h2><p id={descriptionId}>仅当前电脑、当前用户生效，所有工程共用。</p></div>
        <button type="button" className="lighting-manager-close" aria-label="关闭引擎配置" disabled={closingBlocked} onClick={onClose}><LightingManagerIcon name="close" size={23} /></button></header>
      <div className="lighting-engine-body">
        <div className={`lighting-engine-status${status?.available && !busy ? ' is-success' : ''}`} role={checked?.available === false && !busy ? 'alert' : 'status'} aria-live="polite">
          <LightingManagerIcon name={status?.available && !busy ? 'check' : 'warning'} size={21} />
          <div><strong>{statusTitle}</strong><p>{devices && !busy ? `可用设备：${devices}` : draftChanged ? '检测通过后保存，供后续烘焙使用。' : '需要 Blender 4 或更新版本。'}</p></div>
        </div>
        {readonly && <p className="lighting-manager-warning" role="status">烘焙任务正在进行，完成后可修改本机引擎。</p>}
        {configuration?.environmentPath && <p className="lighting-engine-environment" role="status">{configuration.source === 'environment' ? '当前优先使用环境变量 BABYLON_BLENDER_PATH：' : '检测到环境变量 BABYLON_BLENDER_PATH，当前路径不可用：'}<span>{configuration.environmentPath}</span>{configuration.source === 'environment' ? '保存手动路径后，环境变量仍优先生效。' : '当前实际使用的引擎与来源见下方。'}</p>}
        <label className="lighting-engine-path-label" htmlFor={pathId}>Blender 可执行文件</label>
        <div className="lighting-engine-path-row"><input ref={inputRef} id={pathId} type="text" value={candidate} placeholder="选择 blender.exe，或粘贴完整路径"
          autoComplete="off" spellCheck={false} disabled={busy || readonly || !configuration} onChange={event => changeCandidate(event.target.value)} />
          <button type="button" disabled={busy || readonly || !configuration} onClick={() => void choose()}>浏览…</button>
          <button type="button" disabled={busy || !configuration || !candidate.trim()} onClick={() => void detect()}>{action === 'detecting' ? '检测中…' : '检测'}</button></div>
        <div className="lighting-engine-path-help"><p>留空并保存时，自动查找本机已安装的 Blender。</p><button type="button" className="lighting-manager-text-button" disabled={busy || readonly || !configuration}
          onClick={() => { changeCandidate(''); setNotice('保存后移除手动路径，恢复自动查找。'); }}>恢复自动查找</button></div>
        <dl className="lighting-engine-effective"><dt>当前生效引擎</dt><dd>{configuration?.engine.path ?? '尚未找到可用引擎'}</dd>
          <dt>来源</dt><dd>{configuration?.source ? SOURCE_LABELS[configuration.source] : '自动查找'}</dd></dl>
        <details className="lighting-engine-advanced"><summary>高级信息</summary><p>本机配置：<span>{configuration?.configPath ?? '正在读取…'}</span></p></details>
        {notice && <p className="lighting-engine-notice" role="status">{notice}</p>}
        {error && <p className="lighting-engine-error" role="alert">{error}</p>}
      </div>
      <footer className="lighting-manager-footer"><p className="lighting-engine-footer-note">所选路径检测通过后保存，后续烘焙立即使用新配置。</p><div className="lighting-manager-footer-actions">
        <button type="button" disabled={closingBlocked} onClick={onClose}>取消</button><button type="submit" className="lighting-manager-primary" disabled={busy || readonly || !configuration}>{action === 'saving' ? '正在保存…' : '保存并关闭'}</button>
      </div></footer>
    </form>
  </dialog>;
}
