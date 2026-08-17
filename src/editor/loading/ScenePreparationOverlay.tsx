import { useEffect, useRef, useSyncExternalStore } from 'react';
import { SceneLoadingMask } from '../../shared/ui/SceneLoadingMask';
import {
  getScenePreparationSnapshot,
  subscribeScenePreparation,
} from './scenePreparationProgress';

/** 覆盖整个编辑器的场景准备蒙版，直到同步、刷新、加载和合批全部落定。 */
export function ScenePreparationOverlay() {
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
    overlayRef.current?.focus();
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus();
    };
  }, [state.completed, state.sceneSessionId]);

  if (state.completed) return null;

  return (
    <SceneLoadingMask
      detail={state.detail}
      label={state.label}
      percent={state.percent}
      phase={state.phase}
      ref={overlayRef}
      tabIndex={-1}
    />
  );
}
