import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
import { getSceneShadowBakeSignatureContract } from '../../electron/shared/sceneShadowBakeContract.ts';

const [{ recoverLocalSceneResourcePaths }, { createDataPlatformModelRuntimeRevision }, { assertRecoveryPathInsideRoot }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/localSceneResourceRecovery'), typeof import('../../electron/ipc/dataPlatformModelIndex'),
  typeof import('../../electron/shared/recoveryPathBoundary'),
]>(['electron/ipc/localSceneResourceRecovery.ts', 'electron/ipc/dataPlatformModelIndex.ts', 'electron/shared/recoveryPathBoundary.ts']);
const oldKey = 'a'.repeat(64), newKey = 'b'.repeat(64);
const url = (value: string) => `editor-asset://local/${encodeURIComponent(value)}`;
const glb = () => {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }).padEnd(80, ' '));
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
};
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-scene-recovery-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const write = async (relative: string, data: string | Buffer = glb()) => {
    const target = path.join(workspace, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data); return target;
  };
  return { root, workspace, write };
}
const scene = (asset: object) => ({ version: 1, scene: { entities: { one: { id: 'one', components: { modelAsset: asset, transform: { x: 2 } } } } } });

test('来源隔离工程迁移保留 Platforms 目录并避开旧同 ID 工程', async t => {
  const f = await fixture(t); const tail = 'Projects/123/Assets/Models/Model-456/model.glb';
  const target = await f.write(`Platforms/${oldKey}/${tail}`);
  await f.write(tail, 'wrong legacy data');
  const sourcePath = `Z:/previous/Platforms/${oldKey}/${tail}`;
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath, sourceUrl: url(sourcePath) })), workspaceRoot: f.workspace });
  assert.deepEqual(result.issues, []);
  assert.equal(JSON.parse(result.sceneContent).scene.entities.one.components.modelAsset.sourcePath, target);
});

test('恢复认可工作区相对结构，优先原文件并保留普通文本与 URL 参数', async t => {
  const f = await fixture(t), relative = 'SharedResources/Assets/Models/Model-123-中文/model.glb';
  const target = await f.write(relative), old = `Z:/old/${relative}`;
  const document = scene({ sourcePath: old, sourceUrl: `${url(old)}?assetRevision=123#part`, parameterValues: { sourcePath: old } });
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace });
  const asset = JSON.parse(result.sceneContent).scene.entities.one.components.modelAsset;
  assert.equal(asset.sourcePath, target); assert.equal(asset.sourceUrl, `${url(target)}?assetRevision=123#part`);
  assert.equal(asset.parameterValues.sourcePath, old); assert.equal(result.restoredReferenceCount, 2);
  assert.deepEqual(result.resolvedFiles, [target]); assert.deepEqual(result.issues, []);
  const existing = await f.write('original.glb');
  const keep = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: existing, sourceUrl: url(existing) })), workspaceRoot: f.workspace });
  assert.equal(keep.restoredReferenceCount, 0); assert.equal(JSON.parse(keep.sceneContent).scene.entities.one.components.modelAsset.sourcePath, existing);
});

test('同版本模型迁移验证内容，覆盖生成器、脚本与点击绑定且不改参数', async t => {
  const f = await fixture(t); const staging = 'SharedResources/staging/Model-123-test';
  const modelPath = await f.write(`${staging}/model.glb`), metadataPath = await f.write(`${staging}/meta.json`, '{}');
  const scriptPath = await f.write(`${staging}/motion.model.ts`, 'export const speed = 1;');
  const rev = await createDataPlatformModelRuntimeRevision({ modelPath, metadataPath, scriptPaths: [scriptPath] });
  const layout = createHash('sha256').update(JSON.stringify({ mainFile: 'model.glb', thumbnailPath: null, thumbnailRevision: rev.thumbnailRevision })).digest('hex').slice(0, 12);
  const tail = `${rev.runtimeRevision}/Assets/Models/Model-123-test-${layout}`;
  const relative = `SharedResources/.babylon-editor/scene-model-versions/${newKey}/${tail}`;
  await fs.mkdir(path.dirname(path.join(f.workspace, relative)), { recursive: true });
  await fs.cp(path.dirname(modelPath), path.join(f.workspace, relative), { recursive: true });
  const old = `Z:/old/SharedResources/.babylon-editor/scene-model-versions/${oldKey}/${tail}`;
  const asset = { sourcePath: `${old}/model.glb`, sourceUrl: url(`${old}/model.glb`), assetRevision: rev.runtimeRevision,
    scriptAssets: [{ path: `${old}/motion.model.ts`, sourceUrl: url(`${old}/motion.model.ts`) }],
    dataPlatformModel: { sourceKey: oldKey, kind: 'model', resourceId: '123', modelPath: 'model.glb' }, parameterValues: { speed: 5 } };
  const document = scene(asset); (document.scene.entities.one.components as any).modelGenerator = { defaultTarget: { kind: 'model', modelAsset: structuredClone(asset) } };
  (document.scene.entities.one.components as any).clickEventBinding = { deviceSlots: [{ deviceType: structuredClone(asset) }] };
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace, sourceKey: newKey });
  assert.deepEqual(result.issues, []); assert.equal(result.restoredReferenceCount, 12);
  const components = JSON.parse(result.sceneContent).scene.entities.one.components;
  for (const next of [components.modelAsset, components.modelGenerator.defaultTarget.modelAsset, components.clickEventBinding.deviceSlots[0].deviceType]) {
    assert.equal(next.dataPlatformModel.sourceKey, newKey); assert.deepEqual(next.parameterValues, { speed: 5 });
    assert.equal(next.sourcePath, path.join(f.workspace, relative, 'model.glb'));
  }
  await fs.writeFile(path.join(f.workspace, relative, 'motion.model.ts'), 'changed');
  const corrupt = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace, sourceKey: newKey });
  assert.equal(corrupt.restoredReferenceCount, 0); assert.match(corrupt.issues[0].message, /版本|内容/);
});

test('环境变体与项目天空盒路径一起恢复，缺失项保留并结构化报告', async t => {
  const f = await fixture(t); const skyRelative = 'Projects/456/Assets/Skyboxes/天空/天空.exr';
  const sky = await f.write(skyRelative, Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]));
  const envRelative = 'Projects/456/Assets/Environments/Env-789/model.glb', environment = await f.write(envRelative);
  const document = scene({ sourcePath: 'Z:/old/SharedResources/Assets/Models/Model-100-missing/m.glb' });
  (document.scene.entities.one.components as any).skybox = { sourcePath: `Z:/old/${skyRelative}`, sourceUrl: url(`Z:/old/${skyRelative}`) };
  (document.scene as any).sceneSettings = { environment: { packagePath: 'Z:/old/Projects/456/Assets/Environments/Env-789',
    dataPlatformResourceId: '789', activeVariantUrl: url(`Z:/old/${envRelative}`), variants: [{ sourcePath: `Z:/old/${envRelative}`, sourceUrl: url(`Z:/old/${envRelative}`) }] } };
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace });
  const next = JSON.parse(result.sceneContent).scene;
  assert.equal(next.sceneSettings.environment.variants[0].sourcePath, environment);
  assert.equal(next.entities.one.components.skybox.sourcePath, sky);
  assert.equal(result.missing.length, 1); assert.equal(result.missing[0].resourceId, '100');
  assert.equal(result.missing[0].sourcePath, document.scene.entities.one.components.modelAsset.sourcePath);
});

test('拒绝路径穿越、候选符号链接越界和资源身份冲突', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'model.glb'), glb());
  await fs.mkdir(path.join(f.workspace, 'SharedResources/Assets/Models'), { recursive: true });
  await fs.symlink(outside, path.join(f.workspace, 'SharedResources/Assets/Models/Model-123-link'), 'junction');
  for (const asset of [
    { sourcePath: 'Z:/old/SharedResources/../outside/model.glb' },
    { sourcePath: 'Z:/old/SharedResources/Assets/Models/Model-123-link/model.glb' },
    { sourcePath: 'Z:/old/SharedResources/Assets/Models/Model-123-link/model.glb', dataPlatformModel: { kind: 'model', resourceId: '999' } },
  ]) {
    const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene(asset)), workspaceRoot: f.workspace });
    assert.equal(result.restoredReferenceCount, 0); assert.ok(result.issues.length); assert.match(result.issues[0].message, /安全|越界|身份/);
  }
});

test('远程 API 地址和非资源文本不列入文件预检', async t => {
  const f = await fixture(t); const document = scene({ sourceUrl: 'https://example.invalid/model.glb', parameterValues: { path: 'Z:/private/file.txt' } });
  (document.scene as any).dataSources = [{ url: 'https://example.invalid/api/query', sourcePath: 'Z:/private/another.txt' }];
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace });
  assert.deepEqual(JSON.parse(result.sceneContent), document); assert.deepEqual(result.issues, []); assert.deepEqual(result.missing, []);
});

test('网络补齐映射仍校验文件且保留查询参数，取消不产生部分提交', async t => {
  const f = await fixture(t); const old = 'Z:/missing/model.glb', target = await f.write('recovered/model.glb');
  const sceneContent = JSON.stringify(scene({ sourcePath: old, sourceUrl: `${url(old)}?v=1` }));
  const result = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: f.workspace, additionalMappings: new Map([[old, target]]) });
  assert.equal(JSON.parse(result.sceneContent).scene.entities.one.components.modelAsset.sourceUrl, `${url(target)}?v=1`);
  const invalid = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: f.workspace, additionalMappings: new Map([[old, path.join(f.workspace, 'none.glb')]]) });
  assert.equal(invalid.restoredReferenceCount, 0); assert.equal(invalid.missing.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: f.workspace, signal: controller.signal }), /取消/);
});

test('原路径授权拒绝后不复用工作区之外的文件，映射不能跳出受信根目录', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'private.glb'); await fs.writeFile(outside, glb());
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: outside })), workspaceRoot: f.workspace, isOriginalPathAllowed: () => false });
  assert.equal(result.restoredReferenceCount, 0); assert.deepEqual(result.resolvedFiles, []); assert.match(result.issues[0].message, /授权/);
  const mapped = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: 'Z:/old/model.glb' })), workspaceRoot: f.workspace,
    additionalMappings: new Map([['Z:/old/model.glb', outside]]) });
  assert.equal(mapped.restoredReferenceCount, 0); assert.match(mapped.issues[0].message, /安全|超出/);
});

test('项目与工作区有两个有效候选时保留原引用并报告歧义', async t => {
  const f = await fixture(t); await f.write('Projects/456/Assets/Models/Model-123-x/model.glb');
  const projectRoot = path.join(f.root, 'project'); await fs.mkdir(path.join(projectRoot, 'Assets/Models/Model-123-x'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'Assets/Models/Model-123-x/model.glb'), glb());
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: 'Z:/old/Projects/456/Assets/Models/Model-123-x/model.glb' })), workspaceRoot: f.workspace, projectRoot });
  assert.equal(result.restoredReferenceCount, 0); assert.match(result.issues[0].message, /歧义/);
});

test('固定版本映射到可变包仍比较旧指纹，目标资源 ID 不同不能替换', async t => {
  const f = await fixture(t); const target = await f.write('SharedResources/Assets/Models/Model-123-x/model.glb');
  await f.write('SharedResources/Assets/Models/Model-123-x/meta.json', '{}');
  const old = `Z:/old/SharedResources/.babylon-editor/scene-model-versions/${oldKey}/${'c'.repeat(64)}/Assets/Models/Model-123-x/model.glb`;
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: old })), workspaceRoot: f.workspace, additionalMappings: new Map([[old, target]]) });
  assert.equal(result.restoredReferenceCount, 0); assert.match(result.issues[0].message, /版本/);
  assert.equal(result.missing[0].expectedRevision, 'c'.repeat(64));
  const other = await f.write('SharedResources/Assets/Models/Model-999-y/model.glb');
  const mismatched = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: 'Z:/old/SharedResources/Assets/Models/Model-123-x/model.glb' })), workspaceRoot: f.workspace,
    additionalMappings: new Map([['Z:/old/SharedResources/Assets/Models/Model-123-x/model.glb', other]]) });
  assert.equal(mismatched.restoredReferenceCount, 0); assert.match(mismatched.issues[0].message, /身份/);
});

test('损坏资产 URL 和天空盒文件在预检报告，不能消失或标为可用', async t => {
  const f = await fixture(t), document = scene({ sourceUrl: 'editor-asset://local/%zz' });
  (document.scene.entities.one.components as any).skybox = { sourcePath: 'Z:/old/Projects/456/Assets/Skyboxes/bad.exr' };
  await f.write('Projects/456/Assets/Skyboxes/bad.exr', 'not-exr');
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace });
  assert.equal(result.missing.length, 2); assert.equal(result.restoredReferenceCount, 0);
  assert.match(result.issues.map(item => item.message).join(' '), /URL|安全/);
  assert.match(result.issues.map(item => item.message).join(' '), /EXR|格式/);
});

test('共享索引中同一 runtimeRevision 的可变包可以离线恢复固定版本引用', async t => {
  const f = await fixture(t), relative = 'Assets/Models/Model-123-x';
  const modelPath = await f.write(`SharedResources/${relative}/model.glb`);
  const metadataPath = await f.write(`SharedResources/${relative}/meta.json`, '{}');
  const revision = await createDataPlatformModelRuntimeRevision({ modelPath, metadataPath, scriptPaths: [] });
  await f.write('SharedResources/.babylon-editor/data-platform-model-index.json', JSON.stringify({ version: 1, sourceKey: newKey, entries: [{
    ...revision, kind: 'model', resourceId: '123', displayName: 'fixture', packageRelativePath: relative,
    contentFingerprint: null, thumbnailFingerprint: null, syncedAt: '2026-09-09T00:00:00Z',
  }] }));
  const old = `Z:/old/SharedResources/.babylon-editor/scene-model-versions/${oldKey}/${revision.runtimeRevision}/Assets/Models/Model-123-x-aaaaaaaaaaaa/model.glb`;
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: old, assetRevision: revision.runtimeRevision })), workspaceRoot: f.workspace, sourceKey: newKey });
  assert.deepEqual(result.issues, []); assert.equal(JSON.parse(result.sceneContent).scene.entities.one.components.modelAsset.sourcePath, modelPath);
  await fs.writeFile(modelPath, Buffer.concat([glb(), Buffer.from('tampered')]));
  const invalid = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: old })), workspaceRoot: f.workspace, sourceKey: newKey });
  assert.equal(invalid.restoredReferenceCount, 0); assert.match(invalid.issues[0].message, /版本|结构/);
});

test('仅位置迁移保留已有阴影内容并更新其有效签名', async t => {
  const f = await fixture(t), relative = 'Projects/456/Assets/Models/Model-123-x/model.glb'; await f.write(relative);
  const document = scene({ sourcePath: `Z:/old/${relative}`, sourceUrl: url(`Z:/old/${relative}`), parameterValues: { size: 4 } });
  const shadows = { enabled: true, mode: 'static-baked', bake: undefined as any };
  (document.scene as any).sceneSettings = { shadows };
  shadows.bake = { version: 1, signature: getSceneShadowBakeSignatureContract(document.scene), createdAt: '2026-09-09T00:00:00Z', surfaces: [
    { key: 'floor', kind: 'shadow-mask', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=', width: 1, height: 1, uvBounds: [0, 0, 1, 1] },
  ] };
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace });
  const restored = JSON.parse(result.sceneContent).scene;
  assert.deepEqual(restored.sceneSettings.shadows.bake.surfaces, shadows.bake.surfaces);
  assert.equal(restored.sceneSettings.shadows.bake.createdAt, shadows.bake.createdAt);
  assert.equal(restored.sceneSettings.shadows.bake.signature, getSceneShadowBakeSignatureContract(restored));
  assert.notEqual(restored.sceneSettings.shadows.bake.signature, shadows.bake.signature);
});

test('glTF 依赖文件参与校验和授权清单，缺失依赖与越界 URI 明确失败', async t => {
  const f = await fixture(t), relative = 'SharedResources/Assets/Models/Model-123-x/model.gltf';
  const main = await f.write(relative, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'data.bin', byteLength: 4 }], images: [{ uri: 'textures/a.png' }] }));
  const bytes = await f.write('SharedResources/Assets/Models/Model-123-x/data.bin', '1234');
  const texture = await f.write('SharedResources/Assets/Models/Model-123-x/textures/a.png', 'texture');
  const sceneContent = JSON.stringify(scene({ sourcePath: `Z:/old/${relative}` }));
  const result = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: f.workspace });
  assert.deepEqual(result.issues, []); assert.deepEqual(new Set(result.resolvedFiles), new Set([main, bytes, texture]));
  await fs.unlink(bytes);
  const missing = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: f.workspace });
  assert.equal(missing.restoredReferenceCount, 0); assert.match(missing.issues[0].message, /依赖/);
  await fs.writeFile(main, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: '../outside.bin' }] }));
  const unsafe = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: f.workspace });
  assert.equal(unsafe.restoredReferenceCount, 0); assert.match(unsafe.issues[0].message, /安全/);
});

test('相对资产路径在规范化前拒绝穿越，非 local 资产协议报告无效', async t => {
  const f = await fixture(t), sourcePath = 'Assets/../private.glb'; await f.write('private.glb');
  const document = scene({ sourcePath, sourceUrl: 'editor-asset://remote/model.glb' });
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(document), workspaceRoot: f.workspace, sceneFilePath: path.join(f.workspace, 'scene.json') });
  assert.equal(result.restoredReferenceCount, 0); assert.deepEqual(result.resolvedFiles, []);
  assert.equal(result.missing.length, 2); assert.match(result.issues.map(item => item.message).join(' '), /安全/);
});

test('事务可延迟阴影迁移，默认仍拒绝不兼容的位置改写', async t => {
  const f = await fixture(t), relative = 'Assets/Models/Model-123-x';
  const modelPath = await f.write(`SharedResources/${relative}/model.glb`);
  const metadataPath = await f.write(`SharedResources/${relative}/meta.json`, '{}');
  const revision = await createDataPlatformModelRuntimeRevision({ modelPath, metadataPath, scriptPaths: [] });
  await f.write('SharedResources/.babylon-editor/data-platform-model-index.json', JSON.stringify({ version: 1, sourceKey: newKey, entries: [{
    ...revision, kind: 'model', resourceId: '123', displayName: 'fixture', packageRelativePath: relative,
    contentFingerprint: null, thumbnailFingerprint: null, syncedAt: '2026-09-09T00:00:00Z',
  }] }));
  const old = `Z:/old/SharedResources/.babylon-editor/scene-model-versions/${oldKey}/${revision.runtimeRevision}/Assets/Models/Model-123-x-aaaaaaaaaaaa/model.glb`;
  const document = scene({ sourcePath: old, assetRevision: revision.runtimeRevision });
  (document.scene as any).sceneSettings = { shadows: { bake: { version: 1, signature: '', createdAt: '2026-09-09T00:00:00Z', surfaces: [
    { key: 'floor', width: 1, height: 1, uvBounds: [0, 0, 1, 1], dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=' },
  ] } } };
  const bake = (document.scene as any).sceneSettings.shadows.bake;
  bake.signature = getSceneShadowBakeSignatureContract(document.scene);
  const options = { sceneContent: JSON.stringify(document), workspaceRoot: f.workspace, sourceKey: newKey };
  await assert.rejects(recoverLocalSceneResourcePaths(options), /阴影/);
  const deferred = await recoverLocalSceneResourcePaths({ ...options, shadowBakeRelocation: 'defer' });
  assert.equal(deferred.restoredReferenceCount, 1);
  assert.deepEqual(JSON.parse(deferred.sceneContent).scene.sceneSettings.shadows.bake, bake);
});

test('写入边界允许不存在目标，拒绝已存在祖先junction逃逸', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await assertRecoveryPathInsideRoot(f.workspace, path.join(f.workspace, 'new/sub/file.glb'));
  await assertRecoveryPathInsideRoot(f.workspace, f.workspace);
  await assert.rejects(assertRecoveryPathInsideRoot(f.workspace, path.join(outside, 'no-file')), /越界|超出/);
  const junction = path.join(f.workspace, 'junction'); await fs.symlink(outside, junction, 'junction');
  await assert.rejects(assertRecoveryPathInsideRoot(f.workspace, path.join(junction, 'new/sub/file.glb')), /越界|超出/);
  const trustedRoot = path.join(f.root, 'trusted-root'); await fs.symlink(f.workspace, trustedRoot, 'junction');
  await assertRecoveryPathInsideRoot(trustedRoot, path.join(trustedRoot, 'new/file.glb'));
});

test('相对Assets引用按场景文件定位后写回绝对路径和协议URL', async t => {
  const f = await fixture(t), relative = 'Assets/Models/local/model.glb';
  const file = await f.write(relative);
  const result = await recoverLocalSceneResourcePaths({ sceneContent: JSON.stringify(scene({ sourcePath: relative, sourceUrl: url(relative) })),
    workspaceRoot: f.workspace, sceneFilePath: path.join(f.workspace, 'scene.json') });
  const asset = JSON.parse(result.sceneContent).scene.entities.one.components.modelAsset;
  assert.equal(asset.sourcePath, file); assert.equal(asset.sourceUrl, url(file));
  assert.equal(result.restoredReferenceCount, 2); assert.deepEqual(result.issues, []);
});
