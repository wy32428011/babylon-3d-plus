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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const channel of ['scene:load', 'scene:loadFile']) {
  for (const phase of channel === 'scene:load' ? ['dialog', 'read', 'opening', 'lighting'] : ['read', 'opening', 'lighting']) {
    test(channel + ' 在 ' + phase + ' 等待期间开始发布时不得授权或暂存迟到场景', { timeout: 10000 }, async () => {
      let publishing = false;
      const entered = deferred<void>();
      const gate = deferred<void>();
      const effects: string[] = [];
      const steps: string[] = [];
      const boundary = async (name: string) => {
        steps.push(name);
        if (name === phase) { entered.resolve(); await gate.promise; }
      };
      const context: Record<string, unknown> = {
        isDigitalTwinPublishActive: () => publishing,
        beginScenePublishScopeUpdate: () => 42,
        getScenePublishScope: () => ({ generation: 0 }),
        dialog: { showOpenDialog: async () => { await boundary('dialog'); return { canceled: false, filePaths: ['scene.scene.json'] }; } },
        validateLoadSceneFileRequest: (value: unknown) => value,
        assertRecentSceneFile: async () => 'scene.scene.json',
        readUtf8File: async () => { await boundary('read'); return '{"scene":"original"}'; },
        prepareOpeningSceneContent: async (content: string, path: string) => {
          assert.equal(content, '{"scene":"original"}'); assert.equal(path, 'scene.scene.json');
          await boundary('opening'); return '{"scene":"opening"}';
        },
        prepareLightingSceneContent: async (content: string, path: string) => {
          assert.equal(content, '{"scene":"opening"}'); assert.equal(path, 'scene.scene.json');
          await boundary('lighting'); return { content: '{"scene":"prepared"}', files: ['lighting.bin'] };
        },
        getCurrentProjectRoot: () => null, isAuthorizedAssetFile: () => false,
        authorizeAssetFile: () => effects.push('lighting-authorize'),
        authorizeSceneFile: () => effects.push('authorize'),
        authorizeModelAssetsFromSceneContent: () => effects.push('model-authorize'),
        rememberRecentSceneFile: async () => { effects.push('recent'); },
        stageScenePublishScopeFile: () => { effects.push('staged'); return true; },
      };
      context.assertSceneSwitchAllowed = fn(0, 'assertSceneSwitchAllowed', context);
      context.prepareSceneResourceContent = fn(0, 'prepareSceneResourceContent', context);
      const pending = handler(0, channel, context)({}, { filePath: 'scene.scene.json' });
      // 同时观察任务提前结束；VM 缺依赖等错误必须立即失败，不能无限等待门闩。
      await Promise.race([entered.promise, pending.then(() => assert.fail('尚未进入等待点即返回'))]);
      const rejected = assert.rejects(pending, /发布|恢复/);
      publishing = true; gate.resolve(); await rejected;
      assert.deepEqual(effects, []);
      const expectedSteps = phase === 'dialog' ? ['dialog'] : [
        ...(channel === 'scene:load' ? ['dialog'] : []), 'read', 'opening', ...(phase === 'lighting' ? ['lighting'] : []),
      ];
      assert.deepEqual(steps, expectedSteps);
    });
  }
}

test('各异步打开边界关闭会话后，真实发布归属拒绝迟到 token', { timeout: 10000 }, async () => {
  const scopeSource = await readFile(new URL('../../electron/ipc/scenePublishScope.ts', import.meta.url), 'utf8');
  for (const channel of ['scene:load', 'scene:loadFile']) {
    for (const phase of channel === 'scene:load' ? ['dialog', 'read', 'opening', 'lighting'] : ['read', 'opening', 'lighting']) {
      // 使用真实 token/暂存/重置实现；磁盘与资源准备只提供可控异步边界。
      const scope = evaluate('(() => {' + scopeSource.replace(/^import .*$/gm, '').replace(/^export /gm, '')
        + '; return { beginScenePublishScopeUpdate, resetScenePublishScope, stageScenePublishScopeFile, getScenePublishScope, confirmScenePublishScopeFile }; })()', {});
      const gate = deferred<void>(); const entered = deferred<void>();
      const boundary = async (name: string) => { if (name === phase) { entered.resolve(); await gate.promise; } };
      const staged: boolean[] = [];
      const effects: string[] = [];
      const context: Record<string, unknown> = {
        isDigitalTwinPublishActive: () => false,
        beginScenePublishScopeUpdate: scope.beginScenePublishScopeUpdate,
        getScenePublishScope: scope.getScenePublishScope,
        stageScenePublishScopeFile: (token: number, path: string) => {
          const result = scope.stageScenePublishScopeFile(token, path); staged.push(result); return result;
        },
        dialog: { showOpenDialog: async () => { await boundary('dialog'); return { canceled: false, filePaths: ['scene.scene.json'] }; } },
        validateLoadSceneFileRequest: (value: unknown) => value, assertRecentSceneFile: async () => 'scene.scene.json',
        readUtf8File: async () => { await boundary('read'); return '{}'; },
        prepareOpeningSceneContent: async () => { await boundary('opening'); return '{}'; },
        prepareLightingSceneContent: async () => { await boundary('lighting'); return { content: '{}', files: ['lighting.bin'] }; },
        getCurrentProjectRoot: () => null, isAuthorizedAssetFile: () => false,
        authorizeAssetFile: () => effects.push('lighting-authorize'),
        authorizeSceneFile: () => effects.push('scene-authorize'),
        authorizeModelAssetsFromSceneContent: () => effects.push('model-authorize'),
        rememberRecentSceneFile: async () => { effects.push('recent'); },
      };
      context.assertSceneSwitchAllowed = fn(0, 'assertSceneSwitchAllowed', context);
      context.prepareSceneResourceContent = fn(0, 'prepareSceneResourceContent', context);
      const pending = handler(0, channel, context)({}, { filePath: 'scene.scene.json' });
      await Promise.race([entered.promise, pending.then(() => assert.fail('尚未进入等待点即返回'))]);
      await handler(1, 'data-platform:closeProject', {
        isDigitalTwinPublishActive: () => false, projectClosing: false, cancelCompositionSync() {},
        resetScenePublishScope: scope.resetScenePublishScope, projectMetadataControllers: [], projectSessionTasks: [],
        cancelDataPlatformProjectLoading() {}, clearDataPlatformProjectServiceRetryContext() {}, clearDataPlatformChartSyncRetryContext() {},
        resetDataPlatformProjectSession: async () => {}, resetDataPlatformChartSyncSession: async () => {},
        clearCurrentDataPlatformBinding() {}, clearProjectAssetStoreSession() {},
      })();
      gate.resolve();
      assert.deepEqual({ ...await pending }, { canceled: true, filePath: null, content: null }, channel + ':' + phase);
      assert.deepEqual(staged, []);
      assert.deepEqual(effects, [], channel + ':' + phase);
      assert.equal(scope.getScenePublishScope().kind, 'unspecified');
      assert.equal(await scope.confirmScenePublishScopeFile(1), false);
    }
  }
});

for (const channel of ['scene:load', 'scene:loadFile']) {
  test(channel + ' 正常打开时完整准备并授权资源，保留场景内容和暂存 token', async () => {
    const effects: string[] = [];
    const context: Record<string, unknown> = {
      isDigitalTwinPublishActive: () => false,
      beginScenePublishScopeUpdate: () => 42, getScenePublishScope: () => ({ generation: 0 }),
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['scene.scene.json'] }) },
      validateLoadSceneFileRequest: (value: unknown) => value, assertRecentSceneFile: async () => 'scene.scene.json',
      readUtf8File: async () => '{"scene":"original"}',
      prepareOpeningSceneContent: async (content: string) => {
        assert.equal(content, '{"scene":"original"}'); effects.push('opening'); return '{"scene":"opening"}';
      },
      prepareLightingSceneContent: async (content: string) => {
        assert.equal(content, '{"scene":"opening"}'); effects.push('lighting');
        return { content: '{"scene":"prepared"}', files: ['lighting.bin'] };
      },
      getCurrentProjectRoot: () => null, isAuthorizedAssetFile: () => false,
      authorizeAssetFile: (file: string) => { assert.equal(file, 'lighting.bin'); effects.push('lighting-authorize'); },
      authorizeSceneFile: () => effects.push('scene-authorize'),
      authorizeModelAssetsFromSceneContent: (content: string) => {
        assert.equal(content, '{"scene":"prepared"}'); effects.push('model-authorize');
      },
      rememberRecentSceneFile: async () => { effects.push('recent'); },
      stageScenePublishScopeFile: (token: number, file: string) => {
        assert.equal(token, 42); assert.equal(file, 'scene.scene.json'); effects.push('staged'); return true;
      },
    };
    context.assertSceneSwitchAllowed = fn(0, 'assertSceneSwitchAllowed', context);
    context.prepareSceneResourceContent = fn(0, 'prepareSceneResourceContent', context);
    const result = await handler(0, channel, context)({}, { filePath: 'scene.scene.json' });
    assert.deepEqual({ ...result }, { canceled: false, filePath: 'scene.scene.json', content: '{"scene":"prepared"}', sceneOpenToken: 42 });
    assert.deepEqual(effects, ['opening', 'lighting', 'lighting-authorize', 'scene-authorize', 'model-authorize', 'recent', 'staged']);
  });
}

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

test('关闭会话先取消组合库同步并撤销待确认归属，等待任务结束后才清理会话', async () => {
  const events: string[] = [];
  const task = deferred<void>();
  const context: Record<string, unknown> = { isDigitalTwinPublishActive: () => false, projectClosing: false,
    projectMetadataControllers: [{ abort: () => events.push('abort') }], projectSessionTasks: [task.promise],
    cancelCompositionSync: () => events.push('composition-cancel'),
    cancelDataPlatformProjectLoading: () => events.push('loading-cancel'),
    clearDataPlatformProjectServiceRetryContext: () => events.push('service-retry-clear'),
    clearDataPlatformChartSyncRetryContext: () => events.push('chart-retry-clear'),
    resetScenePublishScope: () => events.push('scope-reset'),
    resetDataPlatformProjectSession: async () => events.push('reset'),
    resetDataPlatformChartSyncSession: async () => events.push('chart-reset'),
    clearCurrentDataPlatformBinding: () => events.push('binding-clear'),
    clearProjectAssetStoreSession: () => events.push('assets-clear'),
  };
  const close = handler(1, 'data-platform:closeProject', context);
  const pending = close();
  await tick();
  assert.deepEqual(events, ['composition-cancel', 'scope-reset', 'abort', 'loading-cancel', 'service-retry-clear', 'chart-retry-clear']);
  await assert.rejects(close(), /正在关闭/);
  task.resolve(); await pending;
  assert.deepEqual(events, ['composition-cancel', 'scope-reset', 'abort', 'loading-cancel', 'service-retry-clear', 'chart-retry-clear', 'reset', 'chart-reset', 'binding-clear', 'assets-clear']);
});
