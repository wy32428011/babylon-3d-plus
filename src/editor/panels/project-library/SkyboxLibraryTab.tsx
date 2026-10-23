import { type ProjectSkyboxAssetEntry } from '../../assets/AssetDatabase';
import { type ProjectLibraryKey } from '../../assets/projectLibrary';
import { type DataPlatformSkyboxSyncProgress } from './projectLibrarySyncContracts';

type Props = {
  activeLibraryKey: ProjectLibraryKey;
  orphanedCurrentSkybox: ProjectSkyboxAssetEntry | null;
  skyboxSyncProgress: DataPlatformSkyboxSyncProgress | null;
  skyboxSyncPhaseLabel: string | null;
  skyboxSyncCountLabel: string | null;
  skyboxSyncMessage: string;
  skyboxSyncReloadError: string | null;
  isReloadingSkyboxAssets: boolean;
  handleReloadSkyboxAssets: () => Promise<void>;
  readOnly: boolean | undefined;
  isRetryingSkyboxSync: boolean;
  handleRetryDataPlatformSkyboxSync: () => Promise<void>;
  handleDismissDataPlatformSkyboxSyncFailure: () => void;
};

/** 资源页签只呈现已有同步状态；切换页签不会重建同步订阅或取消事务。 */
export function SkyboxLibraryTab({ activeLibraryKey, orphanedCurrentSkybox, skyboxSyncProgress, skyboxSyncPhaseLabel, skyboxSyncCountLabel, skyboxSyncMessage, skyboxSyncReloadError, isReloadingSkyboxAssets, handleReloadSkyboxAssets, readOnly, isRetryingSkyboxSync, handleRetryDataPlatformSkyboxSync, handleDismissDataPlatformSkyboxSyncFailure }: Props) {
  return <>
      {activeLibraryKey === 'skybox' && orphanedCurrentSkybox ? (
        <div className="library-sync-status library-sync-status-warning" role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>资源已从数据中台删除</strong>
          </div>
          <p title={`天空盒“${orphanedCurrentSkybox.displayName}”（数据中台资源 ID：${orphanedCurrentSkybox.dataPlatformResourceId}）已从数据中台删除。当前场景继续使用本地兼容缓存，但不能用于新场景；现有场景显示不受影响，重新选择天空盒时需使用仍在资源库中的资源。`}>
            天空盒“{orphanedCurrentSkybox.displayName}”（数据中台资源 ID：{orphanedCurrentSkybox.dataPlatformResourceId}）已从数据中台删除。
            当前场景继续使用本地兼容缓存，但不能用于新场景；现有场景显示不受影响，重新选择天空盒时需使用仍在资源库中的资源。
          </p>
        </div>
      ) : null}

      {activeLibraryKey === 'skybox' && skyboxSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${skyboxSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{skyboxSyncPhaseLabel}</strong>
            {skyboxSyncCountLabel ? <span>{skyboxSyncCountLabel}</span> : null}
          </div>
          <p>{skyboxSyncMessage}</p>
          {skyboxSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              {skyboxSyncReloadError ? (
                <button
                  disabled={isReloadingSkyboxAssets}
                  onClick={() => void handleReloadSkyboxAssets()}
                  type="button"
                >
                  {isReloadingSkyboxAssets ? '重新加载中...' : '重新加载资源库'}
                </button>
              ) : null}
              <button
                disabled={readOnly || isRetryingSkyboxSync || isReloadingSkyboxAssets}
                onClick={() => void handleRetryDataPlatformSkyboxSync()}
                type="button"
              >
                {isRetryingSkyboxSync ? '重试中...' : '重试同步'}
              </button>
              <button
                aria-label="关闭天空盒同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformSkyboxSyncFailure}
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
