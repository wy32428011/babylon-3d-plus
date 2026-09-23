import React from 'react';
import { createRoot } from 'react-dom/client';
import { EngineStore } from '@babylonjs/core/Engines/engineStore';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { HierarchyPanel } from '../../src/editor/panels/HierarchyPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument';
import { isScenePreparationActive } from '../../src/editor/loading/scenePreparationProgress';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import '../../src/styles/global.css';

const documentModel = createEmptySceneDocument('组合拖拽验收');
documentModel.sceneSettings.shadows.enabled = false;
for (const x of [-2,2]) {
  const entity=createMeshEntity('cube',{x,y:1,z:0});entity.name=x<0?'设备 A':'设备 B';
  documentModel.entities[entity.id]=entity;documentModel.entityIds.push(entity.id);
}
documentModel.selectedEntityId=documentModel.entityIds[0];
useEditorStore.getState().loadSceneFromContent(serializeScene(documentModel),'composition.scene.json');
useEditorStore.getState().selectHierarchyEntities(documentModel.entityIds,documentModel.entityIds[0]);
const root=createRoot(document.getElementById('root')!);
root.render(<div style={{display:'grid',gridTemplateColumns:'240px minmax(0,1fr) 350px',height:'100vh'}}>
  <HierarchyPanel/><div style={{display:'grid',gridTemplateRows:'minmax(0,1fr) 340px',minHeight:0}}><SceneViewPanel/><ProjectPanel/></div><div style={{overflow:'auto'}}><InspectorPanel/></div>
</div>);
Object.assign(window,{compositionHarness:{store:useEditorStore,save:()=>serializeScene(useEditorStore.getState().scene),reopen:(value:string)=>useEditorStore.getState().loadSceneFromContent(value,'reopened.scene.json'),
  ready:()=>!isScenePreparationActive() && EngineStore.Instances.some(e=>e.scenes.some(s=>s.getFrameId()>2)),camera:()=>{const scene=EngineStore.Instances.flatMap(e=>e.scenes).find(s=>s.activeCamera);const camera=scene?.activeCamera as any;if(camera?.setTarget){camera.setTarget(new Vector3(0,1,0));camera.radius=18;camera.alpha=-1.1;camera.beta=1.1;}},dispose:()=>root.unmount()}});
