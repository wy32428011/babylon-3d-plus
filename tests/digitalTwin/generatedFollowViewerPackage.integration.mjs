import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import unzipper from 'unzipper';

const {app}=electron, output=path.resolve('output/generated-follow');
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(output,'viewer-package-'));
app.setPath('userData',path.join(temp,'user'));app.getAppPath=()=>process.cwd();
app.whenReady().then(async()=>{let code=1;try{
  const {buildDigitalTwinSourcePackage}=await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const {buildDigitalTwinDistPackage}=await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const {authorizeAssetFile}=await import('../../dist-electron/ipc/assetRegistry.js');
  const document=JSON.parse(await readFile('output/playwright/generated-follow/fetch.scene.json','utf8'));
  const root=path.join(temp,'project'),model=path.join(root,'Assets','Models','cargo.gltf');
  await mkdir(path.dirname(model),{recursive:true});await copyFile('output/playwright/generated-follow/cargo.gltf',model);authorizeAssetFile(model);
  const url='editor-asset://local/'+encodeURIComponent(model);
  for(const entity of Object.values(document.scene.entities)){
    const target=entity.components.modelGenerator?.defaultTarget;
    if(target?.kind==='model')Object.assign(target.modelAsset,{sourcePath:model,sourceUrl:url});
    const effect=entity.components.poiEffect;
    if(effect?.configuration?.target.model)Object.assign(effect.configuration.target.model,{sourcePath:model,sourceUrl:url});
  }
  document.scene.fetchConfig={url:'http://127.0.0.1/inventory',apiKey:'',syncIntervalSeconds:1};
  const entry=path.join(root,'Scenes','main.scene.json');await mkdir(path.dirname(entry),{recursive:true});await writeFile(entry,JSON.stringify(document));
  const signal=new AbortController().signal;
  const source=await buildDigitalTwinSourcePackage({projectRoot:root,sharedResourcesRoot:path.join(temp,'shared'),entrySceneFilePath:entry,outputRoot:path.join(temp,'source'),signal,
    manifest:{projectId:'123',projectName:'运行时生成跟随Viewer',editorProjectId:null,baseVersionId:null,resourceRevision:'1'},isPlatformImageReference:()=>false,findSyncedImageForReference:async()=>null,skyboxCacheDependencies:{getSharedProjectSkyboxRoot:()=>null}});
  const dist=await buildDigitalTwinDistPackage({projectId:'123',publishName:'运行时生成跟随Viewer',sceneContent:source.entrySceneContent,sourceResourceFiles:source.resourceFiles,outputRoot:path.join(temp,'dist'),signal});
  const zip=await unzipper.Open.file(dist.filePath),viewer=path.join(output,'viewer');
  for(const entry of zip.files){const destination=path.resolve(viewer,entry.path),relative=path.relative(viewer,destination);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    if(entry.type==='Directory')await mkdir(destination,{recursive:true});else{await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,await entry.buffer());}}
  await copyFile(dist.filePath,path.join(output,'fetch-viewer-dist.zip'));
  console.log('PASS: actual SOURCE/DIST generated fetch fixture, no placed model instances');code=0;
}catch(error){console.error(error);}finally{
  const relative=path.relative(output,temp);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temp).startsWith('viewer-package-'));
  await rm(temp,{recursive:true,force:true});app.exit(code);
}});
