export type PlayerGlobalOverviewActions = {
  cancelPendingAutoPatrol: () => void;
  stopHistoryReplay: () => void;
  stopAutoPatrol: () => void;
  disableManualRoam: () => void;
  closeFloatingControls: () => void;
  cancelCameraTransition: () => void;
  clearSelection: () => void;
  resetStatusOverlay: () => void;
  restoreInitialCamera: () => void;
};

/** 关闭所有临时交互状态，最后恢复发布场景保存的初始相机。 */
export function restorePlayerGlobalOverview(actions: PlayerGlobalOverviewActions): void {
  actions.cancelPendingAutoPatrol();
  actions.stopHistoryReplay();
  actions.stopAutoPatrol();
  actions.disableManualRoam();
  actions.closeFloatingControls();
  actions.cancelCameraTransition();
  actions.clearSelection();
  actions.resetStatusOverlay();
  actions.restoreInitialCamera();
}
