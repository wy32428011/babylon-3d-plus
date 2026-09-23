import { ArcRotateCamera, Color4, Engine, HemisphericLight, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { SpatialEffects } from '../../src/runtime/babylon/effects/SpatialEffects';
import { ConfiguredLegacyEffects, supportsConfiguredLegacyEffect } from '../../src/runtime/babylon/effects/ConfiguredLegacyEffects';
import { LightWallFence } from '../../src/runtime/babylon/effects/LightWallFence';
import { createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect';
import { getSpatialEffectParameters } from '../../src/editor/model/spatialEffectParameters';
import { getLegacyEffectParameters } from '../../src/editor/model/legacyEffectParameters';
import type { PoiEffectComponent, PoiEffectKind } from '../../src/editor/model/components';

const canvas=document.createElement('canvas');canvas.style.cssText='width:100vw;height:100vh';document.body.style.margin='0';document.body.append(canvas);
const engine=new Engine(canvas,true,{preserveDrawingBuffer:true}),scene=new Scene(engine);scene.clearColor=new Color4(.018,.034,.062,1);
const camera=new ArcRotateCamera('camera',-1.2,1.1,24,new Vector3(0,2,0),scene);camera.attachControl(canvas,true);
new HemisphericLight('light',Vector3.Up(),scene);
const root=new TransformNode('effect',scene);
let current:SpatialEffects|ConfiguredLegacyEffects|null=null,wall:LightWallFence|null=null,frames=0,component:PoiEffectComponent;
function change(kind:PoiEffectKind,configured=true):void {
  current?.dispose();current=null;wall?.mesh.dispose(false,false);wall?.material.dispose();wall=null;
  component=createDefaultPoiEffectComponent(kind);
  const parameters=Object.fromEntries([...getSpatialEffectParameters(kind),...getLegacyEffectParameters(kind)].map(p=>[p.key,structuredClone(p.default)]));
  if(kind==='region-level')parameters.regions=[{id:'zoneA',name:'西区',value:20,points:[{x:-4,y:0,z:-3},{x:4,y:0,z:-3},{x:4,y:0,z:3},{x:-4,y:0,z:3}]}];
  if(kind==='heatmap'||kind==='region-level')parameters.colorStops=[{value:0,color:'#00ff44'},{value:100,color:'#ff2200'}];
  if(configured)component.configuration={version:2,parameters} as PoiEffectComponent['configuration'];
  if(kind==='light-wall-fence')wall=new LightWallFence('wall',scene,root,component);
  else if(supportsConfiguredLegacyEffect(kind))current=new ConfiguredLegacyEffects('legacy',scene,root,component);
  else current=new SpatialEffects('effect',scene,root,component);
}
engine.runRenderLoop(()=>{current?.tick(.016);wall?.animate(.016);scene.render();frames++;});
Object.assign(window,{spatialConfiguration:{scene,change,frames:()=>frames,ready:()=>scene.meshes.every(m=>m.isReady(true)),
  update:()=>{component={...component,primaryColor:'#ffcc33',visual:component.visual?{...component.visual,values:component.visual.values.map(()=>50),progress:.7}:undefined};current?.update(component);wall?.update(component);},
  dispose:()=>{current?.dispose();wall?.mesh.dispose();wall?.material.dispose();scene.dispose();engine.dispose();}}});
