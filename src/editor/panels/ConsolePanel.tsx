import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';

type ConsolePanelProps = {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
};

/** 渲染底部 Console 入口和日志弹窗，日志仍来自编辑器全局 store。 */
export function ConsolePanel(props: ConsolePanelProps) {
  const logs = useEditorStore((state) => state.logs);
  const latestLogMessage = logs[0]?.message ?? '暂无日志';

  useEffect(() => {
    if (!props.isOpen) return;

    /** 弹窗打开时监听 Escape，便于键盘快速收起 Console。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      props.onClose();
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [props.isOpen, props.onClose]);

  return (
    <section aria-label="Console 日志入口" className="console-dock">
      <button
        aria-controls="console-dialog"
        aria-expanded={props.isOpen}
        className="console-dock-button"
        onClick={props.onOpen}
        title="打开 Console 日志"
        type="button"
      >
        <strong>Console</strong>
        <span className="console-dock-count">{logs.length}</span>
        <span className="console-dock-message">{latestLogMessage}</span>
      </button>

      {props.isOpen ? (
        <div className="console-dialog-backdrop" onClick={props.onClose}>
          <section
            aria-label="Console 日志弹窗"
            aria-modal="true"
            className="console-dialog"
            id="console-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="console-dialog-header">
              <h2>Console</h2>
              <button
                aria-label="关闭 Console"
                className="console-dialog-close-button"
                onClick={props.onClose}
                title="关闭 Console"
                type="button"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div className="console-log-list" id="console-log-list">
              {logs.map((log) => (
                <div className="console-log" key={log.id}>{log.message}</div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
