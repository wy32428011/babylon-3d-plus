import React from 'react';
import {createRoot} from 'react-dom/client';
import {ArcRotateCamera,EngineStore,Vector3} from '@babylonjs/core';
import {SceneViewPanel} from '../../src/editor/panels/SceneViewPanel';
import {InspectorPanel} from '../../src/editor/panels/InspectorPanel';
import {ProjectPanel} from '../../src/editor/panels/ProjectPanel';
import {useEditorStore} from '../../src/editor/store/editorStore';
import {createEmptySceneDocument,createModelEntity} from '../../src/editor/model/SceneDocument';
import {serializeScene} from '../../src/editor/project/SceneSerializer';
import {installDeploymentAssetManifest} from '../../src/runtime/assets/editorAssetUrl';
import {deviceTelemetryStore} from '../../src/runtime/mqtt/deviceTelemetry';
import {getEffectDiagnostic} from '../../src/runtime/effects/effectDiagnostics';
import '../../src/styles/global.css';

const path=(window as unknown as {effectModelPath:string}).effectModelPath;
const url='editor-asset://local/'+encodeURIComponent(path);
installDeploymentAssetManifest({[url]:location.origin+'/__editor_asset__/'+encodeURIComponent(path)});
const dataDrivenConfig={device:{devType:'device'},motion:true,fixedNodes:[]};
const asset={id:path,name:'示例RGV.glb',displayName:'RGV 测试模板',path,sourceUrl:url,kind:'model' as const,libraryKind:'model' as const,lengthUnit:'meter' as const,unitScaleToMeters:1,dataDrivenConfig};
Object.assign(window,{editorApi:{listProjectAssets:async()=>({projectRoot:'C:/fixture',assets:[asset],skyboxes:[],orphanedSkyboxes:[]}),listSyncedImages:async()=>[]}});
const doc=createEmptySceneDocument('特效模型与数据绑定验收');doc.sceneSettings.shadows.enabled=false;
const ids:string[]=[];
for(const [i,sourceId,assetCode] of [[0,'source-A','000317'],[1,'source-B','000317'],[2,'source-A','000318']] as const){
  const entity=createModelEntity(path,url,`设备 ${sourceId} ${assetCode}`,{lengthUnit:'meter',unitScaleToMeters:1},{x:(i-1)*7,y:0,z:0},undefined,undefined,undefined,undefined,undefined,undefined,dataDrivenConfig);
  entity.components.modelAsset!.assetCode=assetCode;entity.components.transform.scale={x:.3,y:.3,z:.3};
  entity.components.telemetryBinding={enabled:true,sourceId,deviceType:'device',assetCode,expectedIntervalMs:500,staleAfterMs:60000};
  doc.entities[entity.id]=entity;doc.entityIds.push(entity.id);ids.push(entity.id);
}
doc.mqttConfig={...doc.mqttConfig,enabled:true,simulatorEnabled:true,simulatorAssetCode:'unrelated-simulator'};
useEditorStore.getState().loadSceneFromContent(serializeScene(doc),'effect-binding.scene.json');
useEditorStore.setState({sceneResourcePolicy:'preserve-snapshot'});
const root=createRoot(document.getElementById('root')!);
root.render(<div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 490px',height:'100vh'}}>
  <div style={{display:'grid',gridTemplateRows:'minmax(0,1fr) 280px',minHeight:0}}><SceneViewPanel/><ProjectPanel/></div>
  <aside style={{overflow:'auto',padding:10}}><InspectorPanel/></aside>
</div>);
const scene=()=>EngineStore.Instances.flatMap(e=>e.scenes).find(s=>s.transformNodes.some(n=>n.name===ids[0]+'_modelRoot'));
let sequence=0;
Object.assign(window,{effectBindingHarness:{store:useEditorStore,ids,scene,
  ready:()=>ids.every(id=>scene()?.getTransformNodeByName(id+'_modelRoot')?.getChildMeshes().some(m=>m.getTotalVertices()>0)),
  current:()=>{const s=useEditorStore.getState().scene;return s.entities[s.selectedEntityId!]?.components.poiEffect;},
  diagnostic:()=>getEffectDiagnostic(useEditorStore.getState().scene.selectedEntityId??''),
  publish:(sourceId='source-A',assetCode='000317',fields:Record<string,unknown>={speed:2,temperature:36})=>deviceTelemetryStore.upsert({sourceId,assetCode,deviceType:'device',topic:'fixture',payloadDeviceCode:null,sourceTimestamp:Date.now(),sequence:++sequence,receivedAt:Date.now(),fields,currentLocationKey:null,targetLocationKey:null,hasTargetLocation:false,faulted:false,message:''}),
  move:(x:number)=>{const n=scene()!.getTransformNodeByName(ids[0]+'_modelRoot')!;n.position.x=x;n.computeWorldMatrix(true);},
  camera:()=>{const c=scene()!.activeCamera as ArcRotateCamera;c.setTarget(new Vector3(0,1,0));c.alpha=-1.1;c.beta=1.1;c.radius=25;},
  save:()=>serializeScene(useEditorStore.getState().scene),
  reopen:(content:string)=>{useEditorStore.getState().loadSceneFromContent(content,'reopened.scene.json');useEditorStore.setState({sceneResourcePolicy:'preserve-snapshot'});},
  dispose:()=>root.unmount(),
}});
