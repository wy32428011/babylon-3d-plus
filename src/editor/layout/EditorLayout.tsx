import { useEffect } from 'react';
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
  const transformTool = useEditorStore((state) => state.transformTool);
  const transformSpace = useEditorStore((state) => state.transformSpace);
  const snapSettings = useEditorStore((state) => state.snapSettings);
  const gridSettings = useEditorStore((state) => state.gridSettings);
  const cameraSettings = useEditorStore((state) => state.cameraSettings);
  const setTransformTool = useEditorStore((state) => state.setTransformTool);
  const setTransformSpace = useEditorStore((state) => state.setTransformSpace);
  const setSnapEnabled = useEditorStore((state) => state.setSnapEnabled);
  const updateSnapSetting = useEditorStore((state) => state.updateSnapSetting);
  const setGridVisible = useEditorStore((state) => state.setGridVisible);
  const setGridCellSize = useEditorStore((state) => state.setGridCellSize);
  const setCameraViewRange = useEditorStore((state) => state.setCameraViewRange);
  const deleteSelectedEntity = useEditorStore((state) => state.deleteSelectedEntity);
  const saveScene = useEditorStore((state) => state.saveScene);
  const loadScene = useEditorStore((state) => state.loadScene);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canDelete = useEditorStore((state) => state.scene.selectedEntityId !== null);
  const canUndo = useEditorStore((state) => state.history.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.history.redoStack.length > 0);

  useEffect(() => {
    /** 处理 W/E/R 工具快捷键与 Delete 删除快捷键，保持和 Toolbar 按钮共用同一条 store 更新路径。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.altKey || isKeyboardEditableTarget(event.target)) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelectedEntity();
        return;
      }

      const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (!tool) return;

      event.preventDefault();
      setTransformTool(tool);
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [deleteSelectedEntity, setTransformTool]);

  return (
    <div className={styles.editorShell}>
      <Toolbar
        transformTool={transformTool}
        transformSpace={transformSpace}
        snapSettings={snapSettings}
        gridSettings={gridSettings}
        cameraSettings={cameraSettings}
        onSetTransformTool={setTransformTool}
        onSetTransformSpace={setTransformSpace}
        onSetSnapEnabled={setSnapEnabled}
        onUpdateSnapSetting={updateSnapSetting}
        onSetGridVisible={setGridVisible}
        onSetGridCellSize={setGridCellSize}
        onSetCameraViewRange={setCameraViewRange}
        onDeleteSelectedEntity={deleteSelectedEntity}
        onUndo={undo}
        onRedo={redo}
        onSaveScene={() => void saveScene()}
        onLoadScene={() => void loadScene()}
        canDelete={canDelete}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <div className={styles.workspace}>
        <aside className={styles.leftColumn}>
          <HierarchyPanel />
        </aside>
        <main className={styles.centerColumn}>
          <SceneViewPanel />
          <ConsolePanel />
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
