import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url), { app } = electron;
const root = await mkdtemp(path.join(tmpdir(), 'effect-configuration-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
async function cleanup() {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('effect-configuration-packages-')) throw new Error('拒绝清理特效包测试目录之外的路径');
  await rm(root, { recursive: true, force: true });
}
const deadline = setTimeout(() => { console.error('特效 V2 SOURCE/DIST ZIP 验证超时'); abortController.abort(); void cleanup().catch(console.error).finally(() => app.exit(1)); }, 120000);

function effects(document) {
  return Object.values(document.scene.entities).filter(entity => entity.components.poiEffect?.configuration).map(entity => ({ id: entity.id, transform: entity.components.transform, effect: entity.components.poiEffect })).sort((a, b) => a.id.localeCompare(b.id));
}
function assertSafeConfigurations(document) {
  const visit = (value, prefix) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(/^(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|headers)$/i.test(key), false, `${prefix}.${key} 不应存放凭据`);
      visit(child, `${prefix}.${key}`);
    }
  };
  for (const { effect } of effects(document)) {
    assert.equal(effect.configuration.version, 2);
    assert.deepEqual(Object.keys(effect.configuration.data.http).sort(), ['dataSourceId', 'mode', 'namespace', 'pollIntervalMs', 'timeoutMs'].sort());
    assert.equal(effect.configuration.data.assetCode.startsWith('000'), true, '资产编号应保留前导零');
    visit(effect.configuration, effect.effectKind);
  }
}

async function run() {
  let code = 1;
  try {
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const unzipper = require('unzipper');
    const {normalizeEffectDeploymentReferences}=await import('../../dist-electron/shared/effectDeploymentReferences.js');
    const output = path.resolve('output/effect-configuration');
    const content = await readFile(path.join(output, 'scene.scene.json'), 'utf8'), original = JSON.parse(content);
    assert.equal(effects(original).length, 46, '先运行 effectConfiguration.integration.test.mjs 生成全部 46 类特效场景');
    assert.equal(Object.values(original.scene.entities).some(entity => entity.components.modelAsset), false, '双包测试使用普通 cube，不能加载外部模型');
    assertSafeConfigurations(original);
    const projectRoot = path.join(root, 'project'), entrySceneFilePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
    await mkdir(path.dirname(entrySceneFilePath), { recursive: true }); await writeFile(entrySceneFilePath, content, 'utf8');
    const second = structuredClone(original); second.scene.name = 'V2 独立最新遥测与数据集';
    for (const entity of Object.values(second.scene.entities)) {
      const effect = entity.components.poiEffect; if (!effect?.configuration) continue;
      effect.configuration.data.mode = 'http'; effect.configuration.data.http.mode = 'mqtt-latest';
      effect.configuration.data.http.namespace = 'second-space'; effect.configuration.data.assetCode = '000318';
      effect.configuration.data.missing = 'hold'; effect.configuration.data.dataset.coordinateSpace = 'local'; effect.configuration.data.dataset.unitScale = 1;
      effect.configuration.data.trigger.debounceMs = 0;
    }
    const secondContent = JSON.stringify(second); const secondFile = path.join(projectRoot, 'Scenes', 'second.scene.json');
    await writeFile(secondFile, secondContent, 'utf8');
    const sourcePackage = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath,
      outputRoot: path.join(root, 'source-output'), signal: abortController.signal,
      manifest: { projectId: '123', projectName: '特效 V2 配置验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    const distPackage = await buildDigitalTwinDistPackage({ projectId: '123', publishName: '特效 V2 配置验收', sceneContent: sourcePackage.entrySceneContent,
      sourceResourceFiles: sourcePackage.resourceFiles, outputRoot: path.join(root, 'dist-output'), signal: abortController.signal });
    const sourceArchive = await unzipper.Open.file(sourcePackage.filePath), distArchive = await unzipper.Open.file(distPackage.filePath);
    async function readEntry(archive, name) {
      const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === name); assert.ok(entry, `ZIP 缺少 ${name}`);
      return JSON.parse((await entry.buffer()).toString('utf8'));
    }
    const sourceMain = await readEntry(sourceArchive, 'Scenes/main.scene.json'), sourceSecond = await readEntry(sourceArchive, 'Scenes/second.scene.json');
    const distScene = await readEntry(distArchive, 'project/scene.json');
    assert.deepEqual(effects(sourceMain), effects(original), 'SOURCE 入口场景完整配置');
    assert.deepEqual(effects(sourceSecond), effects(second), 'SOURCE 第二场景独立数据绑定');
    const runtimeExpected=structuredClone(original);normalizeEffectDeploymentReferences(runtimeExpected.scene);
    assert.deepEqual(effects(distScene), effects(runtimeExpected), 'DIST保留有效配置并移除编辑态路径');
    for (const document of [sourceMain, sourceSecond, distScene]) assertSafeConfigurations(document);
    assert.equal(await readFile(entrySceneFilePath, 'utf8'), content, '构建不能修改源入口文件');
    assert.equal(await readFile(secondFile, 'utf8'), secondContent, '构建不能修改其他源场景');
    assert.deepEqual(sourcePackage.resourceFiles.filter(file => /fixture-metadata-only|rgv\.glb/i.test(JSON.stringify(file))), [], '匹配模板元数据不能变成需要加载的外部资源');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'packaged-source.scene.json'), JSON.stringify(sourceMain, null, 2), 'utf8');
    await writeFile(path.join(output, 'packaged-dist.scene.json'), JSON.stringify(distScene, null, 2), 'utf8');
    const smoke=structuredClone(distScene);
    for(const entity of Object.values(smoke.scene.entities)){
      const effect=entity.components.poiEffect;if(!effect)continue;
      const active=effect.effectKind==='data-bars';entity.visible=active;effect.enabled=active;
      if(active){
        entity.components.transform.position={x:0,y:0,z:0};
        effect.configuration.target.mode='point';effect.configuration.target.entityId=null;
        effect.configuration.parameters={};effect.configuration.data.mode='http';
        effect.configuration.data.http={mode:'data-source',dataSourceId:'42',namespace:'',pollIntervalMs:1000,timeoutMs:5000};
        effect.configuration.data.assetCode='000317';effect.configuration.data.mappings=[];effect.configuration.data.trigger.enabled=false;
        effect.configuration.data.dataset={enabled:true,rowsPath:'rows',idPath:'id',xPath:'x',yPath:'y',zPath:'z',valuePath:'value',labelPath:'name',unitScale:1,coordinateSpace:'local'};
      }
    }
    const smokePackage=await buildDigitalTwinDistPackage({projectId:'123',publishName:'特效数据 Viewer 验收',sceneContent:JSON.stringify(smoke),sourceResourceFiles:sourcePackage.resourceFiles,outputRoot:path.join(root,'smoke-output'),signal:abortController.signal});
    const smokeArchive=await unzipper.Open.file(smokePackage.filePath),viewerRoot=path.join(output,'viewer');
    for(const entry of smokeArchive.files){const destination=path.resolve(viewerRoot,entry.path),relative=path.relative(viewerRoot,destination);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
      if(entry.type==='Directory')await mkdir(destination,{recursive:true});else{await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,await entry.buffer());}}
    const report = { ok: true, effectCount: effects(original).length, sourceScenes: 2, sourceBytes: (await stat(sourcePackage.filePath)).size,
      distBytes: (await stat(distPackage.filePath)).size, distFiles: distPackage.fileCount,
      checks: ['SOURCE-entry-all-v2-fields', 'SOURCE-second-independent-data', 'DIST-all-v2-fields', 'string-asset-id', 'no-http-credentials', 'metadata-only-template', 'source-not-mutated'] };
    await writeFile(path.join(output, 'packages-result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2)); code = 0;
  } catch (error) { console.error(error); }
  finally { clearTimeout(deadline); try { await cleanup(); } catch (error) { console.error(error); code = 1; } app.exit(code); }
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
