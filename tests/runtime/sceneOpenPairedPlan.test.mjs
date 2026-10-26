import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeSceneOpenBase } from '../../scripts/lib/sceneOpenReadOnlyGuard.mjs';
import * as actualSceneResourceTraversal from '../../dist-electron/shared/sceneResourceTraversal.js';
import { createSceneOpenPairedSchedule, createFreshSceneOpenOutput, freezeSceneOpenInput, compareSceneOpenInputs,
  collectSceneOpenLocationPointers, readSceneOpenLogicalInput, summarizeSceneOpenMemory, collectSceneOpenAuthorizedExclusions,
  validateSceneOpenResolvedBaseline,collectSceneOpenLocationRules,hashSceneOpenReferencedFiles } from '../../scripts/lib/sceneOpenPairedPlan.mjs';

function typedAliasDocument(root='C:\\one'){
  const file=root+'\\Assets\\Models\\Model-123-layout\\m.glb',sourceKey='a'.repeat(64),revision='b'.repeat(64);
  const model={sourcePath:file,sourceUrl:'editor-asset://local/'+encodeURIComponent(file),assetRevision:revision,
    dataPlatformModel:{sourceKey,kind:'model',resourceId:'123',modelPath:'m.glb'}};
  return{scene:{entities:{e:{components:{modelGenerator:{defaultTarget:{kind:'model',assetId:file,modelAsset:structuredClone(model)}},
    clickEventBinding:{deviceSlots:[{deviceType:{...structuredClone(model),assetId:file}}]},modelAsset:{...structuredClone(model),parameterValues:{assetId:file}}}}},
    sceneSettings:{openingAnimation:{package:{id:'opening',version:'1.0.0',contentHash:'c'.repeat(64),manifestUrl:'editor-asset://local/'+encodeURIComponent(root+'\\Assets\\OpeningPackages\\opening\\1.0.0-'+'c'.repeat(64)+'\\manifest.json')}}}}};
}

test('typed manifest/defaultTarget和slot物理assetId别名可逆换根，参数同名字段与opaque ID保持业务值',()=>{
  const doc=typedAliasDocument(),pointers=collectSceneOpenLocationPointers(doc,actualSceneResourceTraversal),rules=collectSceneOpenLocationRules(doc,actualSceneResourceTraversal);
  const gen='/scene/entities/e/components/modelGenerator/defaultTarget/assetId',slot='/scene/entities/e/components/clickEventBinding/deviceSlots/0/deviceType/assetId',opening='/scene/sceneSettings/openingAnimation/package/manifestUrl';
  assert.ok(pointers.includes(gen));assert.ok(pointers.includes(slot));assert.ok(pointers.includes(opening));assert.equal(rules[gen].resourceId,'123');
  assert.ok(!pointers.includes('/scene/entities/e/components/modelAsset/parameterValues/assetId'));
  const moved=JSON.parse(JSON.stringify(doc).replaceAll('C:\\\\one','D:\\\\two').replaceAll('C%3A%5Cone','D%3A%5Ctwo'));
  // 业务参数仍须保持原值；它不能因为“长得像路径”就获得换根资格。
  moved.scene.entities.e.components.modelAsset.parameterValues.assetId=doc.scene.entities.e.components.modelAsset.parameterValues.assetId;
  const roots=[{tag:'project',path:'C:\\one'},{tag:'project',path:'D:\\two'}];
  const freeze=value=>freezeSceneOpenInput(Buffer.from(JSON.stringify(value)),{roots,locationPointers:collectSceneOpenLocationPointers(value,actualSceneResourceTraversal),locationRules:collectSceneOpenLocationRules(value,actualSceneResourceTraversal)});
  assert.equal(compareSceneOpenInputs(freeze(doc),freeze(moved)).equal,true);assert.equal(freeze(moved).reversible,true);
  moved.scene.entities.e.components.modelAsset.parameterValues.assetId='D:\\two\\business-change';assert.equal(compareSceneOpenInputs(freeze(doc),freeze(moved)).equal,false);
  const opaque=typedAliasDocument();opaque.scene.entities.e.components.modelGenerator.defaultTarget.assetId='opaque:model-123';
  assert.ok(!collectSceneOpenLocationPointers(opaque,actualSceneResourceTraversal).includes(gen));
});

test('assetId不匹配/相对/字段冲突/非default规则目标不获得typed别名资格，query及identity仍严格',()=>{
  const gen='/scene/entities/e/components/modelGenerator/defaultTarget/assetId',slot='/scene/entities/e/components/clickEventBinding/deviceSlots/0/deviceType/assetId';
  for(const mutate of [target=>{target.assetId='C:\\one\\other.glb';},target=>{target.assetId='relative.glb';},
    target=>{target.modelAsset.sourceUrl='editor-asset://local/'+encodeURIComponent('C:\\one\\different.glb');},target=>{target.kind='composition';}]){
    const doc=typedAliasDocument();mutate(doc.scene.entities.e.components.modelGenerator.defaultTarget);assert.ok(!collectSceneOpenLocationPointers(doc,actualSceneResourceTraversal).includes(gen));
  }
  const doc=typedAliasDocument();doc.scene.entities.e.components.modelGenerator.rules=[{target:structuredClone(doc.scene.entities.e.components.modelGenerator.defaultTarget)}];
  assert.ok(!collectSceneOpenLocationPointers(doc,actualSceneResourceTraversal).includes('/scene/entities/e/components/modelGenerator/rules/0/target/assetId'));
  const device=doc.scene.entities.e.components.clickEventBinding.deviceSlots[0].deviceType;device.assetId=device.sourceUrl+'?revision=one';device.sourceUrl+='?revision=one';
  assert.ok(collectSceneOpenLocationPointers(doc,actualSceneResourceTraversal).includes(slot));
  const options=value=>({roots:[{tag:'project',path:'C:\\one'}],locationPointers:collectSceneOpenLocationPointers(value,actualSceneResourceTraversal),locationRules:collectSceneOpenLocationRules(value,actualSceneResourceTraversal)});
  const first=freezeSceneOpenInput(Buffer.from(JSON.stringify(doc)),options(doc)),changed=structuredClone(doc);changed.scene.entities.e.components.clickEventBinding.deviceSlots[0].deviceType.assetId=changed.scene.entities.e.components.clickEventBinding.deviceSlots[0].deviceType.assetId.replace('=one','=two');
  assert.equal(compareSceneOpenInputs(first,freezeSceneOpenInput(Buffer.from(JSON.stringify(changed)),options(changed))).equal,false);
});

async function openingHashFixture(t){
  const root=await fs.mkdtemp(path.join(tmpdir(),'scene-open-opening-'));t.after(async()=>{assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('scene-open-opening-'));await fs.rm(root,{recursive:true,force:true});});
  const workspace=path.join(root,'workspace'),project=path.join(workspace,'project'),pkg={id:'opening',version:'1.0.0',contentHash:'c'.repeat(64)},directory=path.join(project,'Assets','OpeningPackages',pkg.id,pkg.version+'-'+pkg.contentHash);
  await fs.mkdir(path.join(directory,'assets'),{recursive:true});await fs.writeFile(path.join(directory,'manifest.json'),'{}');await fs.writeFile(path.join(directory,'assets','image.bin'),new Uint8Array([1,2,3]));
  await fs.mkdir(path.join(directory,'nested'));await fs.writeFile(path.join(directory,'nested','config.json'),'{}');await fs.writeFile(path.join(workspace,'not-referenced.txt'),'do not include');
  pkg.manifestUrl='editor-asset://local/'+encodeURIComponent(path.join(directory,'manifest.json'));const doc={scene:{entities:{},sceneSettings:{openingAnimation:{package:pkg}}}};
  const options={locationPointers:collectSceneOpenLocationPointers(doc,actualSceneResourceTraversal),workspaceRoot:workspace,projectRoot:project};
  return{root,workspace,project,directory,pkg,doc,options};
}

test('typed opening manifest hash覆盖精确版本包闭包，图片变化可见而不扫workspace兄弟',async t=>{
  const f=await openingHashFixture(t),first=await hashSceneOpenReferencedFiles(f.doc,f.options);assert.equal(first.length,3);
  assert.ok(first.every(row=>row.key.startsWith('@PROJECT/Assets/OpeningPackages/opening/1.0.0-')));assert.ok(!first.some(row=>row.key.includes('not-referenced')));
  const image=first.find(row=>row.key.endsWith('/assets/image.bin'));assert.equal(image.sha256,createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex'));
  await fs.writeFile(path.join(f.directory,'assets','image.bin'),new Uint8Array([4,5,6]));const second=await hashSceneOpenReferencedFiles(f.doc,f.options);assert.notEqual(second.find(row=>row.key===image.key).sha256,image.sha256);
});

test('opening hash拒绝错id/version/hash/manifest路径与越界，不把任意manifest扩成包',async t=>{
  const f=await openingHashFixture(t);
  for(const mutate of [p=>{p.id='other';},p=>{p.version='2.0.0';},p=>{p.contentHash='d'.repeat(64);},p=>{p.manifestUrl='editor-asset://local/'+encodeURIComponent(path.join(f.workspace,'manifest.json'));}]){
    const doc=structuredClone(f.doc);mutate(doc.scene.sceneSettings.openingAnimation.package);await assert.rejects(hashSceneOpenReferencedFiles(doc,f.options),/opening manifest路径/);
  }
  const outside=structuredClone(f.doc);outside.scene.sceneSettings.openingAnimation.package.manifestUrl='editor-asset://local/'+encodeURIComponent(path.join(f.root,'outside.json'));
  await assert.rejects(hashSceneOpenReferencedFiles(outside,f.options),/owned workspace以外/);
});

test('opening闭包拒绝内部junction/符号链接，目标在workspace内也不能穿越祖先链接',async t=>{
  const f=await openingHashFixture(t),target=path.join(f.workspace,'elsewhere');await fs.mkdir(target);await fs.writeFile(path.join(target,'secret.bin'),'x');
  const link=path.join(f.directory,'assets','linked');await fs.symlink(target,link,process.platform==='win32'?'junction':'dir');await assert.rejects(hashSceneOpenReferencedFiles(f.doc,f.options),/链接/);
  await fs.unlink(link);const moved=path.join(f.workspace,'relocated-package');await fs.rename(f.directory,moved);await fs.symlink(moved,f.directory,process.platform==='win32'?'junction':'dir');
  await assert.rejects(hashSceneOpenReferencedFiles(f.doc,f.options),/祖先含junction/);
});

async function bootstrapFixture({prepare=false,mainError=null}={}){
  const text=await fs.readFile(new URL('../../scripts/smoke-real-project-loading.mjs',import.meta.url),'utf8'),source=ts.createSourceFile('smoke.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='p0Bootstrap');assert.ok(declaration);
  const generate=vm.runInNewContext('('+declaration.getText(source)+')',{path,pathToFileURL,repo:process.cwd(),normalizeSceneOpenBase,
    values:{url:'http://172.16.3.27:38087','project-id':'2071816469849280514'}});
  const generated=generate({userData:'owned-user',workspace:'owned-workspace',artifact:'owned-artifact',prepare,source:'frozen.scene.json',manifest:{baseUrl:'http://172.16.3.27:38087',projectId:'2071816469849280514',downloads:[]}});
  const parsed=ts.createSourceFile('bootstrap.mjs',generated,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
  for(const statement of parsed.statements)if(ts.isImportDeclaration(statement))edits.push({start:statement.getStart(parsed),end:statement.end,text:''});
  const visit=node=>{if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)edits.push({start:node.expression.getStart(parsed),end:node.expression.end,text:'__e3Import'});ts.forEachChild(node,visit);};visit(parsed);
  let executable=generated;for(const edit of edits.sort((a,b)=>b.start-a.start))executable=executable.slice(0,edit.start)+edit.text+executable.slice(edit.end);
  let ready=false,emit;const readyPromise=new Promise(resolve=>{emit=()=>{ready=true;resolve();};}),events=[],writes=[],net={fetch:()=>{throw new Error('unguarded fetch');}};
  const switches=new Set();
  const app={setPath:()=>events.push('config'),commandLine:{appendSwitch:name=>switches.add(name),hasSwitch:name=>switches.has(name)},
    on(){},whenReady:()=>readyPromise,isReady:()=>ready,getAppMetrics:()=>[]};
  const context={app,net,BrowserWindow:{getAllWindows:()=>[]},path,createHash,Buffer,performance,process:{pid:123,memoryUsage:()=>({rss:1})},
    setInterval:()=>1,clearInterval(){},fs:{readFile:async()=>Buffer.from('{"scene":{}}'),writeFile:async(file,text)=>writes.push({file,text})},
    installSceneOpenNetGuard:()=>{events.push('guard');net.fetch=()=>events.push('guarded-fetch');return{setTrial(){}};},
    collectSceneOpenLocationPointers:()=>[],collectSceneOpenLocationRules:()=>({}),collectSceneOpenAuthorizedExclusions:()=>[],
    requestSceneOpenQueryJson:async()=>{events.push('query-ready:'+ready);return{success:true,data:{id:'2071816469849280514'}};},
    prepareSceneOpenReadOnlyManifest:async options=>{events.push('prepare-ready:'+ready);await options.query('api/v1/projects/detail',{id:options.projectId});return{status:'TRUSTED_METADATA_NOT_DOWNLOADED_NOT_BYTE_VERIFIED'};},
    __e3Import:async url=>{
      if(url.endsWith('/main.js')){events.push('main-ready:'+ready);assert.ok(events.includes('guard'),'guard must precede product import');
        if(ready)throw new Error('protocol.registerSchemesAsPrivileged should be called before app is ready');
        if(mainError)throw mainError;events.push('scheme-registered');net.fetch();return{};}
      if(url.endsWith('/sceneModelUpdatePlan.js'))return{planSceneModelUpdates:()=>[]};
      if(url.endsWith('/sceneEnvironmentReferences.js'))return{getRequiredEnvironmentResourceIds:()=>[]};return{};
    }};
  const module=vm.runInNewContext('(async()=>{'+executable+'\n})()',context);return{module,events,writes,context,emit,flush:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('formal bootstrap在ready前安装guard/config并导入产品注册scheme，不顶层等待ready',async()=>{
  const f=await bootstrapFixture();try{
    await f.module;assert.deepEqual(f.events.slice(0,4),['config','guard','main-ready:false','scheme-registered']);assert.ok(f.events.includes('guarded-fetch'));
    assert.equal(f.context.app.commandLine.hasSwitch('enable-precise-memory-info'),true);
    assert.equal(f.context.__e3P0.ready,false);f.emit();await f.flush();assert.equal(f.context.__e3P0.ready,true);assert.equal(f.context.__e3P0.error,null);
  }finally{f.emit();await f.flush();}
});

test('显式新运行基线只验证已批准的同一SOURCE/项目/修订和真实schema投影，不放宽旧比较',()=>{
  const resolved=Buffer.from(JSON.stringify({scene:{sourceKey:'new-source',assetRevision:'new-revision'}}));
  const derived={locationPointers:[],locationRules:{}},roots=[];
  const manifest={projectId:'1',inputSceneSha256:'1'.repeat(64),project:{source:{versionNumber:110},currentResourceRevision:'231'}};
  const baseline={status:'FROZEN_CURRENT_RESOLVED_BASELINE_NOT_PERFORMANCE_EVIDENCE',assetsByteVerified:true,
    projectId:'1',rawSourceSha256:manifest.inputSceneSha256,sourceVersionNumber:110,resourceRevision:'231',sourceArchiveSha256:'2'.repeat(64),
    resolvedLiveSha256:createHash('sha256').update(resolved).digest('hex'),...derived,roots:[{tag:'project',path:path.resolve('owned-fixture')}],
    resources:[{key:'@PROJECT/model.glb',bytes:32,sha256:'3'.repeat(64)}]};
  baseline.frozen=freezeSceneOpenInput(resolved,{...derived,roots:baseline.roots});
  assert.equal(validateSceneOpenResolvedBaseline(baseline,manifest,resolved,derived).projectionSha256,baseline.frozen.projectionSha256);
  const old=freezeSceneOpenInput(Buffer.from(JSON.stringify({scene:{sourceKey:'old-source',assetRevision:'old-revision'}})),{roots});
  assert.equal(compareSceneOpenInputs(old,baseline.frozen,{requireCanonicalSourceBytes:false}).equal,false,'旧基线不能被新口径静默重解释');
  for(const mutate of [b=>{b.projectId='2';},b=>{b.sourceVersionNumber=111;},b=>{b.resourceRevision='232';},b=>{b.rawSourceSha256='4'.repeat(64);},
    b=>{b.assetsByteVerified=false;},b=>{b.locationPointers=['/scene/assetRevision'];},b=>{b.frozen.projection.scene.assetRevision='ignored';},
    b=>{b.resources.push({...b.resources[0]});}]){
    const invalid=structuredClone(baseline);mutate(invalid);assert.throws(()=>validateSceneOpenResolvedBaseline(invalid,manifest,resolved,derived));
  }
  assert.throws(()=>validateSceneOpenResolvedBaseline(baseline,manifest,Buffer.from('{}'),derived));
});

test('POST-only prepare仍等ready后运行且永不导入产品main/创建窗口',async()=>{
  const f=await bootstrapFixture({prepare:true});await f.module;assert.equal(f.events.some(x=>x.startsWith('prepare-ready:')),false);
  f.emit();await f.flush();assert.ok(f.events.includes('prepare-ready:true'));assert.ok(f.events.includes('query-ready:true'));
  assert.equal(f.events.some(x=>x.startsWith('main-ready:')),false);assert.equal(f.context.__e3P0.createdWindowCount,0);assert.equal(f.context.__e3P0.ready,true);
});

test('产品pre-ready导入失败保留原native错误，能够报告ready错误而不挂到app.whenReady',async()=>{
  const f=await bootstrapFixture({mainError:new Error('original main registration failure')});try{await f.module;
    assert.match(f.context.__e3P0.error,/original main registration failure/);assert.equal(f.context.__e3P0.ready,true);
    assert.ok(f.writes.some(row=>row.file.endsWith('native-failure.json')&&row.text.includes('original main registration failure')));
  }finally{f.emit();await f.flush();}
});

async function reportUiFixture({enabled=false,expanded=false,copyError,failCopy=false}={}){
  const text=await fs.readFile(new URL('../../scripts/smoke-real-project-loading.mjs',import.meta.url),'utf8');
  const source=ts.createSourceFile('smoke.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='p0CopyPreparationReport');assert.ok(declaration);
  const state={enabled,expanded,realClipboardWrites:0},originalClipboard={writeText:()=>{state.realClipboardWrites++;}},navigator={};
  Object.defineProperty(navigator,'clipboard',{configurable:true,enumerable:true,writable:false,value:originalClipboard});
  const context=vm.createContext({window:{},navigator,assert});
  const run=vm.runInContext('('+declaration.getText(source)+')',context);
  const evaluate=fn=>vm.runInContext('('+fn.toString()+')()',context);
  const target={evaluate:async fn=>evaluate(fn),waitForFunction:async fn=>assert.equal(Boolean(evaluate(fn)),true),
    getByRole:()=>({count:async()=>1,isChecked:async()=>state.enabled,check:async()=>{state.enabled=true;},setChecked:async value=>{state.enabled=value;}}),
    locator:selector=>selector==='.scene-performance-summary'?{waitFor:async()=>assert.equal(state.enabled,true),
      getAttribute:async()=>String(state.expanded),click:async()=>{state.expanded=!state.expanded;}}
      :{click:async()=>{if(failCopy)throw copyError;await navigator.clipboard.writeText(JSON.stringify({scenePreparation:{completed:true}}));}}};
  return {state,target,run,navigator,originalClipboard};
}

test('复制准备报告后恢复原监控/展开状态与clipboard，不把额外GPU监控带入暖启动',async t=>{
  for(const enabled of [false,true])for(const expanded of [false,true])await t.test(enabled+'/'+expanded,async()=>{
    const f=await reportUiFixture({enabled,expanded}),report=await f.run(f.target);
    assert.equal(report.scenePreparation.completed,true);assert.equal(report.__e3CaptureUi.enabledBefore,enabled);assert.equal(report.__e3CaptureUi.enabledAfter,enabled);
    assert.equal(report.__e3CaptureUi.expandedBefore,String(expanded));assert.equal(report.__e3CaptureUi.expandedAfter,String(expanded));
    assert.equal(f.state.enabled,enabled);assert.equal(f.state.expanded,expanded);assert.ok(f.navigator.clipboard===f.originalClipboard);
    assert.equal(f.state.realClipboardWrites,0);
  });
});

test('复制报告失败仍精确恢复UI/clipboard，并保留原Error或falsy抛出值',async()=>{
  for(const failure of [new Error('original copy failed'),0]){
    const f=await reportUiFixture({copyError:failure,failCopy:true});let rejected=false;
    try{await f.run(f.target);}catch(error){rejected=true;assert.ok(error===failure);}
    assert.equal(rejected,true);assert.equal(f.state.enabled,false);assert.equal(f.state.expanded,false);
    assert.ok(f.navigator.clipboard===f.originalClipboard);assert.equal(f.state.realClipboardWrites,0);
  }
});

test('真实close方法使用事前ChildProcess/PID，Playwright handle销毁后不再访问process()', async () => {
  const text=await fs.readFile(new URL('../../scripts/smoke-real-project-loading.mjs',import.meta.url),'utf8');
  const source=ts.createSourceFile('smoke.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='p0CloseOwned');assert.ok(declaration);
  const writes=[], childProcess={exitCode:null}, identity={pid:12345,parentPid:1,creationDate:'2026-10-25T00:00:00.0000000Z'};
  let closed=false, forbiddenGetterCalls=0;
  const close=vm.runInNewContext('('+declaration.getText(source)+')',{path,writeFile:async(file,text)=>writes.push({file,document:JSON.parse(text)}),
    p0ReadOwnedProcesses:async()=>closed?[]:[identity]});
  const result=await close({mainPid:identity.pid,childProcess,observedProcesses:[identity],directory:'owned',application:{
    process(){forbiddenGetterCalls++;throw new Error('Playwright _object handle disposed');},async close(){closed=true;childProcess.exitCode=0;}}});
  assert.equal(result.status,'OBSERVED_OWNED_PROCESSES_CLOSED');assert.equal(result.mainPid,identity.pid);assert.equal(result.mainExitCode,0);assert.equal(forbiddenGetterCalls,0);
  assert.equal(writes.length,1);assert.equal(writes[0].document.status,'OBSERVED_OWNED_PROCESSES_CLOSED');
});

test('paired锁定C1/W1至C5/W5，独占output且拒绝覆盖/越界', async t => {
  assert.deepEqual(createSceneOpenPairedSchedule().map(row => row.name), ['C1', 'W1', 'C2', 'W2', 'C3', 'W3', 'C4', 'W4', 'C5', 'W5']);
  assert.throws(() => createSceneOpenPairedSchedule(0));
  const root = await fs.mkdtemp(path.join(tmpdir(), 'scene-open-paired-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('scene-open-paired-')); await fs.rm(root, { recursive: true, force: true }); });
  const output = path.join(root, 'run'); await createFreshSceneOpenOutput(output, root);
  await assert.rejects(createFreshSceneOpenOutput(output, root), /EEXIST/);
  await assert.rejects(createFreshSceneOpenOutput(root, root), /新目录/);
  await assert.rejects(createFreshSceneOpenOutput(path.join(root, '..', 'other'), root), /新目录/);
});

test('完整Location投影可逆；参数同名sourcePath、assetRevision、负零/query变化都不能忽略', () => {
  const input = { version: 6, scene: { entities: { e: { components: { modelAsset: { sourcePath: 'C:\\source\\Assets\\Models\\m.glb',
    sourceUrl: 'editor-asset://local/' + encodeURIComponent('C:\\source\\Assets\\Models\\m.glb') + '?assetRevision=old', assetRevision: 'old',
    parameterValues: { sourcePath: 'C:\\source\\business-string', value: -0 } } } } } } };
  const pointers = ['/scene/entities/e/components/modelAsset/sourcePath', '/scene/entities/e/components/modelAsset/sourceUrl'];
  const roots = [{ tag: 'project', path: 'C:\\source' }, { tag: 'project', path: 'D:\\owned' }];
  const encode = value => Buffer.from(JSON.stringify(value).replace('"value":0', '"value":-0'));
  const freeze = value => freezeSceneOpenInput(encode(value), { roots, locationPointers: pointers });
  const before = freeze(input), clone = structuredClone(input), asset = clone.scene.entities.e.components.modelAsset;
  asset.sourcePath = 'D:\\owned\\Assets\\Models\\m.glb'; asset.sourceUrl = 'editor-asset://local/' + encodeURIComponent(asset.sourcePath) + '?assetRevision=old';
  assert.equal(compareSceneOpenInputs(before, freeze(clone)).equal, true); assert.equal(before.reversible, true);
  for (const mutate of [value => { value.assetRevision = 'new'; }, value => { value.parameterValues.sourcePath = 'D:\\owned\\business-string'; },
    value => { value.sourceUrl = value.sourceUrl.replace('=old', '=new'); }]) {
    const changed = structuredClone(clone); mutate(changed.scene.entities.e.components.modelAsset);
    assert.equal(compareSceneOpenInputs(before, freeze(changed)).equal, false);
  }
  const zero = Buffer.from(encode(input).toString('utf8').replace('"value":-0', '"value":0'));
  assert.equal(compareSceneOpenInputs(before, freezeSceneOpenInput(zero, { roots, locationPointers: pointers })).equal, false);
});

test('project→同修订immutable pin属于可逆Location；物理sourceKey/revision或Assets后缀变化拒绝', () => {
  const sourceKey = 'a'.repeat(64), revision = 'b'.repeat(64), pointer = '/scene/model/sourcePath';
  const roots = [{ tag: 'project', path: 'C:\\source' }, { tag: 'workspace', path: 'D:\\owned' }];
  const rule = { kind: 'model', sourceKey, resourceId: '90071992547409931', revision };
  const old = { scene: { model: { sourcePath: 'C:\\source\\Assets\\Models\\Model-1-layout\\m.glb', assetRevision: revision } } };
  const actual = structuredClone(old); actual.scene.model.sourcePath = `D:\\owned\\SharedResources\\.babylon-editor\\scene-model-versions\\${sourceKey}\\${revision}\\Assets\\Models\\Model-1-layout\\m.glb`;
  const freeze = value => freezeSceneOpenInput(Buffer.from(JSON.stringify(value)), { roots, locationPointers: [pointer], locationRules: { [pointer]: rule } });
  assert.equal(compareSceneOpenInputs(freeze(old), freeze(actual)).equal, true);
  const changed = structuredClone(actual); changed.scene.model.sourcePath = changed.scene.model.sourcePath.replace(revision, 'c'.repeat(64));
  assert.throws(() => freeze(changed), /物理pin修订变化/);
  const filename = structuredClone(actual); filename.scene.model.sourcePath = filename.scene.model.sourcePath.replace('m.glb', 'other.glb');
  assert.equal(compareSceneOpenInputs(freeze(old), freeze(filename)).equal, false);
});

test('资源pointer只来自schema owner；不能扫描业务parameterValues的同名字段', () => {
  const owner = { sourcePath: 'C:\\source\\m.glb', parameterValues: { sourcePath: 'business' } };
  const envelope = { scene: { entities: { e: { components: { modelAsset: owner } } } } };
  const traversal = { collectSceneResourceReferences: () => ({ models: [{ asset: owner }], environments: [], skyboxes: [], cadReferences: [], images: [], entityResources: [], clickEventBindings: [] }),
    collectLightingPolicyResourceModels: () => [], collectLocalSceneResourceFields: value => [{ parent: value, key: 'sourcePath' }] };
  assert.deepEqual(collectSceneOpenLocationPointers(envelope, traversal), ['/scene/entities/e/components/modelAsset/sourcePath']);
});

test('当前逻辑scene reader拒绝旧ref选配和多个不同selector当前值', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  const scene = { entityIds: ['e'], entities: { e: { value: -0 } }, sceneSettings: {} }, old = structuredClone(scene);
  const first = { memoizedState: scene, queue: { getSnapshot: () => scene }, next: { memoizedState: { current: old }, next: null } };
  const fiber = { memoizedState: first }, element = { __reactContainer$test: { stateNode: { current: fiber } } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => element } });
  const result = readSceneOpenLogicalInput(); assert.ok(Object.is(JSON.parse(result.text).scene.entities.e.value, -0));
  first.next = { memoizedState: old, queue: { getSnapshot: () => old } };
  assert.throws(() => readSceneOpenLogicalInput(), /AMBIGUOUS/);
});

test('进程峰值之和不冒充同刻峰值，未知heap/GPU upload/VRAM保持null', () => {
  const result = summarizeSceneOpenMemory([{ processes: [{ pid: 1, creationTime: 10, workingSetBytes: 100, peakWorkingSetBytes: 100 },
    { pid: 2, creationTime: 20, type: 'GPU', workingSetBytes: 200, peakWorkingSetBytes: 900 }], rendererHeapBytes: 0 },
  { processes: [{ pid: 1, creationTime: 10, workingSetBytes: 500, peakWorkingSetBytes: 500 }, { pid: 2, creationTime: 20, workingSetBytes: 100, peakWorkingSetBytes: 900 }] }]);
  assert.equal(result.simultaneousWorkingSetMaxObservedBytes, 600); assert.equal(result.sumPerProcessLifetimePeaksUpperBoundBytes, 1400);
  assert.equal(result.rendererHeapMaxObservedBytes, null); assert.equal(result.gpuUploadDurationMs, null); assert.equal(result.gpuVramPeakBytes, null);
});

test('只列用户授权screen2100824337532211202与精确旧MQTT，其它组件不删除', () => {
  const scene = { entities: { a: { components: { dataPlatformScreen: { screenId: '2100824337532211202', screenUrl: 'http://old/#/preview/2100824337532211202', thumbnailUrl: 'http://old/exact.png' } } },
    b: { components: { dataPlatformScreen: { screenId: 'other', screenUrl: 'http://other/' } } } }, mqttConfig: { address: 'ws://192.168.18.100:8083/mqtt' } };
  const before = JSON.stringify(scene), result = collectSceneOpenAuthorizedExclusions({ scene });
  assert.equal(result.length, 3); assert.equal(JSON.stringify(scene), before); assert.ok(result.every(row => row.url !== 'http://other/'));
});
