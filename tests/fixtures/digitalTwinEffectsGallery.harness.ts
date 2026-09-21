import { ArcRotateCamera, Color3, Color4, Engine, HemisphericLight, MeshBuilder, PBRMaterial, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { PoiEffectRuntime } from '../../src/runtime/babylon/effects/PoiEffectRuntime';
import { createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect';
import { DIGITAL_TWIN_EFFECT_DEFINITIONS } from '../../src/editor/model/digitalTwinEffect';
import { createPoiEffectEntity } from '../../src/editor/model/SceneDocument';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:100vw;height:100vh;display:block'; document.body.style.margin='0'; document.body.append(canvas);
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine); scene.clearColor = new Color4(.018,.034,.062,1);
const camera = new ArcRotateCamera('camera', -1.2, 1.1, 24, new Vector3(0,2,0),scene); camera.attachControl(canvas,true);
new HemisphericLight('light',Vector3.Up(),scene).intensity=.8;
const ground = MeshBuilder.CreateGround('ground',{width:36,height:36},scene);
const floor = new StandardMaterial('groundMaterial',scene);floor.diffuseColor=new Color3(.025,.04,.06);ground.material=floor;
const target = new TransformNode('target',scene);
for(let i=0;i<3;i++) {
  const mesh=MeshBuilder.CreateBox(i===2?'Roof':'Floor'+i,{width:7,height:.7,depth:5},scene);mesh.parent=target;mesh.position.y=1+i*2;
  const material=i%2===0?new StandardMaterial('standard'+i,scene):new PBRMaterial('pbr'+i,scene);
  if(material instanceof StandardMaterial)material.diffuseColor=Color3.FromHexString('#486782');
  else {material.albedoColor=Color3.FromHexString('#486782');material.metallic=.25;material.roughness=.6;}
  mesh.material=material;
}
const runtime=new PoiEffectRuntime(scene,id=>id==='target'?target:null,()=>true);
const entity=createPoiEffectEntity('model-scan');entity.id='gallery-effect';
let frames=0;
engine.runRenderLoop(()=>{scene.render();frames++;});
const change=(kind:string)=>{
  const c=createDefaultPoiEffectComponent(kind as typeof entity.components.poiEffect.effectKind);
  c.visual!.targetEntityId='target';c.visual!.opacity=.6;
  if(kind==='day-night')c.visual!.progress=.6;
  entity.components.poiEffect=c;runtime.sync(entity,false,true,true);
  return c;
};
change('model-scan');
Object.assign(window,{gallery:{scene,runtime,target,entity,definitions:DIGITAL_TWIN_EFFECT_DEFINITIONS,change,
  ready:()=>scene.meshes.filter(m=>m.isEnabled()).every(m=>m.isReady(true)),frames:()=>frames,
  disable:()=>{entity.components.poiEffect!.enabled=false;runtime.sync(entity,false,true,true);},
  dispose:()=>{runtime.dispose();scene.dispose();engine.dispose();},
}});
