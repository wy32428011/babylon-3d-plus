import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ recoverPinnedLocalSceneModel }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/localSceneRemoteRecovery'),
]>(['electron/ipc/localSceneRemoteRecovery.ts']);
const revision = 'a'.repeat(64);
const options = { baseUrl:'https://example.com', sharedResourcesRoot:'C:/test',
  resource:{kind:'model' as const,resourceId:'123'}, expectedRevision:revision, signal:new AbortController().signal };

test('当前版本相同时直接返回；历史版本只有内容指纹相同才接受', async () => {
  const attempts:string[]=[];
  const result=await recoverPinnedLocalSceneModel({...options, dependencies:{
    synchronize:async args=>{ const response:any = args.dependencies ? await args.dependencies.requestJson!({endpointPath:'api/v1/models/detail'} as any) : {data:{fileUrl:'/new.glb'}};
      attempts.push(response.data.fileUrl);
      return [{assetRevision:response.data.fileUrl==='/old.glb'?revision:'b'.repeat(64)}] as any; },
    requestJson:async()=>({success:true,data:{id:'123',modelName:'model',fileName:'new.glb',fileUrl:'/new.glb',versions:[{fileName:'old.glb',fileUrl:'/old.glb'}]}}),
  }});
  assert.equal(result.assetRevision,revision);
  assert.deepEqual(attempts,['/new.glb','/old.glb']);
});

test('所有候选内容都与固定版本不同必须报告失败，不能返回最新版本', async () => {
  await assert.rejects(recoverPinnedLocalSceneModel({...options,dependencies:{
    synchronize:async()=>[{assetRevision:'b'.repeat(64)}] as any,
    requestJson:async()=>({success:true,data:{id:'123',fileUrl:'/new.glb',versions:[{fileName:'old.glb',fileUrl:'/old.glb'}]}}),
  }}),/原版本.*未找到/);
});

test('中台详情身份错误或取消时不得尝试其他资源', async () => {
  await assert.rejects(recoverPinnedLocalSceneModel({...options,dependencies:{
    synchronize:async()=>[{assetRevision:'b'.repeat(64)}] as any,
    requestJson:async()=>({success:true,data:{id:'999',versions:[]}}),
  }}),/身份不匹配/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(recoverPinnedLocalSceneModel({...options,signal:controller.signal,dependencies:{
    synchronize:async()=>{throw new Error('不得执行');},requestJson:async()=>null,
  }}),{name:'AbortError'});
});
