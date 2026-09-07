import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const scenePath=process.argv[2];
if(!scenePath)throw new Error('用法：node scripts/smoke-factory-static-shadows.mjs <场景文件路径>');
const document=JSON.parse(await readFile(scenePath,'utf8')).scene;
const environment=document.sceneSettings.environment;
const assetPath=environment.variants.find(item=>item.sourceUrl===environment.activeVariantUrl).sourcePath;
const useModelPositions=process.argv.includes('--model-positions');
const output=path.resolve('output/playwright/factory-static-shadows');
const harness=`
import{Engine,Scene,FreeCamera,Vector3,Matrix,Quaternion,MeshBuilder,HemisphericLight,SceneLoader}from'@babylonjs/core';
import'@babylonjs/loaders/glTF';
import{SceneEnvironmentRuntime}from'/src/runtime/babylon/SceneEnvironmentRuntime.ts';
import{bakeEnvironmentShadows}from'/src/runtime/babylon/EnvironmentShadowBake.ts';
import{inspectGroundReceiver}from'/src/runtime/babylon/staticShadowReceivers.ts';
import{getSceneShadowBakeSignature,isStaticShadowEntity}from'/src/editor/model/sceneShadowBake.ts';
import{createEmptySceneDocument,DEFAULT_SCENE_SHADOW_SETTINGS}from'/src/editor/model/SceneDocument.ts';
const engine=new Engine(document.querySelector('canvas'),false,{preserveDrawingBuffer:true});
window.runFactoryBake=async()=>{
 const scene=new Scene(engine),camera=new FreeCamera('camera',new Vector3(0,100,-100),scene);camera.setTarget(Vector3.Zero());
 new HemisphericLight('EditorLight',Vector3.Up(),scene);
 const config=await(await fetch('/factory-config')).json();
 const runtime=new SceneEnvironmentRuntime(scene,{loadAssetContainer:(root,file)=>SceneLoader.LoadAssetContainerAsync(root,file,scene),resolveAssetUrl:()=>location.origin+'/factory.glb'});
 const settings={...DEFAULT_SCENE_SHADOW_SETTINGS,...config.shadows,enabled:true,mode:'baked',bake:null};
 const draw=()=>{engine.beginFrame();scene.render();engine.endFrame();};
 const settle=async()=>{for(let i=0;i<30;i++){draw();await new Promise(r=>setTimeout(r,20));}};
 try{
  console.log('factory-bake: loading environment');
  await runtime.apply(config.environment,{requestId:'factory',autoAlign:false});await runtime.syncShadows(settings);
  const surfaces=runtime.getShadowBakeSurfaces();
  const ground=surfaces.map(inspectGroundReceiver).filter(Boolean).filter(item=>item.surface.material.albedoTexture||item.surface.material.diffuseTexture).sort((a,b)=>b.area-a.area)[0];
  if(!ground)throw new Error('实际环境未找到平铺纹理地面');
  const mesh=ground.surface.mesh,positions=mesh.getVerticesData('position'),indices=mesh.getIndices(),world=mesh.computeWorldMatrix(true);
  let center=ground.min.add(ground.max).scale(0.5),area=-1;
  const point=index=>Vector3.TransformCoordinates(new Vector3(positions[index*3],positions[index*3+1],positions[index*3+2]),world);
  for(let i=0;i<indices.length;i+=3){const a=point(indices[i]),b=point(indices[i+1]),c=point(indices[i+2]);const next=Vector3.Cross(b.subtract(a),c.subtract(a)).lengthSquared();if(next>area){area=next;center=a.add(b).add(c).scale(1/3);}}
  const cube=MeshBuilder.CreateBox('diagnostic-static-caster',{size:8},scene);cube.position.set(center.x,ground.max.y+4,center.z);
  const devices=[];
  if(config.useModelPositions){
    cube.dispose();const transforms=new Map();
    const worldFor=id=>{if(transforms.has(id))return transforms.get(id);const entity=config.entities[id],t=entity.components.transform,s=t.scale,r=t.rotation,p=t.position;let world=Matrix.Compose(new Vector3(s.x,s.y,s.z),Quaternion.FromEulerAngles(r.x,r.y,r.z),new Vector3(p.x,p.y,p.z));if(entity.parentId)world=world.multiply(worldFor(entity.parentId));transforms.set(id,world);return world;};
    for(const [id,entity]of Object.entries(config.entities))if(entity.visible!==false&&entity.components.modelAsset&&isStaticShadowEntity({entities:config.entities},id)){const p=Vector3.TransformCoordinates(Vector3.Zero(),worldFor(id));const proxy=MeshBuilder.CreateBox('position-probe',{size:2},scene);proxy.position.set(p.x,p.y+1,p.z);devices.push(proxy);}
    if(!devices.length)throw new Error('实际场景没有可用静态设备位置');center.copyFrom(devices[0].position);
  }else devices.push(cube);
  const azimuth=settings.sunAzimuthDegrees*Math.PI/180;
  camera.position.set(center.x-Math.sin(azimuth)*35,center.y+35,center.z-Math.cos(azimuth)*35);camera.setTarget(center);
  await settle();
  const before=Array.from(await engine.readPixels(0,0,512,512));
  const sceneDocument=createEmptySceneDocument('factory-static-shadow-regression');sceneDocument.sceneSettings.environment=config.environment;sceneDocument.sceneSettings.shadows=settings;
  console.log('factory-bake: starting '+surfaces.length+' environment surfaces');
  const snapshot=await bakeEnvironmentShadows(scene,surfaces,[...surfaces.map(item=>item.mesh),...devices],settings,getSceneShadowBakeSignature(sceneDocument),undefined,message=>console.log('factory-bake: '+message));
  await runtime.syncShadows({...settings,bake:snapshot});await settle();
  const after=Array.from(await engine.readPixels(0,0,512,512));let darker=0,brighter=0;
  for(let i=0;i<before.length;i+=4){if(after[i]<before[i]-5)darker++;if(after[i]>before[i]+5)brighter++;}
  window.factoryImage=document.querySelector('canvas').toDataURL('image/png');
  const result={environmentSurfaces:surfaces.length,devicePositions:devices.length,receivers:snapshot.surfaces.length,mask:snapshot.surfaces.every(item=>item.kind==='shadow-mask'),uniqueTextures:new Set(snapshot.surfaces.map(item=>item.dataUrl).filter(Boolean)).size,resolution:snapshot.surfaces[0].width,darker,brighter,noGenerator:scene.lights.every(light=>!light.getShadowGenerator())};
  console.log('factory-bake: '+JSON.stringify(result));return result;
 }finally{runtime.dispose();scene.dispose();engine.dispose();}
};
`;
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:['@babylonjs/core','@babylonjs/loaders/glTF']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'factory-bake-fixture',resolveId(id){if(id==='/__factory__.js')return'\0factory-bake';},load(id){if(id==='\0factory-bake')return harness;},configureServer(vite){vite.middlewares.use((req,res,next)=>{
 if(req.url==='/factory-config'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({environment,shadows:document.sceneSettings.shadows,useModelPositions,entities:useModelPositions?document.entities:undefined}));return;}
 if(req.url==='/factory.glb'){res.setHeader('Content-Type','model/gltf-binary');createReadStream(assetPath).pipe(res);return;}
 if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return;}
 if(req.url!=='/__factory__')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><canvas width="512" height="512"></canvas><script type="module" src="/__factory__.js"></script>');
 });}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());else if(message.text().startsWith('factory-bake:'))console.log(message.text());});
 await page.goto(server.resolvedUrls.local[0]+'__factory__',{waitUntil:'commit'});await page.waitForFunction(()=>typeof window.runFactoryBake==='function',null,{timeout:180000});
 const result=await page.evaluate(()=>window.runFactoryBake());await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
 const image=await page.evaluate(()=>window.factoryImage);await writeFile(path.join(output,'baked.png'),Buffer.from(image.split(',')[1],'base64'));
 if(errors.length){await writeFile(path.join(output,'errors.log'),errors.join('\n'));throw new Error(errors.filter(item=>/SHADER ERROR|Offending/.test(item)).join('\n').slice(0,3000));}
 assert.ok(result.darker>30,'实际厂区环境必须显示阴影');assert.ok(result.brighter<100,'静态遮罩不得破坏地面原色');assert.equal(result.mask,true);assert.equal(result.uniqueTextures,1);assert.equal(result.noGenerator,true);
}catch(error){await writeFile(path.join(output,'errors.log'),errors.join('\n'));throw error;}finally{await browser?.close();await server.close();}
