import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/static-shadows');
const harness = `
import { AssetContainer, Engine, EngineInstrumentation, Scene, FreeCamera, Vector3, Color3, Matrix,
  MeshBuilder, PBRMaterial, StandardMaterial, HemisphericLight, RawTexture } from '@babylonjs/core';
import { SceneEnvironmentRuntime } from '/src/runtime/babylon/SceneEnvironmentRuntime.ts';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
import { bakeEnvironmentShadows } from '/src/runtime/babylon/EnvironmentShadowBake.ts';
import { DEFAULT_SCENE_SHADOW_SETTINGS, createEmptySceneDocument } from '/src/editor/model/SceneDocument.ts';
import { getSceneShadowBakeSignature } from '/src/editor/model/sceneShadowBake.ts';
import { serializeScene, deserializeScene } from '/src/editor/project/SceneSerializer.ts';
const engine = new Engine(document.querySelector('canvas'), false, {preserveDrawingBuffer:true,stencil:true});
window.checkStaticShadows = async (kind) => {
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(10,12,-15),scene);camera.setTarget(Vector3.Zero());
  new HemisphericLight('EditorLight',Vector3.Up(),scene);
  const shadows = new SceneShadowRuntime(scene);
  const floor = MeshBuilder.CreateGround('floor',{width:20,height:20},scene);
  const material = kind.startsWith('pbr') ? new PBRMaterial('floor',scene) : new StandardMaterial('floor',scene);
  const bytes = new Uint8Array(512*512*4);
  for(let i=0;i<512*512;i++){ const color = (Math.floor(i%512/64)+Math.floor(i/512/64))%2 ? 150:190;bytes.set([color,color,color,255],i*4); }
  const sourceTexture = RawTexture.CreateRGBATexture(bytes,512,512,scene,false,false); sourceTexture.gammaSpace=true;
  if(kind.includes('tiled')){sourceTexture.uScale=128;sourceTexture.vScale=128;}
  if(kind.startsWith('pbr')){material.albedoTexture=sourceTexture;material.albedoColor.set(0.8,0.8,0.8);material.metallic=0;material.roughness=1;}
  else {material.diffuseTexture=sourceTexture;material.diffuseColor.set(0.8,0.8,0.8);}
  floor.material=material;
  const container = new AssetContainer(scene);container.meshes.push(floor);container.materials.push(material);container.rootNodes.push(floor);container.removeAllFromScene();
  const environment = {packagePath:'C:/fixture/environment',lengthUnit:'meter',unitScaleToMeters:1,placementMode:'scene-base',visible:true,opacity:1,
    transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:1},activeVariantUrl:'editor-asset://local/environment.glb',
    variants:[{name:'environment',sourcePath:'C:/fixture/environment.glb',sourceUrl:'editor-asset://local/environment.glb'}]};
  const runtime = new SceneEnvironmentRuntime(scene,{loadAssetContainer:async()=>container,resolveAssetUrl:url=>url});
  const settings={...DEFAULT_SCENE_SHADOW_SETTINGS,mode:'baked',sunElevationDegrees:45};
  const instrumentation=new EngineInstrumentation(engine); instrumentation.captureGPUFrameTime=true;
  const draw=()=>{engine.beginFrame();scene.render();engine.endFrame();};
  const settle=async()=>{for(let i=0;i<20;i++){draw();await new Promise(r=>setTimeout(r,20));}};
  const capture=async()=>{await settle();return Array.from(await engine.readPixels(0,0,256,256));};
  const diff=(a,b)=>{let darker=0,brighter=0;for(let i=0;i<a.length;i+=4){if(b[i]<a[i]-5)darker++;if(b[i]>a[i]+5)brighter++;}return {darker,brighter};};
  const perf=async()=>{const cpu=[],calls=[];let gpu=0;for(let i=0;i<90;i++){await new Promise(requestAnimationFrame);const previous=engine._drawCalls.current;const start=performance.now();draw();cpu.push(performance.now()-start);calls.push(engine._drawCalls.current-previous);gpu=instrumentation.gpuFrameTimeCounter.current;}cpu.sort((a,b)=>a-b);return {cpuMedianMs:cpu[45],cpuP95Ms:cpu[85],gpuLastMs:gpu>0?gpu/1e6:null,drawCalls:Math.max(...calls)};};
  try {
    await runtime.apply(environment,{requestId:'load',autoAlign:false});
    await runtime.syncShadows(settings); shadows.applySettings(settings);
    const cube=MeshBuilder.CreateBox('static-device',{size:2},scene);cube.position.y=1;
    if(kind.endsWith('-instanced')){cube.position.y=0;const matrices=new Float32Array(32);Matrix.Translation(0,1,0).copyToArray(matrices,0);Matrix.Translation(6,1,0).copyToArray(matrices,16);cube.thinInstanceSetBuffer('matrix',matrices,16,true);}
    const dynamic=MeshBuilder.CreateBox('dynamic-device',{size:1},scene);dynamic.position.set(4,0.5,4);
    const baseline=await capture(), baselinePerf=await perf();
    const countsBefore={meshes:scene.meshes.length,vertices:floor.getTotalVertices(),indices:floor.getTotalIndices()};
    const sourceScene=createEmptySceneDocument('static-bake');sourceScene.sceneSettings.environment=environment;sourceScene.sceneSettings.shadows=settings;
    const signature=getSceneShadowBakeSignature(sourceScene);
    const snapshot=await bakeEnvironmentShadows(scene,runtime.getShadowBakeSurfaces(),[floor,cube],settings,signature);
    sourceScene.sceneSettings.shadows={...settings,bake:snapshot};
    const restored=deserializeScene(serializeScene(sourceScene));
    await runtime.syncShadows(restored.sceneSettings.shadows);
    const baked=await capture(), bakedPerf=await perf();
    const difference=diff(baseline,baked);
    const activeMaterial=floor.material;
    const defines=floor.subMeshes[0].materialDefines.toString();
    const noShadowCode=!defines.includes('#define SHADOWS\\n')&&!defines.includes('#define ENVIRONMENT_SHADOW\\n');
    const noGenerator=scene.lights.every(light=>!light.getShadowGenerator());
    const noPlugin=!activeMaterial.pluginManager?.getPlugin('EnvironmentShadow');
    const countsAfter={meshes:scene.meshes.length,vertices:floor.getTotalVertices(),indices:floor.getTotalIndices()};
    window.staticShadowImage=document.querySelector('canvas').toDataURL('image/png');
    await runtime.syncShadows({...settings,enabled:false});
    const disabled=await capture();
    const restoredOriginal=diff(baseline,disabled);
    await runtime.syncShadows({...settings,bake:snapshot});
    await runtime.apply({...environment,opacity:0.4},{requestId:'opacity',autoAlign:false});
    const transparent=await capture();
    const opacityWorks=diff(baked,transparent).darker>100;
    const repeated=await bakeEnvironmentShadows(scene,runtime.getShadowBakeSurfaces(),[floor,cube],settings,signature);
    const repeatMatches=repeated.surfaces[0].dataUrl===snapshot.surfaces[0].dataUrl;
    await runtime.apply(environment,{requestId:'restore-opacity',autoAlign:false});
    dynamic.position.x=6;await settle();
    const noGeneratorAfterMotion=scene.lights.every(light=>!light.getShadowGenerator());
    // 重叠 UV 必须报错，不能生成污染环境颜色的错误纹理。
    const overlap=MeshBuilder.CreateBox('overlapping-uv',{size:1},scene);overlap.material=material;
    let overlapRejected=false;
    try{await bakeEnvironmentShadows(scene,[{key:'overlap',mesh:overlap,material}],[cube],settings,signature);}catch(error){overlapRejected=/UV 重叠|4096/.test(String(error));}
    overlap.dispose();
    return {kind,maskUsed:snapshot.surfaces[0].kind==='shadow-mask',difference,restoredOriginal,noShadowCode,noGenerator,noPlugin,noGeneratorAfterMotion,opacityWorks,repeatMatches,overlapRejected,
      countsBefore,countsAfter,baselinePerf,bakedPerf,bakedTexturePixels:snapshot.surfaces.reduce((n,s)=>n+s.width*s.height,0)};
  }finally{runtime.dispose();shadows.dispose();instrumentation.dispose();sourceTexture.dispose();scene.dispose();}
};
window.disposeStaticFixture=()=>engine.dispose();
`;
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:['@babylonjs/core']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
  name:'static-shadows-fixture',resolveId(id){if(id==='/__static_shadows__.js')return '\0static-shadows';},load(id){if(id==='\0static-shadows')return harness;},
  configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return;}if(req.url!=='/__static_shadows__')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__static_shadows__.js"></script>');});},
}]});
let browser;const errors=[];
try{
  await server.listen();browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(server.resolvedUrls.local[0]+'__static_shadows__',{waitUntil:'commit'});
  await page.waitForFunction(()=>typeof window.checkStaticShadows==='function',null,{timeout:180000});
  for(const kind of ['pbr','standard','pbr-tiled','standard-tiled','pbr-tiled-instanced']){
    let result;
    try{result=await page.evaluate(kind=>window.checkStaticShadows(kind),kind);}catch(error){await writeFile(path.join(output,'errors.log'),errors.join('\n'));throw error;}
    console.log(JSON.stringify(result));await writeFile(path.join(output,kind+'.json'),JSON.stringify(result,null,2));
    const image=await page.evaluate(()=>window.staticShadowImage);await writeFile(path.join(output,kind+'.png'),Buffer.from(image.split(',')[1],'base64'));
    if(errors.length){await writeFile(path.join(output,'errors.log'),errors.join('\n'));throw new Error(errors.filter(v=>/SHADER ERROR|Offending|Failed to load/.test(v)).join('\n').slice(0,3000));}
    assert.ok(result.difference.darker>30,kind+': 必须实际显示静态阴影');
    if(kind.endsWith('-instanced'))assert.ok(result.difference.darker>800,'矩阵实例的两个设备都必须投射阴影');
    assert.ok(result.difference.brighter<20,kind+': 烘焙不能改变未遮挡区域原色');
    assert.deepEqual(result.restoredOriginal,{darker:0,brighter:0},kind+': 关闭阴影恢复原色');
    assert.deepEqual(result.countsAfter,result.countsBefore,kind+': 不增加几何或绘制对象');
    assert.equal(result.bakedPerf.drawCalls,result.baselinePerf.drawCalls,kind+': 不增加每帧绘制次数');
    assert.equal(result.maskUsed,kind.includes('tiled'),kind+': 平铺UV采用静态遮罩且保留原纹理');
    for(const key of ['noShadowCode','noGenerator','noPlugin','noGeneratorAfterMotion','opacityWorks','repeatMatches','overlapRejected'])assert.equal(result[key],true,kind+'/'+key);
  }
  await page.evaluate(()=>window.disposeStaticFixture());
}finally{await browser?.close();await server.close();}
