import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { repairPublishSceneSkyboxes } from '../../src/editor/deployment/repairPublishSceneSkyboxes.ts';

const source = await readFile(new URL('../../src/editor/deployment/useDigitalTwinPublish.ts', import.meta.url), 'utf8');
const hookSource = stripTypeScriptTypes(source.replace(/^import .*\r?\n/gm, '')).replace(/^export /gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const options = { projectId: 'project-1', publishName: '测试发布', remark: '', overwriteExisting: true,
  forceOverwrite: false, confirmResourceBindings: false, allowedParentOrigins: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function context(projectId = 'project-1', versionConflict = false) {
  return { available: true, projectId, baseVersionId: 'version-1', resourceRevision: '10',
    remoteLatestVersionId: versionConflict ? 'version-2' : 'version-1', versionConflict,
    overwriteConfirmationRequired: true, allowedParentOrigins: [] };
}

function result(status = 'conflict') {
  return { requestId: 'result-request', status, errorCode: status === 'conflict' ? 'DIGITAL_TWIN_VERSION_CONFLICT' : null,
    message: '需要重新确认', conflictCopyPath: 'C:/test/conflict.zip', warnings: [] };
}

/** 执行完整 hook，只替代 React 调度和外部 IPC；状态槽跨 render 保留。 */
function fixture() {
  let cursor = 0;
  const slots: any[] = [];
  const logs: string[] = [];
  const contextCalls: unknown[] = [];
  const publishCalls: unknown[] = [];
  const recoveryCalls: any[] = [];
  const commands: string[] = [];
  const cancelCalls: unknown[] = [];
  let progressListener: ((value: unknown) => void) | undefined;
  const initialContext = context();
  const api = {
    context: async (_request: any): Promise<any> => initialContext,
    recover: async (): Promise<any> => ({ replacements: [] }),
    publish: async (_request: any): Promise<any> => result(),
  };
  const store: any = {
    scene: { name: '测试场景' }, sceneSessionId: 'session-1', runtimeMode: 'edit', history: {},
    pushLog: (message: string) => logs.push(message),
    markScenePersisted: (content: string) => logs.push(`persisted:${content}`),
  };
  const useEditorStore = Object.assign((select: (value: any) => unknown) => select(store), {
    getState: () => store,
    setState: (update: (value: any) => any) => Object.assign(store, update(store)),
  });
  const useDigitalTwinPublish = runInNewContext(`${hookSource}\nuseDigitalTwinPublish;`, {
    Error,
    crypto: { randomUUID: (() => { let id = 0; return () => `publish-${++id}`; })() },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (update: any) => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect(effect: () => unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = effect() ?? true;
    },
    useCallback: (callback: unknown) => callback,
    useMemo: (callback: () => unknown) => callback(),
    useEditorStore,
    serializeScene: JSON.stringify,
    repairPublishSceneModels: (scene: unknown) => ({ scene }),
    repairPublishSceneSkyboxes,
    getSceneShadowBakeError: () => null,
    getScenePreparationSnapshot: () => ({ completed: false, runtime: {} }),
    environmentPreparationStore: { getSnapshot: () => ({}) },
    executeCommand(scene: any, history: any, command: any) { commands.push(command.label); return { scene: command.apply(scene), history }; },
    updateSceneDocumentCommand(label: string, apply: any) { return { label, apply }; },
    window: { editorApi: {
      onDigitalTwinPublishProgress: (listener: (value: unknown) => void) => { progressListener = listener; return () => { progressListener = undefined; }; },
      getDigitalTwinPublishContext: (request: unknown) => { contextCalls.push(request); return api.context(request); },
      recoverDigitalTwinModels: (request: any) => { recoveryCalls.push(request); return api.recover(); },
      publishDigitalTwin: (request: any) => { publishCalls.push(request); return api.publish(request); },
      cancelDigitalTwinPublish: async (request: unknown) => { cancelCalls.push(request); return true; },
    } },
  });
  const render = () => { cursor = 0; return useDigitalTwinPublish(); };
  return { render, api, logs, contextCalls, publishCalls, recoveryCalls, commands, store, cancelCalls, initialContext,
    progress: (value: unknown) => progressListener?.(value) };
}

test('版本冲突后刷新上下文并保留冲突结果、进度，刷新期间禁用重试', async () => {
  const f = fixture();
  await f.render().loadContext();
  const refreshed = deferred<any>();
  f.api.context = () => refreshed.promise;
  const conflict = result();
  const progress = { requestId: 'publish-1', phase: 'prepare', detail: '创建发布任务', percent: 50 };
  f.api.publish = async () => { f.progress(progress); return conflict; };
  const publishing = f.render().start(options);
  await tick();
  assert.equal(f.contextCalls.length, 2);
  assert.equal((f.contextCalls[1] as any).projectId, options.projectId);
  assert.equal(f.render().state.status, 'conflict');
  assert.equal(f.render().state.result, conflict);
  assert.equal(f.render().state.progress, progress);
  assert.equal(f.render().isBusy, true, '终态已显示但刷新未落定时按钮仍必须禁用');
  assert.equal(await f.render().start(options), null);
  assert.equal(f.publishCalls.length, 1);
  const latest = context('project-1', true);
  refreshed.resolve(latest);
  assert.equal(await publishing, conflict);
  assert.equal(f.render().state.context, latest);
  assert.equal(f.render().state.context.versionConflict, true, '使弹窗展示显式强制覆盖确认');
  assert.equal(f.render().state.context.baseVersionId, 'version-1');
  assert.equal(f.render().state.result, conflict);
  assert.equal(f.render().state.progress, progress);
  assert.equal(f.render().state.status, 'conflict');
  assert.equal(f.render().isBusy, false);
});

test('需要确认时同样刷新上下文，已完成发布不额外刷新或转成错误', async () => {
  const f = fixture();
  await f.render().loadContext();
  const confirmation = result('confirmation-required');
  const latest = context('project-1', true);
  f.api.publish = async () => confirmation;
  f.api.context = async () => latest;
  assert.equal(await f.render().start(options), confirmation);
  assert.equal(f.render().state.status, 'confirmation-required');
  assert.equal(f.render().state.context, latest);
  assert.equal(f.render().state.result, confirmation);
  const contextCalls = f.contextCalls.length;
  const completed = result('completed');
  f.api.publish = async () => completed;
  f.api.context = async () => { throw new Error('不应刷新'); };
  assert.equal(await f.render().start(options), completed);
  assert.equal(f.render().state.status, 'completed');
  assert.equal(f.contextCalls.length, contextCalls);
  assert.equal(f.render().isBusy, false);
});

test('上下文刷新失败保留冲突和已有上下文，显示可诊断错误并释放忙碌状态', async () => {
  const f = fixture();
  await f.render().loadContext();
  const conflict = result();
  f.api.publish = async () => conflict;
  f.api.context = async () => { throw new Error('fixture offline'); };
  assert.equal(await f.render().start(options), conflict);
  assert.equal(f.render().state.status, 'conflict');
  assert.equal(f.render().state.result, conflict);
  assert.equal(f.render().state.context, f.initialContext);
  assert.match(f.render().state.error, /刷新.*fixture offline/);
  assert.ok(f.logs.some(message => /刷新.*fixture offline/.test(message)));
  assert.equal(f.render().isBusy, false);
});

for (const fails of [false, true]) {
  test(`迟到的${fails ? '失败' : '成功'}刷新不能覆盖后续项目选择`, async () => {
    const f = fixture();
    await f.render().loadContext();
    const late = deferred<any>();
    f.api.context = () => late.promise;
    const publishing = f.render().start(options);
    await tick();
    assert.equal(f.contextCalls.length, 2, '冲突刷新必须已经开始，才能验证迟到隔离');
    const next = context('project-2');
    f.api.context = async () => next;
    await f.render().loadContext('project-2');
    if (fails) late.reject(new Error('旧请求失败'));
    else late.resolve(context('project-1', true));
    await publishing;
    assert.equal(f.render().state.context, next);
    assert.equal(f.render().state.status, 'ready');
    assert.equal(f.render().state.result, null);
    assert.equal(f.render().state.error, null);
    assert.equal(f.render().isBusy, false);
    f.api.publish = async () => result('completed');
    assert.equal((await f.render().start({ ...options, projectId: 'project-2' })).status, 'completed');
  });
}

test('模型恢复期间取消不会继续发布，取消后可以发起新的发布', async () => {
  const f = fixture();
  await f.render().loadContext();
  const recovery = deferred<any>();
  f.api.recover = () => recovery.promise;
  const publishing = f.render().start(options);
  await tick();
  await f.render().cancel();
  recovery.resolve({ replacements: [] });
  assert.equal(await publishing, null);
  assert.equal(f.render().state.status, 'canceled');
  assert.equal(f.render().state.error, null);
  assert.equal(f.render().isBusy, false);
  assert.equal(f.publishCalls.length, 0);
  assert.equal(f.cancelCalls.length, 1);
  f.api.recover = async () => ({ replacements: [] });
  f.api.publish = async () => result('completed');
  assert.equal((await f.render().start(options)).status, 'completed');
  assert.equal(f.render().isBusy, false);
});

test('恢复模型和发布使用预检签发的同一个目标票据', async () => {
  const f = fixture();
  f.api.context = async () => ({ ...context(), targetToken: 'target-B' });
  await f.render().loadContext();
  f.api.publish = async () => result('completed');
  await f.render().start(options);
  assert.equal(f.recoveryCalls[0].targetToken, 'target-B');
  assert.equal((f.publishCalls[0] as any).targetToken, 'target-B');
});

test('关闭窗口或者更换场景后旧上下文不能启动发布', async () => {
  for (const reset of [true, false]) {
    const f = fixture();
    await f.render().loadContext();
    if (reset) f.render().reset();
    else f.store.sceneSessionId = 'session-2';
    assert.equal(await f.render().start(options), null);
    assert.equal(f.recoveryCalls.length, 0);
  }
});

test('场景切换后迟到的上下文被丢弃', async () => {
  const f = fixture();
  const late = deferred<any>();
  f.api.context = () => late.promise;
  const loading = f.render().loadContext();
  f.store.sceneSessionId = 'session-2';
  late.resolve(context());
  await loading;
  assert.equal(f.render().state.context, null);
});

test('本地恢复尚未完成首帧时不能进入发布恢复接口', async () => {
  const f = fixture();
  await f.render().loadContext();
  f.store.sceneResourcePolicy = 'local-refresh';
  f.store.sceneResourceIssues = [];
  assert.equal(await f.render().start(options), null);
  assert.equal(f.recoveryCalls.length, 0);
});

test('恢复期间切换场景不会继续发布或者修改新场景', async () => {
  const f = fixture();
  await f.render().loadContext();
  const recovery = deferred<any>();
  f.api.recover = () => recovery.promise;
  const publishing = f.render().start(options);
  f.store.sceneSessionId = 'session-2';
  recovery.resolve({ replacements: [] });
  assert.equal(await publishing, null);
  assert.equal(f.publishCalls.length, 0);
});

test('发布请求返回前切换场景，不把新场景标记为已保存', async () => {
  const f = fixture();
  await f.render().loadContext();
  const publish = deferred<any>();
  f.api.publish = () => publish.promise;
  const publishing = f.render().start(options);
  await tick();
  f.store.sceneSessionId = 'session-2';
  publish.resolve(result('completed'));
  await publishing;
  assert.equal(f.logs.some(value => value.startsWith('persisted:')), false);
});

test('天空盒恢复经一次命令回写，并把恢复后的文档传给发布', async () => {
  const f = fixture();
  f.store.scene = { sceneSettings: { skybox: { sourceUrl: 'old', sourcePath: 'D:/sky.exr', intensity: 0.5 } }, entities: {} };
  f.api.recover = async () => ({ replacements: [], skyboxReplacements: [
    { entityId: null, sourceUrl: 'old', skybox: { sourceUrl: 'new', sourcePath: 'C:/sky.exr', intensity: 9 } },
  ] });
  f.api.publish = async () => result('completed');
  await f.render().loadContext();
  await f.render().start(options);
  assert.equal(f.commands.length, 1);
  assert.equal(f.store.scene.sceneSettings.skybox.sourceUrl, 'new');
  const published = JSON.parse((f.publishCalls[0] as any).sceneContent);
  assert.equal(published.sceneSettings.skybox.sourceUrl, 'new');
  assert.equal(published.sceneSettings.skybox.intensity, 0.5);
  assert.ok(f.logs.some(message => message.includes('恢复 1 个天空盒引用')));
});
