import { LibrarySyncNotice } from '../../loading/LibrarySyncNotice';
import { RemoteDownloadDetail } from '../../loading/RemoteDownloadDetail';
import { isRemoteDownloadVisible } from '../../loading/sceneRemoteDownloadProgress';

import { type DataPlatformEnvironmentSyncProgress } from './projectLibrarySyncContracts';

type Props = {
  environmentSyncProgress: DataPlatformEnvironmentSyncProgress | null;
  sceneSessionId: string;
  environmentSyncPhaseLabel: string | null;
  environmentSyncCountLabel: string | null;
  environmentSyncMessage: string;
  isRetryingEnvironmentSync: boolean;
  handleRetryDataPlatformEnvironmentSync: () => Promise<void>;
};

/** 资源页签只呈现已有同步状态；切换页签不会重建同步订阅或取消事务。 */
export function EnvironmentLibraryTab({ environmentSyncProgress, sceneSessionId, environmentSyncPhaseLabel, environmentSyncCountLabel, environmentSyncMessage, isRetryingEnvironmentSync, handleRetryDataPlatformEnvironmentSync }: Props) {
  return <>
      {environmentSyncProgress ? (
        <LibrarySyncNotice runId={`${sceneSessionId}:${environmentSyncProgress.runId}`}
          phase={environmentSyncProgress.phase} label="环境模型同步">
          <div className="library-sync-status-heading">
            <strong>{environmentSyncPhaseLabel}</strong>
            {environmentSyncCountLabel ? <span>{environmentSyncCountLabel}</span> : null}
          </div>
          <p>{environmentSyncMessage}</p>
          {isRemoteDownloadVisible(environmentSyncProgress) && environmentSyncProgress.download
            ? <RemoteDownloadDetail label="环境模型远程下载" download={environmentSyncProgress.download} /> : null}
          {environmentSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button disabled={isRetryingEnvironmentSync} onClick={() => void handleRetryDataPlatformEnvironmentSync()} type="button">
                {isRetryingEnvironmentSync ? '重试中...' : '重试环境同步'}
              </button>
            </div>
          ) : null}
        </LibrarySyncNotice>
      ) : null}
  </>;
}
