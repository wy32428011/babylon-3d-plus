import { useEffect, useRef, useSyncExternalStore } from 'react';
import { SceneLoadingMask } from '../../shared/ui/SceneLoadingMask';
import {
  getScenePreparationSnapshot,
  subscribeScenePreparation,
} from './scenePreparationProgress';

/** 覆盖整个编辑器的场景准备蒙版，直到同步、刷新、加载和合批全部落定。 */
export function ScenePreparationOverlay({ onCancel }: { onCancel: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
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

  return (
    <SceneLoadingMask
      detail={state.detail}
      label={state.label}
      percent={state.percent}
      phase={state.phase}
      ref={overlayRef}
      tabIndex={-1}
      action={state.assetRefreshStatus === 'settled'
        ? <button onClick={onCancel} type="button">取消加载并返回首页</button> : undefined}
    />
  );
}
