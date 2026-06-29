import { useEditorStore } from '../store/editorStore';

export function ConsolePanel() {
  const logs = useEditorStore((state) => state.logs);

  return (
    <section className="panel">
      <h2>Console</h2>
      <div className="console-log-list">
        {logs.map((log) => (
          <div className="console-log" key={log.id}>{log.message}</div>
        ))}
      </div>
    </section>
  );
}
