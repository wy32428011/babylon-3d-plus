import assert from 'node:assert/strict'; import { test } from 'node:test'; import { promises as fs } from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { inspectLightingBakeRequest, runLightingBakeJob, mapLightingBakeEngineProgress } from '../../electron/ipc/lightingBakeService.ts';
import type { LightingBakeInput } from '../../electron/shared/sceneLightingBakeContract.ts';
const input=():LightingBakeInput=>({version:1,jobId:'blocked',signature:'s',sceneName:'提前拒绝',settings:{enabled:true,quality:'preview',atlasSize:1024,texelsPerMeter:8,probeSpacing:0.1,maxTextureMiB:16,cacheStaticShadows:true,dynamicShadows:true},meshes:[{key:'a',entityId:'a',nodeKey:'root',name:'面',positions:[0,0,0,100,100,100,0,100,0],normals:[0,1,0,0,1,0,0,1,0],indices:[0,1,2],worldMatrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],material:{baseColor:[1,1,1],alpha:1,metallic:0,roughness:1,emissive:[0,0,0],doubleSided:true}}],lights:[],environment:{color:[1,1,1],intensity:1}});
test('真实后台入口预检失败时不启动引擎、不创建任务或修改既有文件',async t=>{
 const project=await fs.mkdtemp(path.join(os.tmpdir(),'lighting-preflight-'));t.after(()=>fs.rm(project,{recursive:true,force:true}));const marker=path.join(project,'old-result.json');await fs.writeFile(marker,'old'); const scene=input(), before=structuredClone(scene);
 await assert.rejects(runLightingBakeJob({input:scene,projectRoot:project,enginePath:'must-not-run.exe',signal:new AbortController().signal,isProjectCurrent:()=>true,isAuthorizedAssetFile:()=>true,decodeAssetUrl:x=>x,encodeAssetUrl:x=>x,authorizeAssetFile:()=>{},onProgress:()=>{}}),/探针/);
 await assert.rejects(fs.stat(path.join(project,'.babylon-editor')),{code:'ENOENT'});assert.equal(await fs.readFile(marker,'utf8'),'old');assert.deepEqual(scene,before);
});
test('纹理授权及总输入字节预算在准备文件和spawn之前检查',async t=>{
 const project=await fs.mkdtemp(path.join(os.tmpdir(),'lighting-preflight-'));t.after(()=>fs.rm(project,{recursive:true,force:true}));const texture=path.join(project,'source.hdr');await fs.writeFile(texture,'hdr');const scene=input();scene.environment.textureUrl='editor-asset://local/source.hdr';
 await assert.rejects(inspectLightingBakeRequest(scene,{decodeAssetUrl:()=>texture,isAuthorizedAssetFile:()=>false}),/授权/);
 const handle=await fs.open(texture,'r+');await handle.truncate(17*1048576);await handle.close();const report=await inspectLightingBakeRequest(scene,{decodeAssetUrl:()=>texture,isAuthorizedAssetFile:()=>true});assert.equal(report.sourceTextureBytes,17*1048576);assert.ok(report.issues.some(i=>i.code==='source-texture-budget'));
});

test('真实parser所用映射将preflight固定准备边界，普通阶段及动态切分进度非递减',()=>{
 const events=[['unwrap',0,2],['unwrap',1,2],['unwrap',1,4],['unwrap',4,4],['preflight',1,1],['baking',0,2],['baking',1,2],['probes',1,2],['probes',2,2],['completed',1,1]] as const;
 let previous=0;const values=events.map(([phase,completed,total])=>{previous=mapLightingBakeEngineProgress({phase,completed,total},previous);return previous;});
 assert.equal(values[4],0.15);assert.equal(values[5],0.15);assert.equal(values[9],0.96);
 assert.ok(values.every((value,index)=>index===0||value>=values[index-1]));
 assert.equal(mapLightingBakeEngineProgress({phase:'baking',completed:0,total:1}),0.15,'新的独立GPU重试进程可以从15%重新开始');
});
