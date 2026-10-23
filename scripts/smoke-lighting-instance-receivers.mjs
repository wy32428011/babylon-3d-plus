import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/lighting-instance-receivers');
const harness = `
import {
  Color3, DirectionalLight, Engine, FreeCamera, InstancedMesh, Matrix, MeshBuilder, PBRMaterial,
  RawTexture, Scene, Texture, Vector3, VertexBuffer,
} from '@babylonjs/core';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
import { SceneLightingRuntime } from '/src/runtime/babylon/SceneLightingRuntime.ts';
import { EntityArrayThinInstanceBatch } from '/src/runtime/babylon/EntityArrayThinInstanceBatch.ts';
import { createLightingTextureCapture } from '/src/runtime/babylon/lightingGeometry.ts';
import { getLightingGeometrySignature } from '/src/runtime/babylon/lightingRuntimeCapture.ts';
import { getSceneLightingBakeSignature } from '/electron/shared/sceneLightingBakeContract.ts';
globalThis.runInstanceReceiverCase = async ({kind,gi,mobilityCase=false}) => {
  const canvas=globalThis.document.querySelector('canvas'),engine=new Engine(canvas,false,{preserveDrawingBuffer:true});
  const scene=new Scene(engine);scene.clearColor.set(0.08,0.08,0.08,1);
  const camera=new FreeCamera('camera',new Vector3(0,12,-13),scene);camera.setTarget(Vector3.Zero());
  const sun=new DirectionalLight('sun',new Vector3(0.35,-1,0.2).normalize(),scene);
  sun.position.set(-5,12,-4);sun.intensity=2;
  const material=new PBRMaterial('surface',scene);material.albedoColor.set(0.65,0.65,0.65);
  material.metallic=0;material.roughness=0.9;material.emissiveColor.set(0.02,0.02,0.02);
  const left=mobilityCase?MeshBuilder.CreateBox('left',{width:1.5,height:2,depth:1.5},scene)
    :MeshBuilder.CreateGround('left',{width:5,height:5},scene);left.material=material;
  let right,batch;
  if(kind==='native')right=left.createInstance('right');
  else if(kind==='array'){
    batch=EntityArrayThinInstanceBatch.create('floor-source',[left],{interactive:true});
    batch.updateEntityTransforms(Matrix.Identity(),[-3,3].map((x,i)=>({entityId:'receiver-'+i,pickable:true,transform:{
      position:{x,y:mobilityCase?1:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},
    }})));
  }else{right=MeshBuilder.CreateGround('right',{width:5,height:5},scene);right.material=material;}
  if(right){left.position.set(-3,mobilityCase?1:0,0);right.position.set(3,mobilityCase?1:0,0);}
  const casters=[-3,3].map((x,i)=>{
    const mesh=mobilityCase?MeshBuilder.CreateGround('caster-'+i,{width:5,height:5},scene)
      :MeshBuilder.CreateBox('caster-'+i,{width:1.5,height:2,depth:1.5},scene);
    mesh.position.set(x,mobilityCase?0:1,0);mesh.material=material;return mesh;
  });
  const entities={},sources=[];
  const add=(mesh,id,mobility,instance)=>{
    const entity={id,name:id,parentId:null,childrenIds:[],components:{meshRenderer:{type:'box'},lighting:{mobility},
      transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}}};
    entities[id]=entity;
    sources.push({mesh,entry:{key:id+'/$mesh',entityId:id,nodeKey:'$mesh',name:id,mobility,reason:'test',
      castShadows:id.startsWith('caster'),receiveShadows:true,bakeIndirect:mobility==='static',parentDynamic:false},
      ...(instance?{instance}:{}),
      getWorldMatrix:()=>instance?batch.getLightingInstanceWorldMatrix(instance.mesh,instance.sourceIndex):mesh.computeWorldMatrix(true)});
  };
  if(batch)for(const value of batch.getLightingInstances())add(value.mesh,value.entityId,'dynamic',{batch,mesh:value.mesh,sourceIndex:value.sourceIndex});
  else{add(left,'receiver-0','dynamic');add(right,'receiver-1','dynamic');}
  add(casters[0],'caster-0','static');add(casters[1],'caster-1','dynamic');
  if(mobilityCase){sources[0].entry.mobility='static';for(const source of sources)source.entry.castShadows=true;}
  const document={name:'instance-receivers',entities,entityIds:Object.keys(entities),sceneSettings:{
    shadows:{enabled:true,mode:'hybrid',quality:'balanced',darkness:0,catcherEnabled:false,sunAzimuthDegrees:56,
      sunElevationDegrees:63,sunIntensity:0,distanceMeters:45,bias:0.002,normalBias:0.03,fillIntensity:0,iblIntensityMax:1},
    environment:null,skybox:null,lightingBake:{enabled:true,quality:'preview',atlasSize:1024,texelsPerMeter:8,
      probeSpacing:5,maxTextureMiB:16,cacheStaticShadows:true,dynamicShadows:true},
  }};
  const shadows=new SceneShadowRuntime(scene);shadows.syncLight('sun',sun);shadows.applySettings(document.sceneSettings.shadows);
  let currentRoles=new Map();
  const logs=[],runtime=new SceneLightingRuntime(scene,{getSources:()=>sources,
    setShadowRoles:(roles,settings)=>{currentRoles=roles;shadows.setHybridMeshRoles(roles,settings);},pushLog:message=>logs.push(message)});
  runtime.sync(document);
  const upload=async(id,kind,data)=>{
    const bytes=kind==='lightmap'?data:new TextEncoder().encode(JSON.stringify(data));
    const url=location.origin+'/asset/'+crypto.randomUUID();
    await fetch(url,{method:'PUT',headers:{'content-type':kind==='lightmap'?'image/png':'application/json'},body:bytes});
    return{id,kind,url,byteLength:bytes.byteLength};
  };
  const frame=async()=>{
    for(let i=0;i<8;i++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(r=>setTimeout(r,12));}
    await scene.whenReadyAsync();
    await Promise.all(scene.meshes.filter(m=>m.isEnabled()&&m.layerMask!==0&&m.material&&! (m instanceof InstancedMesh))
      .map(m=>m.material.forceCompilationAsync(m)));
    for(let i=0;i<4;i++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(r=>setTimeout(r,12));}
    return Array.from(await engine.readPixels(0,0,640,400));
  };
  const images={},states={};let transition=null;
  const capture=async name=>{
    const pixels=await frame();images[name]=canvas.toDataURL('image/png');
    states[name]=sources.filter(s=>s.entry.entityId.startsWith('receiver')).map(s=>({
      id:s.entry.entityId,requested:s.entry.receiveShadows,actual:s.mesh.receiveShadows,
      selected:runtime.getSelectionMeshes(s.entry.entityId).map(m=>({name:m.name,receiveShadows:m.receiveShadows})),
      bindings:runtime.state?.records.filter(r=>r.source.entry.entityId===s.entry.entityId)
        .map(r=>({proxy:r.proxy,probes:!!r.binding.probes,receiveShadows:r.mesh.receiveShadows}))??[],
    }));
    return pixels;
  };
  const set=(a,b)=>{
    sources.find(s=>s.entry.entityId==='receiver-0').entry.receiveShadows=a;
    sources.find(s=>s.entry.entityId==='receiver-1').entry.receiveShadows=b;
    runtime.markDirty();
  };
  const diff=(a,b,x)=>{
    const viewport=camera.viewport.toGlobal(640,400);
    const points=[[-2.4,-2.4],[-2.4,2.4],[2.4,-2.4],[2.4,2.4]].map(([dx,z])=>
      Vector3.Project(new Vector3(x+dx,0,z),Matrix.Identity(),scene.getTransformMatrix(),viewport));
    const minX=Math.max(0,Math.ceil(Math.min(...points.map(p=>p.x)))),maxX=Math.min(639,Math.floor(Math.max(...points.map(p=>p.x))));
    const minY=Math.max(0,Math.ceil(Math.min(...points.map(p=>p.y)))),maxY=Math.min(399,Math.floor(Math.max(...points.map(p=>p.y))));
    let pixels=0,brighter=0,max=0;
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      const i=((399-y)*640+x)*4,d=Math.abs(a[i]-b[i]);max=Math.max(max,d);if(d>3)pixels++;if(b[i]-a[i]>8)brighter++;
    }
    return{pixels,brighter,max};
  };
  try{
    if(mobilityCase){
      const baseline=await capture('mobility-initial'),before=shadows.getHybridMetrics();
      if(batch)batch.updateEntityTransforms(Matrix.Identity(),[-3,3].map((x,i)=>({entityId:'receiver-'+i,pickable:true,transform:{
        position:{x,y:1,z:i?1.5:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},
      }})));
      else right.position.z+=1.5;
      const cached=await capture('mobility-dynamic-moved'),after=shadows.getHybridMetrics();
      shadows.setHybridMeshRoles(currentRoles,{cacheStaticShadows:false});
      const uncached=await capture('mobility-uncached');
      let mismatch=0,moved=0,max=0;
      for(let i=0;i<cached.length;i+=4){
        const d=Math.max(Math.abs(cached[i]-uncached[i]),Math.abs(cached[i+1]-uncached[i+1]),Math.abs(cached[i+2]-uncached[i+2]));
        max=Math.max(max,d);if(d>2)mismatch++;if(Math.abs(baseline[i]-cached[i])>8)moved++;
      }
      return{kind,gi:false,mobilityCase:true,renderer:engine.getGlInfo().renderer,error:runtime.getError(),logs,images,before,after,mismatch,max,moved};
    }
    if(gi){
      const mesh=casters[0],geometry={version:1,positions:Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)),
        normals:Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)),indices:Array.from(mesh.getIndices()),
        uvs:Array.from(mesh.getVerticesData(VertexBuffer.UVKind)),bakeUvs:Array.from(mesh.getVerticesData(VertexBuffer.UVKind))};
      const raw=RawTexture.CreateRGBATexture(new Uint8Array([0,0,0,255]),1,1,scene,false,false,Texture.NEAREST_SAMPLINGMODE);
      raw.gammaSpace=false;const png=await createLightingTextureCapture()(raw);raw.dispose();
      const assets=await Promise.all([upload('geometry','geometry',geometry),upload('lightmap','lightmap',Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0))),
        upload('probes','probes',{version:1,encoding:'ambient-cube',spacing:5,probes:[-3,3].map(x=>({position:[x,0.1,-1],irradiance:Array(18).fill(0.05)}))})]);
      assets[1].rgbmRange=1;
      const snapshot={version:1,signature:getSceneLightingBakeSignature(document),geometrySignature:getLightingGeometrySignature(sources),
        createdAt:new Date().toISOString(),engineVersion:'instance-receiver-test',probeAssetId:'probes',assets,
        surfaces:[{key:'caster-0/$mesh/primitive:0',entityId:'caster-0',nodeKey:'$mesh',geometryAssetId:'geometry',lightmapAssetId:'lightmap'}],
        statistics:{meshCount:1,triangleCount:12,atlasCount:1,probeCount:2,textureBytes:4,durationMs:1}};
      set(true,false);
      const beforeTransition=await capture('before-gi-transition');
      let candidateMasks=[],candidatePickable=true;
      try{
        await runtime.applySnapshot(snapshot,undefined,async()=>{
          await capture('staged-gi-transition');
          candidateMasks=runtime.getSelectionMeshes('receiver-1').map(m=>m.layerMask);
          candidatePickable=runtime.getSelectionMeshes('receiver-1').every(m=>m.isPickable);
          throw new Error('intentional-late-transition-cancel');
        });
      }catch(error){if(!String(error).includes('intentional-late-transition-cancel'))throw error;}
      const rolledBack=await capture('rolled-back-transition');
      transition={candidateMasks,candidatePickable,rollbackMasks:runtime.getSelectionMeshes('receiver-1').map(m=>m.layerMask),
        rollbackPickable:runtime.getSelectionMeshes('receiver-1').every(m=>m.isPickable),
        left:diff(beforeTransition,rolledBack,-3),right:diff(beforeTransition,rolledBack,3)};
      await runtime.applySnapshot(snapshot);
      transition.committedMasks=runtime.getSelectionMeshes('receiver-1').map(m=>m.layerMask);
      transition.committedPickable=runtime.getSelectionMeshes('receiver-1').every(m=>m.isPickable);
      set(true,true);
    }
    const both=await capture('both-on');
    set(true,false);const rightOff=await capture('right-off');
    set(false,true);const leftOff=await capture('left-off');
    set(false,false);const neither=await capture('both-off');
    return{kind,gi,renderer:engine.getGlInfo().renderer,error:runtime.getError(),logs,images,states,transition,
      rightToggle:{left:diff(both,rightOff,-3),right:diff(both,rightOff,3)},
      leftToggle:{left:diff(both,leftOff,-3),right:diff(both,leftOff,3)},
      allToggle:{left:diff(both,neither,-3),right:diff(both,neither,3)}};
  }finally{runtime.dispose();shadows.dispose();batch?.dispose();scene.dispose();engine.dispose();}
};
`;
const bundle=await build({configFile:false,logLevel:'warn',build:{write:false,minify:false,rollupOptions:{
  input:'/__instance_receivers__.js',output:{codeSplitting:false},
}},plugins:[{name:'instance-receiver-fixture',resolveId(id){if(id==='/__instance_receivers__.js')return '\0instance-receiver-fixture';
  if(id.startsWith('/src/')||id.startsWith('/electron/'))return path.resolve(id.slice(1));},load(id){if(id==='\0instance-receiver-fixture')return harness;}}]});
const entry=bundle.output.find(item=>item.type==='chunk'&&item.isEntry);assert.ok(entry);
const assets=new Map();
const server=createServer((request,response)=>{
  if(request.url.startsWith('/asset/')){
    if(request.method==='PUT'){const chunks=[];request.on('data',c=>chunks.push(c));request.on('end',()=>{
      assets.set(request.url,{bytes:Buffer.concat(chunks),type:request.headers['content-type']});response.writeHead(204).end();});return;}
    const asset=assets.get(request.url);if(!asset){response.writeHead(404).end();return;}response.setHeader('Content-Type',asset.type);response.end(asset.bytes);return;
  }
  if(request.url==='/favicon.ico'){response.writeHead(204).end();return;}
  if(request.url==='/__instance_receivers__.js'){response.setHeader('Content-Type','text/javascript');response.end(entry.code);return;}
  response.setHeader('Content-Type','text/html');response.end('<!doctype html><canvas width="640" height="400"></canvas><script type="module" src="/__instance_receivers__.js"></script>');
});
let browser;const errors=[],warnings=[],results=[];
try{
  await mkdir(output,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'commit'});
  await page.waitForFunction(()=>typeof globalThis.runInstanceReceiverCase==='function',null,{timeout:120_000});
  const cases=[...['ordinary','native','array'].flatMap(kind=>[false,true].map(gi=>({kind,gi}))),
    ...['native','array'].map(kind=>({kind,gi:false,mobilityCase:true}))];
  for(const config of cases){
    const {images,...result}=await page.evaluate(c=>globalThis.runInstanceReceiverCase(c),config);results.push(result);
    for(const [name,image]of Object.entries(images))await writeFile(path.join(output,config.kind+'-'+(config.gi?'gi':'baseline')+'-'+name+'.png'),Buffer.from(image.split(',')[1],'base64'));
    await writeFile(path.join(output,'results.json'),JSON.stringify({results,errors,warnings},null,2));
    console.log(JSON.stringify(result));
  }
  assert.deepEqual(errors,[]);
  for(const r of results){
    assert.equal(r.error,null);
    if(r.mobilityCase){
      assert.ok(r.moved>30);assert.equal(r.mismatch,0,JSON.stringify(r));
      assert.equal(r.after.staticRenders,r.before.staticRenders,'动态成员移动不可触发静态深度重画');
      continue;
    }
    assert.ok(r.allToggle.left.brighter>30&&r.allToggle.right.brighter>30,JSON.stringify({kind:r.kind,gi:r.gi,all:r.allToggle}));
    assert.ok(r.rightToggle.right.brighter>30,JSON.stringify({kind:r.kind,gi:r.gi,right:r.rightToggle}));
    assert.equal(r.rightToggle.left.pixels,0,'关闭右实例不得影响左对象');
    assert.ok(r.leftToggle.left.brighter>30,JSON.stringify({kind:r.kind,gi:r.gi,left:r.leftToggle}));
    assert.equal(r.leftToggle.right.pixels,0,'关闭左对象不得影响右实例');
    if(r.gi)assert.ok(r.states['both-on'].find(s=>s.id==='receiver-1').bindings.some(b=>b.probes),'被测右实例必须有有效探针绑定');
    if(r.gi&&r.kind!=='ordinary'){
      assert.ok(r.transition.candidateMasks.length>0&&r.transition.candidateMasks.every(mask=>mask!==0));
      assert.ok(r.transition.rollbackMasks.length>0&&r.transition.rollbackMasks.every(mask=>mask!==0));
      assert.ok(r.transition.committedMasks.length>0&&r.transition.committedMasks.every(mask=>mask!==0));
      assert.equal(r.transition.rollbackPickable,true);
      assert.equal(r.transition.candidatePickable,true);assert.equal(r.transition.committedPickable,true);
      assert.equal(r.transition.left.pixels,0);assert.equal(r.transition.right.pixels,0);
    }
  }
}finally{await browser?.close();await new Promise(r=>server.close(r));}
