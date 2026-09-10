import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function loadBridge(fileName) {
  const source = await readFile(new URL(`../../electron/${fileName}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  let api;
  const calls = [], listeners = new Map();
  const result = { replacements: [] };
  runInNewContext(outputText, {
    exports: {}, queueMicrotask,
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
    assert.equal(await api.prepareDigitalTwinPublishSceneSnapshots(request), result);
    assert.equal(await api.cancelSceneModelSync({ requestId: request.requestId }), result);
    assert.equal(await api.recoverDigitalTwinModels(request), result);
    assert.equal(await api.publishDigitalTwin(request), result);
    assert.equal(await api.cancelDigitalTwinPublish({ requestId: request.requestId }), result);
    assert.deepEqual(calls, [
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
