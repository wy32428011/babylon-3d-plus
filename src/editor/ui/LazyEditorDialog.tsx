import { Component, lazy, Suspense, useEffect, useId, useRef, type ComponentType, type LazyExoticComponent } from 'react';

type LazyEditorDialogProps<Props extends object> = {
  load: () => Promise<{ default: ComponentType<Props> }>;
  dialogProps: Props;
  open: boolean;
  title: string;
  onClose: () => void;
  keepMounted?: boolean;
};

type LazyEditorDialogState<Props extends object> = {
  activated: boolean;
  Dialog: LazyExoticComponent<ComponentType<Props>>;
  error: Error | null;
};

/** 首次打开才请求弹窗代码；后续默认保留宿主，使既有关闭副作用和后台控制器不变。 */
export class LazyEditorDialog<Props extends object> extends Component<LazyEditorDialogProps<Props>, LazyEditorDialogState<Props>> {
  override state: LazyEditorDialogState<Props> = {
    activated: this.props.open,
    Dialog: lazy(this.props.load),
    error: null,
  };

  static getDerivedStateFromProps(props: { open: boolean }, state: { activated: boolean }) {
    return props.open && !state.activated ? { activated: true } : null;
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  private retry = () => {
    // React.lazy 会缓存被拒绝的 Promise，重试必须创建新的 lazy 类型。
    this.setState({ Dialog: lazy(this.props.load), error: null });
  };

  override render() {
    const { dialogProps, open, title, onClose, keepMounted = true } = this.props;
    if (!open && (!this.state.activated || !keepMounted)) return null;
    if (this.state.error) return open
      ? <LazyDialogFeedback title={title} onClose={onClose} error={this.state.error} onRetry={this.retry} />
      : null;
    const Dialog = this.state.Dialog;
    return <Suspense fallback={open ? <LazyDialogFeedback title={title} onClose={onClose} /> : null}>
      <Dialog {...dialogProps} />
    </Suspense>;
  }
}

/** 加载与失败也占用模态层，避免底层快捷键穿透，并允许随时关闭或重试。 */
function LazyDialogFeedback(props: { title: string; onClose: () => void; error?: Error; onRetry?: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialogRef} className="deployment-export-dialog" data-editor-lazy-dialog
    role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ maxWidth: 'min(90vw, 520px)' }}
    onCancel={event => { event.preventDefault(); props.onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="deployment-export-dialog-header">
      <h2 id={titleId}>{props.title}</h2>
      <button type="button" className="deployment-export-dialog-close" aria-label={`关闭${props.title}`} onClick={props.onClose}>×</button>
    </div>
    <section className="deployment-export-dialog-section">
      {props.error ? <p role="alert">暂时无法打开：{props.error.message || String(props.error)}</p>
        : <p role="status">正在打开{props.title}…</p>}
    </section>
    <div className="deployment-export-dialog-actions">
      <button type="button" onClick={props.onClose}>关闭</button>
      {props.onRetry && <button type="button" className="deployment-export-primary-button" onClick={props.onRetry}>重新加载</button>}
    </div>
  </dialog>;
}
