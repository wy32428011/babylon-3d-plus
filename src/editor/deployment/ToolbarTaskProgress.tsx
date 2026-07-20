export type ToolbarTaskProgressTone = 'active' | 'success' | 'error' | 'canceled';

export type ToolbarTaskProgressProps = {
  label: string;
  percent: number;
  detail: string;
  tone?: ToolbarTaskProgressTone;
};

/** 在 Toolbar 中显示可访问的紧凑任务进度，供 CAD 导入和部署导出共同使用。 */
export function ToolbarTaskProgress(props: ToolbarTaskProgressProps) {
  const percent = Math.min(100, Math.max(0, Math.round(props.percent)));
  const tone = props.tone ?? 'active';

  return (
    <div
      aria-label={`${props.label}，${percent}%`}
      aria-live="polite"
      className={`toolbar-task-progress toolbar-task-progress-${tone}`}
      role="status"
    >
      <div className="toolbar-task-progress-header">
        <strong title={props.label}>{props.label}</strong>
        <span>{percent}%</span>
      </div>
      <div
        aria-label={`${props.label}进度`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="toolbar-task-progress-track"
        role="progressbar"
      >
        <div className="toolbar-task-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p title={props.detail}>{props.detail}</p>
    </div>
  );
}
