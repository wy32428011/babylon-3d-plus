import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import test from 'node:test';

const paths = ['electron/ipc/projectIpc.ts', 'electron/ipc/dataPlatformIpc.ts', 'electron/ipc/projectAssetStore.ts', 'electron/ipc/digitalTwinPublishIpc.ts'];
const sources = await Promise.all(paths.map(file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8')));
function evaluate(text: string, context: Record<string, unknown>) {
  const js = ts.transpileModule(`globalThis.result = (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(`${js};result`, context);
}
function handler(file: number, channel: string, context: Record<string, unknown>) {
  const ast = ts.createSourceFile(paths[file], sources[file], ts.ScriptTarget.Latest, true);
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) found = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(found, channel);
  return evaluate(found.getText(ast), context);
}
function fn(file: number, name: string, context: Record<string, unknown>) {
  const ast = ts.createSourceFile(paths[file], sources[file], ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name); return evaluate(node.getText(ast).replace(/^export /, ''), context);
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('远端工程已经开始打开时，预检、恢复和正式发布均不得抢先启动', async () => {
  const context = { assertTrustedSender: () => ({ sender: { id: 1 } }),
    isDataPlatformProjectClosing: () => false, isDataPlatformProjectOpening: () => true };
  for (const name of ['handleGetContext', 'handleRecoverModels', 'handleStartPublish']) {
    await assert.rejects(fn(3, name, context)({}, {}), /正在打开/, name);
  }
});

test('正式发布或资源恢复活动期间，场景和工程切换入口均在任何操作前拒绝', async () => {
  for (const [file, channels] of [[0, ['scene:load', 'scene:loadFile', 'scene:confirmOpen', 'project:openRecent', 'project:selectDirectory']],
    [1, ['data-platform:saveConfig', 'data-platform:selectWorkspace', 'data-platform:resetWorkspace', 'data-platform:openProject']]] as const) {
    const context: Record<string, unknown> = { isDigitalTwinPublishActive: () => true };
    context.assertSceneSwitchAllowed = fn(file, 'assertSceneSwitchAllowed', context);
    for (const channel of channels) await assert.rejects(handler(file, channel, context)({}, {}), /发布|恢复/, channel);
  }
});

test('场景文件对话框和磁盘读取等待期间开始发布，迟到结果不得进入待确认阶段', async () => {
  for (const channel of ['scene:load', 'scene:loadFile']) {
    let publishing = false; let resume!: (value: any) => void; const events: string[] = [];
    const wait = new Promise(resolve => { resume = resolve; });
    const context: Record<string, unknown> = {
      isDigitalTwinPublishActive: () => publishing, beginScenePublishScopeUpdate: () => 1,
      dialog: { showOpenDialog: () => wait }, validateLoadSceneFileRequest: (value: unknown) => value,
      assertRecentSceneFile: async () => 'scene.scene.json', readUtf8File: () => wait,
      authorizeSceneFile: () => events.push('authorize'), authorizeModelAssetsFromSceneContent() {},
      rememberRecentSceneFile: async () => {}, stageScenePublishScopeFile: () => { events.push('staged'); return true; },
    };
    context.assertSceneSwitchAllowed = fn(0, 'assertSceneSwitchAllowed', context);
    const pending = handler(0, channel, context)({}, { filePath: 'scene.scene.json' });
    await tick(); publishing = true;
    resume(channel === 'scene:load' ? { canceled: false, filePaths: ['scene.scene.json'] } : '{}');
    await assert.rejects(pending, /发布|恢复/); assert.deepEqual(events, []);
  }
});

test('确认 IPC 把发布检查传到归属最终提交边界', async () => {
  let publishing = false; let resume!: () => void; let committed = false;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const context: Record<string, unknown> = { isDigitalTwinPublishActive: () => publishing,
    confirmScenePublishScopeFile: async (_token: number, assertCanCommit: () => void) => {
      await wait; assertCanCommit(); committed = true; return true;
    } };
  context.assertSceneSwitchAllowed = fn(0, 'assertSceneSwitchAllowed', context);
  const pending = handler(0, 'scene:confirmOpen', context)({}, { sceneOpenToken: 1 });
  await tick(); publishing = true; resume(); await assert.rejects(pending, /发布|恢复/);
  assert.equal(committed, false);
});

test('选择项目目录的对话框返回后重新检查，发布开始后不写目录和最近记录', async () => {
  let publishing = false; let resume!: (value: unknown) => void; const events: string[] = [];
  const wait = new Promise(resolve => { resume = resolve; });
  const context: Record<string, unknown> = { dialog: { showOpenDialog: () => wait },
    normalizeFilePath: (value: unknown) => value,
    ensureProjectDirectories: async () => events.push('directories'), authorizeProjectAssetRoots() {},
    persistCurrentProjectRoot: async () => events.push('persist'), rememberRecentProjectRoot: async () => events.push('recent'),
    setSharedProjectAssetRoot() {}, setSharedProjectSkyboxRoot() {}, setSharedProjectEnvironmentRoot() {}, setCurrentProjectRoot: () => events.push('activate'),
  };
  const guard = () => { if (publishing) throw new Error('发布期间拒绝切换'); };
  const pending = fn(2, 'selectCurrentProjectRootWithDialog', context)(guard);
  publishing = true; resume({ canceled: false, filePaths: ['project'] });
  await assert.rejects(pending, /发布/); assert.deepEqual(events, []);
});

test('配置目录准备期间发布开始时不写配置文件', async () => {
  let publishing = false; const events: string[] = [];
  const context: Record<string, unknown> = {
    isDigitalTwinPublishActive: () => publishing, getDataPlatformConfigPath: () => 'config.json',
    path: { dirname: () => '.' }, fs: { mkdir: async () => { publishing = true; }, writeFile: async () => events.push('write') },
    toDataPlatformConfig: (value: unknown) => value,
  };
  context.assertSceneSwitchAllowed = fn(1, 'assertSceneSwitchAllowed', context);
  await assert.rejects(fn(1, 'writeStoredDataPlatformConfig', context)({}), /发布|恢复/);
  assert.deepEqual(events, []);
});

test('关闭会话在等待异步任务之前撤销待确认场景归属', async () => {
  const events: string[] = [];
  const context: Record<string, unknown> = { isDigitalTwinPublishActive: () => false, projectClosing: false,
    projectMetadataControllers: [], projectSessionTasks: [], cancelDataPlatformProjectLoading() {},
    clearDataPlatformProjectServiceRetryContext() {}, clearDataPlatformChartSyncRetryContext() {},
    resetScenePublishScope: () => events.push('scope-reset'),
    resetDataPlatformProjectSession: async () => events.push('reset'), resetDataPlatformChartSyncSession: async () => {},
    clearCurrentDataPlatformBinding() {}, clearProjectAssetStoreSession() {},
  };
  await handler(1, 'data-platform:closeProject', context)();
  assert.deepEqual(events, ['scope-reset', 'reset']);
});
