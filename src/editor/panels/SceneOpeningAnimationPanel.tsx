import { OpeningPackagePanel } from '../opening/OpeningPackagePanel';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';

/** 未导入和应用包时只展示资源入口，不物化任何模板参数。 */
export function SceneOpeningAnimationPanel({ readOnly = false }: { readOnly?: boolean }) {
  const sceneSessionId = useEditorStore(state => state.sceneSessionId);
  const runtimeMode = useEditorStore(state => state.runtimeMode);
  return <CollapsibleFieldset title="开场动画" className="scene-opening-animation-panel">
    <OpeningPackagePanel disabled={readOnly || runtimeMode === 'preview'} sceneSessionId={sceneSessionId} />
  </CollapsibleFieldset>;
}
