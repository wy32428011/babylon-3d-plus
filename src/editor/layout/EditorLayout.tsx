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
  const [isConsoleMinimized, setConsoleMinimized] = useState(false);
  const [isMqttConfigDialogOpen, setMqttConfigDialogOpen] = useState(false);
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const cadImportProgress = useEditorStore((state) => state.cadImportProgress);
  const mqttConfig = useEditorStore((state) => state.scene.mqttConfig);
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
  const importCadReference = useEditorStore((state) => state.importCadReference);
  const saveScene = useEditorStore((state) => state.saveScene);
  const loadScene = useEditorStore((state) => state.loadScene);
  const updateMqttConfig = useEditorStore((state) => state.updateMqttConfig);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
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
  ]);

  /** 仅在当前编辑会话内切换 Console 折叠状态，避免写入场景文件或全局 store。 */
  function toggleConsoleMinimized(): void {
    setConsoleMinimized((value) => !value);
  }

  const centerColumnClassName = isConsoleMinimized
    ? `${styles.centerColumn} ${styles.centerColumnConsoleMinimized}`
    : styles.centerColumn;

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
        onDeleteSelectedEntity={deleteSelectedEntity}
        onUndo={undo}
        onRedo={redo}
        onSaveScene={() => void saveScene()}
        onLoadScene={() => void loadScene()}
        onImportCadReference={() => void importCadReference()}
        mqttConfig={mqttConfig}
        mqttConfigDialogOpen={isMqttConfigDialogOpen}
        onOpenMqttConfig={() => setMqttConfigDialogOpen(true)}
        onCloseMqttConfig={() => setMqttConfigDialogOpen(false)}
        onSaveMqttConfig={updateMqttConfig}
        cadImportProgress={cadImportProgress}
        canDelete={canDelete}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <div className={styles.workspace}>
        <aside className={styles.leftColumn}>
          <HierarchyPanel />
        </aside>
        <main className={centerColumnClassName}>
          <SceneViewPanel />
          <ConsolePanel isMinimized={isConsoleMinimized} onToggleMinimized={toggleConsoleMinimized} />
        </main>
        <aside className={styles.rightColumn}>
          <InspectorPanel />
        </aside>
      </div>
      <div className={styles.bottomBar}>
        <ProjectPanel />
      </div>
    </div>
  );
}
