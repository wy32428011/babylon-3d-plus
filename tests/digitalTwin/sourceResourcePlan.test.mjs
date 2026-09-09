import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import unzipper from 'unzipper';
import { writeFileSync } from 'node:fs';
import { buildDigitalTwinSourcePackage } from '../../dist-electron/ipc/digitalTwinSourcePackage.js';
import { relocateDataPlatformScene } from '../../dist-electron/ipc/dataPlatformSceneRelocation.js';
import { bindSourceResourceIntegrity } from '../../dist-electron/ipc/digitalTwinSourceResourcePlan.js';
import { copyDeploymentFiles } from '../../dist-electron/ipc/deploymentExportFileSystem.js';
import { getSceneShadowBakeSignatureContract, getSceneShadowBakeErrorContract } from '../../dist-electron/shared/sceneShadowBakeContract.js';

const url = (value) => `editor-asset://local/${encodeURIComponent(value)}`;
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-resource-plan-'));
  const projectRoot = path.join(root, 'Projects', '42');
  const sharedResourcesRoot = path.join(root, 'SharedResources');
  const roots = [projectRoot, sharedResourcesRoot].map(base => path.join(base, 'Assets', 'Models', '货架'));
  const sceneFile = path.join(projectRoot, 'Scenes', 'main.scene.json');
  for (const folder of [...roots, path.dirname(sceneFile)]) await mkdir(folder, { recursive: true });
  for (const folder of roots) {
    await writeFile(path.join(folder, 'model.glb'), 'same-model');
    await writeFile(path.join(folder, 'runtime.ts'), 'same-script');
    await writeFile(path.join(folder, 'meta.json'), '{"lengthUnit":"meter"}');
  }
  const asset = (folder) => ({ sourcePath: path.join(folder, 'model.glb'), sourceUrl: url(path.join(folder, 'model.glb')),
    metadataPath: path.join(folder, 'meta.json'), scriptAssets: [{ path: path.join(folder, 'runtime.ts'), sourceUrl: url(path.join(folder, 'runtime.ts')) }],
    parameterValues: { length: 8 }, dataPlatformResourceId: '1001' });
  const scene = { version: 5, scene: { name: '两个版本', entityIds: ['a', 'b'], entities: {
    a: { id: 'a', name: '项目货架', components: { modelAsset: asset(roots[0]) } },
    b: { id: 'b', name: '共享货架', components: { modelAsset: asset(roots[1]) } },
  }, sceneSettings: {}, note: roots[0] } };
  const options = { projectRoot, sharedResourcesRoot, entrySceneFilePath: sceneFile, outputRoot: path.join(root, 'output'),
    manifest: { projectId: '42', projectName: '测试', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } };
  const save = () => writeFile(sceneFile, JSON.stringify(scene));
  try { await run({ root, roots, scene, options, save }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('同名完整资源包内容相同：合并且记录固定快照，普通文本不被改写', async () => fixture(async ({ roots, scene, options, save }) => {
  await save();
  const result = await buildDigitalTwinSourcePackage(options);
  const portable = JSON.parse(result.sceneContents[0]);
  const a = portable.scene.entities.a.components.modelAsset, b = portable.scene.entities.b.components.modelAsset;
  assert.equal(a.sourcePath, b.sourcePath);
  assert.equal(a.scriptAssets[0].path, b.scriptAssets[0].path);
  assert.match(a.sourceSnapshot.contentSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(a.sourceSnapshot, b.sourceSnapshot);
  assert.equal(portable.scene.note, roots[0]);
  assert.deepEqual(a.parameterValues, scene.scene.entities.a.components.modelAsset.parameterValues);
  assert.equal(result.resourceFileCount, 3);
}));

test('GLB相同但脚本不同：两版本完整保留，换工作区往返后目标稳定', async () => fixture(async ({ root, roots, options, save }) => {
  await writeFile(path.join(roots[1], 'runtime.ts'), 'different-script');
  await save();
  const result = await buildDigitalTwinSourcePackage(options);
  const portable = JSON.parse(result.sceneContents[0]);
  const a = portable.scene.entities.a.components.modelAsset, b = portable.scene.entities.b.components.modelAsset;
  assert.notEqual(a.sourcePath, b.sourcePath);
  assert.notEqual(a.sourceSnapshot.contentSha256, b.sourceSnapshot.contentSha256);
  const archive = await unzipper.Open.file(result.filePath);
  const get = async p => (await archive.files.find(f => f.path === p).buffer()).toString();
  assert.equal(await get(a.scriptAssets[0].path), 'same-script');
  assert.equal(await get(b.scriptAssets[0].path), 'different-script');
  const reopenedRoot = path.join(root, 'reopened');
  await archive.extract({ path: reopenedRoot });
  await writeFile(path.join(reopenedRoot, 'Scenes', 'main.scene.json'), JSON.stringify(relocateDataPlatformScene(portable, reopenedRoot)));
  const again = await buildDigitalTwinSourcePackage({ ...options, projectRoot: reopenedRoot,
    entrySceneFilePath: path.join(reopenedRoot, 'Scenes', 'main.scene.json'), outputRoot: path.join(root, 'output-again') });
  const repeated = JSON.parse(again.sceneContents[0]);
  assert.equal(repeated.scene.entities.a.components.modelAsset.sourcePath, a.sourcePath);
  assert.equal(repeated.scene.entities.b.components.modelAsset.sourcePath, b.sourcePath);
  assert.equal(again.resourceFileCount, 6);
}));

test('同一实例混用两个不同版本的模型和脚本时报告引用位置', async () => fixture(async ({ roots, scene, options, save }) => {
  await writeFile(path.join(roots[1], 'runtime.ts'), 'different-script');
  scene.scene.entities.a.components.modelAsset.scriptAssets = scene.scene.entities.b.components.modelAsset.scriptAssets;
  await save();
  await assert.rejects(buildDigitalTwinSourcePackage(options), /资源版本混用.*a.*scriptAssets/s);
}));

test('清单形成后同步改写资源：拒绝产生混合版本并清理失败产物', async () => fixture(async ({ roots, options, save }) => {
  await save();
  let changed = false;
  await assert.rejects(buildDigitalTwinSourcePackage({ ...options, onProgress: detail => {
    if (!changed && detail === '正在复制源工程场景…') {
      changed = true;
      // 同步写入模拟与后台同步原子提升同时到达；长度相同也必须能检出。
      writeFileSync(path.join(roots[0], 'runtime.ts'), 'evil-script');
    }
  } }), /SHA-256|资源.*变化/);
  assert.equal(changed, true);
  assert.deepEqual(await readdir(options.outputRoot), []);
}));

test('非入口场景的缺失模型和脚本不能写入固定快照', async () => fixture(async ({ roots, options, save }) => {
  await save();
  const secondary = path.join(path.dirname(options.entrySceneFilePath), 'secondary.scene.json');
  for (const bad of [ { sourcePath: path.join(roots[0], 'missing.glb') },
    { sourcePath: path.join(roots[0], 'model.glb'), scriptPaths: [path.join(roots[0], 'missing.ts')] } ]) {
    await writeFile(secondary, JSON.stringify({ version: 5, scene: { entities: { broken: { components: { modelAsset: bad } } } } }));
    await assert.rejects(buildDigitalTwinSourcePackage(options), /引用不存在.*secondary\.scene\.json.*broken/s);
  }
}));

test('SOURCE和DIST共用内容清单：同长度的后续替换也不得上传', async () => fixture(async ({ root, roots, options, save }) => {
  await save();
  const result = await buildDigitalTwinSourcePackage(options);
  const file = path.join(roots[1], 'runtime.ts');
  await writeFile(file, 'evil-script');
  const { stat } = await import('node:fs/promises');
  const current = await stat(file);
  const files = bindSourceResourceIntegrity([{ sourcePath: file, relativePath: 'runtime.ts', destinationRelativePath: 'runtime.ts',
    size: current.size, mtimeMs: current.mtimeMs, kind: 'script' }], result.resourceFiles);
  await assert.rejects(copyDeploymentFiles(files, path.join(root, 'dist'), 1, options.signal, () => {}), /SHA-256/);
}));

test('冲突目录改名保留有效烘焙、生成器和普通模型快照', async () => fixture(async ({ root, roots, scene, options, save }) => {
  await writeFile(path.join(roots[1], 'runtime.ts'), 'different-script');
  const env = path.join(options.projectRoot, 'Assets', 'Environments', 'Floor', 'floor.glb');
  await mkdir(path.dirname(env), { recursive: true }); await writeFile(env, 'floor');
  const settings = scene.scene.sceneSettings;
  settings.environment = { packagePath: path.dirname(env), activeVariantUrl: url(env), variants: [{ sourcePath: env, sourceUrl: url(env) }] };
  settings.shadows = { enabled: true, mode: 'baked', darkness: .4 };
  scene.scene.entities.a.components.modelGenerator = { modelAsset: structuredClone(scene.scene.entities.a.components.modelAsset) };
  settings.shadows.bake = { version: 1, signature: getSceneShadowBakeSignatureContract(scene.scene), createdAt: '2026-09-08T00:00:00Z', surfaces: [
    { key: '0:floor', kind: 'shadow-mask', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=', width: 1, height: 1, uvBounds: [0, 0, 1, 1] },
  ] };
  assert.equal(getSceneShadowBakeErrorContract(scene.scene), null);
  await save();
  const result = await buildDigitalTwinSourcePackage(options);
  const portable = JSON.parse(result.sceneContents[0]);
  assert.equal(getSceneShadowBakeErrorContract(portable.scene), null);
  const reopened = relocateDataPlatformScene(portable, path.join(root, 'another-workspace'));
  assert.equal(getSceneShadowBakeErrorContract(reopened.scene), null);
  assert.deepEqual(reopened.scene.sceneSettings.shadows.bake.surfaces, settings.shadows.bake.surfaces);
  assert.match(reopened.scene.entities.a.components.modelGenerator.modelAsset.sourceSnapshot.contentSha256, /^[a-f0-9]{64}$/);
  scene.scene.entities.a.components.modelAsset.parameterValues.length = 99;
  await save();
  const stale = await buildDigitalTwinSourcePackage({ ...options, outputRoot: path.join(root, 'stale-bake-output') });
  assert.match(getSceneShadowBakeErrorContract(JSON.parse(stale.sceneContents[0]).scene), /变化|过期|失效/);
}));

test('同名不同内容图片保留扩展名；大小写路径别名和URL查询仍正确映射', async () => fixture(async ({ scene, options, save }) => {
  const images = [options.projectRoot, options.sharedResourcesRoot].map(root => path.join(root, 'Assets', 'Images', '图标.png'));
  for (const file of images) await mkdir(path.dirname(file), { recursive: true });
  await writeFile(images[0], 'image-one'); await writeFile(images[1], 'image-two');
  scene.scene.images = images.map(sourcePath => ({ sourcePath, sourceUrl: `${url(sourcePath)}?revision=1#preview` }));
  if (process.platform === 'win32') {
    const asset = scene.scene.entities.a.components.modelAsset;
    asset.sourceUrl = url(asset.sourcePath.toUpperCase());
  }
  await save();
  const result = await buildDigitalTwinSourcePackage(options);
  const portable = JSON.parse(result.sceneContents[0]);
  assert.notEqual(portable.scene.images[0].sourcePath, portable.scene.images[1].sourcePath);
  for (const image of portable.scene.images) {
    assert.match(image.sourceUrl, /\.png\?revision=1#preview$/);
    assert.ok(image.sourcePath.includes('__zsrc-'));
  }
  const asset = portable.scene.entities.a.components.modelAsset;
  assert.equal(decodeURIComponent(new URL(asset.sourceUrl).pathname.slice(1)), asset.sourcePath);
  assert.equal(result.resourceFileCount, 5);
}));


test('首次发布切换工程根目录后，已同步的工作区根模型仍应完整打包', async () => fixture(async ({ root, scene, options, save }) => {
  const packageRoot = path.join(root, 'Assets', 'Models', 'Model-1001-货架');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'model.glb'), 'synced-model');
  scene.scene.entities.a.components.modelAsset = { sourcePath: path.join(packageRoot, 'model.glb'), sourceUrl: url(path.join(packageRoot, 'model.glb')) };
  await save();
  const result = await buildDigitalTwinSourcePackage({ ...options, legacyWorkspaceRoot: root });
  assert.deepEqual(result.omittedResources, [], '有效的工作区同步资源不应误报为外部资源');
}));


test('历史外部 CAD 只打包已授权的精确 DXF 文件并保留显示配置', async () => fixture(async ({ root, scene, options, save }) => {
  const folder = path.join(root, 'external'); await mkdir(folder);
  const dxf = path.join(folder, '施工图.dxf'); await writeFile(dxf, '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n');
  await writeFile(path.join(folder, 'unrelated.txt'), 'private-neighbor');
  scene.scene.entities.cad = { components: { cadReference: { name: '施工图', sourcePath: dxf, sourceUrl: url(dxf), sourceLengthUnit: 'millimeter', opacity: 0.3 } } };
  await save();
  const result = await buildDigitalTwinSourcePackage({ ...options, isAuthorizedCadFile: file => file === dxf });
  assert.deepEqual(result.omittedResources, []);
  const cad = JSON.parse(result.sceneContents[0]).scene.entities.cad.components.cadReference;
  assert.match(cad.sourcePath, /^Assets\/Cad\//);
  assert.equal(cad.opacity, 0.3); assert.equal(cad.sourceLengthUnit, 'millimeter');
  const archive = await unzipper.Open.file(result.filePath);
  assert.deepEqual(await archive.files.find(file => file.path === cad.sourcePath).buffer(), await readFile(dxf));
  assert.equal(archive.files.some(file => file.path.includes('unrelated.txt')), false);
}));

test('外部 CAD 未授权、缺失原图时明确阻断，不当作中台模型缓存处理', async () => fixture(async ({ root, scene, options, save }) => {
  const dxf = path.join(root, 'private.dxf'); await writeFile(dxf, 'drawing');
  scene.scene.entities.cad = { components: { cadReference: { name: '施工图', sourcePath: dxf, sourceUrl: url(dxf) } } };
  await save();
  await assert.rejects(buildDigitalTwinSourcePackage({ ...options, isAuthorizedCadFile: () => false }), /CAD.*授权/);
  await rm(dxf);
  await assert.rejects(buildDigitalTwinSourcePackage({ ...options, isAuthorizedCadFile: () => true }), /CAD.*不存在.*重新导入/s);
}));


test('项目 Drawings 中的历史 CAD 也按单文件打包，不要求原路径含 Assets', async () => fixture(async ({ scene, options, save }) => {
  const folder = path.join(options.projectRoot, 'Drawings'); await mkdir(folder);
  const file = path.join(folder, 'layout.dxf'); await writeFile(file, 'legacy-project-cad');
  scene.scene.entities.cad = { components: { cadReference: { sourcePath: file, sourceUrl: url(file) } } };
  await save();
  const result = await buildDigitalTwinSourcePackage(options);
  assert.deepEqual(result.omittedResources, []);
  const cad = JSON.parse(result.sceneContents[0]).scene.entities.cad.components.cadReference;
  assert.equal(cad.sourcePath, 'Assets/Cad/layout.dxf');
}));

test('兼容工作区 Assets 不放行工作区其它目录或兄弟项目资源', async () => fixture(async ({ root, scene, options, save }) => {
  const other = path.join(root, 'other-project', 'Assets', 'Models', 'Private');
  await mkdir(other, { recursive: true }); await writeFile(path.join(other, 'private.glb'), 'private');
  scene.scene.entities.a.components.modelAsset = { sourcePath: path.join(other, 'private.glb') };
  await save();
  const result = await buildDigitalTwinSourcePackage({ ...options, legacyWorkspaceRoot: root });
  assert.deepEqual(result.omittedResources, [other]);
}));


test('旧工作区缓存兼容仍拒绝 Assets 祖先 Junction 逃逸', async () => fixture(async ({ root, scene, options, save }) => {
  const external = path.join(root, 'private-target');
  await mkdir(path.join(external, 'Private'), { recursive: true });
  await writeFile(path.join(external, 'Private', 'model.glb'), 'must-not-package');
  const assets = path.join(root, 'Assets'); await mkdir(assets);
  await symlink(external, path.join(assets, 'Models'), process.platform === 'win32' ? 'junction' : 'dir');
  scene.scene.entities.a.components.modelAsset = { sourcePath: path.join(assets, 'Models', 'Private', 'model.glb') };
  await save();
  await assert.rejects(buildDigitalTwinSourcePackage({ ...options, legacyWorkspaceRoot: root }), /符号|Junction|链接|逃逸|真实路径/);
}));


test('旧工作区资源目录不能与 SOURCE 输出目录重叠', async () => fixture(async ({ root, options, save }) => {
  await save();
  await assert.rejects(buildDigitalTwinSourcePackage({ ...options, legacyWorkspaceRoot: root,
    outputRoot: path.join(root, 'Assets', 'Models', 'Output') }), /旧工作区资源目录不能重叠/);
}));


test('发布忽略 CAD 保留有效模型烘焙与本地 CAD 引用', async () => fixture(async ({ root, scene, options, save }) => {
  const env = path.join(options.projectRoot, 'Assets', 'Environments', 'Floor', 'floor.glb');
  await mkdir(path.dirname(env), { recursive: true }); await writeFile(env, 'floor');
  scene.scene.entities.cad = { components: { transform: { position: { x: 1, y: 0, z: 2 } },
    cadReference: { sourcePath: path.join(root, 'missing.dxf'), sourceUrl: url(path.join(root, 'missing.dxf')) } } };
  scene.scene.entityIds.push('cad');
  const settings = scene.scene.sceneSettings;
  settings.environment = { packagePath: path.dirname(env), activeVariantUrl: url(env), variants: [{ sourcePath: env, sourceUrl: url(env) }] };
  settings.shadows = { enabled: true, mode: 'baked', darkness: .4 };
  settings.shadows.bake = { version: 1, signature: getSceneShadowBakeSignatureContract(scene.scene), createdAt: '2026-09-09T00:00:00Z', surfaces: [
    { key: '0:floor', kind: 'shadow-mask', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=', width: 1, height: 1, uvBounds: [0, 0, 1, 1] },
  ] };
  await save();
  const before = await readFile(options.entrySceneFilePath, 'utf8');
  const result = await buildDigitalTwinSourcePackage({ ...options, skipCadReferences: true });
  const published = JSON.parse(result.entrySceneContent);
  assert.equal(published.scene.entities.cad.components.cadReference, undefined);
  assert.equal(getSceneShadowBakeErrorContract(published.scene), null);
  assert.deepEqual(published.scene.sceneSettings.shadows.bake.surfaces, settings.shadows.bake.surfaces);
  assert.equal(await readFile(options.entrySceneFilePath, 'utf8'), before);
  assert.deepEqual(result.omittedResources, []);
  settings.shadows.bake.signature = 'stale-bake-signature';
  await save();
  const stale = await buildDigitalTwinSourcePackage({ ...options, skipCadReferences: true, outputRoot: path.join(root, 'stale-output') });
  assert.notEqual(getSceneShadowBakeErrorContract(JSON.parse(stale.entrySceneContent).scene), null, '不能把原有过期阴影重新签成有效');
}));
