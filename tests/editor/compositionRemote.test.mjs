import { authorizeAssetRoot } from '../../dist-electron/ipc/assetRegistry.js';
import { recoverSceneCompositions } from '../../dist-electron/ipc/compositionSceneRecovery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { saveCompositionPackage, listCompositionPackages } from '../../dist-electron/ipc/compositionPackage.js';
import { syncCompositionLibrary } from '../../dist-electron/ipc/compositionRemote.js';
const unzipper=createRequire(import.meta.url)('unzipper');
const hash=b=>createHash('sha256').update(b).digest('hex');
const definition=x=>({schemaVersion:1,name:'跨机组合',nodes:[0,1].map(i=>({id:'node'+i,name:'模型'+i,parentId:null,childrenIds:[],components:{transform:{position:{x:i*x,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},meshRenderer:{meshKind:'cube',materialColor:'#fff'}}}))});
test('上传、另一工作区下载、同卡片更新及并发冲突均保留正确版本',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'composition-http-')),first=path.join(root,'first'),second=path.join(root,'second');
  authorizeAssetRoot(root);
  const sourceFile=path.join(root,'source','model.gltf');await fs.mkdir(path.dirname(sourceFile),{recursive:true});
  const positions=Buffer.from(new Float32Array([0,0,0,1,0,0,0,1,0]).buffer);
  await fs.writeFile(sourceFile,JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],buffers:[{byteLength:positions.length,uri:'data:application/octet-stream;base64,'+positions.toString('base64')}],bufferViews:[{buffer:0,byteLength:positions.length}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}]}));
  const modelDefinition=x=>{const value=definition(x);delete value.nodes[0].components.meshRenderer;value.nodes[0].components.modelAsset={sourcePath:sourceFile,sourceUrl:'editor-asset://local/'+encodeURIComponent(sourceFile),assetCode:'fixture',lengthUnit:'meter',unitScaleToMeters:1};return value;};
  let current=null,saves=0;const versions=new Map();
  const server=createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://localhost');let data;
    if(url.pathname.endsWith('/save')){
      const request=new Request('http://localhost'+req.url,{method:'POST',headers:req.headers,body:Readable.toWeb(req),duplex:'half'});
      const form=await request.formData(),revision=form.get('operationId');
      if(versions.has(revision))data=versions.get(revision).entry;
      else if(form.get('targetId')&&current?.revision!==form.get('baseRevision')){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,code:'COMPOSITION_REVISION_CONFLICT',message:'版本冲突'}));return;}
      else{
        const zip=Buffer.from(await form.get('compositionFile').arrayBuffer()),directory=await unzipper.Open.buffer(zip),manifest=await directory.files.find(f=>f.path==='composition.json').buffer();
        data={id:'2053001280000000001',name:form.get('name'),revision,manifestSha256:hash(manifest),packageSha256:hash(zip),memberCount:2,updatedAt:new Date().toISOString()};
        current=data;versions.set(revision,{entry:data,zip});saves++;
      }
    }else if(url.pathname.endsWith('/resolve')){const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));data=[...versions.values()].map(v=>v.entry).filter(e=>e.revision===input.revision&&e.manifestSha256===input.manifestSha256);}
    else if(url.pathname.endsWith('/query')){for await(const _ of req){}data=current?[current]:[];}
    else if(url.pathname.endsWith('/package')){const revision=url.pathname.split('/').at(-2);const zip=versions.get(revision).zip;res.writeHead(200,{'Content-Type':'application/zip','Content-Length':zip.length});res.end(zip);return;}
    else if(url.pathname.includes('/versions/'))data=versions.get(url.pathname.split('/').at(-1)).entry;
    else throw Error('未定义请求 '+url.pathname);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data}));
  }catch(e){res.writeHead(500);res.end(JSON.stringify({success:false,message:String(e)}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const offline=await saveCompositionPackage(first,{definition:modelDefinition(1)});
    const initial=await saveCompositionPackage(first,{definition:modelDefinition(3),targetId:offline.id,expectedRevision:offline.revision});
    const uploaded=(await syncCompositionLibrary(first,base))[0];assert.equal(uploaded.id,initial.id);assert.equal(uploaded.syncStatus,'synced');
    const downloaded=(await syncCompositionLibrary(second,base))[0];assert.equal((await listCompositionPackages(second))[0].definition.nodes[1].components.transform.position.x,3);
    assert.equal(downloaded.resourceId,uploaded.resourceId);
    await saveCompositionPackage(first,{definition:modelDefinition(5),targetId:uploaded.id,expectedRevision:uploaded.revision});
    const replaced=(await syncCompositionLibrary(first,base))[0];assert.equal(replaced.id,initial.id);assert.equal(replaced.resourceId,uploaded.resourceId);assert.equal(saves,3);
    await saveCompositionPackage(second,{definition:modelDefinition(7),targetId:downloaded.id,expectedRevision:downloaded.revision});
    const conflict=(await syncCompositionLibrary(second,base))[0];assert.equal(conflict.syncStatus,'conflict');assert.equal((await listCompositionPackages(second))[0].definition.nodes[1].components.transform.position.x,7);assert.equal(saves,3);
    assert.equal((await listCompositionPackages(first)).length,1);
    const scene={entities:{root:{id:'root',name:'旧版本实例',childrenIds:['child'],composition:{schemaVersion:1,instanceId:'instance',libraryId:initial.id,revision:initial.revision,resourceId:uploaded.resourceId,packagePath:initial.packagePath,contentSha256:initial.contentSha256}},child:{id:'child',parentId:'root',childrenIds:[],components:{transform:{position:{x:42,y:1,z:0}}}}}};
    const recovered=await recoverSceneCompositions(scene,path.join(root,'third'),null,base,new AbortController().signal);
    assert.deepEqual(recovered.issues,[]);assert.equal(recovered.scene.entities.root.composition.revision,initial.revision);
    assert.equal(recovered.scene.entities.child.components.transform.position.x,42);
    const manifest=JSON.parse(await fs.readFile(path.join(recovered.scene.entities.root.composition.packagePath,'composition.json'),'utf8'));
    assert.equal(manifest.definition.nodes[1].components.transform.position.x,3,'历史实例不能被库当前版本的摆放覆盖');
    assert.ok(versions.has(offline.revision),'离线期间被替换的旧版本也必须同步');
    const standalone={entities:{detached:{id:'detached',name:'已解除组合的成员',childrenIds:[],parentId:null,components:{transform:{position:{x:42,y:0,z:0}},modelAsset:offline.definition.nodes[0].components.modelAsset}}}};
    const detached=await recoverSceneCompositions(standalone,path.join(root,'fourth'),null,base,new AbortController().signal);
    assert.deepEqual(detached.issues,[]);
    assert.equal(detached.scene.entities.detached.composition,undefined);
    const asset=detached.scene.entities.detached.components.modelAsset;
    assert.equal(asset.sourceSnapshot.compositionResource.resourceId,uploaded.resourceId);
    assert.equal(asset.sourceSnapshot.compositionResource.revision,offline.revision);
    assert.equal(await fs.readFile(asset.sourcePath,'utf8'),await fs.readFile(sourceFile,'utf8'));
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});
