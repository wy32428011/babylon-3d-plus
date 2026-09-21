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

const document = createEmptySceneDocument('数字孪生特效验收');
document.sceneSettings.shadows.enabled = false;
const building = createMeshEntity('cube', { x: 0, y: 3, z: 0 });
building.name = '示例建筑';
building.components.transform.scale = { x: 6, y: 6, z: 4 };
building.components.meshRenderer!.materialColor = '#405469';
document.entities[building.id] = building;
document.entityIds.push(building.id);
useEditorStore.getState().loadSceneFromContent(serializeScene(document), '数字孪生特效验收.scene.json');
const root = createRoot(window.document.getElementById('root')!);
root.render(<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 390px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 260px', minHeight: 0 }}>
    <SceneViewPanel /><ProjectPanel />
  </div>
  <aside style={{ overflow: 'auto', padding: 12 }}><InspectorPanel /></aside>
</div>);

const getScene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(m => m.name.endsWith('_poiEffectPickShell')));
Object.assign(window, { effectHarness: {
  store: useEditorStore, scene: getScene, buildingId: building.id,
  current: () => { const s = useEditorStore.getState().scene; return s.entities[s.selectedEntityId!]?.components.poiEffect; },
  camera: () => { const camera = getScene()!.activeCamera as import('@babylonjs/core').ArcRotateCamera; camera.setTarget(new Vector3(0, 2, 0)); camera.alpha = -1.2; camera.beta = 1.1; camera.radius = 23; },
  save: () => serializeScene(useEditorStore.getState().scene),
  reopen: (content: string) => useEditorStore.getState().loadSceneFromContent(content, '重新打开.scene.json'),
  dispose: () => root.unmount(),
} });
