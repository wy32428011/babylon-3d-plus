import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import unzipper from 'unzipper';

const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'composition-publish-'));
app.setPath('userData',path.join(temporary,'user-data'));app.getAppPath=()=>process.cwd();
async function run(){
  const {buildDigitalTwinSourcePackage}=await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const {buildDigitalTwinDistPackage}=await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const {saveCompositionPackage}=await import('../../dist-electron/ipc/compositionPackage.js');
  const {setCurrentProjectRoot}=await import('../../dist-electron/ipc/projectAssetStore.js');
  const original=JSON.parse(await fs.readFile('output/playwright/editable-composition/scene.scene.json','utf8'));
  const roots=Object.values(original.scene.entities).filter(e=>e.composition);assert.equal(roots.length,2);
  const first=roots[0];const nodes=first.childrenIds.map(id=>({...original.scene.entities[id],parentId:null}));
  const shared=path.join(temporary,'shared');
  const entry=await saveCompositionPackage(shared,{definition:{schemaVersion:1,name:'组合发布',nodes}});
  for(const root of roots)root.composition={...root.composition,libraryId:entry.id,revision:entry.revision,packagePath:entry.packagePath,contentSha256:entry.contentSha256,resourceId:'123',resourceType:'ENV_MODEL'};
  const projectRoot=path.join(temporary,'project'),entrySceneFilePath=path.join(projectRoot,'Scenes/main.scene.json');
  await fs.mkdir(path.dirname(entrySceneFilePath),{recursive:true});await fs.writeFile(entrySceneFilePath,JSON.stringify(original),'utf8');
  setCurrentProjectRoot(projectRoot);const signal=new AbortController().signal;
  const source=await buildDigitalTwinSourcePackage({projectRoot,sharedResourcesRoot:shared,entrySceneFilePath,outputRoot:path.join(temporary,'source'),signal,
    manifest:{projectId:'123',projectName:'组合发布',editorProjectId:null,baseVersionId:null,resourceRevision:'1'},isPlatformImageReference:()=>false,findSyncedImageForReference:async()=>null,
    skyboxCacheDependencies:{getSharedProjectSkyboxRoot:()=>null}});
  const dist=await buildDigitalTwinDistPackage({projectId:'123',publishName:'组合发布',sceneContent:source.entrySceneContent,sourceResourceFiles:source.resourceFiles,outputRoot:path.join(temporary,'dist'),signal});
  const sourceZip=await unzipper.Open.file(source.filePath),distZip=await unzipper.Open.file(dist.filePath);
  assert.ok(sourceZip.files.some(f=>f.path.endsWith('/composition.json')),'SOURCE 必须包含组合定义');
  const sourceScene=JSON.parse((await sourceZip.files.find(f=>f.path==='Scenes/main.scene.json').buffer()).toString()).scene;
  const distScene=JSON.parse((await distZip.files.find(f=>f.path==='project/scene.json').buffer()).toString()).scene;
  for(const root of roots){
    assert.match(sourceScene.entities[root.id].composition.packagePath,/^Assets\/Compositions\//);
    assert.equal(distScene.entities[root.id].composition.packagePath,undefined);
    assert.equal(distScene.entities[root.id].composition.revision,entry.revision);
    for(const id of root.childrenIds)assert.deepEqual(distScene.entities[id].components.transform,original.scene.entities[id].components.transform);
  }
  const viewerRoot=path.resolve('output/playwright/editable-composition/viewer');await fs.mkdir(viewerRoot,{recursive:true});
  for(const file of distZip.files){
    if(file.type==='Directory')continue;const target=path.resolve(viewerRoot,file.path),relative=path.relative(viewerRoot,target);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('DIST 路径越界');
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,await file.buffer());
  }
  await fs.writeFile('output/playwright/editable-composition/packages-result.json',JSON.stringify({status:'PASS',sourceBytes:source.fileSize,distBytes:dist.fileSize,checks:['SOURCE-editable-definition','SOURCE-relative-paths','DIST-member-transforms','DIST-no-local-composition-path','pinned-revision']},null,2));
  console.log('PASS: 组合 SOURCE/DIST 包、相对路径、独立成员变换及固定版本');
}
async function finish(code){const resolved=path.resolve(temporary);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('composition-publish-'))throw Error('临时目录越界');await fs.rm(resolved,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(run).then(()=>finish(0),async error=>{console.error(error);await finish(1);});
