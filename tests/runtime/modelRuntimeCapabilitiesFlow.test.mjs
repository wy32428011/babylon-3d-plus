import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { embedRuntimeCapabilities } from '../../scripts/declare-model-runtime-capabilities.mjs';
import { NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { digestModelScriptText } from '../../electron/shared/modelScriptCompilation.ts';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/^@babylonjs\/(?:core|loaders)\//.test(specifier) && !specifier.endsWith('.js')) return next(specifier + '.js', context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (!specifier.endsWith('.ts') && existsSync(target)) return { url: target.href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(root.href) && /\.(?:png|jpg|webp|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
  if (url.startsWith(root.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  return next(url, context);
} });
let createEmptySceneDocument, createModelEntity, serializeScene, deserializeScene, createModelGeneratorTargetFromAsset, mergeSceneModelAssetUpdate, ExternalModelScriptRuntime;
try {
  ({ createEmptySceneDocument, createModelEntity } = await import('../../src/editor/model/SceneDocument.ts'));
  ({ serializeScene, deserializeScene } = await import('../../src/editor/project/SceneSerializer.ts'));
  ({ createModelGeneratorTargetFromAsset } = await import('../../src/editor/model/modelGenerator.ts'));
  ({ mergeSceneModelAssetUpdate } = await import('../../src/editor/assets/mergeModelAssetUpdate.ts'));
  ({ ExternalModelScriptRuntime } = await import('../../src/runtime/babylon/ExternalModelScriptRuntime.ts'));
} finally { hooks.deregister(); }

const capability = { version: 1, geometry: 'shared-readonly', materials: 'owned', configurationSha256: 'a'.repeat(64), scripts: {} };

test('模型创建、保存重开与生成器携带声明，资源换版去掉声明时不残留', () => {
  const entity = createModelEntity('F:/fixture/model.glb', 'editor-asset://local/fixture/model.glb', 'model', undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, 'r1', undefined, undefined, undefined, capability);
  const scene = createEmptySceneDocument('capability');
  scene.entityIds.push(entity.id); scene.entities[entity.id] = entity;
  const reopened = deserializeScene(serializeScene(scene));
  assert.deepEqual(reopened.entities[entity.id].components.modelAsset.runtimeCapabilities, capability);
  const asset = { id: 'a', name: 'model.glb', path: 'F:/fixture/model.glb', sourceUrl: 'editor-asset://local/fixture/model.glb',
    kind: 'model', libraryKind: 'model', assetRevision: 'r1', lengthUnit: 'meter', runtimeCapabilities: capability };
  const target = createModelGeneratorTargetFromAsset(asset);
  assert.deepEqual(target.modelAsset.runtimeCapabilities, capability);
  const previous = entity.components.modelAsset, next = { ...previous }; delete next.runtimeCapabilities;
  assert.equal(mergeSceneModelAssetUpdate(previous, next).runtimeCapabilities, undefined);
  const unknown = structuredClone(scene); unknown.entities[entity.id].components.modelAsset.runtimeCapabilities.version = 999;
  assert.equal(deserializeScene(serializeScene(unknown)).entities[entity.id].components.modelAsset.runtimeCapabilities, undefined);
});

test('只读实例在执行脚本factory之前核摘要，不匹配不执行；正确摘要保留生命周期', async () => {
  const source = 'export default class RuntimeComponent { constructor(node) { this.node = node; } onStart() { this.node.metadata = { started: true }; } }';
  const fetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(String(url).includes('.compiled.json') ? '{}' : source, { status: 200 });
  const engine = new NullEngine(), scene = new Scene(engine);
  const node = new TransformNode('script-owner', scene);
  const asset = { assetCode: 'one', assetRevision: 'r1', scriptAssets: [{ name: 'move.model.ts', path: 'move.model.ts', sourceUrl: 'https://fixture.invalid/move.model.ts' }] };
  const invalid = new ExternalModelScriptRuntime(node, asset, { expectedScriptHashes: { 'move.model.ts': '0'.repeat(64) } });
  const valid = new ExternalModelScriptRuntime(node, asset, { expectedScriptHashes: { 'move.model.ts': await digestModelScriptText(source) } });
  try {
    await invalid.start();
    assert.match(invalid.getInitializationError(), /脚本内容已改变/);
    assert.equal(node.metadata, null);
    await valid.start();
    assert.equal(valid.getInitializationError(), null);
    assert.equal(node.metadata.started, true);
  } finally { invalid.dispose(); valid.dispose(); scene.dispose(); engine.dispose(); globalThis.fetch = fetch; }
});

test('GLB新修订只增加声明，BIN与负零、节点名字和原始buffer保持', () => {
  const json = Buffer.from('{"asset":{"version":"2.0"},"nodes":[{"name":"梁","translation":[-0,0,0]}]}');
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const binary = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const original = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  original.writeUInt32LE(0x46546c67, 0); original.writeUInt32LE(2, 4); original.writeUInt32LE(original.length, 8);
  original.writeUInt32LE(padded.length, 12); original.writeUInt32LE(0x4e4f534a, 16); padded.copy(original, 20);
  original.writeUInt32LE(binary.length, 20 + padded.length); original.writeUInt32LE(0x004e4942, 24 + padded.length); binary.copy(original, 28 + padded.length);
  const frozen = Buffer.from(original), candidate = embedRuntimeCapabilities(original, capability), size = candidate.readUInt32LE(12);
  const parsed = JSON.parse(candidate.subarray(20, 20 + size).toString('utf8'));
  assert.equal(Object.is(parsed.nodes[0].translation[0], -0), true);
  assert.equal(parsed.nodes[0].name, '梁'); assert.deepEqual(parsed.asset.extras.runtimeCapabilities, capability);
  assert.deepEqual(candidate.subarray(20 + size), original.subarray(20 + padded.length));
  assert.deepEqual(original, frozen);
});
