

import { type DataPlatformImageSyncProgress } from './projectLibrarySyncContracts';

type Props = {
  imageSyncProgress: DataPlatformImageSyncProgress | null;
  imageSyncPhaseLabel: string | null;
  imageSyncCountLabel: string | null;
  imageSyncMessage: string;
  isRetryingImageSync: boolean;
  handleRetryDataPlatformImageSync: () => Promise<void>;
  handleDismissDataPlatformImageSyncFailure: () => void;
};

/** 资源页签只呈现已有同步状态；切换页签不会重建同步订阅或取消事务。 */
export function ImageLibraryTab({ imageSyncProgress, imageSyncPhaseLabel, imageSyncCountLabel, imageSyncMessage, isRetryingImageSync, handleRetryDataPlatformImageSync, handleDismissDataPlatformImageSyncFailure }: Props) {
  return <>
      {imageSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${imageSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{imageSyncPhaseLabel}</strong>
            {imageSyncCountLabel ? <span>{imageSyncCountLabel}</span> : null}
          </div>
          <p>{imageSyncMessage}</p>
          {imageSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button
                disabled={isRetryingImageSync}
                onClick={() => void handleRetryDataPlatformImageSync()}
                type="button"
              >
                {isRetryingImageSync ? '重试中...' : '重试同步'}
              </button>
              <button
                aria-label="关闭同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformImageSyncFailure}
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
