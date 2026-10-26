import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import vm from 'node:vm';
import { captureSceneOpenLogicalImages, deriveSceneOpenLogicalImageSlots, MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES } from '../../scripts/lib/sceneOpenLogicalImages.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const platform = 'editor-image://platform/active-image', builtin = 'editor-image://builtin/pai-logo';

function documentFixture() {
  const model = value => ({ assetRevision: 'rev?&一', parameterConfig: { parameters: [{ key: 'logo', type: 'texture', defaultValue: builtin }, { key: 'text', type: 'string' }] }, parameterValues: { logo: value, text: builtin } });
  return { scene: { entities: {
    p: { id: 'p', visible: true, components: {} }, a: { id: 'a', parentId: 'p', components: { modelAsset: model(platform) } },
    b: { id: 'b', components: { modelAsset: model(builtin) } }, c: { id: 'c', components: { modelAsset: model(platform) } },
    hidden: { id: 'hidden', visible: false, components: {} }, h: { id: 'h', parentId: 'hidden', components: { modelAsset: model(platform) } },
    defaults: { id: 'defaults', components: { modelAsset: { ...model(builtin), parameterValues: {} } } },
  } } };
}

test('只取实际可见texture参数值，不取默认值/普通字符串/图库，保留原始引用与修订', () => {
  const scene = documentFixture(); scene.scene.entities.a.components.modelAsset.parameterValues.logo = ' ' + platform + ' ';
  const slots = deriveSceneOpenLogicalImageSlots(scene); assert.equal(slots.length, 3);
  assert.deepEqual(slots.map(x => x.entityId), ['a', 'b', 'c']); assert.equal(slots[0].rawReference, ' ' + platform + ' ');
  assert.equal(slots[0].logicalReference, platform); assert.equal(slots[0].modelAssetRevision, 'rev?&一');
  assert.equal(slots[0].pointer, '/scene/entities/a/components/modelAsset/parameterValues/logo');
});

test('纯枚举拒绝失联祖先/环/重复声明/未知逻辑格式与getter，Proxy不触发descriptor trap', () => {
  for (const [mutate, error] of [
    [s => { s.scene.entities.a.parentId = 'missing'; }, /缺少 missing/],
    [s => { s.scene.entities.p.parentId = 'a'; }, /祖先形成环/],
    [s => { s.scene.entities.a.components.modelAsset.parameterConfig.parameters.push({ key: 'logo', type: 'texture' }); }, /key 重复/],
    [s => { s.scene.entities.a.components.modelAsset.parameterValues.logo = 'editor-image://unknown/x'; }, /引用格式未知/],
    [s => { Object.defineProperty(s.scene.entities.a.components.modelAsset.parameterValues, 'logo', { get() { throw new Error('must not run'); } }); }, /getter/],
  ]) { const s = documentFixture(); mutate(s); assert.throws(() => deriveSceneOpenLogicalImageSlots(s), error); }
  let traps = 0; const s = documentFixture(); s.scene.entities.a = new Proxy(s.scene.entities.a, { getOwnPropertyDescriptor() { traps++; throw new Error('trap'); }, getPrototypeOf() { traps++; throw new Error('trap'); } });
  assert.throws(() => deriveSceneOpenLogicalImageSlots(s), /普通数据/); assert.equal(traps, 0);
  const valuesProxy = documentFixture(); valuesProxy.scene.entities.a.components.modelAsset.parameterValues = new Proxy({}, { ownKeys() { traps++; throw new Error('ownKeys trap'); }, getOwnPropertyDescriptor() { traps++; throw new Error('descriptor trap'); } });
  assert.throws(() => deriveSceneOpenLogicalImageSlots(valuesProxy), /非Proxy对象/); assert.equal(traps, 0);
});

/** 只模拟CDP传输；descriptor读取不执行getter，Proxy以协议subtype先拒绝。 */
function mockPage({ runtime, api, rootOverride, failures = {}, poisonArrayPrototype = false, domNodes = [2], exceptionResponse }) {
  const objects = new Map(), ids = new WeakMap(), calls = [], releases = [], globals = { root: rootOverride ?? { '__reactContainer$fixture': { stateNode: { current: { memoizedProps: { ref: { current: runtime } }, memoizedState: null, child: null, sibling: null } } } }, window: { editorApi: api } };
  let next = 1, detached = false;
  const remote = value => {
    if (value === null) return { type: 'object', subtype: 'null', value: null };
    if (typeof value !== 'object' && typeof value !== 'function') return { type: typeof value, value };
    if (!ids.has(value)) { ids.set(value, String(next++)); objects.set(ids.get(value), value); }
    return { type: typeof value === 'function' ? 'function' : 'object', objectId: ids.get(value),
      subtype: types.isProxy(value) ? 'proxy' : value instanceof Map ? 'map' : Array.isArray(value) ? 'array' : value instanceof Uint8Array ? 'typedarray' : undefined,
      className: value instanceof Uint8Array ? 'Uint8Array' : undefined };
  };
  const session = { async send(method, params) {
    calls.push({ method, params }); if (failures[method]) throw new Error(failures[method]);
    if (exceptionResponse?.method === method) return exceptionResponse.result;
    if (method === 'DOM.getDocument') { assert.equal(params.depth, 1); assert.equal(params.pierce, false); return { root: { nodeId: 1 } }; }
    if (method === 'DOM.querySelectorAll') { assert.equal(params.nodeId, 1); assert.equal(params.selector, '#root'); return { nodeIds: domNodes }; }
    if (method === 'DOM.resolveNode') { assert.equal(params.nodeId, 2); assert.ok(params.objectGroup.startsWith('scene-open-images-')); return { object: { ...remote(globals.root), subtype: 'node', className: 'HTMLDivElement' } }; }
    if (method === 'Runtime.evaluate') { assert.equal(params.expression, 'this'); assert.equal(params.throwOnSideEffect, true); return { result: remote(globals.window) }; }
    if (method === 'Runtime.getProperties') {
      assert.equal(params.ownProperties, true); assert.equal(params.generatePreview, false);
      const value = objects.get(params.objectId); assert.ok(!types.isProxy(value), 'Proxy getProperties must not be called');
      const result = Object.entries(Object.getOwnPropertyDescriptors(value)).map(([name, d]) => ({ name, ...(Object.hasOwn(d, 'value') ? { value: remote(d.value) } : { get: remote(d.get), set: remote(d.set) }) }));
      return { result, internalProperties: value instanceof Map ? [{ name: '[[Entries]]', value: remote([...value].map(([key, item]) => ({ key, value: item }))) }] : [] };
    }
    if (method === 'Runtime.callFunctionOn') {
      const fn = vm.runInNewContext((poisonArrayPrototype ? 'Object.defineProperty(Array.prototype,"0",{set(){throw new Error("array prototype setter must not execute")}});' : '') + '(' + params.functionDeclaration + ')'), args = (params.arguments ?? []).map(x => x.objectId ? objects.get(x.objectId) : x.value);
      const result = await fn.apply(objects.get(params.objectId), args); return { result: params.returnByValue ? { type: typeof result, value: result } : remote(result) };
    }
    if (method === 'Runtime.releaseObjectGroup') { releases.push(params.objectGroup); return {}; }
    throw new Error('unexpected CDP method ' + method);
  }, async detach() { detached = true; if (failures.detach) throw new Error(failures.detach); } };
  return { page: { context: () => ({ newCDPSession: async () => session }) }, calls, releases, get detached() { return detached; } };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'scene-open-images-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('scene-open-images-')); await fs.rm(root, { recursive: true, force: true }); });
  const workspaceRoot = path.join(root, 'workspace'), bundledRoot = path.join(root, 'dist');
  await fs.mkdir(path.join(workspaceRoot, 'SharedResources/Assets/Images'), { recursive: true }); await fs.mkdir(path.join(bundledRoot, 'assets'), { recursive: true });
  const platformBytes = Buffer.from([137, 80, 78, 71, 0, 255, 9]), builtinBytes = Buffer.from([1, 0, 255, 7]);
  const filePath = path.join(workspaceRoot, 'SharedResources/Assets/Images/active.png'), builtinFile = path.join(bundledRoot, 'assets/pai-logo-hash.png');
  await fs.writeFile(filePath, platformBytes); await fs.writeFile(builtinFile, builtinBytes);
  const scene = documentFixture(), slots = deriveSceneOpenLogicalImageSlots(scene), sourceUrl = 'editor-asset://local/' + encodeURIComponent(filePath);
  const entry = { id: '2097188108602388481', iconKey: 'active-image', name: '活跃图片', sortOrder: 1000, updatedAt: '2026-10-25T00:00:00', fileName: 'active.png', filePath, sourceUrl, reference: platform };
  const registry = Object.fromEntries(Object.entries(entry).filter(([key]) => !['sourceUrl', 'filePath'].includes(key)));
  const expected = { version: 1, slots, images: [
    { logicalReference: platform, kind: 'platform', registry, fileKey: '@WORKSPACE/SharedResources/Assets/Images/active.png', bytes: platformBytes.length, sha256: sha(platformBytes), contentType: 'image/png' },
    { logicalReference: builtin, kind: 'builtin', urlKind: 'file', fileKey: '@BUNDLED/assets/pai-logo-hash.png', bytes: builtinBytes.length, sha256: sha(builtinBytes), contentType: 'image/png' },
  ] };
  const models = new Map();
  for (const slot of slots) { const value = slot.logicalReference === platform ? sourceUrl + '?assetRevision=' + encodeURIComponent(slot.modelAssetRevision) : pathToFileURL(builtinFile).href;
    models.set(slot.entityId, { assetRevision: slot.modelAssetRevision, entitySnapshot: scene.scene.entities[slot.entityId], externalScriptRuntime: { instances: [{ logo: value }, { logo: value }] } }); }
  const runtime = { scene: { _isDisposed: false }, assets: { models } }, apiCalls = { list: 0, read: 0 };
  const api = { listSyncedImages: async () => { apiCalls.list++; return [entry, { ...entry, reference: 'editor-image://platform/unused', filePath: '/must-not-read' }]; },
    readSyncedImage: async reference => { apiCalls.read++; assert.equal(reference, platform); return { bytes: new Uint8Array(platformBytes), contentType: 'image/png' }; } };
  return { root, workspaceRoot, bundledRoot, platformBytes, builtinBytes, filePath, builtinFile, scene, slots, expected, entry, runtime, models, api, apiCalls, options: { output: path.join(root, 'capture'), workspaceRoot, bundledRoot, bindingVerified: true } };
}

test('真实实例注入URL→3slots/2bytes，platform cached API与物理文件双核，去重只读一次并释放对象组', async t => {
  const f = await fixture(t), mock = mockPage(f), receipt = await captureSceneOpenLogicalImages(mock.page, f.expected, f.options);
  assert.equal(receipt.status, 'PASS_ACTUAL_INPUT_IMAGE_BYTES_ONLY'); assert.equal(receipt.provesGpuTextureSuccess, false);
  assert.equal(receipt.slots.length, 3); assert.equal(receipt.images.length, 2); assert.deepEqual(f.apiCalls, { list: 1, read: 1 });
  assert.equal(receipt.images[0].independentlyMatchedPhysicalFile, true); assert.equal(receipt.images[1].independentlyMatchedPhysicalFile, false);
  assert.ok(receipt.slots[0].actualResolvedUrl.endsWith('?assetRevision=rev%3F%26%E4%B8%80')); assert.equal(mock.releases.length, 1); assert.equal(mock.detached, true);
  assert.deepEqual(await fs.readFile(receipt.images[0].localEvidenceFile), f.platformBytes); assert.deepEqual(await fs.readFile(receipt.images[1].localEvidenceFile), f.builtinBytes);
  const saved = JSON.parse(await fs.readFile(path.join(f.options.output, 'receipt.json'), 'utf8')); assert.equal(saved.status, receipt.status);
  await assert.rejects(captureSceneOpenLogicalImages(mock.page, f.expected, f.options), /EEXIST/);
});

test('未核绑定在任何CDP/缓存API前拒绝；缺期望/重复槽位/图库额外条目/大小超限拒绝', async t => {
  const f = await fixture(t), mock = mockPage(f);
  await assert.rejects(captureSceneOpenLogicalImages(mock.page, f.expected, { ...f.options, bindingVerified: false }), /先核当前owned绑定/); assert.equal(mock.calls.length, 0);
  for (const mutate of [e => e.images.pop(), e => e.slots.push(e.slots[0]), e => e.images.push({ ...e.images[0], logicalReference: 'editor-image://platform/unused' }), e => { e.images[0].bytes = MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES + 1; }]) {
    const expected = structuredClone(f.expected); mutate(expected); await assert.rejects(captureSceneOpenLogicalImages(mock.page, expected, f.options)); assert.equal(mock.calls.length, 0);
  }
});

test('拒绝实例空值/getter/不一致/Proxy，并把原错误与cleanup次错分别留存', async t => {
  for (const [mutate, pattern] of [
    [m => { m.externalScriptRuntime.instances = []; }, /实例为空/],
    [m => { delete m.externalScriptRuntime.instances[0].logo; }, /缺少 logo/],
    [m => { Object.defineProperty(m.externalScriptRuntime.instances[0], 'logo', { get() { throw new Error('getter must not run'); } }); }, /getter/],
    [m => { m.externalScriptRuntime.instances[0].logo += '-wrong'; }, /URL不一致/],
    [m => { let traps = 0; m.externalScriptRuntime.instances[0] = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw new Error('trap'); } }); m.traps = () => traps; }, /Proxy/],
  ]) {
    const f = await fixture(t); mutate(f.models.get('a')); const mock = mockPage({ ...f, failures: { detach: 'secondary cleanup' } });
    await assert.rejects(captureSceneOpenLogicalImages(mock.page, f.expected, f.options), pattern);
    const receipt = JSON.parse(await fs.readFile(path.join(f.options.output, 'receipt.json'), 'utf8')); assert.match(receipt.error.message, pattern); assert.equal(receipt.cleanupErrors[0].message, 'secondary cleanup');
    assert.equal(mock.releases.length, 1); assert.equal(mock.detached, true); assert.equal(f.models.get('a').traps?.() ?? 0, 0);
  }
});

test('runtime必须唯一non-disposed，原生Map Proxy/实例链getter不能逃逸', async t => {
  for (const [mutate, pattern] of [
    [f => { f.runtime.scene._isDisposed = true; }, /non-disposed runtime必须唯一/],
    [f => { f.runtime.assets.models = new Proxy(f.models, {}); }, /模型表未知/],
    [f => { Object.defineProperty(f.models.get('a'), 'externalScriptRuntime', { get() { throw new Error('getter must not run'); } }); }, /getter/],
    [f => { delete f.runtime.scene._isDisposed; }, /缺少 _isDisposed/],
  ]) { const f = await fixture(t); mutate(f); const mock = mockPage(f); await assert.rejects(captureSceneOpenLogicalImages(mock.page, f.expected, f.options), pattern); }
  const f = await fixture(t), other = { scene: { _isDisposed: false }, assets: { models: f.models } };
  const root = { '__reactContainer$fixture': { memoizedProps: { one: { current: f.runtime }, two: { current: other } } } };
  await assert.rejects(captureSceneOpenLogicalImages(mockPage({ ...f, rootOverride: root }).page, f.expected, f.options), /non-disposed runtime必须唯一/);
});

test('registry身份/后缀/query和实际生产修订拼接严格，不统一删除query', async t => {
  for (const [mutate, pattern] of [
    [f => { f.entry.id = 'different'; }, /registry id 漂移/],
    [f => { f.entry.sourceUrl += '?unknown=1'; }, /strictly equal/],
    [f => { f.models.get('a').externalScriptRuntime.instances.forEach(x => { x.logo += '&ignored=1'; }); }, /生产注入URL/],
    [f => { f.entry.filePath = path.join(f.root, 'outside.png'); }, /路径与URL不一致|越出/],
    [f => { f.entry.sourceUrl = 'https://example.invalid/active.png'; }, /strictly equal/],
    [f => { f.models.get('a').assetRevision = 'other'; }, /模型修订漂移/],
    [f => { f.models.get('a').entitySnapshot.components.modelAsset.parameterValues.logo = builtin; }, /原始参数漂移/],
  ]) { const f = await fixture(t); mutate(f); await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), pattern); }
  const f = await fixture(t); f.entry.sourceUrl += '?v=original'; f.expected.images[0].sourceQuery = '?v=original';
  for (const id of ['a', 'c']) f.models.get(id).externalScriptRuntime.instances.forEach(x => { x.logo = f.entry.sourceUrl + '&assetRevision=' + encodeURIComponent('rev?&一'); });
  assert.equal((await captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options)).status, 'PASS_ACTUAL_INPUT_IMAGE_BYTES_ONLY');
});

test('缓存API原bytes与实际注册文件均独立核SHA；长度漂移/错误类型/缺登记拒绝', async t => {
  for (const [mutate, pattern] of [
    [async f => { await fs.writeFile(f.filePath, Buffer.from([1, 2])); }, /实际字节数漂移/],
    [f => { f.api.readSyncedImage = async () => ({ bytes: new Uint8Array([1]), contentType: 'image/png' }); }, /bytes长度漂移/],
    [f => { f.api.readSyncedImage = async () => ({ bytes: new Uint8Array(f.platformBytes.length), contentType: 'image/png' }); }, /实际SHA256漂移/],
    [f => { f.api.readSyncedImage = async () => ({ bytes: new Uint16Array(f.platformBytes.length), contentType: 'image/png' }); }, /Uint8Array|typedarray/],
    [f => { f.api.listSyncedImages = async () => []; }, /未登记/],
    [f => { f.api.listSyncedImages = async () => [f.entry, f.entry]; }, /登记重复/],
  ]) { const f = await fixture(t); await mutate(f); await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), pattern); }
});

test('fileURL拒绝HTTP/UNC/越界/query漂移，链接与非普通/空文件拒绝', async t => {
  for (const [mutate, pattern] of [
    [f => { f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo = 'https://example.invalid/a.png'; }); }, /fileURL/],
    [f => { f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo = 'file://remote/share/a.png'; }); }, /UNC/],
    [f => { f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo = pathToFileURL(f.filePath).href; }); }, /越出允许根/],
    [f => { f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo += '?ignored=1'; }); }, /strictly equal/],
    [async f => { await fs.writeFile(f.builtinFile, ''); }, /非空/],
    [async f => { await fs.unlink(f.builtinFile); await fs.mkdir(f.builtinFile); }, /非空/],
    [async f => { const dir = path.dirname(f.builtinFile), target = path.join(f.root, 'moved'); await fs.rename(dir, target); await fs.symlink(target, dir, process.platform === 'win32' ? 'junction' : 'dir'); }, /链接/],
  ]) { const f = await fixture(t); await mutate(f); await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), pattern); }
});

test('超20MiB稀疏文件在读取分配前拒绝，输出目录祖先链接拒绝', async t => {
  const f = await fixture(t), handle = await fs.open(f.builtinFile, 'r+'); await handle.truncate(MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES + 1); await handle.close();
  await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), /不超过20MiB/);
  const other = await fixture(t), link = path.join(other.root, 'linked'); await fs.symlink(other.bundledRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureSceneOpenLogicalImages(mockPage(other).page, other.expected, { ...other.options, output: path.join(link, 'capture') }), /链接/);
});

test('builtin dataURI按精确字节冻结，base64/百分号二进制等价；类型/长度/非法base64拒绝', async t => {
  for (const encoded of ['AQD/Bw==', '%01%00%FF%07']) {
    const f = await fixture(t), image = f.expected.images[1]; image.urlKind = 'data'; delete image.fileKey;
    const url = 'data:image/png' + (encoded.startsWith('%') ? ',' : ';base64,') + encoded;
    f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo = url; });
    const receipt = await captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options); assert.deepEqual(await fs.readFile(receipt.images[1].localEvidenceFile), f.builtinBytes);
  }
  for (const url of ['data:text/plain;base64,AQD/Bw==', 'data:image/png;base64,AQD/Bw', 'data:image/png;base64,AQ==', 'data:image/png,%ZZ']) {
    const f = await fixture(t); f.expected.images[1].urlKind = 'data'; delete f.expected.images[1].fileKey; f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo = url; });
    await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), /dataURI|base64|match/);
  }
});

test('同一builtin跨槽位不允许前槽位错误dataURI被最后正确值覆盖', async t => {
  const f = await fixture(t); f.expected.images[1].urlKind = 'data'; delete f.expected.images[1].fileKey;
  const slot = structuredClone(f.expected.slots.find(x => x.entityId === 'b')); slot.entityId = 'd'; slot.pointer = slot.pointer.replace('/b/', '/d/'); f.expected.slots.push(slot);
  f.models.set('d', { assetRevision: slot.modelAssetRevision, entitySnapshot: f.scene.scene.entities.b, externalScriptRuntime: { instances: [{ logo: 'data:image/png;base64,AQD/Bw==' }] } });
  f.models.get('b').externalScriptRuntime.instances.forEach(x => { x.logo = 'data:image/png;base64,AAAAAA=='; });
  await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), /同逻辑builtin图片实际URL不一致/);
});

test('receipt写盘次错不掩盖实例原始错误', async t => {
  const f = await fixture(t), list = f.api.listSyncedImages;
  f.api.listSyncedImages = async () => { await fs.mkdir(path.join(f.options.output, 'receipt.json')); return list(); };
  delete f.models.get('a').externalScriptRuntime.instances[0].logo;
  await assert.rejects(captureSceneOpenLogicalImages(mockPage(f).page, f.expected, f.options), error => {
    assert.match(error.message, /缺少 logo/); assert.equal(error.sceneOpenLogicalImageSecondaryErrors.at(-1).method, 'writeReceipt'); return true;
  });
});

test('typedarray字节提取不写browser Array.prototype数字setter', async t => {
  const f = await fixture(t), mock = mockPage({ ...f, poisonArrayPrototype: true });
  assert.equal((await captureSceneOpenLogicalImages(mock.page, f.expected, f.options)).status, 'PASS_ACTUAL_INPUT_IMAGE_BYTES_ONLY');
});

test('通过原生DOM严格唯一root解析，global this仍启用throwOnSideEffect，未知节点不回退JS求值', async t => {
  const f = await fixture(t), mock = mockPage(f); await captureSceneOpenLogicalImages(mock.page, f.expected, f.options);
  assert.deepEqual(mock.calls.slice(0, 3).map(x => x.method), ['DOM.getDocument', 'DOM.querySelectorAll', 'DOM.resolveNode']);
  assert.deepEqual(mock.calls.filter(x => x.method === 'Runtime.evaluate').map(x => x.params.expression), ['this']);
  for (const domNodes of [[], [2, 3]]) {
    const other = await fixture(t), failed = mockPage({ ...other, domNodes });
    await assert.rejects(captureSceneOpenLogicalImages(failed.page, other.expected, other.options), /DOM root必须严格唯一/);
    assert.equal(failed.calls.some(x => x.method === 'Runtime.evaluate'), false); assert.equal(failed.releases.length, 1); assert.equal(failed.detached, true);
  }
});

test('真实CDP异常保留有界method/expression/text/description原错与失败收据', async t => {
  const f = await fixture(t), text = 'X'.repeat(5000), description = 'EvalError: ' + 'D'.repeat(5000);
  const mock = mockPage({ ...f, exceptionResponse: { method: 'Runtime.evaluate', result: { result: { type: 'object', subtype: 'error', className: 'EvalError', description }, exceptionDetails: { text } } } });
  await assert.rejects(captureSceneOpenLogicalImages(mock.page, f.expected, f.options), error => {
    assert.equal(error.sceneOpenLogicalImageCdpException.method, 'Runtime.evaluate'); assert.equal(error.sceneOpenLogicalImageCdpException.expression, 'this');
    assert.equal(error.sceneOpenLogicalImageCdpException.text.length, 2048); assert.equal(error.sceneOpenLogicalImageCdpException.description.length, 2048); return true;
  });
  const receipt = JSON.parse(await fs.readFile(path.join(f.options.output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.error.cdpException.method, 'Runtime.evaluate'); assert.ok(receipt.error.cdpException.description.startsWith('EvalError:'));
  assert.equal(mock.releases.length, 1); assert.equal(mock.detached, true); assert.deepEqual(f.apiCalls, { list: 0, read: 0 });
});
