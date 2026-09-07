import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output=path.resolve('output/playwright/static-shadow-ui');
const binary=Buffer.concat([
  Buffer.from(new Float32Array([-10,0,-10,10,0,-10,10,0,10,-10,0,10]).buffer),
  Buffer.from(new Float32Array([0,1,0,0,1,0,0,1,0,0,1,0]).buffer),
  Buffer.from(new Float32Array([-155,-155,155,-155,155,155,-155,155]).buffer),
  Buffer.from(new Uint16Array([0,2,1,0,3,2]).buffer),
]);
const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'Floor'}],meshes:[{name:'Floor',primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],materials:[{name:'FloorMaterial',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.6,0.6,0.6,1],metallicFactor:0,roughnessFactor:1}}],buffers:[{byteLength:binary.length,uri:'data:application/octet-stream;base64,'+binary.toString('base64')}],bufferViews:[{buffer:0,byteOffset:0,byteLength:48},{buffer:0,byteOffset:48,byteLength:48},{buffer:0,byteOffset:96,byteLength:32},{buffer:0,byteOffset:128,byteLength:12}],accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-10,0,-10],max:[10,0,10]},{bufferView:1,componentType:5126,count:4,type:'VEC3'},{bufferView:2,componentType:5126,count:4,type:'VEC2'},{bufferView:3,componentType:5123,count:6,type:'SCALAR'}]};
const jsonBytes=Buffer.from(JSON.stringify(gltf));
const jsonChunk=Buffer.alloc(Math.ceil(jsonBytes.length/4)*4,0x20);jsonBytes.copy(jsonChunk);
const glb=Buffer.alloc(20+jsonChunk.length);glb.writeUInt32LE(0x46546c67,0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(jsonChunk.length,12);glb.writeUInt32LE(0x4e4f534a,16);jsonChunk.copy(glb,20);
const harness=`
import React from 'react';import{createRoot}from'react-dom/client';
import{SceneViewPanel}from'/src/editor/panels/SceneViewPanel.tsx';
import{SceneSettingsPanel}from'/src/editor/panels/SceneSettingsPanel.tsx';
import{useEditorStore}from'/src/editor/store/editorStore.ts';
import{createEmptySceneDocument,createMeshEntity,sanitizeSceneEnvironment}from'/src/editor/model/SceneDocument.ts';
import{serializeScene}from'/src/editor/project/SceneSerializer.ts';
import{installDeploymentAssetManifest}from'/src/runtime/assets/editorAssetUrl.ts';
import{EngineStore}from'@babylonjs/core';
import'/src/styles/global.css';
const environmentUrl='editor-asset://local/C%3A%2Ffixture%2Ffloor.glb';
installDeploymentAssetManifest({[environmentUrl]:location.origin+'/fixture.glb'});
const scene=createEmptySceneDocument('静态阴影界面验证');
scene.sceneSettings.shadows.sunAzimuthDegrees=225;scene.sceneSettings.shadows.sunElevationDegrees=35;
const cube=createMeshEntity('cube',{x:0,y:1,z:0});cube.components.transform.scale={x:2,y:2,z:2};scene.entities[cube.id]=cube;scene.entityIds.push(cube.id);
scene.sceneSettings.environment=sanitizeSceneEnvironment({packagePath:'C:/fixture/environment',activeVariantUrl:environmentUrl,variants:[{name:'floor',sourcePath:'C:/fixture/floor.glb',sourceUrl:environmentUrl}],placementMode:'scene-base',lengthUnit:'meter',unitScaleToMeters:1,visible:true,opacity:1,transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:1}});
if(!scene.sceneSettings.environment)throw new Error('环境测试配置未通过校验');
useEditorStore.getState().loadSceneFromContent(serializeScene(scene),'fixture.scene.json');
window.bakeUiStore=useEditorStore;window.bakeUiEntityId=cube.id;
window.bakeUiEngine=()=>EngineStore.Instances.find(engine=>engine.scenes.some(scene=>scene.meshes.some(mesh=>mesh.metadata?.editorEnvironmentMesh)));
const root=createRoot(document.getElementById('root'));
root.render(React.createElement('div',{style:{display:'grid',gridTemplateColumns:'minmax(0,1fr) 390px',height:'850px',gap:'10px'}},
React.createElement(SceneViewPanel,{performanceHudVisible:true}),React.createElement('aside',{style:{overflow:'auto',padding:'12px'}},React.createElement(SceneSettingsPanel,{}))));
window.disposeBakeUi=()=>root.unmount();
`;
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{include:['@babylonjs/core','react','react-dom/client','react/jsx-runtime','zustand','mqtt','@linkiez/dxf-renew']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'bake-ui-fixture',resolveId(id){if(id==='/__bake_ui__.js')return'\0bake-ui';},load(id){if(id==='\0bake-ui')return harness;},configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url==='/fixture.glb'){res.setHeader('Content-Type','model/gltf-binary');res.end(glb);return;}if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return;}if(req.url!=='/__bake_ui__')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script type="module" src="/__bake_ui__.js"></script>');});}}]});
let browser,page;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(server.resolvedUrls.local[0]+'__bake_ui__',{waitUntil:'commit'});
 await page.waitForFunction(()=>window.bakeUiStore?.getState().environmentRuntimeSnapshot.phase==='ready',null,{timeout:180000});
 const mode=page.getByRole('combobox').filter({has:page.locator('option[value="baked"]')});
 assert.equal(await mode.inputValue(),'baked');
 await page.evaluate(()=>{
   const store=window.bakeUiStore,state=store.getState(),id=window.bakeUiEntityId;
   store.setState({scene:{...state.scene,entities:{...state.scene.entities,[id]:{...state.scene.entities[id],components:{...state.scene.entities[id].components,telemetryBinding:{enabled:true}}}}}});
 });
 await page.getByRole('button',{name:'更新阴影',exact:true}).click();
 await page.waitForFunction(()=>window.bakeUiStore.getState().shadowBakeStatus.phase!=='baking',null,{timeout:90000});
 let state=await page.evaluate(()=>({status:window.bakeUiStore.getState().shadowBakeStatus,baked:!!window.bakeUiStore.getState().scene.sceneSettings.shadows.bake}));
 assert.equal(state.baked,true,JSON.stringify(state));
 const textureUrl=await page.evaluate(()=>window.bakeUiStore.getState().scene.sceneSettings.shadows.bake.surfaces[0].dataUrl);
 await writeFile(path.join(output,'baked-texture.png'),Buffer.from(textureUrl.split(',')[1],'base64'));
 const textureRange=await page.evaluate(async()=>{const url=window.bakeUiStore.getState().scene.sceneSettings.shadows.bake.surfaces[0].dataUrl;const img=new Image();img.src=url;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,img.width,img.height).data;let min=255,max=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]){min=Math.min(min,pixels[i]);max=Math.max(max,pixels[i]);}return{min,max};});
 assert.ok(textureRange.max-textureRange.min>30,'实际SceneRuntime必须把静态设备阴影写入纹理：'+JSON.stringify(textureRange));
 await page.waitForFunction(()=>{const engine=window.bakeUiEngine();return engine?.getFps()>55&&engine.scenes.some(scene=>scene.meshes.some(mesh=>mesh.material?.name.endsWith('-static-shadow')&&mesh.material.isReady(mesh)));},null,{timeout:15000});
 await page.evaluate(()=>new Promise(resolve=>{let frames=0;const next=()=>++frames>=120?resolve():requestAnimationFrame(next);requestAnimationFrame(next);}));
 await page.screenshot({path:path.join(output,'baked.png'),fullPage:true});
 await page.evaluate(()=>{const store=window.bakeUiStore;store.getState().updateShadowSettings({sunAzimuthDegrees:100});});
 await page.getByText('已过期',{exact:true}).waitFor();
 await mode.selectOption('realtime');
 await page.getByRole('combobox').filter({has:page.locator('option[value="quality"]')}).waitFor();
 await mode.selectOption('baked');
 await page.getByRole('button',{name:'更新阴影',exact:true}).click();
 await page.waitForFunction(()=>window.bakeUiStore.getState().shadowBakeStatus.phase!=='baking',null,{timeout:90000});
 state=await page.evaluate(()=>({status:window.bakeUiStore.getState().shadowBakeStatus,baked:!!window.bakeUiStore.getState().scene.sceneSettings.shadows.bake}));
 assert.equal(state.status.phase,'idle',JSON.stringify(state));
 await page.evaluate(()=>window.bakeUiStore.setState(current=>({scene:{...current.scene,entityIds:[],entities:{}}})));
 await page.getByRole('button',{name:'更新阴影',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'没有可参与烘焙的可见模型'}).waitFor();
 await page.getByText('更新失败',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('真实设置面板、平铺UV环境、更新阴影、过期提示、模式切换、无投射物错误反馈均通过。');
 await page.evaluate(()=>window.disposeBakeUi());
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});await writeFile(path.join(output,'errors.log'),errors.join('\n'));throw error;}finally{await browser?.close();await server.close();}
