import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/multilevel-static-shadows');
const harness = `
import {AssetContainer,Engine,Scene,FreeCamera,Vector3,MeshBuilder,PBRMaterial,RawTexture,HemisphericLight} from '@babylonjs/core';
import {SceneEnvironmentRuntime} from '/src/runtime/babylon/SceneEnvironmentRuntime.ts';
import {bakeEnvironmentShadows} from '/src/runtime/babylon/EnvironmentShadowBake.ts';
import {createEmptySceneDocument,DEFAULT_SCENE_SHADOW_SETTINGS} from '/src/editor/model/SceneDocument.ts';
import {getSceneShadowBakeSignature} from '/src/editor/model/sceneShadowBake.ts';
import {serializeScene,deserializeScene} from '/src/editor/project/SceneSerializer.ts';
const engine=new Engine(document.querySelector('canvas'),false,{preserveDrawingBuffer:true});
window.checkMultilevel=async()=>{
 const scene=new Scene(engine),camera=new FreeCamera('camera',new Vector3(0,18,-22),scene);camera.setTarget(new Vector3(0,2,0));
 new HemisphericLight('EditorLight',Vector3.Up(),scene);
 const lower=MeshBuilder.CreateGround('lower',{width:20,height:20},scene),upper=MeshBuilder.CreateGround('upper',{width:20,height:20},scene);upper.position.y=4;
 const material=new PBRMaterial('shared-floor',scene);
 const pixels=new Uint8Array(64*64*4).fill(180);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
 const texture=RawTexture.CreateRGBATexture(pixels,64,64,scene,false,false);texture.uScale=128;texture.vScale=128;material.albedoTexture=texture;
 lower.material=material;upper.material=material;
 const container=new AssetContainer(scene);container.meshes.push(lower,upper);container.materials.push(material);container.rootNodes.push(lower,upper);container.removeAllFromScene();
 const environment={packagePath:'C:/fixture',lengthUnit:'meter',unitScaleToMeters:1,placementMode:'scene-base',visible:true,opacity:1,transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:1},activeVariantUrl:'editor-asset://local/floors.glb',variants:[{name:'floors',sourcePath:'C:/fixture/floors.glb',sourceUrl:'editor-asset://local/floors.glb'}]};
 const runtime=new SceneEnvironmentRuntime(scene,{loadAssetContainer:async()=>container,resolveAssetUrl:url=>url});
 const settings={...DEFAULT_SCENE_SHADOW_SETTINGS,mode:'baked',sunElevationDegrees:45,sunAzimuthDegrees:90};
 const draw=()=>{engine.beginFrame();scene.render();engine.endFrame();};
 const settle=async()=>{for(let i=0;i<20;i++){draw();await new Promise(r=>setTimeout(r,20));}};
 try{
  await runtime.apply(environment,{requestId:'load',autoAlign:false});await runtime.syncShadows(settings);
  const a=MeshBuilder.CreateBox('lower-device',{size:2},scene);a.position.set(-4,1,0);
  const b=MeshBuilder.CreateBox('upper-device',{size:2},scene);b.position.set(4,5,0);await settle();
  const source=createEmptySceneDocument('multilevel');source.sceneSettings.environment=environment;source.sceneSettings.shadows=settings;
  const snapshot=await bakeEnvironmentShadows(scene,runtime.getShadowBakeSurfaces(),[a,b],settings,getSceneShadowBakeSignature(source));
  source.sceneSettings.shadows.bake=snapshot;const restored=deserializeScene(serializeScene(source));
  await runtime.syncShadows(restored.sceneSettings.shadows);await settle();
  const image=new Image();image.src=snapshot.surfaces.find(surface=>surface.dataUrl).dataUrl;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,image.width,image.height).data;
  const sample=(surface,x,z)=>{const box=surface.uvBounds;const u=(x-box[0])/(box[2]-box[0]),v=(z-box[1])/(box[3]-box[1]);return data[(Math.floor(v*image.height)*image.width+Math.floor(u*image.width))*4];};
  const bottom=snapshot.surfaces.find(surface=>surface.key.endsWith(':lower')),top=snapshot.surfaces.find(surface=>surface.key.endsWith(':upper'));
  const result={surfaces:snapshot.surfaces.length,uniquePng:snapshot.surfaces.filter(surface=>surface.dataUrl).length,pixels:image.width*image.height,sharedMaterial:lower.material===upper.material,originalTexture:lower.material.albedoTexture===texture,noGenerator:scene.lights.every(light=>!light.getShadowGenerator()),lowerShadow:sample(bottom,-5.5,0),upperAtLowerShadow:sample(top,-5.5,0),upperShadow:sample(top,2.5,0),differentProjection:JSON.stringify(bottom.uvBounds)!==JSON.stringify(top.uvBounds)};
  window.multilevelAtlas=image.src;
  await runtime.syncShadows({...settings,enabled:false});result.originalRestored=lower.material===material&&upper.material===material;
  return result;
 }finally{runtime.dispose();texture.dispose();scene.dispose();engine.dispose();}
};
`;
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:['@babylonjs/core']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'multilevel-shadows',resolveId(id){if(id==='/__multilevel__.js')return'\0multilevel-shadows';},load(id){if(id==='\0multilevel-shadows')return harness;},configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return;}if(req.url!=='/__multilevel__')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__multilevel__.js"></script>');});}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(server.resolvedUrls.local[0]+'__multilevel__',{waitUntil:'commit'});await page.waitForFunction(()=>typeof window.checkMultilevel==='function',null,{timeout:180000});
 const result=await page.evaluate(()=>window.checkMultilevel());console.log(JSON.stringify(result));await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
 const atlas=await page.evaluate(()=>window.multilevelAtlas);await writeFile(path.join(output,'atlas.png'),Buffer.from(atlas.split(',')[1],'base64'));
 assert.equal(result.surfaces,2);assert.equal(result.uniquePng,1);assert.ok(result.pixels<=16*1024*1024);
 for(const key of ['sharedMaterial','originalTexture','noGenerator','differentProjection','originalRestored'])assert.equal(result[key],true,key);
 assert.ok(result.lowerShadow<200,'下层设备必须投射到下层地面');assert.ok(result.upperAtLowerShadow>245,'下层设备的阴影不得贴到上层');assert.ok(result.upperShadow<200,'上层设备必须投射到上层地面');
 if(errors.length)throw new Error(errors.filter(error=>/SHADER ERROR|Offending/.test(error)).join('\n').slice(0,3000));
}finally{await browser?.close();await server.close();}
