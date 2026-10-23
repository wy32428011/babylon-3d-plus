import React from 'react';
import { createRoot } from 'react-dom/client';
import { EngineStore } from '@babylonjs/core/Engines/engineStore';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { HierarchyPanel } from '../../src/editor/panels/HierarchyPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createMeshEntity, createModelEntity } from '../../src/editor/model/SceneDocument';
import { captureComposition, groupComposition } from '../../src/editor/composition/composition';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import '../../src/styles/global.css';

const sourcePath = (window as unknown as { compositionArrayAsset: string }).compositionArrayAsset;
const sourceUrl = 'editor-asset://local/' + encodeURIComponent(sourcePath);
installDeploymentAssetManifest({ [sourceUrl]: location.origin + '/builtin-model-packages/virtual-conveyor/virtual-conveyor.glb' });
const documentModel = createEmptySceneDocument('组合阵列验收');
// 沿用本夹具禁用阴影的设置，使用当前统一光照字段。
documentModel.sceneSettings.lighting.shadows.enabled = false;
documentModel.sceneSettings.lighting.bake.enabled = false;
for (const x of [-2, 2]) {
  const entity = createMeshEntity('cube', { x, y: 1, z: 0 });
  entity.name = x < 0 ? '设备 A' : '设备 B';
  documentModel.entities[entity.id] = entity; documentModel.entityIds.push(entity.id);
}
const imported = createModelEntity(sourcePath, sourceUrl, '导入输送机', { lengthUnit: 'meter', unitScaleToMeters: 1 }, { x: 0, y: 0, z: 2 });
documentModel.entities[imported.id] = imported; documentModel.entityIds.push(imported.id);
const grouped = groupComposition(documentModel, captureComposition(documentModel, documentModel.entityIds, '阵列设备1'), { libraryId: 'array-fixture', revision: 'v1' });
const seed = serializeScene(grouped);
useEditorStore.getState().loadSceneFromContent(seed, 'composition-array.scene.json');
useEditorStore.setState({ sceneResourcePolicy: 'preserve-snapshot' });
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: '250px minmax(0,1fr) 340px', height: '100vh' }}>
  <HierarchyPanel /><SceneViewPanel /><aside style={{ overflow: 'auto' }}><InspectorPanel /></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(e => e.scenes).find(s => s.activeCamera && s.meshes.some(m => m.metadata?.editorEntityId === documentModel.entityIds[0]));
const camera = () => { const c = scene()?.activeCamera as any; if (c?.setTarget) { c.setTarget(new Vector3(0, 1, 0)); c.radius = 28; c.alpha = -1.1; c.beta = 1.1; } };
Object.assign(window, { compositionArrayHarness: {
  store: useEditorStore, rootId: grouped.selectedEntityId, seed, scene, camera,
  ready: () => Boolean((scene()?.getFrameId() ?? 0) > 3 && scene()?.getTransformNodeByName(imported.id + '_modelRoot')?.getChildMeshes().some(m => m.getTotalVertices() > 0 && m.isReady(true))),
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => { useEditorStore.getState().loadSceneFromContent(content, 'reopened.scene.json'); useEditorStore.setState({ sceneResourcePolicy: 'preserve-snapshot' }); },
  project: (point: { x: number; y: number; z: number }, targetScene = scene()) => {
    if (!targetScene?.activeCamera) throw Error('场景相机未就绪');
    const engine = targetScene.getEngine(); const canvas = engine.getRenderingCanvas()!; const box = canvas.getBoundingClientRect();
    const p = Vector3.Project(new Vector3(point.x, point.y, point.z), Matrix.Identity(), targetScene.getTransformMatrix(), targetScene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
    return { x: box.left + p.x * box.width / engine.getRenderWidth(), y: box.top + p.y * box.height / engine.getRenderHeight() };
  },
  engines: EngineStore, dispose: () => root.unmount(),
} });
