import React from 'react';
import { createRoot } from 'react-dom/client';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { SceneSettingsPanel } from '../../src/editor/panels/SceneSettingsPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { createEmptySceneDocument, createMeshEntity, sanitizeSceneEnvironment } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';
import { normalizeSceneModelEntranceSettings } from '../../src/editor/model/sceneModelEntrance';
import { installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import '../../src/styles/global.css';

const scene = createEmptySceneDocument('模型入场配置与运行验收');
scene.sceneSettings.shadows.enabled = false;
scene.sceneSettings.modelEntrance = normalizeSceneModelEntranceSettings({ enabled: true, effect: 'dissolve', durationSeconds: .5 });
scene.mqttConfig.enabled = true;
scene.mqttConfig.simulatorEnabled = true;
if (new URLSearchParams(location.search).has('environment')) {
  const sourceUrl = 'editor-asset://local/' + encodeURIComponent('output/model-entrance/environment.glb');
  installDeploymentAssetManifest({ [sourceUrl]:new URL('/environment.glb',location.href).href });
  scene.sceneSettings.environment = sanitizeSceneEnvironment({ packagePath:'output/model-entrance', displayName:'入场验收厂房',
    lengthUnit:'meter',unitScaleToMeters:1,placementMode:'scene-base',visible:true,opacity:1,
    activeVariantUrl:sourceUrl,variants:[{name:'默认厂房',sourcePath:'output/model-entrance/environment.glb',sourceUrl}] });
}
for(let index=0;index<3;index++) {
  const entity=createMeshEntity('cube',{x:(index-1)*3,y:1,z:0});entity.name='设备 '+(index+1);
  entity.components.transform.scale={x:2,y:2,z:2};entity.components.meshRenderer!.materialColor=['#b17a42','#409ca7','#72945a'][index];
  scene.entities[entity.id]=entity;scene.entityIds.push(entity.id);
}
useEditorStore.getState().loadSceneFromContent(serializeScene(scene),'model-entrance.scene.json');
let runtime:SceneRuntime|null=null, starts=0, saved='';
const prepare=SceneRuntime.prototype.prepareModelEntrance;
const start=SceneRuntime.prototype.startModelEntrance;
SceneRuntime.prototype.prepareModelEntrance=function(settings,signal){runtime=this;return prepare.call(this,settings,signal);};
SceneRuntime.prototype.startModelEntrance=function(){starts++;return start.call(this);};
function Fixture() {
  const state=useEditorStore();
  const [message,setMessage]=React.useState('');
  return <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 390px',height:'100vh'}}>
    <div style={{display:'grid',gridTemplateRows:'48px minmax(0,1fr) 140px',minHeight:0}}>
      <div style={{display:'flex',gap:10,padding:8}}>
        <button onClick={()=>{const result=useEditorStore.getState().startRuntimePreview();setMessage(JSON.stringify(result));}}>进入运行</button>
        <button onClick={()=>useEditorStore.getState().stopRuntimePreview()}>退出运行</button>
        <button onClick={()=>{saved=serializeScene(useEditorStore.getState().scene);setMessage('场景已保存');}}>保存场景</button>
        <button onClick={()=>{if(saved)useEditorStore.getState().loadSceneFromContent(saved,'重开入场.scene.json');}}>重新打开</button>
      </div>
      <SceneViewPanel />
      <div style={{display:'grid',gridTemplateRows:'70px 70px',minHeight:0}}><ProjectPanel />
        <pre id="editor-entrance-status">{message+'\n'+JSON.stringify({mode:state.runtimeMode,settings:state.scene.sceneSettings.modelEntrance,starts,snapshot:runtime?.getModelEntranceSnapshot()},null,2)}</pre>
      </div>
    </div>
    <aside style={{overflow:'auto',padding:12}}><SceneSettingsPanel /></aside>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const status=document.createElement('output');status.id='runtime-entrance-status';document.body.append(status);
const timer=window.setInterval(()=>{status.textContent=JSON.stringify({starts,snapshot:runtime?.getModelEntranceSnapshot()});},100);
window.addEventListener('pagehide',()=>window.clearInterval(timer),{once:true});
