import { useEffect, useState } from 'react';
import { ConsolePanel } from '../panels/ConsolePanel';
import { HierarchyPanel } from '../panels/HierarchyPanel';
import { InspectorPanel } from '../panels/InspectorPanel';
import { ProjectPanel } from '../panels/ProjectPanel';
import { SceneViewPanel } from '../panels/SceneViewPanel';
import { useEditorStore, type TransformTool } from '../store/editorStore';
import { Toolbar } from '../ui/Toolbar';
import styles from './EditorLayout.module.css';

const TOOL_SHORTCUTS: Record<string, TransformTool> = {
  w: 'translate',
  e: 'rotate',
  r: 'scale',
};

/** 判断当前快捷键事件是否来自可输入控件，避免干扰 Inspector 数值编辑。 */
function isKeyboardEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function EditorLayout() {
  const [isConsoleDialogOpen, setConsoleDialogOpen] = useState(false);
  const [isMqttConfigDialogOpen, setMqttConfigDialogOpen] = useState(false);
  const [runtimePreviewError, setRuntimePreviewError] = useState<string | null>(null);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const cadImportProgress = useEditorStore((state) => state.cadImportProgress);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
  const fetchConfig = useEditorStore((state) => state.scene.fetchConfig);
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const setTransformTool = useEditorStore((state) => state.setTransformTool);
  const setTransformSpace = useEditorStore((state) => state.setTransformSpace);
  const setSnapEnabled = useEditorStore((state) => state.setSnapEnabled);
  const updateSnapSetting = useEditorStore((state) => state.updateSnapSetting);
  const setGridVisible = useEditorStore((state) => state.setGridVisible);
  const setGridCellSize = useEditorStore((state) => state.setGridCellSize);
  const deleteSelectedEntity = useEditorStore((state) => state.deleteSelectedEntity);
  const hideSelectedEntities = useEditorStore((state) => state.hideSelectedEntities);
  const lockSelectedEntities = useEditorStore((state) => state.lockSelectedEntities);
  const copySelectedEntities = useEditorStore((state) => state.copySelectedEntities);
  const pasteEntityClipboard = useEditorStore((state) => state.pasteEntityClipboard);
  const groupSelectedEntities = useEditorStore((state) => state.groupSelectedEntities);
  const ungroupSelectedEntities = useEditorStore((state) => state.ungroupSelectedEntities);
  const requestSceneFocusForSelection = useEditorStore((state) => state.requestSceneFocusForSelection);
  const requestCameraTopView = useEditorStore((state) => state.requestCameraTopView);
  const importCadReference = useEditorStore((state) => state.importCadReference);
  const saveScene = useEditorStore((state) => state.saveScene);
  const loadScene = useEditorStore((state) => state.loadScene);
  const updateMqttConfig = useEditorStore((state) => state.updateMqttConfig);
  const updateFetchConfig = useEditorStore((state) => state.updateFetchConfig);
  const startRuntimePreview = useEditorStore((state) => state.startRuntimePreview);
  const stopRuntimePreview = useEditorStore((state) => state.stopRuntimePreview);
  const pushLog = useEditorStore((state) => state.pushLog);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const isRuntimePreview = runtimeMode === 'preview';
  const canDelete = useEditorStore((state) => {
    const selectedEntityId = state.scene.selectedEntityId;
    const selectedEntity = selectedEntityId ? state.scene.entities[selectedEntityId] : null;
    const parentEntity = selectedEntity?.parentId ? state.scene.entities[selectedEntity.parentId] : null;
    const isLocked = selectedEntity?.locked === true || parentEntity?.locked === true;

    return Boolean(selectedEntity && !isLocked);
  });
  const canUndo = useEditorStore((state) => state.history.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.history.redoStack.length > 0);

  useEffect(() => {
    /** 处理编辑器全局快捷键，保持和菜单/Toolbar 共用同一条 store 更新路径。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.altKey || isKeyboardEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      const isCommandKey = event.ctrlKey || event.metaKey;

      if (isRuntimePreview) {
        if (key === 'f') {
          event.preventDefault();
          requestSceneFocusForSelection();
          return;
        }

        if (isCommandKey || event.key === 'Delete' || event.key === 'Backspace' || key === 'h' || TOOL_SHORTCUTS[key] || key === 'g') {
          event.preventDefault();
        }
        return;
      }

      if (isCommandKey) {
        if (key === 'c') {
          event.preventDefault();
          copySelectedEntities();
          return;
        }

        if (key === 'v') {
          event.preventDefault();
          pasteEntityClipboard();
          return;
        }

        if (key === 'k') {
          event.preventDefault();
          lockSelectedEntities();
          return;
        }

        if (key === 'g' && !event.shiftKey) {
          event.preventDefault();
          groupSelectedEntities();
          return;
        }

        return;
      }

      if (event.shiftKey && key === 'g') {
        event.preventDefault();
        ungroupSelectedEntities();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelectedEntity();
        return;
      }

      if (key === 'f') {
        event.preventDefault();
        requestSceneFocusForSelection();
        return;
      }

      if (key === 'h') {
        event.preventDefault();
        hideSelectedEntities();
        return;
      }

      const tool = TOOL_SHORTCUTS[key];
      if (!tool) return;

      event.preventDefault();
      setTransformTool(tool);
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [
    copySelectedEntities,
    deleteSelectedEntity,
    groupSelectedEntities,
    hideSelectedEntities,
    lockSelectedEntities,
    pasteEntityClipboard,
    requestSceneFocusForSelection,
    setTransformTool,
    ungroupSelectedEntities,
    isRuntimePreview,
  ]);

  /** 运行按钮先校验 MQTT/模拟器配置，失败时保持编辑态并打开配置弹窗。 */
  function handleStartRuntimePreview(): void {
    if (cadImportProgress?.active) {
      const message = '请等待 CAD 导入完成。';
      setRuntimePreviewError(message);
      pushLog(`运行预览已阻止：${message}`);
      return;
    }

    const readiness = startRuntimePreview();

    if (!readiness.ok) {
      setRuntimePreviewError(readiness.message);
      if (readiness.code !== 'cad-import-active') setMqttConfigDialogOpen(true);
      return;
    }

    setRuntimePreviewError(null);
    setMqttConfigDialogOpen(false);
  }

  /** 停止按钮可在预览态随时回到编辑态。 */
  function handleStopRuntimePreview(): void {
    stopRuntimePreview();
  }

  /** 关闭 MQTT 弹窗时清除本次运行预检错误。 */
  function handleCloseMqttConfig(): void {
    setRuntimePreviewError(null);
    setMqttConfigDialogOpen(false);
  }

  /** 保存 MQTT 配置后清除旧预检错误，配置本身不会在编辑态建立连接。 */
  function handleSaveMqttConfig(config: typeof mqttConfig): void {
    updateMqttConfig(config);
    setRuntimePreviewError(null);
  }

  function handleSaveFetchConfig(config: typeof fetchConfig): void {
    updateFetchConfig(config);
  }

  return (
    <div className={styles.editorShell}>
      <Toolbar
        transformTool={transformTool}
        transformSpace={transformSpace}
        snapSettings={snapSettings}
        gridSettings={gridSettings}
        onSetTransformTool={setTransformTool}
        onSetTransformSpace={setTransformSpace}
        onSetSnapEnabled={setSnapEnabled}
        onUpdateSnapSetting={updateSnapSetting}
        onSetGridVisible={setGridVisible}
        onSetGridCellSize={setGridCellSize}
        onSetTopView={requestCameraTopView}
        onDeleteSelectedEntity={deleteSelectedEntity}
        onUndo={undo}
        onRedo={redo}
        onSaveScene={() => void saveScene()}
        onLoadScene={() => void loadScene()}
        onImportCadReference={() => void importCadReference()}
        mqttConfig={mqttConfig}
        mqttConfigDialogOpen={isMqttConfigDialogOpen}
        onOpenMqttConfig={() => setMqttConfigDialogOpen(true)}
        onCloseMqttConfig={handleCloseMqttConfig}
        onSaveMqttConfig={handleSaveMqttConfig}
        fetchConfig={fetchConfig}
        onSaveFetchConfig={handleSaveFetchConfig}
        runtimeMode={runtimeMode}
        runtimePreviewError={runtimePreviewError}
        readOnly={isRuntimePreview}
        onStartRuntimePreview={handleStartRuntimePreview}
        onStopRuntimePreview={handleStopRuntimePreview}
        cadImportProgress={cadImportProgress}
        canDelete={!isRuntimePreview && canDelete}
        canUndo={!isRuntimePreview && canUndo}
        canRedo={!isRuntimePreview && canRedo}
      />
      <div className={styles.workspace}>
        <aside className={styles.leftColumn}>
          <HierarchyPanel readOnly={isRuntimePreview} />
        </aside>
        <main className={styles.centerColumn}>
          <SceneViewPanel />
          <div className={styles.bottomWorkspace}>
            <ProjectPanel readOnly={isRuntimePreview} />
            <ConsolePanel
              isOpen={isConsoleDialogOpen}
              onClose={() => setConsoleDialogOpen(false)}
              onOpen={() => setConsoleDialogOpen(true)}
            />
          </div>
        </main>
        <aside className={styles.rightColumn}>
          <InspectorPanel readOnly={isRuntimePreview} />
        </aside>
      </div>
    </div>
  );
}
