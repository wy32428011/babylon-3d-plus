import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { binaryFixture } from './lightingGeometryBinaryFixture.ts';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { resolveEditorAssetProtocolResponse } from '../../electron/ipc/editorAssetCacheHeaders.ts';
import { createAssetFileByteStream } from '../../electron/shared/assetFileByteStream.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { resolveSceneLightingBakeAssets, prepareLightingSceneSave, prepareLightingSceneContent, assertLightingBakeResourceFile } = await import('../../electron/ipc/sceneLightingBakeResources.ts');
hooks.deregister();
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);
const decode = (value: string) => decodeURIComponent(new URL(value).pathname.slice(1));
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-files-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('b7-files-')); await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, 'original'), job = path.join(projectRoot, 'Assets', 'LightingBakes', 'job');
  await fs.mkdir(job, { recursive: true });
  const rows = [['g', 'geometry', 'geometry-0.bin', binaryFixture()], ['l', 'lightmap', 'lightmap-0.png', new Uint8Array([1, 2, 3])], ['p', 'probes', 'probes.json', new TextEncoder().encode('{}')]] as const;
  const assets = [];
  for (const [id, kind, file, bytes] of rows) {
    await fs.writeFile(path.join(job, file), bytes);
    assets.push({ id, kind, url: url(path.join(job, file)), byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(id === 'g' ? { encoding: 'binary-v1', geometryVersion: 2 } : {}) });
  }
  const scene = { entities: { a: { components: { meshRenderer: { meshKind: 'cube' } } } }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-24T00:00:00Z', engineVersion: 'fixture', assets,
    surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } };
  return { root, projectRoot, job, scene, assets, bytes: rows[0][3] };
}

test('二进制资产保存/搬迁/重开保留encoding、几何version、字节与SHA，旧源可移走', async t => {
  const f = await fixture(t), target = path.join(f.root, 'saved', 'Scenes', 'a.scene.json');
  assert.equal((await resolveSceneLightingBakeAssets(f.scene, { projectRoot: f.projectRoot })).length, 3);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const saved = await prepareLightingSceneSave(JSON.stringify({ version: 6, scene: f.scene }), target, { projectRoot: f.projectRoot });
  const moved = path.join(f.root, 'moved'); assert.equal(path.dirname(moved), f.root); await fs.rename(f.projectRoot, moved);
  const reopened = JSON.parse((await prepareLightingSceneContent(saved.content, target)).content).scene;
  const asset = reopened.sceneSettings.lighting.result.assets[0];
  assert.equal(asset.encoding, 'binary-v1'); assert.equal(asset.geometryVersion, 2); assert.equal(asset.sha256, f.assets[0].sha256);
  assert.deepEqual(new Uint8Array(await fs.readFile(decode(asset.url))), f.bytes);
  assert.equal(reopened.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(reopened));
});

test('只有geometry+binary-v1允许.bin；未授权/错误encoding-kind-extension/路径逃逸/Junction仍拒绝', async t => {
  const f = await fixture(t), original = structuredClone(f.assets);
  await assertLightingBakeResourceFile(decode(f.assets[0].url));
  for (const mutate of [
    (a: Record<string, unknown>[]) => { delete a[0].encoding; }, (a: Record<string, unknown>[]) => { a[0].encoding = 'json'; },
    (a: Record<string, unknown>[]) => { a[0].encoding = 'future'; }, (a: Record<string, unknown>[]) => { a[1].encoding = 'binary-v1'; },
    (a: Record<string, unknown>[]) => { a[2].encoding = 'binary-v1'; },
    (a: Record<string, unknown>[]) => { a[0].url = url(path.join(f.projectRoot, 'secret.bin')); },
  ]) {
    f.scene.sceneSettings.lighting.result.assets = structuredClone(original); mutate(f.scene.sceneSettings.lighting.result.assets);
    await assert.rejects(resolveSceneLightingBakeAssets(f.scene, { projectRoot: f.projectRoot }));
  }
  f.scene.sceneSettings.lighting.result.assets = structuredClone(original);
  await assert.rejects(resolveSceneLightingBakeAssets(f.scene, { projectRoot: path.join(f.root, 'unauthorized') }), /授权/);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'geometry.bin'), f.bytes);
  const junction = path.join(f.job, 'linked'); await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  f.scene.sceneSettings.lighting.result.assets[0].url = url(path.join(junction, 'geometry.bin'));
  await assert.rejects(resolveSceneLightingBakeAssets(f.scene, { projectRoot: f.projectRoot }), /符号链接|路径/);
  await assert.rejects(assertLightingBakeResourceFile(path.join(junction, 'geometry.bin')), /符号链接|路径/);
});

test('实际editor-asset协议handler经授权与专用gate后流式返回.bin，协商缓存/403行为不变', async t => {
  const f = await fixture(t), file = decode(f.assets[0].url), authorized = new Set([file]);
  const source = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const entry = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerEditorAssetProtocol');
  assert.ok(entry);
  let handler: (request: Request) => Promise<Response>;
  const javascript = ts.transpileModule('(' + entry.getText(tree) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  // 提取未导出生产入口，只替代Electron协议注册器；请求处理/授权/文件流均实际执行。
  const dependencies = { protocol: { handle: (_scheme: string, callback: typeof handler) => { handler = callback; } },
    decodeAssetUrl: decode, isAuthorizedAssetFile: (value: string) => authorized.has(value), assertLightingBakeResourceFile, fs, path,
    resolveEditorAssetProtocolResponse, createAssetFileByteStream };
  Function(...Object.keys(dependencies), 'return ' + javascript.trimStart().replace(/^"use strict";\s*/, ''))(...Object.values(dependencies))();
  const response = await handler!(new Request(url(file))); assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes);
  const cached = await handler!(new Request(url(file), { headers: { 'If-None-Match': response.headers.get('ETag')! } }));
  assert.equal(cached.status, 304);
  authorized.clear(); assert.equal((await handler!(new Request(url(file)))).status, 403);
});
