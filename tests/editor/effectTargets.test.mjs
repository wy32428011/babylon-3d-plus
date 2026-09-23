import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const root=new URL('../../',import.meta.url);
const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)){const u=new URL(s.endsWith('.js')?s.slice(0,-3):s,c.parentURL);if(!existsSync(u)&&existsSync(new URL(u.href+'.ts')))return next(u.href+'.ts',c);}return next(s,c);},load(u,c,next){if(u.startsWith(root.href)&&u.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}});
const {resolveEffectTargets}=await import('../../src/editor/model/effectTargets.ts');hooks.deregister();
const identity={sourceKey:'factory',kind:'model',resourceId:'123',modelPath:'main.glb'};
function entity(id,assetCode,sourceId='default',resourceId='123'){return{id,name:id,components:{modelAsset:{sourcePath:'C:/old/main.glb',sourceUrl:'editor-asset://local/old',assetCode,dataPlatformModel:{...identity,resourceId},dataDrivenConfig:{device:{devType:'rgv'}}},telemetryBinding:{enabled:true,sourceId,deviceType:'rgv',assetCode}}};}
const entities={one:entity('one','000317'),two:entity('two','000317','second'),three:entity('three','000318')};
const scene={entityIds:Object.keys(entities),entities,sceneSettings:{environment:null}};
const target={mode:'model',entityId:null,model:{name:'RGV',sourcePath:'C:/new/main.glb',sourceUrl:'editor-asset://local/new',identity},sourceId:'',deviceType:'rgv',assetCode:'',selection:'single',maxTargets:32,anchor:'origin',nodePath:'',offset:{x:0,y:0,z:0}};
test('模型库资源按稳定身份匹配，不依赖变更的URL',()=>{const r=resolveEffectTargets(scene,{...target,selection:'all'},'model-outline');assert.deepEqual(r.ids,['one','two','three']);});
test('跟随必须唯一，来源和前导零资产号精确隔离',()=>{assert.equal(resolveEffectTargets(scene,target,'target-follow').status,'ambiguous');const r=resolveEffectTargets(scene,{...target,assetCode:'000317',sourceId:'second'},'target-follow');assert.deepEqual(r.ids,['two']);assert.equal(resolveEffectTargets(scene,{...target,assetCode:'317'},'target-follow').status,'missing-target');});
test('单个相机不能通过全部实例绕过歧义，超限不能静默截断',()=>{assert.equal(resolveEffectTargets(scene,{...target,selection:'all'},'target-follow').status,'ambiguous');assert.equal(resolveEffectTargets(scene,{...target,selection:'all',maxTargets:2},'model-outline').status,'limit');});
test('缺失环境和实体不创建替代目标',()=>{assert.equal(resolveEffectTargets(scene,{...target,mode:'environment'},'model-outline').status,'missing-target');assert.equal(resolveEffectTargets(scene,{...target,mode:'entity',entityId:'gone'},'target-follow').status,'missing-target');assert.equal(scene.entityIds.length,3);});
test('本地资源迁移通过场景身份证据保持模板匹配，冲突不猜测',()=>{
  const local=structuredClone(scene);for(const entity of Object.values(local.entities)){delete entity.components.modelAsset.dataPlatformModel;entity.components.modelAsset.sourcePath='D:/published/renamed.glb';entity.components.modelAsset.sourceUrl='editor-asset://local/new';}
  const binding={...target,model:{name:'本地模板',sourcePath:'C:/old/main.glb',sourceUrl:'editor-asset://local/old',entityIds:['one','two']},selection:'all'};
  assert.equal(resolveEffectTargets(local,binding,'model-outline').ids.length,3);
  local.entities.two.components.modelAsset.sourcePath='D:/other.glb';
  assert.equal(resolveEffectTargets(local,binding,'model-outline').status,'ambiguous');
});
