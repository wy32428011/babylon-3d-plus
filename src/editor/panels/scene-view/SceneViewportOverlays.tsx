import { RuntimeFollowControls } from '../../../shared/ui/RuntimeFollowControls';
import { OpeningAnimationOverlay } from '../../../shared/ui/OpeningAnimationOverlay';
import { type useEditorOpeningAnimation } from '../../opening/useEditorOpeningAnimation';
import { SceneLoadingMask } from '../../../shared/ui/SceneLoadingMask';
import { type BabylonViewport } from '../../../runtime/babylon/createEngine';
import { type SceneRuntime } from '../../../runtime/babylon/SceneRuntime';
import { type AutoPatrolPlaybackController, type AutoPatrolPlaybackRoute } from '../../../runtime/babylon/AutoPatrolPlaybackController';
import { type SceneDocument } from '../../model/SceneDocument';
import { ViewportOrientationCompass } from '../../ui/ViewportOrientationCompass';
import { AutoPatrolControls } from '../../../shared/ui/AutoPatrolControls';
import { DataPlatformScreenOverlay } from '../../../runtime/babylon/DataPlatformScreenOverlay';
import { DataPlatformViewportScreenOverlay } from '../../../runtime/babylon/DataPlatformViewportScreenOverlay';
import { ManualRoamControls } from '../../../shared/ui/ManualRoamControls';
import { type ManualRoamRuntime, type ManualRoamSnapshot } from '../../../runtime/roam/ManualRoamRuntime';
import type { ComponentProps, RefObject } from 'react';
import { type useEditorStore } from '../../store/editorStore';
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Props = {
  performanceHud: import('react').ReactNode;
  isPerformanceRun: boolean;
  sceneResourcesReady: boolean;
  entranceRequired: boolean;
  entranceReadySession: string | null;
  sceneSessionId: string;
  entrancePreparationError: string | null;
  entrancePreparation: ReturnType<SceneRuntime['getModelEntranceSnapshot']> | null;
  opening: ReturnType<typeof useEditorOpeningAnimation>;
  isRuntimePreview: boolean;
  overlayViewport: BabylonViewport | null;
  overlayRuntime: SceneRuntime | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  handleDataPlatformScreenCommand: ComponentProps<typeof DataPlatformScreenOverlay>['onCommand'];
  hierarchySelectionIds: string[];
  selectedEntityId: string | null;
  handleViewportDataPlatformScreenCommand: ComponentProps<typeof DataPlatformViewportScreenOverlay>['onCommand'];
  sceneDocument: SceneDocument;
  viewportCamera: BabylonViewport['camera'] | null;
  viewportError: string | null;
  manualRoamSnapshot: ManualRoamSnapshot;
  pauseHistoryReplay: () => void;
  autoPatrolPlaybackRef: RefObject<AutoPatrolPlaybackController | null>;
  requestCameraReset: EditorState['requestCameraReset'];
  toggleCameraStandardView: EditorState['toggleCameraStandardView'];
  cameraOrientation: EditorState['cameraOrientation'];
  hasManualRoamSpawn: boolean;
  handleManualRoamConfig: ComponentProps<typeof ManualRoamControls>['onConfigChange'];
  manualRoamRef: RefObject<ManualRoamRuntime | null>;
  handleManualRoamEnabled: ComponentProps<typeof ManualRoamControls>['onEnabledChange'];
  handleManualRoamLocomotionMode: ComponentProps<typeof ManualRoamControls>['onLocomotionModeChange'];
  handleManualRoamTouchAction: ComponentProps<typeof ManualRoamControls>['onTouchAction'];
  handleManualRoamViewMode: ComponentProps<typeof ManualRoamControls>['onViewModeChange'];
  autoPatrolRoutes: AutoPatrolPlaybackRoute[];
  autoPatrolHistory: ComponentProps<typeof AutoPatrolControls>['history'];
  autoPatrolPlaybackSnapshot: EditorState['autoPatrolPlaybackSnapshot'];
  requestAutoPatrolPlayback: EditorState['requestAutoPatrolPlayback'];
  handleHistoryAction: ComponentProps<typeof AutoPatrolControls>['onHistoryAction'];
  environmentAdjustmentActive: boolean;
};

/** 叠加层使用原画布、运行时和事件处理器，保持各控件的挂载顺序。 */
export function SceneViewportOverlays({
  performanceHud, isPerformanceRun, sceneResourcesReady, entranceRequired, entranceReadySession, sceneSessionId, entrancePreparationError, entrancePreparation, opening, isRuntimePreview, overlayViewport, overlayRuntime, canvasRef, handleDataPlatformScreenCommand, hierarchySelectionIds, selectedEntityId, handleViewportDataPlatformScreenCommand, sceneDocument, viewportCamera, viewportError, manualRoamSnapshot, pauseHistoryReplay, autoPatrolPlaybackRef, requestCameraReset, toggleCameraStandardView, cameraOrientation, hasManualRoamSpawn, handleManualRoamConfig, manualRoamRef, handleManualRoamEnabled, handleManualRoamLocomotionMode, handleManualRoamTouchAction, handleManualRoamViewMode, autoPatrolRoutes, autoPatrolHistory, autoPatrolPlaybackSnapshot, requestAutoPatrolPlayback, handleHistoryAction, environmentAdjustmentActive,
}: Props) {
  return <>
        {sceneResourcesReady && entranceRequired && entranceReadySession !== sceneSessionId ? <SceneLoadingMask
          label={entrancePreparationError ? '场景首帧验证失败' : entrancePreparation?.status === 'preparing' ? '正在准备入场材质' : '正在验证场景首帧'}
          detail={entrancePreparationError ?? (entrancePreparation?.status === 'preparing'
            ? `入场网格 ${entrancePreparation.preparedBindingCount}/${entrancePreparation.totalBindingCount}`
            : '等待入场材质与实际渲染完成…')}
          percent={99}
        /> : null}
        {opening.active && isRuntimePreview ? <OpeningAnimationOverlay settings={opening.settings} snapshot={opening.snapshot} preview={!isRuntimePreview} onSkip={isRuntimePreview ? opening.skip : opening.stop} /> : null}
        {overlayViewport && overlayRuntime ? (
          <DataPlatformScreenOverlay
            playbackActive={isRuntimePreview}
            canvas={canvasRef.current}
            interactive={isRuntimePreview}
            onCommand={handleDataPlatformScreenCommand}
            runtime={overlayRuntime}
            selectedEntityIds={hierarchySelectionIds.length > 0
              ? hierarchySelectionIds
              : selectedEntityId
                ? [selectedEntityId]
                : []}
            scene={overlayViewport.scene}
          />
        ) : null}
        <DataPlatformViewportScreenOverlay
          interactive={isRuntimePreview}
          onCommand={handleViewportDataPlatformScreenCommand}
          screen={sceneDocument.sceneSettings.viewportScreen}
          selectedEntityIds={hierarchySelectionIds.length > 0
            ? hierarchySelectionIds
            : selectedEntityId
              ? [selectedEntityId]
              : []}
        />
        <ViewportOrientationCompass
          camera={viewportCamera}
          disabled={Boolean(viewportError) || (isRuntimePreview && manualRoamSnapshot.enabled)}
          onReset={() => {
            pauseHistoryReplay();
            autoPatrolPlaybackRef.current?.notifyManualInput();
            autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
            requestCameraReset();
          }}
          onToggleStandardView={(orientation) => {
            pauseHistoryReplay();
            autoPatrolPlaybackRef.current?.notifyManualInput();
            autoPatrolPlaybackRef.current?.notifyCameraChangedWhilePaused();
            toggleCameraStandardView(orientation);
          }}
          orientation={cameraOrientation}
        />
        {isRuntimePreview && !opening.active ? <RuntimeFollowControls /> : null}
        {isRuntimePreview && hasManualRoamSpawn ? (
          <ManualRoamControls
            snapshot={manualRoamSnapshot}
            onConfigChange={handleManualRoamConfig}
            onDebugCollidersChange={(visible) => manualRoamRef.current?.setDebugColliders(visible)}
            onEnabledChange={handleManualRoamEnabled}
            onLocomotionModeChange={handleManualRoamLocomotionMode}
            onPointerLock={() => manualRoamRef.current?.requestPointerLock()}
            onReset={() => manualRoamRef.current?.reset()}
            onTouchAction={handleManualRoamTouchAction}
            onViewModeChange={handleManualRoamViewMode}
            onVirtualMove={(right, forward) => manualRoamRef.current?.setVirtualMovement(right, forward)}
          />
        ) : null}
        {isRuntimePreview
          && (autoPatrolRoutes.length > 0 || Boolean(autoPatrolHistory?.records.length))
          && !manualRoamSnapshot.enabled ? (
          <AutoPatrolControls
            routes={autoPatrolRoutes}
            snapshot={autoPatrolPlaybackSnapshot}
            onAction={(action, routeId, payload) => requestAutoPatrolPlayback(action, routeId, payload)}
            history={autoPatrolHistory}
            onHistoryAction={handleHistoryAction}
          />
        ) : null}
        {performanceHud}
        {isRuntimePreview ? (
          <span aria-live="polite" className="scene-preview-badge" role="status">{isPerformanceRun ? '性能运行' : '运行预览'}</span>
        ) : null}
        {!isRuntimePreview && environmentAdjustmentActive ? (
          <span aria-live="polite" className="scene-environment-adjustment-badge" role="status">
            正在调整环境（Esc 结束）
          </span>
        ) : null}
        {viewportError ? (
          <div className="scene-error" role="alert">
            <strong>Scene View 暂时不可用</strong>
            <p>{viewportError}</p>
          </div>
        ) : null}
  </>;
}
