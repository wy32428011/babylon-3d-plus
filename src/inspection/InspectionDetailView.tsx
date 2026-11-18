import type { Ref } from 'react';
import './inspectionDetailView.css';

export type InspectionDetailPart = {
  partKey: string;
  name: string;
  depth?: number;
};

export type InspectionDetailViewProps = {
  canvasRef: Ref<HTMLCanvasElement>;
  deviceName: string;
  assetCode: string;
  modelVersion?: string;
  parts: readonly InspectionDetailPart[];
  selectedPartKey: string | null;
  percent: number;
  isolated: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  onSelectPart: (partKey: string | null) => void;
  onChangePercent: (percent: number) => void;
  onToggleIsolation: () => void;
  onFrameAll: () => void;
  onFocusPart: () => void;
  onReset: () => void;
  onClose: () => void;
};

/** 仅展示当前查看状态；资源、相机和业务筛选由调用方管理。 */
export function InspectionDetailView({
  canvasRef,
  deviceName,
  assetCode,
  modelVersion,
  parts,
  selectedPartKey,
  percent,
  isolated,
  status,
  error,
  onSelectPart,
  onChangePercent,
  onToggleIsolation,
  onFrameAll,
  onFocusPart,
  onReset,
  onClose,
}: InspectionDetailViewProps) {
  const ready = status === 'ready';
  const hasSelection = selectedPartKey !== null;
  const selectedPart = parts.find((part) => part.partKey === selectedPartKey);

  return (
    <section className="inspection-detail" aria-label="设备高精度详情">
      <header className="inspection-detail__header">
        <div className="inspection-detail__identity">
          <span className="inspection-detail__eyebrow">设备详情 / 零件爆炸图</span>
          <h1>{deviceName || '设备详情'}</h1>
          <p>
            <span>资产编号：{assetCode || '—'}</span>
            {modelVersion && <span>模型版本：{modelVersion}</span>}
          </p>
        </div>
        <button type="button" className="inspection-detail__close" onClick={onClose} aria-label="关闭设备详情">
          关闭
        </button>
      </header>

      <div className="inspection-detail__body">
        <aside className="inspection-detail__parts" aria-label="装配零件">
          <div className="inspection-detail__parts-heading">
            <h2>装配零件</h2>
            <span>{parts.length}</span>
          </div>
          {parts.length === 0 ? (
            <p className="inspection-detail__empty">{ready ? '此模型未配置零件。' : '等待模型加载。'}</p>
          ) : (
            <ul className="inspection-detail__part-list">
              {parts.map((part) => (
                <li key={part.partKey}>
                  <button
                    type="button"
                    className="inspection-detail__part"
                    aria-pressed={part.partKey === selectedPartKey}
                    disabled={!ready}
                    onClick={() => onSelectPart(part.partKey)}
                    style={{ paddingInlineStart: `${12 + Math.min(Math.max(part.depth ?? 0, 0), 4) * 12}px` }}
                  >
                    <span>{part.name}</span>
                    <small>{part.partKey}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="inspection-detail__clear"
            disabled={!ready || !hasSelection}
            onClick={() => onSelectPart(null)}
          >
            取消零件选择
          </button>
        </aside>

        <div className="inspection-detail__workspace">
          <div className="inspection-detail__viewport">
            <canvas ref={canvasRef} aria-label="设备高精度三维模型" />
            {(status === 'idle' || status === 'loading') && (
              <div className="inspection-detail__notice" role="status">
                {status === 'idle' ? '等待打开设备详情' : '正在加载高精度模型…'}
              </div>
            )}
            {status === 'error' && (
              <div className="inspection-detail__notice inspection-detail__notice--error" role="alert">
                {error || '高精度模型加载失败。'}
              </div>
            )}
          </div>
          <div className="inspection-detail__selection" aria-live="polite">
            {selectedPart ? `当前零件：${selectedPart.name} · ${selectedPart.partKey}` : '请选择零件查看关联数据'}
          </div>
          <div className="inspection-detail__controls">
            <label className="inspection-detail__progress">
              <span>展开程度</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={percent}
                disabled={!ready}
                onChange={(event) => onChangePercent(Number(event.currentTarget.value))}
              />
              <output>{Math.round(percent)}%</output>
            </label>
            <div className="inspection-detail__actions">
              <button type="button" disabled={!ready} onClick={onFrameAll}>整体取景</button>
              <button type="button" disabled={!ready || !hasSelection} onClick={onFocusPart}>聚焦零件</button>
              <button
                type="button"
                disabled={!ready || !hasSelection}
                aria-pressed={isolated}
                onClick={onToggleIsolation}
              >
                {isolated ? '退出隔离' : '隔离零件'}
              </button>
              <button type="button" disabled={!ready} onClick={onReset}>复原</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
