import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ProjectPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'startModelLibrarySync'
    && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback, '必须测试实际自动模型库同步入口');
const executable = ts.transpileModule('globalThis.result = (' + callback.getText(ast) + ');', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** 真实 callback 的窄依赖替身；配置 Promise 可控，避免把未知配置当成禁用。 */
function fixture(config: Promise<{ baseUrl: string }> = Promise.resolve({ baseUrl: '' }), syncError?: Error) {
  const session = { current: 'scene-a' };
  const starting = { current: null as string | null };
  const preparing = { current: false };
  const busy: boolean[] = [];
  const syncs: boolean[] = [];
  const logs: string[] = [];
  const libraryStates: unknown[] = [];
  let configurationReads = 0;
  const run = runInNewContext(executable + '; result;', {
    Error,
    props: { readOnly: false },
    sceneSessionIdRef: session,
    startingLibrarySyncSessionRef: starting,
    localResourcePreparingRef: preparing,
    getSceneModelPublishSession: () => null,
    getScenePreparationSnapshot: () => ({ sceneSessionId: session.current }),
    isScenePreparationSettled: () => true,
    setIsStartingLibrarySync: (value: boolean) => busy.push(value),
    startExplicitSceneModelSync: async (syncLibrary: boolean) => {
      syncs.push(syncLibrary);
      if (syncError) throw syncError;
    },
    window: { editorApi: { getDataPlatformConfig: () => { configurationReads += 1; return config; } } },
    setLibraryStatuses: (update: (previous: unknown) => unknown) => libraryStates.push(update({})),
    pushLog: (message: string) => logs.push(message),
  }) as (automatic?: boolean) => Promise<void>;
  return { run, session, starting, preparing, busy, syncs, logs, libraryStates, reads: () => configurationReads };
}

test('普通本地工程无中台配置时，自动模型库任务不再启动 scene-latest 同步', async () => {
  const f = fixture();
  await f.run(true);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.syncs, []);
  assert.deepEqual(f.busy, [true, false]);
  assert.equal(f.starting.current, null);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.libraryStates, []);
});

test('有中台配置时自动同步保留完整模型库更新参数', async () => {
  const f = fixture(Promise.resolve({ baseUrl: 'http://platform.example' }));
  await f.run(true);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.syncs, [true]);
  assert.deepEqual(f.busy, [true, false]);
});

test('配置仍未知时等待真实读取，稍后发现已配置仍启动自动同步', async () => {
  const config = deferred<{ baseUrl: string }>();
  const f = fixture(config.promise);
  const pending = f.run(true);
  await Promise.resolve();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.syncs, []);
  assert.deepEqual(f.busy, [true]);
  config.resolve({ baseUrl: 'http://platform.example' });
  await pending;
  assert.deepEqual(f.syncs, [true]);
  assert.deepEqual(f.busy, [true, false]);
});

test('用户显式同步不被空配置分支吞掉，保留实际同步路径的配置错误', async () => {
  const error = new Error('请先配置数据中台地址。');
  const f = fixture(Promise.resolve({ baseUrl: '' }), error);
  await assert.rejects(f.run(), error);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.syncs, [true]);
  assert.deepEqual(f.busy, [true, false]);
});

test('等待配置期间切换场景，迟到结果不启动新场景的模型同步', async () => {
  const config = deferred<{ baseUrl: string }>();
  const f = fixture(config.promise);
  const pending = f.run(true);
  f.session.current = 'scene-b';
  config.resolve({ baseUrl: 'http://platform.example' });
  await pending;
  assert.deepEqual(f.syncs, []);
  assert.equal(f.starting.current, null);
});

test('等待配置期间任务失效，迟到结果不越过既有取消归属', async () => {
  const config = deferred<{ baseUrl: string }>();
  const f = fixture(config.promise);
  const pending = f.run(true);
  f.starting.current = null;
  config.resolve({ baseUrl: 'http://platform.example' });
  await pending;
  assert.deepEqual(f.syncs, []);
});

test('读取配置失败只报告模型库检查错误，不冒充无配置成功跳过', async () => {
  const f = fixture(Promise.reject(new Error('配置文件损坏')));
  await f.run(true);
  assert.deepEqual(f.syncs, []);
  assert.deepEqual(f.logs, ['自动同步模型库配置检查失败：配置文件损坏']);
  assert.equal(f.libraryStates.length, 1);
  assert.deepEqual(f.busy, [true, false]);
});
