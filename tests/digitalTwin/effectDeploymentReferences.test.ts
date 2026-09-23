import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{normalizeEffectDeploymentReferences}] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/shared/effectDeploymentReferences'),
]>(['electron/shared/effectDeploymentReferences.ts']);
test('DIST模板筛选移除本机路径，保留资源身份及本地场景身份证据',()=>{
  const source={entities:{device:{components:{modelAsset:{sourcePath:'C:/private/model.glb',sourceUrl:'editor-asset://local/C%3Amodel'}}},effect:{components:{poiEffect:{configuration:{version:2,target:{model:{name:'模板',entityIds:['device'],sourcePath:'C:/private/model.glb',sourceUrl:'editor-asset://local/C%3Amodel'}}}}}}}};
  const runtime=structuredClone(source);normalizeEffectDeploymentReferences(runtime);
  const ref=runtime.entities.effect.components.poiEffect.configuration.target.model as typeof source.entities.effect.components.poiEffect.configuration.target.model&{entityIds:string[]};
  assert.deepEqual(ref.entityIds,['device']);assert.equal(ref.sourcePath,'');assert.equal(ref.sourceUrl,'');
  assert.equal(source.entities.effect.components.poiEffect.configuration.target.model.sourcePath,'C:/private/model.glb');
});
test('零编辑实例的生成器类型引用复用 DIST 资源映射',()=>{
  const model={sourcePath:'C:/Assets/Models/device.glb',sourceUrl:'editor-asset://local/'+encodeURIComponent('C:/Assets/Models/device.glb')};
  const scene={entities:{generator:{components:{modelGenerator:{defaultTarget:{kind:'model',modelAsset:{...model}},rules:[]}}},fx:{components:{poiEffect:{configuration:{target:{model:{...model,name:'设备'}}}}}}}};
  const deployed='editor-asset://local/project%2Fassets%2Fmodels%2Fdevice.glb';
  normalizeEffectDeploymentReferences(scene,new Map([['c:\\assets\\models\\device.glb',deployed]]));
  assert.equal(scene.entities.fx.components.poiEffect.configuration.target.model.sourcePath,deployed);
  assert.equal(scene.entities.fx.components.poiEffect.configuration.target.model.sourceUrl,deployed);
  assert.equal(scene.entities.generator.components.modelGenerator.defaultTarget.modelAsset.sourcePath,model.sourcePath);
});
test('仅元数据的未生成类型不增加资源且不泄露本机路径',()=>{
  const model={sourcePath:'C:/private/missing.glb',sourceUrl:'editor-asset://local/missing',name:'未生成'};
  const scene={entities:{fx:{components:{poiEffect:{configuration:{target:{model}}}}}}};
  normalizeEffectDeploymentReferences(scene,new Map());
  assert.equal(model.sourcePath,'');assert.equal(model.sourceUrl,'');assert.equal(model.name,'未生成');
});
test('远程稳定身份不需要打包筛选模板，也不改变业务编号',()=>{
  const identity={sourceKey:'a'.repeat(64),kind:'model',resourceId:'42',modelPath:'model.glb'};
  const scene={entities:{fx:{components:{poiEffect:{configuration:{version:2,target:{assetCode:'000317',model:{name:'远程',identity,sourcePath:'C:/cache/model.glb',sourceUrl:'editor-asset://local/cache'}}}}}}}};
  normalizeEffectDeploymentReferences(scene);
  assert.deepEqual(scene.entities.fx.components.poiEffect.configuration.target.model.identity,identity);
  assert.equal(scene.entities.fx.components.poiEffect.configuration.target.assetCode,'000317');
  assert.equal(scene.entities.fx.components.poiEffect.configuration.target.model.sourcePath,'');
});
