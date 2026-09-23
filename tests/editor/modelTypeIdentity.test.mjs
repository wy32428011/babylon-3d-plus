import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const root = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(s,c,next) {
  if (s.startsWith('.') && c.parentURL?.startsWith(root.href)) {
    const candidate = new URL(s.endsWith('.js') ? s.slice(0,-3)+'.ts' : s+'.ts', c.parentURL);
    if (existsSync(candidate)) return {url:candidate.href,shortCircuit:true};
  } return next(s,c);
}, load(u,c,next) {
  if (/\.(png|svg|jpg|webp)$/.test(u)) return {format:'module',shortCircuit:true,source:`export default ${JSON.stringify(u)}`};
  if (u.startsWith(root.href) && u.endsWith('.ts') && !u.includes('/node_modules/')) return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};
  return next(u,c);
}});
const {createModelTypeIdentityFromAsset,matchesModelTypeReference,modelTypePathKey} = await import('../../electron/shared/modelTypeIdentity.ts');
const {createModelGeneratorTargetFromAsset} = await import('../../src/editor/model/modelGenerator.ts');
const {applySceneModelUpdates} = await import('../../src/editor/assets/applySceneModelUpdates.ts');
const {applyPublishModelIdentityReplacements} = await import('../../electron/shared/publishResourceIdentityMigration.ts');
hooks.deregister();
const asset = {id:'template',name:'模板',kind:'model',libraryKind:'model',path:'C:/Assets/Models/Combo-42-test/parts/motor.glb',sourceUrl:'editor-asset://local/'+encodeURIComponent('C:/Assets/Models/Combo-42-test/parts/motor.glb'),dataPlatformSourceKey:'a'.repeat(64)};
test('从模型库独立构建完整类型身份，不需要编辑态实例',()=>{
  const identity = createModelTypeIdentityFromAsset(asset);
  assert.deepEqual(identity,{sourceKey:'a'.repeat(64),kind:'combo',resourceId:'42',modelPath:'parts/motor.glb'});
  assert.deepEqual(createModelGeneratorTargetFromAsset(asset).modelAsset.dataPlatformModel,identity);
});
test('类型身份区分来源、组合和子模型，且拒绝不完整来源猜测',()=>{
  const identity = createModelTypeIdentityFromAsset(asset);
  const reference = {sourcePath:asset.path,sourceUrl:asset.sourceUrl,identity};
  const model = {sourcePath:'D:/moved.glb',sourceUrl:'editor-asset://local/moved',dataPlatformModel:identity};
  assert.equal(matchesModelTypeReference(model,reference),true);
  for(const field of [{sourceKey:'b'.repeat(64)},{kind:'model'},{resourceId:'43'},{modelPath:'parts/other.glb'}]) assert.equal(matchesModelTypeReference({...model,dataPlatformModel:{...identity,...field}},reference),false);
  assert.equal(createModelTypeIdentityFromAsset({...asset,dataPlatformSourceKey:undefined}),undefined);
});
test('本地类型按规范资源位置匹配，不使用名称和修订缓存参数',()=>{
  assert.equal(modelTypePathKey('editor-asset://local/'+encodeURIComponent('C:\\Models\\Device.glb')+'?v=2'),'c:/models/device.glb');
  assert.equal(matchesModelTypeReference({sourcePath:'C:/models/device.glb',sourceUrl:''},{sourcePath:'C:\\Models\\Device.glb',sourceUrl:''}),true);
  assert.equal(matchesModelTypeReference({sourcePath:'C:/other/device.glb',sourceUrl:''},{sourcePath:'C:/models/device.glb',sourceUrl:''}),false);
});
test('同资源更新同时迁移生成器和类型引用，不跨来源改绑且保留原文档',()=>{
  const target=createModelGeneratorTargetFromAsset(asset), identity=target.modelAsset.dataPlatformModel;
  const reference={name:'类型A',sourcePath:asset.path,sourceUrl:asset.sourceUrl,identity};
  const scene={entities:{generator:{components:{modelGenerator:{defaultTarget:target,rules:[]}}},fx:{components:{poiEffect:{configuration:{target:{model:reference}}}}},other:{components:{poiEffect:{configuration:{target:{model:{...reference,identity:{...identity,sourceKey:'b'.repeat(64)}}}}}}}},entityIds:['generator','fx','other'],sceneSettings:{}};
  const updated={...asset,path:'D:/cache/Combo-42-new/parts/motor.glb',sourceUrl:'editor-asset://local/'+encodeURIComponent('D:/cache/Combo-42-new/parts/motor.glb'),assetRevision:'2'};
  const {scene:result}=applySceneModelUpdates(scene,[{sourceUrls:[asset.sourceUrl],asset:updated}],identity.sourceKey);
  assert.equal(result.entities.generator.components.modelGenerator.defaultTarget.modelAsset.sourcePath,updated.path);
  assert.equal(result.entities.fx.components.poiEffect.configuration.target.model.sourcePath,updated.path);
  assert.equal(result.entities.other.components.poiEffect.configuration.target.model.sourcePath,asset.path);
  assert.equal(scene.entities.fx.components.poiEffect.configuration.target.model.sourcePath,asset.path);
});
test('生产规则已切换其他类型时，不以生成器位置将旧类型引用迁移',()=>{
  const target=createModelGeneratorTargetFromAsset(asset), identity=target.modelAsset.dataPlatformModel;
  const oldReference={name:'旧类型',sourcePath:'C:/old/model.glb',sourceUrl:'editor-asset://local/old',identity:{...identity,resourceId:'41'}};
  const scene={entities:{generator:{components:{modelGenerator:{defaultTarget:target,rules:[]}}},fx:{components:{poiEffect:{configuration:{target:{model:oldReference}}}}}},entityIds:['generator','fx'],sceneSettings:{}};
  const updated={...asset,path:'D:/cache/Combo-42-new/parts/motor.glb',sourceUrl:'editor-asset://local/'+encodeURIComponent('D:/cache/Combo-42-new/parts/motor.glb')};
  const {scene:result}=applySceneModelUpdates(scene,[{sourceUrls:[asset.sourceUrl],asset:updated}],identity.sourceKey);
  assert.deepEqual(result.entities.fx.components.poiEffect.configuration.target.model,oldReference);
});
test('发布已验证身份迁移同步跟随类型，未匹配来源仍保留原身份',()=>{
  const target=createModelGeneratorTargetFromAsset({...asset,assetRevision:'c'.repeat(64)}),identity=target.modelAsset.dataPlatformModel;
  const reference={name:'类型A',sourcePath:asset.path,sourceUrl:asset.sourceUrl,identity};
  const document={scene:{entities:{generator:{components:{modelGenerator:{defaultTarget:target,rules:[]}}},fx:{components:{poiEffect:{configuration:{target:{model:reference}}}}},other:{components:{poiEffect:{configuration:{target:{model:{...reference,identity:{...identity,sourceKey:'e'.repeat(64)}}}}}}}}}};
  const migrated={...asset,path:'D:/moved/Combo-99-test/parts/motor.glb',sourceUrl:'editor-asset://local/'+encodeURIComponent('D:/moved/Combo-99-test/parts/motor.glb'),dataPlatformResourceId:'99',dataPlatformSourceKey:'b'.repeat(64),assetRevision:'c'.repeat(64)};
  const result=JSON.parse(applyPublishModelIdentityReplacements(JSON.stringify(document),{replacements:[{sourceUrls:[asset.sourceUrl],asset:migrated}]}));
  assert.deepEqual(result.scene.entities.fx.components.poiEffect.configuration.target.model.identity,{...identity,sourceKey:'b'.repeat(64),resourceId:'99'});
  assert.equal(result.scene.entities.fx.components.poiEffect.configuration.target.model.sourceUrl,migrated.sourceUrl);
  assert.equal(result.scene.entities.other.components.poiEffect.configuration.target.model.identity.sourceKey,'e'.repeat(64));
});
