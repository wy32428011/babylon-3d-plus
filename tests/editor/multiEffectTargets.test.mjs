import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const root=new URL('../../',import.meta.url);
const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)){const u=new URL(s.endsWith('.js')?s.slice(0,-3):s,c.parentURL);if(!existsSync(u)&&existsSync(new URL(u.href+'.ts')))return next(u.href+'.ts',c);}return next(s,c);},load(u,c,next){if(u.startsWith(root.href)&&u.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}});
const {resolveEffectTargets}=await import('../../src/editor/model/effectTargets.ts');
const {resolveRuntimeEffectTargets}=await import('../../src/runtime/effects/runtimeEffectTargets.ts');
const {sanitizeEffectConfiguration,createDefaultEffectConfiguration,validateEffectConfiguration}=await import('../../src/editor/model/effectConfigurationValidation.ts');
hooks.deregister();
const model={sourcePath:'C:/robot.glb',sourceUrl:'asset:///robot.glb'};
const scene={entityIds:['a','b','c'],entities:Object.fromEntries(['a','b','c'].map(id=>[id,{id,name:id,visible:true,components:{modelAsset:{...model,assetCode:id,dataDrivenConfig:{device:{devType:'rgv'}}}}}]))};
const target={mode:'entity',entityId:'a',entityIds:['a','b','a','gone'],model:null,sourceId:'',deviceType:'',assetCode:'',selection:'all',maxTargets:8};
test('指定多个模型去重，缺失项保留配置且不妨碍有效对象',()=>{
  const r=resolveEffectTargets(scene,target,'model-outline');assert.deepEqual(r.ids,['a','b']);assert.match(r.message,/1.*不存在/);assert.equal(target.entityIds.length,4);
  assert.equal(resolveEffectTargets(scene,{...target,entityIds:[]},'model-outline').status,'unbound');
  assert.equal(resolveEffectTargets(scene,{...target,maxTargets:1},'model-outline').status,'limit');
});
test('相机拒绝同时多目标，拖尾允许同类型各自运行',()=>{
  assert.equal(resolveEffectTargets(scene,target,'target-follow').status,'ambiguous');
  assert.deepEqual(resolveEffectTargets(scene,{...target,mode:'model',model},'motion-trail').ids,['a','b','c']);
});
test('运行时全部类型覆盖编辑与生成模型，loading实例独立等待',()=>{
  const generated=[{id:'generated',name:'g',origin:'generated',model,identity:null,state:'ready',generation:1},{id:'loading',name:'loading',origin:'generated',model,identity:null,state:'loading',generation:1}];
  const r=resolveRuntimeEffectTargets(scene,{...target,mode:'model',model},generated,{multiple:true});
  assert.equal(r.status,'resolved');assert.deepEqual(r.ids,['a','b','c','generated']);assert.equal(r.candidates.length,5);
  assert.equal(resolveRuntimeEffectTargets(scene,{...target,mode:'model',model,maxTargets:4},generated,{multiple:true}).status,'limit');
});
test('多选清洗独立数组、去重与边界校验，旧单个配置不注入列表',()=>{
  const component={effectKind:'motion-trail'};const c=createDefaultEffectConfiguration(component);Object.assign(c.target,target);
  const clean=sanitizeEffectConfiguration(c,component);assert.deepEqual(clean.target.entityIds,['a','b','gone']);assert.equal(clean.target.selection,'all');assert.notEqual(clean.target.entityIds,c.target.entityIds);
  delete c.target.entityIds;assert.equal(sanitizeEffectConfiguration(c,component).target.entityIds,undefined);
  c.target.entityIds=Array.from({length:65},(_,i)=>'id'+i);assert.throws(()=>validateEffectConfiguration(c,'motion-trail'),/64/);
});
