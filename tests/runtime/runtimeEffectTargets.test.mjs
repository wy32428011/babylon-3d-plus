import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const root=new URL('../../',import.meta.url);
const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)){const u=new URL(s.endsWith('.js')?s.slice(0,-3):s,c.parentURL);if(!existsSync(u)&&existsSync(new URL(u.href+'.ts')))return next(u.href+'.ts',c);}return next(s,c);},load(u,c,next){if(u.startsWith(root.href)&&u.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}});
const {resolveRuntimeEffectTargets, runtimeTargetLockKey}=await import('../../src/runtime/effects/runtimeEffectTargets.ts');hooks.deregister();
const empty={entityIds:[],entities:{}};
const model={name:'箱体',sourceUrl:'asset:///box.glb',sourcePath:'C:/box.glb'};
const binding={mode:'model',model,sourceId:'',deviceType:'',assetCode:'',selection:'single',maxTargets:32};
const generated=(id,extra={})=>({id,name:id,origin:'generated',model,identity:null,containerCode:id,generatorId:'g1',state:'ready',generation:1,...extra});
test('编辑场景零实例时等待，实例出现无需修改文档即可解析',()=>{
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[]).status,'missing-target');
  assert.deepEqual(resolveRuntimeEffectTargets(empty,binding,[generated('A')]).ids,['A']);
  assert.equal(empty.entityIds.length,0);
});
test('容器和承载设备编号独立，来源精确匹配不伪造货物数据身份',()=>{
  const a=generated('A',{containerCode:'0003',carrierIdentity:{sourceId:'one',deviceType:'rgv',assetCode:'000317'}});
  const b=generated('B',{containerCode:'0003',carrierIdentity:{sourceId:'two',deviceType:'rgv',assetCode:'000317'}});
  assert.deepEqual(resolveRuntimeEffectTargets(empty,{...binding,instanceKey:'containerCode',assetCode:'0003',sourceId:'two'},[a,b]).ids,['B']);
  assert.deepEqual(resolveRuntimeEffectTargets(empty,{...binding,instanceKey:'carrierAssetCode',assetCode:'000317',sourceId:'one'},[a,b]).ids,['A']);
  assert.equal(resolveRuntimeEffectTargets(empty,{...binding,assetCode:'000317'},[a]).status,'missing-target');
});
test('多实例不任取首个，运行时选择只接受当前候选，已锁定对象保持稳定',()=>{
  const a=generated('A'),b=generated('B');
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[a,b]).status,'ambiguous');
  assert.equal(resolveRuntimeEffectTargets(empty,{...binding,followSelection:'manual'},[a]).status,'ambiguous');
  assert.deepEqual(resolveRuntimeEffectTargets(empty,binding,[a,b],{selectedId:'B'}).ids,['B']);
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[a,b],{selectedId:'invalid'}).status,'ambiguous');
  assert.deepEqual(resolveRuntimeEffectTargets(empty,binding,[b,a],{lockedKey:runtimeTargetLockKey(a)}).ids,['A']);
});
test('loading/hidden/error不可跟随，销毁重建按稳定业务身份重新解析',()=>{
  const a=generated('old');
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[{...a,state:'loading'}]).status,'loading');
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[{...a,state:'hidden'}]).ids.length,0);
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[{...a,state:'error',message:'模型失败'}]).status,'error');
  const fresh=generated('new',{containerCode:a.containerCode,generation:2});
  assert.deepEqual(resolveRuntimeEffectTargets(empty,binding,[fresh,generated('other')],{lockedKey:runtimeTargetLockKey(a)}).ids,['new']);
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[generated('other')],{lockedKey:runtimeTargetLockKey(a)}).status,'missing-target');
});
test('实例来源与生成器范围过滤，模板类型变化不得继续旧锁定',()=>{
  const a=generated('A'),b=generated('B',{generatorId:'g2'});
  assert.deepEqual(resolveRuntimeEffectTargets(empty,{...binding,generatorId:'g2'},[a,b]).ids,['B']);
  assert.equal(resolveRuntimeEffectTargets(empty,{...binding,instanceSource:'scene'},[a]).ids.length,0);
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[{...a,model:{...model,sourceUrl:'asset:///other.glb',sourcePath:'D:/other.glb'}}],{lockedKey:runtimeTargetLockKey(a)}).ids.length,0);
});
test('手选运行ID被复用时不能绕过已有业务锁定或匿名代际锁定',()=>{
  const old=generated('slot',{containerCode:'0001'}),next={...old,containerCode:'0002',generation:2};
  assert.equal(resolveRuntimeEffectTargets(empty,binding,[next],{selectedId:'slot',lockedKey:runtimeTargetLockKey(old)}).status,'missing-target');
  const anonymous={...old,containerCode:''};
  assert.equal(resolveRuntimeEffectTargets(empty,{...binding,followSelection:'manual'},[{...anonymous,generation:2}],{selectedId:'slot',lockedKey:runtimeTargetLockKey(anonymous)}).status,'ambiguous');
});
test('同一生成器的容器从库存转为设备承载仍保持身份，显式来源筛选继续隔离',()=>{
  const inventory=generated('fetch',{containerCode:'000317',carrierIdentity:null});
  const carried=generated('cargo',{containerCode:'000317',carrierIdentity:{sourceId:'line-a',deviceType:'rgv',assetCode:'R01'}});
  assert.deepEqual(resolveRuntimeEffectTargets(empty,binding,[carried,generated('other')],{lockedKey:runtimeTargetLockKey(inventory)}).ids,['cargo']);
  assert.equal(resolveRuntimeEffectTargets(empty,{...binding,instanceKey:'containerCode',sourceId:'line-b'},[carried],{lockedKey:runtimeTargetLockKey(inventory)}).status,'missing-target');
});
