import { LibrarySyncNotice } from '../../loading/LibrarySyncNotice';
import { RemoteDownloadDetail } from '../../loading/RemoteDownloadDetail';
import { isRemoteDownloadVisible } from '../../loading/sceneRemoteDownloadProgress';
import { type ProjectLibraryKey } from '../../assets/projectLibrary';
import { type DataPlatformModelSyncProgress } from './projectLibrarySyncContracts';

type Props = {
  modelSyncProgress: DataPlatformModelSyncProgress | null;
  sceneSessionId: string;
  modelSyncPhaseLabel: string | null;
  modelSyncCountLabel: string | null;
  modelSyncMessage: string;
  isRetryingModelSync: boolean;
  handleRetryDataPlatformModelSync: () => Promise<void>;
};

/** 资源页签只呈现已有同步状态；切换页签不会重建同步订阅或取消事务。 */
export function ModelLibraryTab({ modelSyncProgress, sceneSessionId, modelSyncPhaseLabel, modelSyncCountLabel, modelSyncMessage, isRetryingModelSync, handleRetryDataPlatformModelSync }: Props) {
  return <>
      {modelSyncProgress ? (
        <LibrarySyncNotice runId={`${sceneSessionId}:${modelSyncProgress.runId}`}
          phase={modelSyncProgress.phase} label="模型同步">
          <div className="library-sync-status-heading">
            <strong>{modelSyncPhaseLabel}</strong>
            {modelSyncCountLabel ? <span>{modelSyncCountLabel}</span> : null}
          </div>
          <p>{modelSyncMessage}</p>
          {isRemoteDownloadVisible(modelSyncProgress) && modelSyncProgress.download
            ? <RemoteDownloadDetail label="模型远程下载" download={modelSyncProgress.download} /> : null}
          {modelSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button
                disabled={isRetryingModelSync}
                onClick={() => void handleRetryDataPlatformModelSync()}
                type="button"
              >
                {isRetryingModelSync ? '重试中...' : '重试同步'}
              </button>
            </div>
          ) : null}
        </LibrarySyncNotice>
      ) : null}
  </>;
}

/** 模型专属类型筛选保留原有标签、值与更新动作。 */
export function ModelLibraryTypeFilter({ activeLibraryKey, setModelDeviceTypeFilter, modelDeviceTypeFilter, modelDeviceTypes }: {
  activeLibraryKey: ProjectLibraryKey;
  setModelDeviceTypeFilter: (value: string) => void;
  modelDeviceTypeFilter: string;
  modelDeviceTypes: string[];
}) {
  return <>
        {activeLibraryKey === 'model' ? (
          <>
            <label className="library-filter-label" htmlFor="project-library-model-type">
              模型类型
            </label>
            <select
              className="library-filter-select"
              id="project-library-model-type"
              onChange={(event) => setModelDeviceTypeFilter(event.target.value)}
              value={modelDeviceTypeFilter}
            >
              <option value="">全部类型</option>
              {modelDeviceTypes.map((deviceType) => (
                <option key={deviceType} value={deviceType}>{deviceType}</option>
              ))}
            </select>
          </>
        ) : null}
  </>;
}
