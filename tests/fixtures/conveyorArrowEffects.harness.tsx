import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, Camera, EngineStore, Matrix, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { isScenePreparationActive } from '../../src/editor/loading/scenePreparationProgress';
import '../../src/styles/global.css';

const documentModel = createEmptySceneDocument('输送方向箭头六款验收');
documentModel.sceneSettings.shadows.enabled = false;
documentModel.sceneSettings.camera.savedPose = {
  alpha: -Math.PI / 2, beta: 0.15, radius: 31, target: { x: 0, y: 0, z: 0 },
};
const positions = Array.from({ length: 6 }, (_, index) => ({ x: index % 2 ? 5.5 : -5.5, y: 0.15, z: (Math.floor(index / 2) - 1) * 4.5 }));
for (const [index, position] of positions.entries()) {
  const platform = createMeshEntity('cube', { ...position, y: -0.3 });
  platform.name = `箭头示例平台 ${index + 1}`;
  platform.components.transform.scale = { x: 9.5, y: 0.5, z: 3.3 };
  platform.components.meshRenderer!.materialColor = '#202933';
  documentModel.entities[platform.id] = platform;
  documentModel.entityIds.push(platform.id);
}
useEditorStore.getState().loadSceneFromContent(serializeScene(documentModel), 'conveyor-arrow-effects.scene.json');
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 410px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 270px', minHeight: 0 }}>
    <SceneViewPanel /><ProjectPanel />
  </div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(value => value.activeCamera && value.meshes.some(mesh => mesh.getTotalVertices() > 0));
const entities = () => Object.values(useEditorStore.getState().scene.entities).filter(entity => entity.components.poiEffect?.effectKind.startsWith('conveyor-arrow-'));
const current = () => { const state = useEditorStore.getState().scene; return state.entities[state.selectedEntityId!]; };
const meshes = () => scene()?.meshes.filter(mesh => mesh.name.endsWith('_conveyor_arrow')) ?? [];
Object.assign(window, { conveyorEffectsHarness: {
  store: useEditorStore, scene, entities, current, meshes, positions,
  ready: () => !isScenePreparationActive() && !!scene(),
  camera: () => {
    const camera = scene()!.activeCamera as ArcRotateCamera;
    camera.setTarget(new Vector3(0, 0, 0)); camera.alpha = -Math.PI / 2; camera.beta = 0.015; camera.radius = 30;
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -12; camera.orthoRight = 12; camera.orthoTop = 8; camera.orthoBottom = -8;
  },
  place: (index: number) => {
    for (const axis of ['x', 'y', 'z'] as const) useEditorStore.getState().updateSelectedTransform('position', axis, positions[index][axis]);
  },
  region: (index: number) => {
    const currentScene = scene()!, engine = currentScene.getEngine(), position = positions[index];
    const rect = engine.getRenderingCanvas()!.getBoundingClientRect();
    const points = [-1, 1].flatMap(x => [-1, 1].map(z => Vector3.Project(
      new Vector3(position.x + x * 4.6, position.y, position.z + z * 1.45), Matrix.Identity(), currentScene.getTransformMatrix(),
      currentScene.activeCamera!.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
    )));
    return { x: Math.min(...points.map(p => p.x)) * rect.width / engine.getRenderWidth(),
      y: Math.min(...points.map(p => p.y)) * rect.height / engine.getRenderHeight(),
      width: (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))) * rect.width / engine.getRenderWidth(),
      height: (Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))) * rect.height / engine.getRenderHeight() };
  },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, 'reopened-arrows.scene.json'),
  dispose: () => root.unmount(),
} });
