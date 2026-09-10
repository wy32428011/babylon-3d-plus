import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { getRequiredEnvironmentResourceIds } from '../../electron/shared/sceneEnvironmentReferences.ts';
import { cancelProjectLoading, createProjectOpenSession } from '../../src/editor/home/projectLoadingCancellation.ts';

test('不支持取消或请求失败明确报错，没有远程任务也允许退出本地加载', async () => {
  await assert.rejects(cancelProjectLoading(undefined), /不支持/);
  await assert.rejects(cancelProjectLoading(async () => { throw new Error('IPC失联'); }), /IPC失联/);
  await cancelProjectLoading(async () => false);
  await cancelProjectLoading(async () => true);
});

test('取消与打开完成交错时，旧结果不能进入编辑器或覆盖新项目', () => {
  const session = createProjectOpenSession();
  const old = session.begin();
  assert.equal(session.isCurrent(old), true);
  session.invalidate();
  assert.equal(session.isCurrent(old), false);
  const current = session.begin();
  assert.equal(session.isCurrent(old), false);
  assert.equal(session.isCurrent(current), true);
});

test('真实store场景提交边界丢弃取消后的loadSceneFile结果及后续同步', async () => {
  const source = await readFile(new URL('../../src/editor/store/editorStore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  loadSceneFromFile: async');
  const end = source.indexOf('  loadSceneFromContent:', start);
  assert.ok(start >= 0 && end > start);
  let resolve!: (result: unknown) => void;
  let commits = 0;
  let syncs = 0;
  let committed: { environmentStartupRelinkSessionId?: string | null; sceneResourcePolicy?: string } = {};
  const loadSceneFromFile = runInNewContext(`({${source.slice(start, end)}}).loadSceneFromFile`, {
    window: { editorApi: { loadSceneFile: () => new Promise((done) => { resolve = done; }), confirmSceneOpen: async () => true } },
    get: () => ({ runtimeMode: 'edit', pushLog: () => { commits += 1; } }),
    set: (update: (state: object) => object) => { commits += 1; committed = update({}); },
    deserializeScene: JSON.parse,
    createLoadedSceneState: () => ({ sceneSessionId: 'loaded-session' }),
    syncDataPlatformModelsAfterLocalSceneLoad: () => { syncs += 1; },
    syncDataPlatformEnvironmentsAfterWorkspaceOpen: () => { syncs += 1; },
    syncDataPlatformImagesAfterLocalSceneLoad: () => { syncs += 1; },
  }) as (path: string, current?: () => boolean, defer?: boolean) => Promise<boolean>;
  const session = createProjectOpenSession();
  const request = session.begin();
  const pending = loadSceneFromFile('old-machine.scene.json', () => session.isCurrent(request));
  session.invalidate();
  resolve({ canceled: false, content: '{"name":"old"}', filePath: 'old-machine.scene.json' });
  assert.equal(await pending, false);
  assert.equal(commits, 0);
  assert.equal(syncs, 0);
  const normal = loadSceneFromFile('current.scene.json');
  resolve({ canceled: false, content: '{"name":"current","sceneSettings":{"environment":null}}', filePath: 'current.scene.json', sceneOpenToken: 1 });
  assert.equal(await normal, true);
  assert.equal(commits, 1);
  assert.equal(syncs, 1, '普通/组合与环境由本地准备流程统一启动，仅图片继续后台同步');
  assert.equal(committed.sceneResourcePolicy, 'local-refresh');
  assert.equal(committed.environmentStartupRelinkSessionId, null);
  const remote = loadSceneFromFile('bound.scene.json', () => true, true);
  resolve({ canceled: false, content: '{"name":"bound","sceneSettings":{"environment":{"packagePath":"D:/old-local/environment"}}}', filePath: 'bound.scene.json', sceneOpenToken: 2 });
  assert.equal(await remote, true);
  assert.equal(committed.environmentStartupRelinkSessionId, 'loaded-session');
});

test('打开场景后的环境同步仅请求当前稳定ID，空场景不下载整个环境库', async () => {
  const source = await readFile(new URL('../../src/editor/store/editorStore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function syncDataPlatformEnvironmentsAfterWorkspaceOpen(');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  let environment: unknown = null;
  let request: { requiredResourceIds?: string[]; expectedSourceKey?: string } = {};
  const method = source.slice(start, end).replace('(pushLog: (message: string) => void): Promise<void>', '(pushLog)');
  const sync = runInNewContext(`(${method})`, {
    getRequiredEnvironmentResourceIds,
    window: { editorApi: { syncDataPlatformEnvironments: async (next: typeof request) => { request = next; return true; } } },
    useEditorStore: { getState: () => ({ scene: { sceneSettings: { environment } } }) },
  }) as (log: (message: string) => void) => Promise<void>;
  await sync(() => {});
  assert.equal(JSON.stringify(request.requiredResourceIds), '[]');
  environment = { source: 'data-platform', dataPlatformResourceId: '9007199254740993', dataPlatformSourceKey: 'platform' };
  await sync(() => {});
  assert.equal(JSON.stringify(request.requiredResourceIds), '["9007199254740993"]');
  assert.equal(request.expectedSourceKey, 'platform');
  environment = { packagePath: `D:/other-machine/.babylon-editor/data-platform-cache/environments/${'a'.repeat(64)}/9007199254740995/7` };
  await sync(() => {});
  assert.equal(JSON.stringify(request.requiredResourceIds), '["9007199254740995"]');
  environment = { source: 'local', packagePath: 'D:/legacy/environment' };
  await sync(() => {});
  assert.equal(request.requiredResourceIds, undefined);
});
