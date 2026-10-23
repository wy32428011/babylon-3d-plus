import { type ProjectLibraryKey } from '../../assets/projectLibrary';
import { type DataPlatformChartSyncProgress } from './projectLibrarySyncContracts';

type Props = {
  activeLibraryKey: ProjectLibraryKey;
  chartSyncProgress: DataPlatformChartSyncProgress | null;
  chartSyncPhaseLabel: string | null;
  chartSyncCountLabel: string | null;
  chartSyncMessage: string;
  readOnly: boolean | undefined;
  chartSyncContextKey: string | null;
  isRetryingChartSync: boolean;
  handleRetryDataPlatformChartSync: () => Promise<void>;
  handleDismissDataPlatformChartSyncFailure: () => void;
};

/** 资源页签只呈现已有同步状态；切换页签不会重建同步订阅或取消事务。 */
export function ChartLibraryTab({ activeLibraryKey, chartSyncProgress, chartSyncPhaseLabel, chartSyncCountLabel, chartSyncMessage, readOnly, chartSyncContextKey, isRetryingChartSync, handleRetryDataPlatformChartSync, handleDismissDataPlatformChartSyncFailure }: Props) {
  return <>
      {activeLibraryKey === 'chart' && chartSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${chartSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{chartSyncPhaseLabel}</strong>
            {chartSyncCountLabel ? <span>{chartSyncCountLabel}</span> : null}
          </div>
          <p>{chartSyncMessage}</p>
          {chartSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button
                disabled={readOnly || !chartSyncContextKey || isRetryingChartSync}
                onClick={() => void handleRetryDataPlatformChartSync()}
                type="button"
              >
                {isRetryingChartSync ? '重试中...' : '重试大屏同步'}
              </button>
              <button
                aria-label="关闭大屏同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformChartSyncFailure}
                type="button"
              >
                关闭
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
  </>;
}
