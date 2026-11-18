import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import path from 'node:path';
import ts from 'typescript';

const source = await readFile(new URL('../../src/editor/store/slices/sceneDocumentSlice.ts', import.meta.url), 'utf8');
const start = source.indexOf('  loadScene: async (');
const end = source.indexOf('  loadSceneFromContent:', start);
assert.ok(start >= 0 && end > start);
type Entry = 'dialog' | 'path';
const entries = ['dialog', 'path'] as const;
const filePath = 'new.scene.json';
const sceneOpenToken = 8;

async function openFixture(kind: Entry, token = sceneOpenToken, cancelToken?: (token: number) => void) {
  const original = { name: '原场景', sceneSettings: {} };
  let state = { sceneSessionId: 'A', scene: original, runtimeMode: 'edit', logs: [] as string[], pushLog() {} };
  let current = true;
  const reading = Promise.withResolvers<string>();
  const file = Promise.withResolvers<{ canceled: false; content: string; filePath: string; sceneOpenToken: number }>();
  const confirming = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<boolean>();
  const confirmations: number[] = [], cancellations: number[] = [];
  const cachedImages = [{ reference: 'image-a' }], registrations: unknown[][] = [];
  const startRead = (entry: string) => { reading.resolve(entry); return file.promise; };
  const snapshot = (s: typeof state) => ({ sessionId: s.sceneSessionId, content: JSON.stringify(s.scene) });
  const actions = runInNewContext(stripTypeScriptTypes(`({${source.slice(start, end)}})`), {
    window: { editorApi: {
      loadScene: () => startRead('dialog'),
      loadSceneFile: (request: { filePath: string }) => startRead(request.filePath),
      listSyncedImages: async () => cachedImages,
      confirmSceneOpen: (request: { sceneOpenToken: number }) => {
        confirmations.push(request.sceneOpenToken);
        confirming.resolve();
        return decision.promise;
      },
      cancelSceneOpen: async ({ sceneOpenToken }: { sceneOpenToken: number }) => {
        cancellations.push(sceneOpenToken);
        cancelToken?.(sceneOpenToken);
      },
    } },
    get: () => state, set: (update: any) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; },
    // 模拟用户同意离开时的凭据；同会话内后续编辑也会使凭据过期。
    confirmSceneLeave: async (get: () => typeof state) => snapshot(get()),
    isSceneLeaveApprovalCurrent: (s: typeof state, approval: ReturnType<typeof snapshot>) =>
      s.sceneSessionId === approval.sessionId && JSON.stringify(s.scene) === approval.content,
    deserializeScene: JSON.parse, createLoadedSceneState: (_before: unknown, scene: unknown) => ({ scene, sceneSessionId: 'loaded' }),
    prependLog: (_before: unknown, message: string) => [message], syncDataPlatformImagesAfterLocalSceneLoad() {},
    setSyncedImageAssets: (images: unknown[]) => registrations.push(images),
  });
  const pending: Promise<boolean> = kind === 'dialog' ? actions.loadScene() : actions.loadSceneFromFile(filePath, () => current);
  async function waitForCall<T>(started: Promise<T>, label: string) {
    const reached = await Promise.race([started.then(value => ({ value })), pending.then(result => ({ result }))]);
    if ('result' in reached) assert.fail(`${kind} 未到达${label}便返回 ${reached.result}：${state.logs.join('；')}`);
    return reached.value;
  }
  assert.equal(await waitForCall(reading.promise, '读取'), kind === 'dialog' ? 'dialog' : filePath);
  return {
    pending, original, get: () => state, set: (next: Partial<typeof state>) => { state = { ...state, ...next }; },
    confirmations, cancellations, cachedImages, registrations,
    read: (content = '{"name":"新场景","sceneSettings":{}}') => file.resolve({ canceled: false, content, filePath, sceneOpenToken: token }),
    waitForConfirm: () => waitForCall(confirming.promise, '归属确认'),
    confirm: (accepted: boolean) => decision.resolve(accepted), cancel: () => { current = false; },
  };
}

test('文件选择器和最近文件均在反序列化通过后确认发布归属，确认完成前不提交场景', async () => {
  for (const kind of entries) {
    const f = await openFixture(kind);
    assert.deepEqual(f.confirmations, []);
    f.read();
    await f.waitForConfirm();
    assert.deepEqual(f.confirmations, [sceneOpenToken]);
    assert.equal(f.get().scene, f.original);
    assert.deepEqual(f.registrations, []);
    f.confirm(true);
    assert.equal(await f.pending, true);
    assert.equal(f.get().scene.name, '新场景');
    assert.equal(f.get().sceneSessionId, 'loaded');
    assert.deepEqual(f.registrations, [f.cachedImages]);
    assert.deepEqual(f.cancellations, []);
  }
});

test('格式无效或主进程拒绝 token 时保留当前场景，格式校验失败不确认归属', async () => {
  for (const kind of entries) {
    const invalid = await openFixture(kind);
    // 即使错误地发起确认也会得到肯定答复，后续据实断言它从未被调用。
    invalid.confirm(true);
    invalid.read('{invalid');
    assert.equal(await invalid.pending, false);
    assert.deepEqual(invalid.confirmations, []);
    assert.equal(invalid.get().scene, invalid.original);
    assert.deepEqual(invalid.registrations, []);
    assert.deepEqual(invalid.cancellations, kind === 'dialog' ? [sceneOpenToken] : []);

    const denied = await openFixture(kind);
    denied.read();
    await denied.waitForConfirm();
    assert.deepEqual(denied.confirmations, [sceneOpenToken]);
    denied.confirm(false);
    assert.equal(await denied.pending, false);
    assert.equal(denied.get().scene, denied.original);
    assert.deepEqual(denied.registrations, []);
    assert.deepEqual(denied.cancellations, kind === 'dialog' ? [sceneOpenToken] : []);
  }
});

test('文件读取或归属确认期间切换场景，旧返回均不能覆盖新会话', async () => {
  for (const kind of entries) for (const phase of ['reading', 'confirming']) {
    const f = await openFixture(kind);
    if (phase === 'confirming') { f.read(); await f.waitForConfirm(); }
    const later = { name: '后打开的场景', sceneSettings: {} };
    f.set({ sceneSessionId: 'B', scene: later });
    if (phase === 'reading') f.read();
    f.confirm(true);
    assert.equal(await f.pending, false);
    assert.equal(f.get().scene, later);
    assert.equal(f.get().sceneSessionId, 'B');
    assert.deepEqual(f.confirmations, phase === 'reading' ? [] : [sceneOpenToken]);
    assert.deepEqual(f.registrations, []);
    assert.deepEqual(f.cancellations, kind === 'dialog' || phase === 'confirming' ? [sceneOpenToken] : []);
  }
});

test('文件选择器确认归属期间编辑同一会话，保留新修改并撤销该 token', async () => {
  const f = await openFixture('dialog');
  f.read();
  await f.waitForConfirm();
  const edited = { ...f.original, name: '继续编辑的场景' };
  f.set({ scene: edited });
  f.confirm(true);
  assert.equal(await f.pending, false);
  assert.equal(f.get().scene, edited);
  assert.equal(f.get().sceneSessionId, 'A');
  assert.deepEqual(f.cancellations, [sceneOpenToken]);
  assert.deepEqual(f.registrations, []);
});

/** 执行主进程实际归属逻辑，只隔离文件路径和绑定查询。 */
async function createPublishScope() {
  const source = await readFile(new URL('../../electron/ipc/scenePublishScope.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const scope = {} as typeof import('../../electron/ipc/scenePublishScope.ts');
  runInNewContext(outputText, { exports: scope, require(id: string) {
    if (id === 'node:path') return path;
    if (id === 'node:fs') return { promises: { realpath: async (file: string) => path.resolve(file) } };
    if (id === './dataPlatformBindingStore.js') return { readDataPlatformBinding: async () => null };
    throw new Error(`未声明的归属依赖：${id}`);
  } });
  return scope;
}

test('最近文件在主进程确认后取消，只回滚自己的发布归属并保留较新的令牌', async () => {
  const scope = await createPublishScope();
  for (const newer of ['none', 'pending', 'confirmed'] as const) {
    scope.setBoundScenePublishScope('project-A', 'original.scene.json');
    const previous = scope.getScenePublishScope();
    const token = scope.beginScenePublishScopeUpdate();
    assert.equal(scope.stageScenePublishScopeFile(token, filePath), true);
    const f = await openFixture('path', token, scope.cancelScenePublishScopeFile);
    f.read();
    await f.waitForConfirm();
    assert.deepEqual(f.confirmations, [token]);
    const accepted = await scope.confirmScenePublishScopeFile(f.confirmations[0]);
    assert.equal(accepted, true);
    assert.equal(scope.getScenePublishScope().sceneFilePath, path.resolve(filePath));

    const nextPath = 'newer.scene.json';
    let nextToken: number | undefined;
    let expectedScene = f.original;
    if (newer !== 'none') {
      nextToken = scope.beginScenePublishScopeUpdate();
      assert.equal(scope.stageScenePublishScopeFile(nextToken, nextPath), true);
      if (newer === 'confirmed') {
        assert.equal(await scope.confirmScenePublishScopeFile(nextToken), true);
        expectedScene = { ...f.original, name: '后打开的场景' };
        f.set({ sceneSessionId: 'C', scene: expectedScene });
      }
    }
    const scopeBeforeReply = scope.getScenePublishScope();
    if (newer !== 'confirmed') f.cancel();
    f.confirm(accepted);
    assert.equal(await f.pending, false);
    assert.equal(f.get().scene, expectedScene);
    assert.deepEqual(f.registrations, []);
    const after = scope.getScenePublishScope();
    if (newer === 'none') {
      assert.equal(after.sceneFilePath, previous.sceneFilePath);
      assert.equal(after.projectRoot, previous.projectRoot);
      assert.equal(after.kind, previous.kind);
      assert.ok(after.generation > token);
    } else {
      assert.equal(after, scopeBeforeReply);
      if (newer === 'pending') assert.equal(await scope.confirmScenePublishScopeFile(nextToken!), true);
      assert.equal(scope.getScenePublishScope().sceneFilePath, path.resolve(nextPath));
    }
    assert.deepEqual(f.cancellations, [token]);
  }
});

test('开发与打包 preload 均只发送主进程签发的 sceneOpenToken', async () => {
  for (const file of ['electron/preload.ts', 'electron/preload.cts']) {
    const preload = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const line = preload.split('\n').find(item => item.includes('confirmSceneOpen:'));
    assert.ok(line, `${file} 必须暴露确认接口`);
    const calls: unknown[][] = [];
    const method = runInNewContext(stripTypeScriptTypes(`({${line}}).confirmSceneOpen`), {
      ipcRenderer: { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(true); } },
    });
    const request = { sceneOpenToken: 8 };
    await method(request); assert.equal(calls[0][0], 'scene:confirmOpen'); assert.equal(calls[0][1], request);
  }
});
