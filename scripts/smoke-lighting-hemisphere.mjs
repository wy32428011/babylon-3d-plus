import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/lighting-hemisphere');
const harness = `
import {
  Color3, Engine, FreeCamera, HemisphericLight, Matrix, MeshBuilder, PBRMaterial, PointLight, RawTexture, Scene,
  StandardMaterial, Texture, Vector3, VertexBuffer,
} from '@babylonjs/core';
import { SceneLightingRuntime } from '/src/runtime/babylon/SceneLightingRuntime.ts';
import { createLightingTextureCapture } from '/src/runtime/babylon/lightingGeometry.ts';
import { getLightingGeometrySignature } from '/src/runtime/babylon/lightingRuntimeCapture.ts';
import { getSceneLightingBakeSignature } from '/electron/shared/sceneLightingBakeContract.ts';
window.checkHemisphericLighting = async ({kind,policy='all',diffuse=false,coating='',lightKind='hemisphere'}) => {
  const canvas=globalThis.document.querySelector('canvas'),engine=new Engine(canvas,false,{preserveDrawingBuffer:true});
  const scene=new Scene(engine);scene.clearColor.set(0,0,0,1);
  const camera=new FreeCamera('camera',new Vector3(0,0,-8),scene);camera.setTarget(Vector3.Zero());
  const hemi=lightKind==='point'?new PointLight('business-light',new Vector3(0,1,-5),scene)
    :new HemisphericLight('business-light',new Vector3(0,0.2,-1).normalize(),scene);
  // PBR 原生高光使用 diffuse RGB 作为入射光；纯金属自身的漫反射为零，仍能隔离高光。
  hemi.diffuse=diffuse?Color3.White():kind==='pbr'?new Color3(1,0.5,0.2):Color3.Black();
  if(hemi instanceof HemisphericLight)hemi.groundColor=diffuse?Color3.White():Color3.Black();
  hemi.specular=diffuse?Color3.Black():new Color3(1,0.5,0.2);hemi.intensity=0.8;
  const fixed=MeshBuilder.CreateSphere('static',{diameter:2,segments:24},scene);fixed.position.x=-1.5;
  const moving=MeshBuilder.CreateSphere('dynamic',{diameter:2,segments:24},scene);moving.position.x=1.5;
  for(const mesh of [fixed,moving]){
    const material=kind==='pbr'?new PBRMaterial(mesh.name,scene):new StandardMaterial(mesh.name,scene);
    if(kind==='pbr'){material.albedoColor.set(0.7,0.6,0.5);material.metallic=diffuse?0:1;material.roughness=0.25;}
    else{material.diffuseColor=diffuse?new Color3(0.7,0.6,0.5):Color3.Black();material.specularColor=diffuse?Color3.Black():Color3.White();material.specularPower=24;}
    mesh.material=material;
    if(coating==='clearcoat'){material.clearCoat.isEnabled=true;material.clearCoat.intensity=1;material.clearCoat.roughness=0.15;}
    if(coating==='sheen'){material.sheen.isEnabled=true;material.sheen.intensity=1;material.sheen.color.set(1,0.3,0.2);material.sheen.roughness=0.3;}
  }
  if(policy==='include-static')hemi.includedOnlyMeshes=[fixed];
  if(policy==='exclude-static')hemi.excludedMeshes=[fixed];
  const originalIncluded=[...hemi.includedOnlyMeshes],originalExcluded=[...hemi.excludedMeshes];
  const entity=(id,mobility)=>({id,name:id,parentId:null,childrenIds:[],components:{
    meshRenderer:{type:'sphere'},lighting:{mobility},transform:{position:{x:id==='fixed'?-1.5:1.5,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},
  }});
  const fixedEntity=entity('fixed','static'),dynamicEntity=entity('moving','dynamic');
  const document={name:'hemi-contract',entities:{fixed:fixedEntity,moving:dynamicEntity},entityIds:['fixed','moving'],sceneSettings:{
    shadows:{mode:'hybrid'},environment:null,skybox:null,lightingBake:{enabled:true,quality:'preview',atlasSize:1024,texelsPerMeter:8,probeSpacing:4,maxTextureMiB:16,cacheStaticShadows:true,dynamicShadows:true},
  }};
  const sources=[[fixed,fixedEntity],[moving,dynamicEntity]].map(([mesh,e])=>({
    mesh,entry:{key:e.id+'/$mesh',entityId:e.id,nodeKey:'$mesh',name:mesh.name,mobility:e.components.lighting.mobility,reason:'test',
      castShadows:true,receiveShadows:true,bakeIndirect:true,parentDynamic:false},getWorldMatrix:()=>mesh.computeWorldMatrix(true),
  }));
  const logs=[],images={},diagnostics={};
  const runtime=new SceneLightingRuntime(scene,{getSources:()=>sources,setShadowRoles:()=>{},pushLog:message=>logs.push(message)});
  runtime.sync(document);
  const frame=async()=>{
    engine.beginFrame();scene.render();engine.endFrame();
    await Promise.all(scene.meshes.filter(mesh=>mesh.isEnabled()&&mesh.layerMask!==0&&mesh.material)
      .map(mesh=>mesh.material.forceCompilationAsync(mesh)));
    await scene.whenReadyAsync();
    for(let i=0;i<4;i++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(r=>setTimeout(r,12));}
  };
  const capture=async label=>{
    await frame();images[label]=canvas.toDataURL('image/png');
    diagnostics[label]=scene.meshes.filter(mesh=>mesh.isEnabled()&&mesh.layerMask!==0).map(mesh=>({
      mesh:mesh.name,lights:mesh.lightSources.map(l=>l.name),specular:mesh.subMeshes[0]?.effect?.defines.includes('#define SPECULARTERM'),
      metal:mesh.material?.metallic,
    }));
    return Array.from(await engine.readPixels(0,0,512,256));
  };
  const sample=(pixels,mesh)=>{
    const screen=Vector3.Project(mesh.getAbsolutePosition(),Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(512,256));
    const offset=((255-Math.floor(screen.y))*512+Math.floor(screen.x))*4;return pixels.slice(offset,offset+3);
  };
  const stats=pixels=>({
    lit:pixels.filter((v,i)=>i%4!==3&&v>12).length,
    sum:pixels.reduce((total,v,i)=>total+(i%4!==3?v:0),0),
    left:sample(pixels,fixed),right:sample(pixels,moving),
  });
  const difference=(a,b)=>{
    let max=0,pixels=0;for(let i=0;i<a.length;i+=4){const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));max=Math.max(max,d);if(d>2)pixels++;}
    return {max,pixels};
  };
  const asset=async(id,kind,bytes)=>{
    const url=location.origin+'/asset/'+crypto.randomUUID()+'-'+id;
    const response=await fetch(url,{method:'PUT',headers:{'content-type':kind==='lightmap'?'image/png':'application/json'},body:bytes});
    if(!response.ok)throw Error('fixture asset upload failed');
    return{id,kind,url,byteLength:bytes.byteLength};
  };
  try{
    const baseline=await capture('baseline');
    const geometry={version:1,positions:Array.from(fixed.getVerticesData(VertexBuffer.PositionKind)),normals:Array.from(fixed.getVerticesData(VertexBuffer.NormalKind)),
      indices:Array.from(fixed.getIndices()),uvs:Array.from(fixed.getVerticesData(VertexBuffer.UVKind)),bakeUvs:Array.from(fixed.getVerticesData(VertexBuffer.UVKind))};
    const raw=RawTexture.CreateRGBATexture(new Uint8Array(diffuse?[0,64,0,128]:[0,0,0,255]),1,1,scene,false,false,Texture.NEAREST_SAMPLINGMODE);
    raw.gammaSpace=false;
    const png=await createLightingTextureCapture()(raw);raw.dispose();
    const pngBytes=Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0));
    const green=diffuse?(64/255)*(128/255)*2:0;
    const probe=Array.from({length:6},()=>[0,green,0]).flat();
    const encoded=value=>new TextEncoder().encode(JSON.stringify(value));
    const assets=await Promise.all([asset('geometry','geometry',encoded(geometry)),asset('lightmap','lightmap',pngBytes),
      asset('probes','probes',encoded({version:1,encoding:'ambient-cube',spacing:4,probes:[{position:[1.5,0,0],irradiance:probe}]}))]);
    assets[1].rgbmRange=diffuse?2:1;
    const snapshot={version:1,signature:getSceneLightingBakeSignature(document),geometrySignature:getLightingGeometrySignature(sources),
      createdAt:new Date().toISOString(),engineVersion:'hemisphere-test',probeAssetId:'probes',
      assets,
      surfaces:[{key:'fixed/$mesh/primitive:0',entityId:'fixed',nodeKey:'$mesh',geometryAssetId:'geometry',lightmapAssetId:'lightmap'}],
      statistics:{meshCount:1,triangleCount:geometry.indices.length/3,atlasCount:1,probeCount:1,textureBytes:4,durationMs:1},
    };
    await runtime.applySnapshot(snapshot);
    const baked=await capture('baked');
    runtime.setPreview(false,true);const before=await capture('before');
    runtime.setPreview(false,false);
    if(!diffuse){
      hemi.specular.set(0.2,0.7,1);
      if(hemi instanceof HemisphericLight)hemi.direction.set(0.2,0.4,-1).normalize();
      if(kind==='standard')hemi.intensity=0.9;
    }
    const updated=await capture('updated');
    runtime.setPreview(false,true);const updatedBefore=await capture('updated-before');
    runtime.setPreview(false,false);
    document.sceneSettings.lightingBake.enabled=false;runtime.sync(document);
    const cleared=await capture('cleared');
    const visibleProxies=scene.meshes.filter(mesh=>mesh.metadata?.lightingDerived&&!mesh.metadata?.editorHelper).length;
    return{kind,policy,diffuse,coating,lightKind,renderer:engine.getGlInfo().renderer,images,logs,diagnostics,error:runtime.getError(),
      baseline:stats(baseline),baked:stats(baked),updated:stats(updated),cleared:stats(cleared),
      initialDifference:difference(baseline,baked),beforeDifference:difference(baseline,before),
      updateDifference:difference(updated,cleared),updatedBeforeDifference:difference(updatedBefore,cleared),
      remainingLights:scene.lights.map(l=>l.name),visibleProxies,
      includedRestored:hemi.includedOnlyMeshes.length===originalIncluded.length&&hemi.includedOnlyMeshes.every((m,i)=>m===originalIncluded[i]),
      excludedRestored:hemi.excludedMeshes.length===originalExcluded.length&&hemi.excludedMeshes.every((m,i)=>m===originalExcluded[i]),
    };
  }finally{runtime.dispose();scene.dispose();engine.dispose();}
};
`;
const bundle=await build({configFile:false,logLevel:'warn',build:{write:false,minify:false,rollupOptions:{
  input:'/__lighting_hemi__.js',output:{codeSplitting:false},
}},plugins:[{name:'hemi-fixture',resolveId(id){if(id==='/__lighting_hemi__.js')return '\0hemi-fixture';if(id.startsWith('/src/')||id.startsWith('/electron/'))return path.resolve(id.slice(1));},
  load(id){if(id==='\0hemi-fixture')return harness;}}]});
const entry=bundle.output.find(item=>item.type==='chunk'&&item.isEntry);assert.ok(entry);
const servedAssets=new Map();
const server=createServer((request,response)=>{
  if(request.url.startsWith('/asset/')){
    if(request.method==='PUT'){
      const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
        servedAssets.set(request.url,{bytes:Buffer.concat(chunks),type:request.headers['content-type']});response.writeHead(204).end();
      });return;
    }
    const asset=servedAssets.get(request.url);if(!asset){response.writeHead(404).end();return;}
    response.setHeader('Content-Type',asset.type);response.end(asset.bytes);return;
  }
  if(request.url==='/favicon.ico'){response.writeHead(204).end();return;}
  if(request.url==='/__lighting_hemi__.js'){response.setHeader('Content-Type','text/javascript');response.end(entry.code);return;}
  response.setHeader('Content-Type','text/html');response.end('<!doctype html><canvas width="512" height="256"></canvas><script type="module" src="/__lighting_hemi__.js"></script>');
});
let browser;const errors=[],results=[];
try{
  await mkdir(output,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
  page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());console.error(message.text());}});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'commit'});
  await page.waitForFunction(()=>typeof globalThis.checkHemisphericLighting==='function',null,{timeout:120_000});
  const cases=process.env.HEMISPHERE_CASE?[JSON.parse(process.env.HEMISPHERE_CASE)]:
    [...['pbr','standard'].flatMap(kind=>[...['all','include-static','exclude-static'].map(policy=>({kind,policy})),{kind,diffuse:true}]),
      ...['clearcoat','sheen'].map(coating=>({kind:'pbr',coating})),
      ...['include-static','exclude-static'].map(policy=>({kind:'pbr',lightKind:'point',policy}))];
  for(const config of cases){
    const {images,...result}=await page.evaluate(config=>globalThis.checkHemisphericLighting(config),config);
    results.push(result);await writeFile(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));
    const prefix=[config.kind,config.lightKind??'hemisphere',config.policy??'all',config.coating||'',config.diffuse?'diffuse':'specular'].filter(Boolean).join('-');
    for(const [name,image]of Object.entries(images))await writeFile(path.join(output,prefix+'-'+name+'.png'),Buffer.from(image.split(',')[1],'base64'));
    console.log(JSON.stringify(result));
    assert.deepEqual(errors,[]);assert.equal(result.error,null);
    assert.ok(result.baseline.lit>100,'原生Hemi参考必须有可见亮度');
    assert.equal(result.beforeDifference.pixels,0,'烘焙前比较必须保持原生Hemi参数和过滤语义');
    assert.equal(result.updatedBeforeDifference.pixels,0,'实时更新后的比较结果必须与清除后的原生结果一致');
    if(!config.diffuse){
      assert.equal(result.initialDifference.pixels,0,'启用GI不得删除原生Hemi高光');
      assert.equal(result.updateDifference.pixels,0,'方向/强度/specular实时更新必须保持');
    }else{
      assert.ok(result.baked.left[1]>12&&result.baked.right[1]>12,'真实PNG RGBM和探针均须产生绿色GI');
      assert.ok(result.baked.left[0]<3&&result.baked.left[2]<3&&result.baked.right[0]<3&&result.baked.right[2]<3,'Hemi漫反射不可重复加入绿色GI');
      assert.ok(Math.abs(result.baked.left[1]-result.baked.right[1])<3,'同值lightmap和probe应一致，排除UV/解码丢失');
    }
    assert.deepEqual(result.remainingLights,['business-light']);assert.equal(result.visibleProxies,0);
    assert.ok(result.includedRestored&&result.excludedRestored);
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
