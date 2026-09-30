import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';
const {app}=electron, require=createRequire(import.meta.url), unzipper=require('unzipper');
const root=await mkdtemp(path.join(tmpdir(),'model-entrance-packages-'));
app.setPath('userData',path.join(root,'user-data'));app.getAppPath=()=>process.cwd();
const controller=new AbortController();
const deadline=setTimeout(()=>{controller.abort();app.exit(1);},120000);
const effects=['fade','scan','dissolve','hologram','particles','assembly','radial','stagger'];
const settings={enabled:true,effect:'scan',durationSeconds:4,delaySeconds:0,color:'#00ccff',intensity:1,axis:'y',reverse:false,
  staggerSeconds:.15,particleCount:600,particleSize:3,spreadMeters:3,assemblyDistanceMeters:1.5,loop:false,loopIntervalSeconds:0,scope:'all',targetEntityIds:[]};
const entities=Object.fromEntries([0,1,2].map(index=>['device-'+index,{id:'device-'+index,name:'设备 '+index,visible:true,locked:false,parentId:null,childrenIds:[],
  components:{transform:{position:{x:(index-1)*3,y:1,z:0},rotation:{x:0,y:0,z:0},scale:{x:2,y:2,z:2}},meshRenderer:{meshKind:'cube',materialColor:'#5596af'}}}]));
const document={version:5,units:{length:'meter'},scene:{id:'model-entrance-package',name:'模型入场验收',entityIds:Object.keys(entities),entities,selectedEntityId:null,
  mqttConfig:{enabled:false,ip:'',address:'',topic:'',subscriptions:[],simulatorEnabled:false},fetchConfig:{url:'',apiKey:''},
  sceneSettings:{modelEntrance:settings,camera:{savedPose:null,savedOrientation:'orbit',savedProjection:'perspective',viewDistance:1000},sensitivity:{zoom:1,pan:1,rotate:1},environment:null,skybox:null}}};
let code=1;
try {
  const {buildDigitalTwinSourcePackage}=await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const {buildDigitalTwinDistPackage}=await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const {authorizeAssetFile}=await import('../../dist-electron/ipc/assetRegistry.js');
  const projectRoot=path.join(root,'project'), entrySceneFilePath=path.join(projectRoot,'Scenes','main.scene.json');
  await mkdir(path.dirname(entrySceneFilePath),{recursive:true});
  const original=JSON.stringify(document);await writeFile(entrySceneFilePath,original);
  for(const effect of effects){const copy=structuredClone(document);copy.scene.sceneSettings.modelEntrance={...settings,effect,intensity:0,delaySeconds:0,loopIntervalSeconds:0};await writeFile(path.join(projectRoot,'Scenes',effect+'.scene.json'),JSON.stringify(copy));}
  const {NullEngine,Scene,MeshBuilder,StandardMaterial}=await import('@babylonjs/core');
  const {GLTF2Export}=await import('@babylonjs/serializers/glTF/2.0/glTFSerializer.js');
  const engine=new NullEngine(), environmentScene=new Scene(engine), environmentMesh=MeshBuilder.CreateBox('factory',{},environmentScene);
  environmentMesh.material=new StandardMaterial('factory-original',environmentScene);
  const glb=await GLTF2Export.GLBAsync(environmentScene,'environment'), environmentPath=path.join(projectRoot,'Assets','Environments','environment.glb');
  await mkdir(path.dirname(environmentPath),{recursive:true});
  await writeFile(environmentPath,Buffer.from(await glb.glTFFiles['environment.glb'].arrayBuffer()));environmentScene.dispose();engine.dispose();
  authorizeAssetFile(environmentPath);
  const environmentDocument=structuredClone(document), environmentId='__scene_environment_model__';
  environmentDocument.scene.sceneSettings.modelEntrance={...settings,scope:'selected',targetEntityIds:[environmentId]};
  environmentDocument.scene.sceneSettings.shadows={enabled:false,mode:'baked'};
  const environmentUrl='editor-asset://local/'+encodeURIComponent(environmentPath);
  environmentDocument.scene.sceneSettings.environment={packagePath:environmentPath,displayName:'入场厂房',lengthUnit:'meter',unitScaleToMeters:1,placementMode:'scene-base',visible:true,opacity:1,
    activeVariantUrl:environmentUrl,variants:[{name:'默认厂房',sourcePath:environmentPath,sourceUrl:environmentUrl}]};
  await writeFile(path.join(projectRoot,'Scenes','environment.scene.json'),JSON.stringify(environmentDocument));
  const source=await buildDigitalTwinSourcePackage({projectRoot,sharedResourcesRoot:path.join(root,'shared'),entrySceneFilePath,outputRoot:path.join(root,'source'),signal:controller.signal,
    manifest:{projectId:'123',projectName:'模型入场验收',editorProjectId:null,baseVersionId:null,resourceRevision:'1'},isPlatformImageReference:()=>false,findSyncedImageForReference:async()=>null,skyboxCacheDependencies:{getSharedProjectSkyboxRoot:()=>null}});
  const sourceArchive=await unzipper.Open.file(source.filePath);
  for(const effect of effects){const file=sourceArchive.files.find(file=>file.path==='Scenes/'+effect+'.scene.json');assert.ok(file);const parsed=JSON.parse((await file.buffer()).toString('utf8'));assert.deepEqual(parsed.scene.sceneSettings.modelEntrance,{...settings,effect,intensity:0,delaySeconds:0,loopIntervalSeconds:0});}
  const packagedEnvironment=sourceArchive.files.find(file=>file.path==='Scenes/environment.scene.json');assert.ok(packagedEnvironment);
  const environmentContent=(await packagedEnvironment.buffer()).toString('utf8');
  assert.deepEqual(JSON.parse(environmentContent).scene.sceneSettings.modelEntrance,environmentDocument.scene.sceneSettings.modelEntrance);
  const dist=await buildDigitalTwinDistPackage({projectId:'123',publishName:'模型入场验收',sceneContent:source.entrySceneContent,sourceResourceFiles:source.resourceFiles,outputRoot:path.join(root,'dist'),signal:controller.signal});
  const distArchive=await unzipper.Open.file(dist.filePath), entry=distArchive.files.find(file=>file.path==='project/scene.json');
  assert.deepEqual(JSON.parse((await entry.buffer()).toString('utf8')).scene.sceneSettings.modelEntrance,settings);
  assert.equal(await readFile(entrySceneFilePath,'utf8'),original,'打包不得改写原场景');
  const environmentSource=await buildDigitalTwinSourcePackage({projectRoot,sharedResourcesRoot:path.join(root,'shared'),
    entrySceneFilePath:path.join(projectRoot,'Scenes','environment.scene.json'),outputRoot:path.join(root,'environment-source'),signal:controller.signal,
    manifest:{projectId:'123',projectName:'环境入场验收',editorProjectId:null,baseVersionId:null,resourceRevision:'1'},isPlatformImageReference:()=>false,
    findSyncedImageForReference:async()=>null,skyboxCacheDependencies:{getSharedProjectSkyboxRoot:()=>null}});
  const environmentDist=await buildDigitalTwinDistPackage({projectId:'123',publishName:'环境入场验收',sceneContent:environmentSource.entrySceneContent,sourceResourceFiles:environmentSource.resourceFiles,outputRoot:path.join(root,'environment-dist'),signal:controller.signal});
  const environmentArchive=await unzipper.Open.file(environmentDist.filePath), environmentEntry=environmentArchive.files.find(file=>file.path==='project/scene.json');
  const environmentPack=JSON.parse((await environmentEntry.buffer()).toString('utf8'));
  assert.deepEqual(environmentPack.scene.sceneSettings.modelEntrance,environmentDocument.scene.sceneSettings.modelEntrance);
  assert.equal(environmentPack.scene.sceneSettings.environment.displayName,'入场厂房');
  assert.equal(environmentPack.scene.sceneSettings.shadows.enabled,false,'无阴影的测试环境配置必须保留');
  assert.ok(environmentArchive.files.some(file=>file.path.endsWith('.glb')),'DIST 必须含环境GLB资源');
  const output=path.resolve('output/model-entrance');await mkdir(output,{recursive:true});
  const viewerRoot=await mkdtemp(path.join(output,'viewer-'));
  for(const file of distArchive.files){const destination=path.resolve(viewerRoot,file.path),relative=path.relative(viewerRoot,destination);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));if(file.type==='Directory')await mkdir(destination,{recursive:true});else{await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,await file.buffer());}}
  await writeFile(path.join(output,'packages-result.json'),JSON.stringify({sourceModes:effects,distSettings:settings,environmentTargetId:environmentId,environmentSourceDistPassed:true,viewerRoot},null,2));
  console.log('PASS: SOURCE八种配置与零值、DIST配置、环境目标和GLB资源、原文件不变；Viewer='+viewerRoot);code=0;
} catch(error){console.error(error);}
finally{clearTimeout(deadline);const relative=path.relative(path.resolve(tmpdir()),path.resolve(root));if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(root).startsWith('model-entrance-packages-'))await rm(root,{recursive:true,force:true});app.exit(code);}
