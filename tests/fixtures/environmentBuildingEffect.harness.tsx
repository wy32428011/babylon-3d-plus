import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArcRotateCamera, EngineStore, Vector3 } from '@babylonjs/core';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { InspectorPanel } from '../../src/editor/panels/InspectorPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, sanitizeSceneEnvironment } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import '../../src/styles/global.css';

const sourcePath = (window as unknown as { environmentFixturePath: string }).environmentFixturePath;
const sourceUrl = 'editor-asset://local/' + encodeURIComponent(sourcePath);
const documentModel = createEmptySceneDocument('环境模型建筑特效验收');
documentModel.sceneSettings.shadows.enabled = false;
documentModel.sceneSettings.environment = sanitizeSceneEnvironment({packagePath: sourcePath, lengthUnit:'meter',unitScaleToMeters:1,
  displayName:'示例环境厂房',placementMode:'scene-base',visible:true,opacity:1,
  activeVariantUrl:sourceUrl,variants:[{name:'默认环境',sourcePath,sourceUrl}]});
useEditorStore.getState().loadSceneFromContent(serializeScene(documentModel),'environment-effects.scene.json');
const root = createRoot(document.getElementById('root')!);
root.render(<div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 440px',height:'100vh'}}>
  <div style={{display:'grid',gridTemplateRows:'minmax(0,1fr) 260px',minHeight:0}}><SceneViewPanel/><ProjectPanel/></div>
  <aside style={{overflow:'auto',padding:12}}><InspectorPanel/></aside>
</div>);
const scene = () => EngineStore.Instances.flatMap(e=>e.scenes).find(s=>s.transformNodes.some(n=>n.name.startsWith('EnvironmentRoot_')));
const environmentRoot = () => scene()?.transformNodes.find(n=>n.name.startsWith('EnvironmentRoot_'));
Object.assign(window,{environmentEffectHarness:{store:useEditorStore,scene,environmentRoot,
  meshes:()=>environmentRoot()?.getChildMeshes().filter(m=>m.getTotalVertices()>0)??[],
  ready:()=>useEditorStore.getState().environmentRuntimeSnapshot.phase==='ready',
  camera:()=>{const camera=scene()?.activeCamera as ArcRotateCamera;camera.setTarget(new Vector3(0,2,0));camera.alpha=-1.2;camera.beta=1.15;camera.radius=22;},
  current:()=>{const s=useEditorStore.getState().scene;return s.entities[s.selectedEntityId!]?.components.poiEffect;},
  save:()=>serializeScene(useEditorStore.getState().scene),
  reopen:(content:string)=>useEditorStore.getState().loadSceneFromContent(content,'reopened.scene.json'),
  dispose:()=>root.unmount(),
}});
