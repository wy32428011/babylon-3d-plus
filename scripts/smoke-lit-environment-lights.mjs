import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const out = path.resolve('output/playwright/lit-environment-lights');
const harness = `
import { Camera, Color3, Engine, FreeCamera, HemisphericLight, Light, Matrix, MeshBuilder, PBRMaterial, PointLight, SpotLight, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
const engine = new Engine(document.querySelector('canvas'),false,{preserveDrawingBuffer:true});
window.run = async (kind,falloff,lightKind) => {
 const scene=new Scene(engine), camera=new FreeCamera('camera',new Vector3(0,10,-0.001),scene);
 camera.setTarget(Vector3.Zero()); camera.mode=Camera.ORTHOGRAPHIC_CAMERA;
 camera.orthoLeft=camera.orthoBottom=-10; camera.orthoRight=camera.orthoTop=10;
 const fill=new HemisphericLight('fill',Vector3.Up(),scene); fill.intensity=.2;
 const floor=MeshBuilder.CreateGround('floor',{width:30,height:30},scene); floor.metadata={editorEnvironmentMesh:true};
 const material=kind==='pbr'?new PBRMaterial('floor',scene):new StandardMaterial('floor',scene);
 if(kind==='pbr'){material.albedoColor.set(.6,.6,.6); material.metallic=0; material.roughness=1;}
 else {material.diffuseColor.set(.6,.6,.6); material.specularColor.set(0,0,0);}
 floor.material=material;
 const box=MeshBuilder.CreateBox('box',{size:2},scene); box.position.set(2,1,0);
 // 与现场一致使用零深度偏移；保留法线偏移以隔离平面自阴影。
 const runtime=new SceneShadowRuntime(scene); runtime.applySettings({enabled:true,mode:'realtime',quality:'balanced',darkness:.35,catcherEnabled:false,sunAzimuthDegrees:0,sunElevationDegrees:90,sunIntensity:1,distanceMeters:120,bias:0,normalBias:.03,fillIntensity:.2,iblIntensityMax:.45});
 const capture=async()=>{for(let f=0;f<16;f++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(r=>setTimeout(r,10));}return Array.from(await engine.readPixels(0,0,256,256));};
 const at=(p,x,z)=>{const q=Vector3.Project(new Vector3(x,0,z),Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(256,256));return p[((255-Math.round(q.y))*256+Math.round(q.x))*4];};
 material.freeze(); await capture();
 const local=lightKind==='point' ? new PointLight('local',new Vector3(0,13.5256,0),scene)
   : new SpotLight('local',new Vector3(0,13.5256,0),Vector3.Down(),Math.PI/2,2,scene);
 local.intensity=3;local.range=120;
 if(falloff==='standard')local.falloffType=Light.FALLOFF_STANDARD;
 runtime.syncLight('local',local);
 await capture(); await scene.whenReadyAsync(); const shadow=await capture();
 const index=floor.lightSources.indexOf(local), defines=floor.subMeshes[0].effect.defines;
 const result={lightDefines:defines.split(String.fromCharCode(10)).filter(v=>/LIGHT|SHADOW/.test(v)),kind,falloff,lightKind,frozen:material.isFrozen,index,maxLights:material.maxSimultaneousLights,hasShadow:defines.includes('#define SHADOW'+index)};
 result.shadowImage=document.querySelector('canvas').toDataURL();
 // 只关闭当前点光的投影，避免太阳光/材质刷新干扰像素比较。
 local.getShadowGenerator().setDarkness(1);
 const unshadowed=await capture();
 let changed=0,maxDelta=0;for(let i=0;i<shadow.length;i+=4){const d=unshadowed[i]-shadow[i];if(d>2)changed++;maxDelta=Math.max(maxDelta,d);}
 result.changed=changed;result.maxDelta=maxDelta;result.free=[at(shadow,-3,0),at(unshadowed,-3,0)];result.occluded=[at(shadow,3.25,0),at(unshadowed,3.25,0)];
 result.unshadowedImage=document.querySelector('canvas').toDataURL();
 runtime.dispose();scene.dispose();return result;
};
`;
await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,cacheDir:'node_modules/.vite-lit-environment-lights',optimizeDeps:{noDiscovery:true,include:['@babylonjs/core']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[{name:'lit-probe',resolveId(id){if(id==='/__lit.js')return '\0lit';},load(id){if(id==='\0lit')return harness;},configureServer(v){v.middlewares.use((req,res,next)=>{if(req.url!=='/__lit')return next();res.setHeader('Content-Type','text/html');res.end('<canvas width="256" height="256"></canvas><script type="module" src="/__lit.js"></script>');});}}]});
let browser;
try {
 await server.listen();browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();page.on('pageerror',e=>console.error(e.message));
 await page.goto(server.resolvedUrls.local[0]+'__lit',{waitUntil:'commit'});await page.waitForFunction(()=>typeof window.run==='function',null,{timeout:90000});
 const results=[];
 for(const kind of ['pbr','standard'])for(const lightKind of ['point','spot'])for(const falloff of ['default','standard']){
   const result=await page.evaluate(([k,f,l])=>window.run(k,f,l),[kind,falloff,lightKind]);
   for(const state of ['shadow','unshadowed']){
     await writeFile(path.join(out,kind+'-'+lightKind+'-'+falloff+'-'+state+'.png'),Buffer.from(result[state+'Image'].split(',')[1],'base64'));
     delete result[state+'Image'];
   }
   results.push(result);console.log(JSON.stringify(result));
 }
 await writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));
 assert.ok(results.every(result=>result.hasShadow), '所有材质与局部灯类型都必须编译阴影定义');
 const physical=results.find(result=>result.kind==='pbr'&&result.falloff==='default'&&result.lightKind==='point');
 assert.ok(physical.maxDelta<3, '诊断条件应复现13.5m低强度物理点光的不可见投影');
 for (const standard of results.filter(result=>result.falloff==='standard')) {
   assert.ok(standard.changed>100&&standard.maxDelta>20, standard.kind+'/'+standard.lightKind+': 编辑衰减下地面必须出现可见投影');
   assert.ok(standard.occluded[1]>standard.occluded[0]+20, standard.kind+'/'+standard.lightKind+': 方块外侧真实地面必须出现局部投影');
   assert.ok(Math.abs(standard.free[1]-standard.free[0])<=2, '开关局部投影不能改变未遮挡区域');
 }
} finally {await browser?.close();await server.close();}

