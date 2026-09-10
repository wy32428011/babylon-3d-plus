import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [scope, bindings] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/scenePublishScope'),
  typeof import('../../electron/ipc/dataPlatformBindingStore'),
]>(['electron/ipc/scenePublishScope.ts', 'electron/ipc/dataPlatformBindingStore.ts']);

test('独立本地文件不继承旧工程绑定，资源文件引用不影响发布归属', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-publish-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  scope.setBoundScenePublishScope(projectRoot);
  const file = path.join(root, 'local.scene.json');
  await fs.writeFile(file, JSON.stringify({ sourcePath: path.join(projectRoot, 'model.glb') }));
  assert.equal(await scope.commitScenePublishScopeFromFile(scope.beginScenePublishScopeUpdate(), file), true);
  assert.equal(scope.getScenePublishScope().kind, 'local-file');
  assert.equal(scope.getScenePublishScope().sceneFilePath, await fs.realpath(file));
});

test('真实父目录绑定决定工程归属，前缀相似目录不继承', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-publish-bound-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await bindings.writeDataPlatformBinding(projectRoot, bindings.createDataPlatformBinding({
    baseUrl: 'http://old.example:8086', projectId: '123', projectName: '旧工程',
    workspaceRoot: root, editorProjectId: null, latestVersionId: null,
    latestVersionNumber: null, resourceRevision: '1', entryScenePath: null,
    syncedAt: new Date().toISOString(),
  }));
  const file = path.join(projectRoot, 'Scenes', 'scene.scene.json');
  await fs.mkdir(path.dirname(file)); await fs.writeFile(file, '{}');
  await scope.commitScenePublishScopeFromFile(scope.beginScenePublishScopeUpdate(), file);
  assert.equal(scope.getScenePublishScope().kind, 'bound-project');
  assert.equal(scope.getScenePublishScope().projectRoot, await fs.realpath(projectRoot));
  const otherFile = path.join(root, 'project-copy', 'scene.scene.json');
  await fs.mkdir(path.dirname(otherFile)); await fs.writeFile(otherFile, '{}');
  await scope.commitScenePublishScopeFromFile(scope.beginScenePublishScopeUpdate(), otherFile);
  assert.equal(scope.getScenePublishScope().kind, 'local-file');
});

test('迟到读取不能覆盖新工程或返回首页后的会话，失败读取保留旧归属', async () => {
  scope.setBoundScenePublishScope(path.resolve('old-project'));
  const old = scope.getScenePublishScope();
  const token = scope.beginScenePublishScopeUpdate();
  await assert.rejects(scope.commitScenePublishScopeFromFile(token, path.join(os.tmpdir(), 'missing-scope-scene-992.scene.json')));
  assert.deepEqual(scope.getScenePublishScope(), old);
  const staleToken = scope.beginScenePublishScopeUpdate();
  scope.resetScenePublishScope();
  assert.equal(await scope.commitScenePublishScopeFromFile(staleToken, 'missing.scene.json'), false);
  assert.equal(scope.getScenePublishScope().kind, 'unspecified');
});

test('快照不可更改活动归属，每次成功提交推进 generation', () => {
  scope.resetScenePublishScope();
  const before = scope.getScenePublishScope();
  scope.setBoundScenePublishScope(path.resolve('next-project'));
  const after = scope.getScenePublishScope();
  assert.ok(after.generation > before.generation);
  assert.ok(Object.isFrozen(after));
});

test('未确认的解析失败或取消不改变原归属，确认只接受主进程读取的当前token', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-publish-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'scene.scene.json');
  await fs.writeFile(file, '{}');
  scope.setBoundScenePublishScope(path.join(root, 'previous'));
  const before = scope.getScenePublishScope();
  const token = scope.beginScenePublishScopeUpdate();
  assert.equal(scope.stageScenePublishScopeFile(token, file), true);
  assert.deepEqual(scope.getScenePublishScope(), before);
  assert.equal(await scope.confirmScenePublishScopeFile(token + 100), false);
  assert.equal(await scope.confirmScenePublishScopeFile(token), true);
  assert.equal(scope.getScenePublishScope().kind, 'local-file');
  assert.equal(await scope.confirmScenePublishScopeFile(token), false);
  const stale = scope.beginScenePublishScopeUpdate();
  scope.stageScenePublishScopeFile(stale, file);
  scope.resetScenePublishScope();
  assert.equal(await scope.confirmScenePublishScopeFile(stale), false);
});

test('正在读取父目录绑定时关闭工程，迟到结果也不能复活归属', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-publish-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'scene.scene.json');
  await fs.writeFile(file, '{}');
  const token = scope.beginScenePublishScopeUpdate();
  scope.stageScenePublishScopeFile(token, file);
  const reading = scope.confirmScenePublishScopeFile(token);
  scope.resetScenePublishScope();
  assert.equal(await reading, false);
  assert.equal(scope.getScenePublishScope().kind, 'unspecified');
});

test('损坏的真实父目录绑定报告错误并保留原归属', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-publish-bad-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'scene.scene.json');
  await fs.writeFile(file, '{}');
  await fs.mkdir(path.join(root, '.babylon-editor'));
  await fs.writeFile(path.join(root, '.babylon-editor', 'data-platform-binding.json'), 'broken');
  scope.setBoundScenePublishScope(path.join(root, 'old'));
  const before = scope.getScenePublishScope();
  await assert.rejects(scope.commitScenePublishScopeFromFile(scope.beginScenePublishScopeUpdate(), file), /绑定/);
  assert.deepEqual(scope.getScenePublishScope(), before);
});

test('最终提交守卫拒绝后仍保持原发布归属，结束发布后可确认同一读取结果', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-publish-final-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'scene.scene.json'); await fs.writeFile(file, '{}');
  scope.setBoundScenePublishScope(path.join(root, 'old'));
  const before = scope.getScenePublishScope();
  const token = scope.beginScenePublishScopeUpdate(); scope.stageScenePublishScopeFile(token, file);
  await assert.rejects(scope.confirmScenePublishScopeFile(token, () => { throw new Error('发布已经开始'); }), /发布/);
  assert.equal(scope.getScenePublishScope(), before);
  assert.equal(await scope.confirmScenePublishScopeFile(token, () => {}), true);
  assert.equal(scope.getScenePublishScope().kind, 'local-file');
});
