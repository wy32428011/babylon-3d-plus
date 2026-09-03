import { useEffect, useState, type DragEvent } from 'react';
import type { ChartMarkerThemeScreen } from '../model/components';
import { DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE, decodeDataPlatformScreenDragPayload } from '../assets/dataPlatformScreenDrag';

type Props = {
  label: string;
  disabled: boolean;
  screen?: ChartMarkerThemeScreen;
  onChange: (screen?: ChartMarkerThemeScreen) => void;
};

export function ChartMarkerThemeScreenSlot({ label, disabled, screen, onChange }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDragOver(false);
    setError('');
  }, [screen, disabled, label]);

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    if (disabled) return;
    const source = decodeDataPlatformScreenDragPayload(event.dataTransfer.getData(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE));
    if (!source?.screenUrl) {
      setError('请拖入图表库中具有有效页面地址的完整大屏。');
      return;
    }
    onChange({
      projectId: source.projectId,
      screenId: source.screenId,
      name: source.name,
      screenUrl: source.screenUrl,
      ...(source.thumbnailUrl ? { thumbnailUrl: source.thumbnailUrl } : {}),
    });
    setError('');
  }

  return (
    <div className="chart-marker-theme-target">
      <span className="chart-marker-theme-label">目标主题</span>
      <div className={'chart-marker-screen-slot chart-marker-theme-slot' + (dragOver ? ' is-drag-over' : '')}
        role="group" aria-label={label + ' 目标主题槽位'} aria-disabled={disabled}
        onDragOver={(event) => {
          // 阻止拖放继续落入立标内容槽或画布，避免误改其他组件。
          event.preventDefault();
          event.stopPropagation();
          const accepted = !disabled && event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE);
          event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
          setDragOver(accepted);
          if (!disabled && !accepted) setError('请拖入图表库中具有有效页面地址的完整大屏。');
        }}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
        }}
        onDrop={handleDrop}
      >
        {screen?.thumbnailUrl ? <img src={screen.thumbnailUrl} alt={screen.name + ' 缩略图'} draggable={false} /> : null}
        <strong>{screen?.name || '将图表库大屏拖到这里'}</strong>
        <span>{screen ? '拖入其他大屏可替换目标主题' : '点击立标时切换数据中台大屏'}</span>
      </div>
      {screen ? <div className="chart-marker-actions">
        <button type="button" disabled={disabled} aria-label={'清空' + label + ' 目标主题'} onClick={() => {
          if (disabled) return;
          onChange();
          setError('');
        }}>清空主题</button>
      </div> : null}
      {error ? <p className="chart-marker-error" role="alert">{error}</p> : null}
      <p className="muted">点击立标后，在数据中台大屏中切换到绑定的大屏；需从数据中台嵌入的数字孪生中触发。未绑定时跳过此动作。</p>
    </div>
  );
}
