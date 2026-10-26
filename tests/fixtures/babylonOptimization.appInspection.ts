import { useEditorStore } from '../../src/editor/store/editorStore';
import type { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';

/** 只读真实编辑器状态；业务操作由 UI/IPC 完成。 */
export function inspectBabylonOptimizationApp() {
  const state = useEditorStore.getState();
  const root = document.getElementById('root');
  const key = Object.keys(root ?? {}).find(name => name.startsWith('__reactContainer$'));
  const first = key ? (root as unknown as Record<string, any>)[key] : null;
  const pending = first ? [first.stateNode?.current ?? first] : [], seen = new Set();
  let runtime: SceneRuntime | undefined;
  while (pending.length && seen.size < 30000) {
    const fiber = pending.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i < 500; i++, hook = hook.next) {
      const value = hook.memoizedState?.current ?? hook.memoizedState;
      if (value?.scene?.meshes && typeof value.getPerformanceMetrics === 'function') runtime = value;
    }
    pending.push(fiber.child, fiber.sibling);
  }
  const assets = (runtime as unknown as { assets?: { models: Map<string, any> } })?.assets;
  return {
    sceneSessionId: state.sceneSessionId, dirty: state.hasUnsavedChanges(),
    selectedEntityId: state.scene.selectedEntityId, resources: state.sceneResourceIssues,
    models: state.scene.entityIds.flatMap(id => {
      const entity = state.scene.entities[id], model = assets?.models.get(id);
      if (!entity?.components.modelAsset) return [];
      const mesh = model?.meshes.find((value: any) => value.getTotalVertices() > 0);
      return [{ id, asset: entity.components.modelAsset, transform: entity.components.transform,
        ready: model?.measurementReady, error: model?.readinessError ?? null,
        verified: model?.assetHandle?.runtimeCapabilities ?? null,
        scriptStarted: model?.contentRoot.metadata?.readonlyFixtureStarted ?? false,
        geometry: mesh?.geometry?.uniqueId, material: mesh?.material?.uniqueId,
        vertices: mesh?.getTotalVertices(), position: model?.root.position.asArray() }];
    }),
    loading: runtime?.getPerformanceMetrics().loading,
    renderer: runtime?.scene.getEngine().getGlInfo().renderer,
    logs: state.logs.slice(0, 6).map(log => log.message),
  };
}
