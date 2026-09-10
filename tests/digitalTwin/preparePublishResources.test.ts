import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePublishResources } from '../../src/editor/deployment/preparePublishResources.ts';

test('发布同步传入唯一取消 ID 并原样返回准备结果', async () => {
  const requests: Array<{ requestId: string; sceneContent: string }> = [];
  const result = { configured: true, sourceKey: 'source', modelReplacements: [], modelAssets: [], environmentAssets: [] };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { editorApi: {
    prepareLocalSceneResources: async request => { requests.push(request); return result; },
    cancelSceneModelSync: async () => { assert.fail('无需取消'); },
  } } });
  try {
    assert.equal(await preparePublishResources('first', () => {}), result);
    assert.equal(await preparePublishResources('second', () => {}), result);
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.deepEqual(requests.map(request => request.sceneContent), ['first', 'second']);
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});

test('取消仅中止对应下载并立即拒绝，迟到结果不会回写', async () => {
  let requestId = '';
  let canceledId = '';
  let stopped = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { editorApi: {
    prepareLocalSceneResources: request => { requestId = request.requestId; stopped = true; return new Promise(() => {}); },
    cancelSceneModelSync: async request => { canceledId = request.requestId; return true; },
  } } });
  try {
    await assert.rejects(preparePublishResources('scene', () => { if (stopped) throw Error('scene changed'); }), /scene changed/);
    assert.equal(canceledId, requestId);
    assert.ok(requestId.startsWith('publish-models-'));
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});
