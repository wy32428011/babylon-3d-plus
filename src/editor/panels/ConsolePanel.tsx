import { useEditorStore } from '../store/editorStore';

type ConsolePanelProps = {
  isMinimized: boolean;
  onToggleMinimized: () => void;
};

/** 渲染编辑器日志面板，并提供局部最小化控制。 */
export function ConsolePanel(props: ConsolePanelProps) {
  const logs = useEditorStore((state) => state.logs);
  const toggleLabel = props.isMinimized ? '恢复 Console' : '最小化 Console';
  const panelClassName = props.isMinimized
    ? 'panel console-panel console-panel-minimized'
    : 'panel console-panel';

  return (
    <section
      aria-label="Console 日志面板"
      className={panelClassName}
    >
      <div className="console-panel-header">
        <h2>Console</h2>
        <button
          aria-controls="console-log-list"
          aria-expanded={!props.isMinimized}
          aria-label={toggleLabel}
          className="console-minimize-button"
          onClick={props.onToggleMinimized}
          title={toggleLabel}
          type="button"
        >
          <span aria-hidden="true">{props.isMinimized ? '+' : '-'}</span>
        </button>
      </div>
      {props.isMinimized ? null : (
        <div className="console-log-list" id="console-log-list">
          {logs.map((log) => (
            <div className="console-log" key={log.id}>{log.message}</div>
          ))}
        </div>
      )}
    </section>
  );
}
