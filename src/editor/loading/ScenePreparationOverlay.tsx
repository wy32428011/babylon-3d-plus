import { useEffect, useRef, useSyncExternalStore } from 'react';
import { SceneLoadingMask } from '../../shared/ui/SceneLoadingMask';
import { RemoteDownloadDetail } from './RemoteDownloadDetail';
import { sceneRemoteDownloadStore } from './sceneRemoteDownloadProgress';
import { environmentPreparationStore } from './environmentPreparationProgress';
import {
  getScenePreparationSnapshot,
  subscribeScenePreparation,
} from './scenePreparationProgress';

/** 覆盖整个编辑器的场景准备蒙版，直到同步、刷新、加载和合批全部落定。 */
export function ScenePreparationOverlay({ onCancel, cancelling = false }: { onCancel: () => void; cancelling?: boolean }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const environment = useSyncExternalStore(
    environmentPreparationStore.subscribe,
    environmentPreparationStore.getSnapshot,
    environmentPreparationStore.getSnapshot,
  );
  const downloads = useSyncExternalStore(
    sceneRemoteDownloadStore.subscribe,
    sceneRemoteDownloadStore.getSnapshot,
    sceneRemoteDownloadStore.getSnapshot,
  );
  const state = useSyncExternalStore(
    subscribeScenePreparation,
    getScenePreparationSnapshot,
    getScenePreparationSnapshot,
  );

  useEffect(() => {
    if (state.completed) return undefined;
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const cancelButton = overlayRef.current?.querySelector('button');
    if (cancelButton) cancelButton.focus();
    else overlayRef.current?.focus();
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus();
    };
  }, [state.completed, state.sceneSessionId, state.assetRefreshStatus]);

  if (state.completed) return null;
  const environmentError = environment.sceneSessionId === state.sceneSessionId ? environment.error : null;

  return (
    <SceneLoadingMask
      detail={environmentError ?? state.detail}
      label={environmentError ? '环境模型加载失败' : state.label}
      percent={state.percent}
      phase={state.phase}
      downloadDetail={downloads.sceneSessionId === state.sceneSessionId ? <>
        {downloads.model ? <RemoteDownloadDetail label="模型远程下载" download={downloads.model.download} /> : null}
        {downloads.environment ? <RemoteDownloadDetail label="环境模型远程下载" download={downloads.environment.download} /> : null}
      </> : undefined}
      ref={overlayRef}
      tabIndex={-1}
      action={<>
          {environmentError ? <button disabled={environment.retrying} onClick={() => void environmentPreparationStore.retry()} type="button">重试环境模型同步</button> : null}
          <button disabled={cancelling} onClick={onCancel} type="button">{cancelling ? '正在请求取消…' : '取消加载并返回首页'}</button>
        </>}
    />
  );
}
