import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import electron from 'electron';
import ts from 'typescript';

const require = createRequire(import.meta.url), { app } = electron;
const output = path.resolve('output/effect-configuration');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, 'template-packages-'));
app.setPath('userData', path.join(temporary, 'user-data'));
app.getAppPath = () => process.cwd();
const controller = new AbortController();
const projectUrl = new URL('../../', import.meta.url);

async function loadResolver() {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(projectUrl.href)) {
        const candidate = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(projectUrl.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
      };
      return next(url, context);
    },
  });
  try { return await import('../../src/editor/model/effectTargets.ts'); }
  finally { hooks.deregister(); }
}

async function cleanup() {
  const resolvedOutput = await realpath(output), resolvedTemporary = await realpath(temporary);
  const relative = path.relative(resolvedOutput, resolvedTemporary);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolvedTemporary).startsWith('template-packages-')) throw new Error('拒绝清理模板发布测试目录之外的路径');
  await rm(resolvedTemporary, { recursive: true, force: true });
}
const deadline = setTimeout(() => {
  controller.abort(); console.error('模型模板绑定 SOURCE/DIST 验证超时');
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 120000);

const digest = value => createHash('sha256').update(value).digest('hex');
const entityValues = document => Object.values(document.scene.entities);
const followEntity = document => entityValues(document).find(entity => entity.components.poiEffect?.effectKind === 'target-follow');
const modelEntities = document => entityValues(document).filter(entity => entity.components.modelAsset);
const portable = value => value.replace(/\\/g, '/');

async function run() {
  let code = 1;
  try {
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const { authorizeAssetFile } = await import('../../dist-electron/ipc/assetRegistry.js');
    const { resolveEffectTargets, effectDeviceIdentity } = await loadResolver();
    const unzipper = require('unzipper');
    const fixturePath = path.join(output, 'editor-binding.scene.json'), modelPath = path.join(output, 'device.glb');
    const content = await readFile(fixturePath, 'utf8'), original = JSON.parse(content), modelBytes = await readFile(modelPath);
    const originalEffect = followEntity(original);
    assert.ok(originalEffect, '先生成真实编辑器模板绑定场景'); assert.equal(modelEntities(original).length, 3);
    const originalConfiguration = originalEffect.components.poiEffect.configuration;
    assert.equal(originalConfiguration.target.mode, 'model'); assert.equal(originalConfiguration.target.sourceId, 'source-A');
    assert.equal(originalConfiguration.target.deviceType, 'device'); assert.equal(originalConfiguration.target.assetCode, '000317');
    if (originalConfiguration.target.model.entityIds) assert.equal(originalConfiguration.target.model.entityIds.length, 3);
    assert.ok(!originalConfiguration.target.model.identity, '该 fixture 应覆盖本地模板资源，而非中台身份的替代匹配路径');
    assert.equal(digest(await readFile(originalConfiguration.target.model.sourcePath)), digest(modelBytes));
    const targetId = modelEntities(original).find(entity => {
      const identity = effectDeviceIdentity(entity); return identity.sourceId === 'source-A' && identity.deviceType === 'device' && identity.assetCode === '000317';
    }).id;

    function assertUniqueMatch(document, label) {
      const effect = followEntity(document).components.poiEffect;
      const result = resolveEffectTargets(document.scene, effect.configuration.target, effect.effectKind);
      assert.equal(result.status, 'resolved', `${label}: ${result.message}`); assert.deepEqual(result.ids, [targetId], label);
      assert.deepEqual(effectDeviceIdentity(document.scene.entities[result.ids[0]]), { sourceId: 'source-A', deviceType: 'device', assetCode: '000317' }, label);

    }
    assertUniqueMatch(original, '原始编辑器场景');
    const projectRoot = path.join(temporary, 'project'), sceneFile = path.join(projectRoot, 'Scenes', 'main.scene.json');
    const projectModel = path.join(projectRoot, 'Assets', 'Models', 'device.glb');
    await mkdir(path.dirname(projectModel), { recursive: true }); await copyFile(modelPath, projectModel);
    // 独立 Electron 会话需重建与编辑器资产选择相同的单文件授权；模型与输出目录互为兄弟，避免递归导出。
    authorizeAssetFile(projectModel);
    const relocated = structuredClone(original);
    for (const entity of modelEntities(relocated)) {
      entity.components.modelAsset.sourcePath = projectModel;
      entity.components.modelAsset.sourceUrl = `editor-asset://local/${encodeURIComponent(projectModel)}`;
    }
    // 新配置独立保存类型位置；工程复制时与实际模型使用同一资源映射。
    const relocatedReference = followEntity(relocated).components.poiEffect.configuration.target.model;
    Object.assign(relocatedReference, { sourcePath: projectModel, sourceUrl: `editor-asset://local/${encodeURIComponent(projectModel)}` });
    delete relocatedReference.entityIds;
    const relocatedContent = JSON.stringify(relocated);
    assertUniqueMatch(relocated, '模型文件搬迁后的本地项目');
    await mkdir(path.dirname(sceneFile), { recursive: true }); await writeFile(sceneFile, relocatedContent, 'utf8');

    // 参考实体证据仍有效时，模板元数据本身不应触发加载或打包不存在的 GLB。
    const metadataOnly = structuredClone(relocated);
    const metadataTemplate = followEntity(metadataOnly).components.poiEffect.configuration.target.model;
    metadataTemplate.entityIds = modelEntities(metadataOnly).map(entity => entity.id);
    metadataTemplate.sourcePath = path.join(temporary, 'not-a-loadable-resource', 'metadata-only-template.glb');
    metadataTemplate.sourceUrl = `editor-asset://local/${encodeURIComponent(metadataTemplate.sourcePath)}`;
    const metadataContent = JSON.stringify(metadataOnly), metadataFile = path.join(projectRoot, 'Scenes', 'metadata-only.scene.json');
    await writeFile(metadataFile, metadataContent, 'utf8');
    assert.equal(existsSync(metadataTemplate.sourcePath), false);

    const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(temporary, 'shared'), entrySceneFilePath: sceneFile,
      outputRoot: path.join(temporary, 'source-output'), signal: controller.signal,
      manifest: { projectId: '123', projectName: '真实模板绑定发布验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: '真实模板绑定发布验收', sceneContent: source.entrySceneContent,
      sourceResourceFiles: source.resourceFiles, outputRoot: path.join(temporary, 'dist-output'), signal: controller.signal });
    const sourceZip = await unzipper.Open.file(source.filePath), distZip = await unzipper.Open.file(dist.filePath);
    const readScene = async (archive, name) => {
      const entry = archive.files.find(file => portable(file.path) === name); assert.ok(entry, `ZIP 缺少 ${name}`);
      return JSON.parse((await entry.buffer()).toString('utf8'));
    };
    const sourceScene = await readScene(sourceZip, 'Scenes/main.scene.json');
    const sourceMetadata = await readScene(sourceZip, 'Scenes/metadata-only.scene.json');
    const distScene = await readScene(distZip, 'project/scene.json');
    for (const [label, document] of [['SOURCE', sourceScene], ['SOURCE metadata-only', sourceMetadata], ['DIST', distScene]]) assertUniqueMatch(document, label);
    assert.equal(followEntity(sourceScene).components.poiEffect.configuration.target.model.sourcePath, modelEntities(sourceScene)[0].components.modelAsset.sourcePath, 'SOURCE 类型与实际模型使用同一资源映射');
    assert.equal(followEntity(sourceMetadata).components.poiEffect.configuration.target.model.sourcePath, modelEntities(sourceMetadata)[0].components.modelAsset.sourcePath, 'SOURCE 兼容旧实体搬迁证据且不加载陈旧模板路径');
    assert.ok(modelEntities(sourceScene).every(entity => entity.components.modelAsset.sourcePath !== originalConfiguration.target.model.sourcePath && entity.components.modelAsset.sourcePath !== projectModel), 'SOURCE 模型加载引用应已搬迁');
    assert.ok(modelEntities(distScene).every(entity => entity.components.modelAsset.sourcePath !== originalConfiguration.target.model.sourcePath && entity.components.modelAsset.sourcePath !== projectModel), 'DIST 模型加载引用应已搬迁');
    assert.equal(followEntity(sourceScene).components.poiEffect.configuration.target.model.entityIds, undefined, '新 SOURCE 类型引用不依赖编辑实例');
    assert.equal(followEntity(distScene).components.poiEffect.configuration.target.model.entityIds, undefined, '新 DIST 类型引用不注入编辑实例依赖');
    assert.deepEqual(followEntity(sourceMetadata).components.poiEffect.configuration.target.model.entityIds, metadataTemplate.entityIds, '兼容旧配置的三个实体证据');
    const deployed = followEntity(distScene).components.poiEffect.configuration;
    assert.equal(deployed.target.model.sourcePath, modelEntities(distScene)[0].components.modelAsset.sourcePath, 'DIST 类型与模型共享部署路径'); assert.equal(deployed.target.model.sourceUrl, modelEntities(distScene)[0].components.modelAsset.sourceUrl, 'DIST 类型与模型共享部署 URL');
    assert.deepEqual(deployed.data, originalConfiguration.data, 'DIST 保留按资产身份继承数据的配置');
    assert.equal(deployed.target.assetCode, '000317');

    const sourceGlbs = sourceZip.files.filter(file => file.type !== 'Directory' && /\.glb$/i.test(file.path));
    // Viewer 自带漫游人物与内置输送机，场景模型去重只统计 project/assets。
    const distGlbs = distZip.files.filter(file => file.type !== 'Directory' && portable(file.path).startsWith('project/assets/') && /\.glb$/i.test(file.path));
    assert.equal(sourceGlbs.length, 1, 'SOURCE 三个模型实例与模板元数据共享唯一 GLB');
    assert.equal(distGlbs.length, 1, 'DIST 三个模型实例共享唯一 GLB');
    assert.equal(digest(await sourceGlbs[0].buffer()), digest(modelBytes), 'SOURCE GLB 内容保持完整');
    assert.equal(digest(await distGlbs[0].buffer()), digest(modelBytes), 'DIST GLB 内容保持完整');
    assert.equal(sourceZip.files.some(file => /metadata-only-template\.glb/i.test(file.path)), false);
    assert.equal(distZip.files.some(file => /metadata-only-template\.glb/i.test(file.path)), false);
    assert.equal(source.resourceFiles.some(file => /metadata-only-template\.glb/i.test(JSON.stringify(file))), false);
    assert.equal(await readFile(sceneFile, 'utf8'), relocatedContent, '打包不修改入口文件');
    assert.equal(await readFile(metadataFile, 'utf8'), metadataContent, '打包不修改其他场景');
    assert.equal(await readFile(fixturePath, 'utf8'), content, '真实编辑器证据文件保持不变');
    assert.equal(digest(await readFile(modelPath)), digest(modelBytes), '原始设备模型保持不变');

    await copyFile(source.filePath, path.join(output, 'template-source.zip'));
    await copyFile(dist.filePath, path.join(output, 'template-dist.zip'));
    await writeFile(path.join(output, 'template-packaged-source.scene.json'), JSON.stringify(sourceScene, null, 2), 'utf8');
    await writeFile(path.join(output, 'template-packaged-dist.scene.json'), JSON.stringify(distScene, null, 2), 'utf8');
    const report = { ok: true, targetId, identity: { sourceId: 'source-A', deviceType: 'device', assetCode: '000317' },
      templateProofCount: 0, legacyTemplateProofCount: 3, sourceScenes: 2, sourceGlbCount: sourceGlbs.length, distGlbCount: distGlbs.length,
      sourceBytes: (await stat(source.filePath)).size, distBytes: (await stat(dist.filePath)).size,
      checks: ['actual-editor-fixture', 'SOURCE-relocated-exact-match', 'SOURCE-type-reference-no-instance-proof', 'SOURCE-legacy-instance-proof-retained', 'SOURCE-metadata-only-template-not-loaded', 'DIST-relocated-exact-match', 'DIST-local-paths-removed', 'shared-glb-single-copy', 'glb-sha256-preserved', 'string-asset-and-source-isolation', 'source-fixtures-not-mutated'] };
    await writeFile(path.join(output, 'template-packages-result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2)); code = 0;
  } catch (error) { console.error(error); }
  finally { clearTimeout(deadline); try { await cleanup(); } catch (error) { console.error(error); code = 1; } app.exit(code); }
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
