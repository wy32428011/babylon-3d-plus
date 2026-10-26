import { EngineStore } from '@babylonjs/core/Engines/engineStore.js';
import { useEditorStore } from '../../src/editor/store/editorStore.ts';
import { getScenePreparationSnapshot } from '../../src/editor/loading/scenePreparationProgress.ts';

/** 只读应用探针；业务操作必须由真实 UI/IPC 完成，不通过探针修改场景。 */
export function inspectNativeSkyboxApp() {
  const state = useEditorStore.getState();
  const skyboxes = state.scene.entityIds.flatMap(id => {
    const entity = state.scene.entities[id];
    return entity?.components.skybox ? [{ id, transform: entity.components.transform, skybox: entity.components.skybox }] : [];
  });
  const scenes = EngineStore.Instances.flatMap(engine => engine.scenes);
  const scene = scenes.find(candidate => candidate.meshes.some(mesh => mesh.metadata?.runtimeSkybox));
  const sky = scene?.meshes.find(mesh => mesh.metadata?.runtimeSkybox);
  const preparation = getScenePreparationSnapshot();
  return {
    sceneSessionId: state.sceneSessionId, sceneName: state.scene.name, dirty: state.hasUnsavedChanges(),
    skyboxes, resourceIssues: state.sceneResourceIssues,
    preparation: { completed: preparation.completed, runtime: preparation.runtime },
    runtime: scene && sky ? { skyReady: sky.material?.isReady(sky), environmentReady: scene.environmentTexture?.isReady(),
      environmentName: scene.environmentTexture?.name, environmentIntensity: scene.environmentIntensity,
      infiniteDistance: sky.infiniteDistance, pickable: sky.isPickable, position: sky.position.asArray(),
      cameraPosition: scene.activeCamera?.globalPosition.asArray(), maxZ: scene.activeCamera?.maxZ,
      triangles: sky.getTotalIndices() / 3, frames: scene.getFrameId(), renderer: scene.getEngine().getGlInfo().renderer,
      meshCount: scene.meshes.length, textureCount: scene.textures.length } : null,
    logs: state.logs.slice(0, 8).map(log => log.message),
  };
}
