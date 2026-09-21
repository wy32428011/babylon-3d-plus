import React from 'react';
import { createRoot } from 'react-dom/client';
import { EngineStore, Vector3, Camera } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import '../../src/styles/global.css';

const document = createEmptySceneDocument('光墙围栏验收');
document.sceneSettings.shadows.enabled = false;
const building = createMeshEntity('cube', { x: 0, y: 3, z: 0 });
building.name = '示例建筑';
building.components.transform.scale = { x: 6, y: 6, z: 4 };
building.components.meshRenderer!.materialColor = '#405469';
document.entities[building.id] = building;
document.entityIds.push(building.id);
useEditorStore.getState().loadSceneFromContent(serializeScene(document), '光墙围栏验收.scene.json');
const root = createRoot(window.document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 390px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 260px', minHeight: 0 }}>
    <SceneViewPanel /><ProjectPanel />
  </div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);
const getScene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(m => m.name.endsWith('_poiEffectPickShell')));
const wall = () => getScene()?.meshes.find(m => m.name.endsWith('_light_wall_fence'));
Object.assign(window, { lightWallHarness: {
  store: useEditorStore,
  scene: getScene,
  wall,
  current: () => { const s = useEditorStore.getState().scene; return s.entities[s.selectedEntityId!]?.components.poiEffect; },
  camera: (front = false) => {
    const camera = getScene()!.activeCamera as import('@babylonjs/core').ArcRotateCamera;
    camera.setTarget(new Vector3(0, 2.5, 0)); camera.alpha = front ? -Math.PI / 2 : -1.1;
    camera.beta = front ? Math.PI / 2 : 1.1; camera.radius = 25;
    camera.mode = front ? Camera.ORTHOGRAPHIC_CAMERA : Camera.PERSPECTIVE_CAMERA;
    if (front) { camera.orthoLeft = -8; camera.orthoRight = 8; camera.orthoTop = 6; camera.orthoBottom = -6; }
  },
  project: (x: number, y: number, z: number) => {
    const scene = getScene()!, engine = scene.getEngine();
    const p = Vector3.Project(new Vector3(x, y, z), wall()!.getWorldMatrix(), scene.getTransformMatrix(), scene.activeCamera!.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
    const rect = engine.getRenderingCanvas()!.getBoundingClientRect();
    return { x: rect.left + p.x * rect.width / engine.getRenderWidth(), y: rect.top + p.y * rect.height / engine.getRenderHeight() };
  },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, '重新打开.scene.json'),
  dispose: () => root.unmount(),
} });
