import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { GeographicOpeningRuntime, type OpeningSnapshot } from '../../src/runtime/opening/GeographicOpeningRuntime';
import { createDefaultSceneOpeningAnimation, normalizeSceneOpeningAnimation, type SceneOpeningAnimationSettings } from '../../src/editor/model/sceneOpeningAnimation';

const canvas=document.querySelector<HTMLCanvasElement>('#renderCanvas')!;
const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:true});
engine.setHardwareScalingLevel(Math.min(1,1/window.devicePixelRatio));
const scene=new Scene(engine);
scene.clearColor=new Color4(.022,.043,.074,1);
const camera=new ArcRotateCamera('business-camera',-Math.PI*.63,Math.PI*.32,86,new Vector3(0,0,0),scene);
camera.minZ=.1;camera.maxZ=500;camera.lowerRadiusLimit=20;camera.upperRadiusLimit=140;
camera.attachControl(canvas,true);
new HemisphericLight('ambient',new Vector3(0,1,0),scene).intensity=.8;
new DirectionalLight('sun',new Vector3(.5,-1,.4),scene).intensity=1.4;

const material=(name:string,color:string,glow=false)=>{const m=new StandardMaterial(name,scene);m.diffuseColor=Color3.FromHexString(color);m.specularColor=new Color3(.2,.3,.4);if(glow)m.emissiveColor=m.diffuseColor.scale(.65);return m;};
const groundMaterial=material('campus-ground','#102838');
const buildingMaterial=material('campus-facade','#c5dce7');
const roofMaterial=material('campus-roof','#2a4a5d');
const windowMaterial=material('campus-windows','#3ac8e4',true);
const roadMaterial=material('campus-road','#081923');
const greenMaterial=material('campus-green','#236a61');
const orangeMaterial=material('campus-logistics','#ef9c48');
const box=(name:string,x:number,y:number,z:number,width:number,height:number,depth:number,mat:StandardMaterial)=>{const mesh=MeshBuilder.CreateBox(name,{width,height,depth},scene);mesh.position.set(x,y,z);mesh.material=mat;return mesh;};
box('园区底座',0,-.65,0,66,1.2,42,groundMaterial);
for(const z of [-14,0,14])box('园区道路',0,0,z,64,.04,3.4,roadMaterial);
for(const x of [-27,0,27])box('园区道路',x,0,0,3.2,.04,40,roadMaterial);
for(const [index,x] of [-15,14].entries())for(const z of [-7,7]){
  const height=index===0?4.4:5.8;
  box('智慧制造厂房',x,height/2,z,20,height,9.5,buildingMaterial);
  box('厂房屋顶',x,height+.16,z,20.5,.34,10,roofMaterial);
  for(let row=0;row<3;row++)box('采光天窗',x,height+.38,z-3+row*3,17,.15,.6,windowMaterial);
  for(let bay=0;bay<6;bay++)box('门厅',x-8+bay*3.2,1.4,z-4.8,1.9,2.8,.08,roofMaterial);
  box('建筑光带',x,height-.9,z-4.82,19,.2,.04,windowMaterial);
}
for(let i=0;i<10;i++){
  const x=-28+i*6.3;
  box('绿化带',x,.08,-19,3.5,.16,1.8,greenMaterial);
  const tree=MeshBuilder.CreateSphere('绿植',{diameter:1.7,segments:8},scene);tree.position.set(x,1,-19);tree.material=greenMaterial;
}
for(let i=0;i<7;i++){box('货箱',6+i*2.5,.55,17,1.7,1.1,2.5,orangeMaterial);}
const gridLines:Vector3[][]=[];
for(let x=-40;x<=40;x+=4)gridLines.push([new Vector3(x,-1.3,-30),new Vector3(x,-1.3,30)]);
for(let z=-30;z<=30;z+=4)gridLines.push([new Vector3(-40,-1.3,z),new Vector3(40,-1.3,z)]);
MeshBuilder.CreateLineSystem('ground-grid',{lines:gridLines},scene).color=Color3.FromHexString('#173344');

const settings:SceneOpeningAnimationSettings={...createDefaultSceneOpeningAnimation(),enabled:true};
let runtime!:GeographicOpeningRuntime;
let error:string|null=null;
let ready=false;
let completions=0;
const update=(snapshot:OpeningSnapshot)=>{
  ready=true;
  document.body.classList.remove('opening-preparing');
  document.body.classList.toggle('scene-ready',snapshot.phase==='complete');
};
const replay=()=>{
  runtime?.dispose();error=null;ready=false;
  document.body.classList.remove('scene-ready');
  document.body.classList.add('opening-preparing');
  document.querySelector<HTMLElement>('#error')!.style.display='none';
  camera.detachControl();
  runtime=new GeographicOpeningRuntime({scene,settings,onProgress:update,onComplete:()=>{completions++;camera.attachControl(canvas,true);update(runtime.getSnapshot());},onError:e=>{error=String(e);document.body.classList.remove('opening-preparing');const el=document.querySelector<HTMLElement>('#error')!;el.textContent=error;el.style.display='block';camera.attachControl(canvas,true);console.error(e);}});
  runtime.start();
};
document.querySelector('#replay')!.addEventListener('click',replay);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&settings.allowSkip)runtime.skip();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)runtime.pause();else runtime.resume();});
window.addEventListener('resize',()=>engine.resize());
window.addEventListener('pagehide',()=>{runtime.dispose();engine.dispose();},{once:true});
engine.runRenderLoop(()=>scene.render());
replay();
const seekParam=new URLSearchParams(location.search).get('seek');
if(seekParam!==null){runtime.seek(Number(seekParam));runtime.pause();}
(window as unknown as {__openingDemo:unknown}).__openingDemo={settings,scene,engine,
  getState:()=>({snapshot:runtime.getSnapshot(),error,ready,completions,scenes:engine.scenes.length}),
  seek:(seconds:number)=>{if(runtime.getSnapshot().phase==='complete')replay();runtime.seek(seconds);runtime.pause();},
  play:()=>runtime.resume(),pause:()=>runtime.pause(),skip:()=>runtime.skip(),replay,
  dispose:()=>runtime.dispose(),
  configure:(patch:Partial<SceneOpeningAnimationSettings>)=>{Object.assign(settings,normalizeSceneOpeningAnimation({...settings,...patch}));replay();},
};
