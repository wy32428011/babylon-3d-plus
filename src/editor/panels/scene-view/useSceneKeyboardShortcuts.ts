import { useEffect } from 'react';
import { type AutoPatrolPlaybackController } from '../../../runtime/babylon/AutoPatrolPlaybackController';
import { useEditorStore } from '../../store/editorStore';
import { isScenePreparationActive } from '../../loading/scenePreparationProgress';
import type { RefObject } from 'react';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Options = {
  pauseHistoryReplay: () => void;
  autoPatrolPlaybackRef: RefObject<AutoPatrolPlaybackController | null>;
  requestAutoPatrolCapture: EditorState['requestAutoPatrolCapture'];
  environmentAdjustmentActive: boolean;
  setEnvironmentAdjustmentActive: EditorState['setEnvironmentAdjustmentActive'];
};

/** 保留视口原有执行顺序和依赖，集中管理快捷键。 */
export function useSceneKeyboardShortcuts({
  pauseHistoryReplay, autoPatrolPlaybackRef, requestAutoPatrolCapture, environmentAdjustmentActive, setEnvironmentAdjustmentActive,
}: Options) {
  /** F1 只在非输入态、编辑模式且选中巡检路线时录制或覆盖当前相机视角。 */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isScenePreparationActive()) {
        if (event.target instanceof Element && event.target.closest('[data-scene-loading-action]')) return;
        event.preventDefault();
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest('dialog.manual-roam-avatar-preview[open]')) return;
      const inputFocused = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (inputFocused || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'F1') {
        const state = useEditorStore.getState();
        const entity = state.scene.selectedEntityId ? state.scene.entities[state.scene.selectedEntityId] : null;
        if (state.runtimeMode !== 'edit' || !entity?.components.autoPatrol) return;
        event.preventDefault();
        if (event.repeat) return;
        state.requestAutoPatrolCapture();
        return;
      }

      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC'].includes(event.code)) return;
      const interactiveControlFocused = target instanceof HTMLElement
        && Boolean(target.closest('button, a, [role="button"]'));
      if (interactiveControlFocused) return;
      pauseHistoryReplay();
      autoPatrolPlaybackRef.current?.notifyManualInput();
      autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [pauseHistoryReplay, requestAutoPatrolCapture, autoPatrolPlaybackRef]);

  /** Esc 随时结束环境临时调整，不影响当前普通实体选择。 */
  useEffect(() => {
    if (!environmentAdjustmentActive) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isScenePreparationActive()) return;
      if (event.key !== 'Escape') return;
      setEnvironmentAdjustmentActive(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [environmentAdjustmentActive, setEnvironmentAdjustmentActive]);
}
