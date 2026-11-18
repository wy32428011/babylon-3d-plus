import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function loadBridge(fileName, trusted = true) {
  const source = await readFile(new URL(`../../electron/${fileName}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  let api;
  const calls = [], listeners = new Map();
  const result = { replacements: [] };
  runInNewContext(outputText, {
    exports: {}, queueMicrotask, URL,
    process: { isMainFrame: true, argv: ['--editor-entry-url=' + encodeURIComponent('http://127.0.0.1:3000/')] },
    location: { href: trusted ? 'http://127.0.0.1:3000/' : 'https://untrusted.example/' },
    require: name => {
      assert.equal(name, 'electron', 'sandbox preload 不能依赖额外运行时模块');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'editorApi'); api = value; } },
        ipcRenderer: {
          invoke: (channel, request) => { calls.push({ channel, request }); return Promise.resolve(result); },
          on: (channel, listener) => listeners.set(channel, listener),
          removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
        },
      };
    },
  });
  return { api, calls, listeners, result };
}

for (const fileName of ['preload.cts', 'preload.ts']) {
  test(`${fileName} 向窗口暴露模型恢复，并保留发布、取消和进度接口`, async () => {
    const { api, calls, listeners, result } = await loadBridge(fileName);
    assert.equal(typeof api.recoverDigitalTwinModels, 'function', '点击发布需要 window.editorApi.recoverDigitalTwinModels');
    const request = { requestId: 'publish-1', projectId: '1', sceneContent: '{"scene":{}}' };
    const traceRequest = { openId: '11111111-1111-4111-8111-111111111111' };
    assert.equal(await api.getProjectOpenTrace(traceRequest), result);
    assert.equal(await api.prepareDigitalTwinPublishSceneSnapshots(request), result);
    assert.equal(await api.cancelSceneModelSync({ requestId: request.requestId }), result);
    assert.equal(await api.recoverDigitalTwinModels(request), result);
    assert.equal(await api.publishDigitalTwin(request), result);
    assert.equal(await api.cancelDigitalTwinPublish({ requestId: request.requestId }), result);
    assert.deepEqual(calls, [
      { channel: 'data-platform:getProjectOpenTrace', request: traceRequest },
      { channel: 'digital-twin-publish:prepareScenes', request },
      { channel: 'data-platform:cancelSceneModelSync', request: { requestId: request.requestId } },
      { channel: 'digital-twin-publish:recoverModels', request },
      { channel: 'digital-twin-publish:start', request },
      { channel: 'digital-twin-publish:cancel', request: { requestId: request.requestId } },
    ]);
    const received = [];
    const unsubscribe = api.onDigitalTwinPublishProgress(progress => received.push(progress));
    const progress = { requestId: request.requestId, detail: '恢复模型' };
    listeners.get('digital-twin-publish:progress')({}, progress);
    assert.deepEqual(received, [progress]);
    unsubscribe();
    assert.equal(listeners.has('digital-twin-publish:progress'), false);
  });
}

test('实际 CommonJS 与 ESM preload 的公开接口保持一致', async () => {
  const [cjs, esm] = await Promise.all([loadBridge('preload.cts'), loadBridge('preload.ts')]);
  assert.deepEqual(Object.keys(cjs.api).sort(), Object.keys(esm.api).sort());
});

test('非受信任页面不能获得发布桥接', async () => {
  for (const fileName of ['preload.cts', 'preload.ts']) assert.equal((await loadBridge(fileName, false)).api, undefined);
});

for (const fileName of ['preload.cts', 'preload.ts']) {
  test(`${fileName} 原样转发高精度模型版本的 Long ID`, async () => {
    const { api, calls, result } = await loadBridge(fileName);
    const resourceId = '9223372036854775807';
    const versionId = '9223372036854775806';
    const versionsRequest = { resourceId };
    const prepareRequest = { resourceId, versionId };
    assert.equal(await api.listInspectionModels(), result);
    assert.equal(await api.listInspectionModelVersions(versionsRequest), result);
    assert.equal(await api.prepareInspectionModelVersion(prepareRequest), result);
    assert.deepEqual(calls, [
      { channel: 'inspection:list-models', request: undefined },
      { channel: 'inspection:list-model-versions', request: versionsRequest },
      { channel: 'inspection:prepare-model-version', request: prepareRequest },
    ]);
  });
}

test('高精度资源 IPC 只接受可信编辑器主页面并透传服务结果', async () => {
  const trustedSource = await readFile(new URL('../../electron/ipc/trustedEditorIpc.ts', import.meta.url), 'utf8');
  const mainSource = await readFile(new URL('../../electron/main.ts', import.meta.url), 'utf8');
  const mainAst = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const registration = mainAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerInspectionModelIpc');
  assert.ok(registration, '主进程应声明高精度模型 IPC 注册函数');
  const registrationCalls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'registerInspectionModelIpc') registrationCalls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(mainAst);
  assert.equal(registrationCalls.length, 1, '主进程应在启动时注册一次高精度 IPC');
  let enclosing = registrationCalls[0].parent;
  while (enclosing && !ts.isArrowFunction(enclosing)) enclosing = enclosing.parent;
  assert.ok(enclosing && ts.isCallExpression(enclosing.parent)
    && enclosing.parent.expression.getText(mainAst) === 'app.whenReady().then', 'IPC 应在应用就绪时注册');

  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); },
    removeHandler: channel => handlers.delete(channel),
  };
  const trustedExports = {};
  const trustedJs = ts.transpileModule(trustedSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(trustedJs, {
    exports: trustedExports, URL,
    require: name => { assert.equal(name, 'electron'); return { ipcMain }; },
  });
  const requests = [];
  const result = { model: { contentSha256: 'computed-by-main' }, configuration: { id: 'default', parameters: { length: 1, axis: { x: 0, y: 1, z: 0 } } } };
  const registrationJs = ts.transpileModule(registration.getText(mainAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(registrationJs + '\nregisterInspectionModelIpc();', {
    editorIpc: trustedExports.editorIpc,
    listInspectionModels: () => { requests.push({ name: 'models' }); return result; },
    listInspectionModelVersions: request => { requests.push({ name: 'versions', request }); return result; },
    prepareInspectionModelVersion: request => {
      requests.push({ name: 'prepare', request });
      if (request.versionId === '1') return Promise.reject(new Error('版本未授权'));
      return result;
    },
  });
  const frame = { url: 'http://127.0.0.1:3000/' };
  const sender = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const window = { webContents: sender, isDestroyed: () => false };
  trustedExports.trustEditorWindow(window, frame.url);
  const event = { sender, senderFrame: frame };
  const versionsRequest = { resourceId: '9223372036854775807' };
  const prepareRequest = { ...versionsRequest, versionId: '9223372036854775806' };
  assert.equal(handlers.get('inspection:list-models')(event), result);
  assert.equal(handlers.get('inspection:list-model-versions')(event, versionsRequest), result);
  assert.equal(handlers.get('inspection:prepare-model-version')(event, prepareRequest), result);
  assert.deepEqual(requests, [
    { name: 'models' }, { name: 'versions', request: versionsRequest }, { name: 'prepare', request: prepareRequest },
  ]);
  for (const [channel, handler] of handlers) {
    assert.throws(() => handler({ sender, senderFrame: { url: frame.url } }, prepareRequest), /可信编辑器主页面/, channel);
    assert.throws(() => handler({ sender: { ...sender }, senderFrame: frame }, prepareRequest), /可信编辑器主页面/, channel);
  }
  frame.url = 'http://127.0.0.1:3000/untrusted';
  for (const [channel, handler] of handlers) {
    assert.throws(() => handler(event, prepareRequest), /可信编辑器主页面/, channel);
  }
  frame.url = 'http://127.0.0.1:3000/';
  assert.equal(requests.length, 3, '非受信任请求不能到达资源服务');
  await assert.rejects(handlers.get('inspection:prepare-model-version')(event, { ...versionsRequest, versionId: '1' }), /版本未授权/);
});
