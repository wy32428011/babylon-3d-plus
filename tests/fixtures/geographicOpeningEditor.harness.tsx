import React from 'react';
import { createRoot } from 'react-dom/client';
import { EngineStore } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { SceneSettingsPanel } from '../../src/editor/panels/SceneSettingsPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { getScenePreparationSnapshot } from '../../src/editor/loading/scenePreparationProgress';
import { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import '../../src/styles/global.css';

const fixture = createEmptySceneDocument('地理开场验收');
fixture.sceneSettings.shadows.enabled = false;
fixture.mqttConfig = { ...fixture.mqttConfig, enabled: true, simulatorEnabled: true };
fixture.sceneSettings.camera = { savedPose: { alpha: -Math.PI / 3, beta: 1.05, radius: 45, target: { x: 0, y: 1, z: 0 } }, savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 };
for (const [x,z] of [[-8,-6],[8,-6],[-8,6],[8,6]]) {
  const building = createMeshEntity('cube', { x, y: 2, z });
  building.components.transform.scale = { x: 10, y: 4, z: 8 };
  building.components.meshRenderer!.materialColor = '#25768e';
  fixture.entities[building.id] = building; fixture.entityIds.push(building.id);
}
useEditorStore.getState().loadSceneFromContent(serializeScene(fixture), '地理开场验收.scene.json');
createRoot(document.getElementById('root')!).render(<div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 380px',height:'100vh'}}>
  <div style={{display:'grid',gridTemplateRows:'minmax(0,1fr) 100px',minHeight:0}}><SceneViewPanel/><ProjectPanel/></div>
  <aside style={{overflow:'auto',padding:12}}><SceneSettingsPanel/></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(engine=>engine.scenes).find(scene=>scene.activeCamera?.name==='EditorCamera');
Object.assign(window,{openingEditorHarness:{
  store:useEditorStore, preparation:getScenePreparationSnapshot, scene,
  camera:()=>Array.from(scene()!.activeCamera!.getViewMatrix(true).m),
  save:()=>serializeScene(useEditorStore.getState().scene),
  reopen:(value:string)=>useEditorStore.getState().loadSceneFromContent(value,'地理开场验收.scene.json'),
}});
