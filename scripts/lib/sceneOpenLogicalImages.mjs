import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

export const MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES = 20 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const referencePattern = /^editor-image:\/\/(platform|builtin)\/[a-z][a-z0-9_-]{1,63}$/;
const escapePointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
const fileCleanupErrors = new WeakMap();

/** 输入来自已冻结 JSON；这里仍拒绝 Proxy/accessor，避免纯枚举执行业务代码。 */
function own(value, key, required = false) {
  assert.ok(value && typeof value === 'object' && !types.isProxy(value), `图片输入 ${key} 不是可读普通数据`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  assert.ok(!descriptor || Object.hasOwn(descriptor, 'value'), `图片输入 ${key} 是 getter/setter`);
  assert.ok(!required || descriptor, `图片输入缺少 ${key}`);
  return descriptor?.value;
}

/** 仅枚举实际可见实体的已声明 texture 参数值，不取默认值、不遍历图库或普通字符串。 */
export function deriveSceneOpenLogicalImageSlots(envelope) {
  const scene = own(envelope, 'scene') ?? envelope, entities = own(scene, 'entities', true);
  assert.ok(!types.isProxy(entities) && !Array.isArray(entities), '图片实体表必须为 JSON 对象');
  const isVisible = (entity, entityId) => {
    const visited = new Set();
    while (entity) {
      assert.ok(!visited.has(entityId), '图片实体祖先形成环'); visited.add(entityId);
      if (own(entity, 'visible') === false) return false;
      const parentId = own(entity, 'parentId');
      if (!parentId) return true;
      assert.equal(typeof parentId, 'string', '图片实体 parentId 无效');
      entity = own(entities, parentId, true); entityId = parentId;
    }
    return true;
  };
  const slots = [];
  for (const entityId of Object.keys(entities).sort()) {
    const entity = own(entities, entityId, true);
    if (!isVisible(entity, entityId)) continue;
    const components = own(entity, 'components'), model = components && own(components, 'modelAsset');
    if (!model) continue;
    const config = own(model, 'parameterConfig'), parameters = config && own(config, 'parameters');
    const values = own(model, 'parameterValues');
    if (!parameters || !values) continue;
    assert.ok(Array.isArray(parameters) && !types.isProxy(parameters), '图片参数声明必须为数组');
    assert.ok(typeof values === 'object' && !types.isProxy(values) && !Array.isArray(values), '图片参数值必须为非Proxy对象');
    const definitions = new Map();
    for (let i = 0; i < parameters.length; i++) {
      const definition = own(parameters, String(i), true), key = own(definition, 'key', true);
      assert.equal(typeof key, 'string'); assert.ok(!definitions.has(key), '图片参数声明 key 重复');
      definitions.set(key, own(definition, 'type', true));
    }
    for (const key of Object.keys(values).sort()) {
      if (definitions.get(key) !== 'texture') continue;
      const rawReference = own(values, key, true);
      if (typeof rawReference !== 'string' || !rawReference.trim().startsWith('editor-image://')) continue;
      const logicalReference = rawReference.trim(); assert.match(logicalReference, referencePattern, '逻辑图片引用格式未知');
      const revision = own(model, 'assetRevision'); assert.ok(revision == null || typeof revision === 'string', '图片模型修订无效');
      slots.push({ entityId, key, pointer: `/scene/entities/${escapePointer(entityId)}/components/modelAsset/parameterValues/${escapePointer(key)}`,
        rawReference, logicalReference, modelAssetRevision: revision ?? null });
      assert.ok(slots.length <= 10000, '活跃图片槽位超过上限');
    }
  }
  return slots;
}

function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  assert.ok(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), '图片文件越出允许根');
  return relative.split(path.sep).join('/');
}

async function noLinks(file, { missingLeaf = false } = {}) {
  const absolute = path.resolve(file); let cursor = path.parse(absolute).root;
  const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    try { assert.equal((await fs.lstat(cursor)).isSymbolicLink(), false, '图片路径/祖先包含链接'); }
    catch (error) { if (missingLeaf && error.code === 'ENOENT' && index === parts.length - 1) return; throw error; }
  }
}

async function withReadHandle(file, read) {
  const handle = await fs.open(file, 'r');
  let failure, result;
  try { result = await read(handle); }
  catch (error) { failure = error; }
  finally {
    try { await handle.close(); }
    catch (error) { if (!failure) failure = error; else fileCleanupErrors.set(failure, [...(fileCleanupErrors.get(failure) ?? []), { method: 'file.close', message: error.message }]); }
  }
  if (failure) throw failure; return result;
}

/** 先验证大小再有界分配；句柄与路径身份、读取前后大小/时间均不允许变化。 */
async function readImageFile(file, root) {
  inside(root, file); await noLinks(file); const pathBefore = await fs.lstat(file, { bigint: true });
  return withReadHandle(file, async handle => {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.size > 0n && before.size <= BigInt(MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES), '图片文件必须非空且不超过20MiB');
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat({ bigint: true }); await noLinks(file); const current = await fs.lstat(file, { bigint: true });
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      assert.equal(after[field], before[field], '图片句柄读取期间变化'); assert.equal(current[field], pathBefore[field], '图片路径读取期间变化');
    }
    // Windows lstat.dev 为0而fstat.dev为卷标识；用当前路径新句柄与原句柄比较身份，不能混比两种stat。
    await withReadHandle(file, async currentHandle => { const reopened = await currentHandle.stat({ bigint: true }); for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(reopened[field], before[field], '图片路径不再指向原句柄'); });
    assert.equal(BigInt(length), before.size, '图片读取期间增长/截断'); return buffer.subarray(0, length);
  });
}

function assertImageBytes(bytes, expected) {
  assert.equal(bytes.length, expected.bytes, '图片实际字节数漂移'); assert.equal(digest(bytes), expected.sha256, '图片实际SHA256漂移');
}

function validateExpected(expected) {
  assert.equal(expected?.version, 1, '图片期望版本未知'); assert.ok(Array.isArray(expected.slots) && Array.isArray(expected.images));
  assert.ok(expected.slots.length > 0 && expected.slots.length <= 10000, '图片期望槽位为空或超限');
  const slotKeys = new Set(), refs = new Set();
  for (const slot of expected.slots) {
    assert.ok(typeof slot.entityId === 'string' && typeof slot.key === 'string'); assert.match(slot.logicalReference, referencePattern);
    assert.equal(slot.rawReference.trim(), slot.logicalReference); assert.ok(slot.modelAssetRevision == null || typeof slot.modelAssetRevision === 'string');
    const key = JSON.stringify([slot.entityId, slot.key]); assert.ok(!slotKeys.has(key), '图片期望槽位重复'); slotKeys.add(key); refs.add(slot.logicalReference);
  }
  const images = new Map();
  for (const image of expected.images) {
    assert.match(image.logicalReference, referencePattern); assert.ok(!images.has(image.logicalReference), '图片期望身份重复');
    assert.ok(Number.isInteger(image.bytes) && image.bytes > 0 && image.bytes <= MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES, '图片期望大小越界');
    assert.match(image.sha256, /^[a-f0-9]{64}$/); assert.ok(refs.delete(image.logicalReference), '图片期望包含非活跃图库');
    assert.ok(image.kind === 'platform' || image.kind === 'builtin'); assert.ok(image.logicalReference.startsWith(`editor-image://${image.kind}/`));
    if (image.kind === 'platform') assert.ok(image.registry && image.fileKey?.startsWith('@WORKSPACE/'));
    else assert.ok(image.urlKind === 'data' || (image.urlKind === 'file' && image.fileKey?.startsWith('@BUNDLED/')));
    images.set(image.logicalReference, image);
  }
  assert.equal(refs.size, 0, '图片期望未覆盖所有活跃槽位'); return images;
}

/** CDP 只读 own-data；Proxy 在 getProperties 之前拒绝，不运行业务 getter/Map 方法。 */
class OwnRemoteReader {
  constructor(session, group) { this.session = session; this.group = group; this.cache = new Map(); this.requests = 0; }
  async send(method, params) {
    assert.ok(++this.requests <= 150000, '图片CDP读取超过有界预算'); const result = await this.session.send(method, params);
    if (result.exceptionDetails) {
      const bounded = value => typeof value === 'string' ? value.slice(0, 2048) : '';
      const evidence = { method: bounded(method), expression: bounded(params.expression ?? params.functionDeclaration),
        text: bounded(result.exceptionDetails.text), description: bounded(result.result?.description ?? result.exceptionDetails.exception?.description) };
      const error = new Error('图片CDP求值失败: ' + JSON.stringify(evidence)); error.sceneOpenLogicalImageCdpException = evidence; throw error;
    }
    return result;
  }
  async evaluate(expression) { return (await this.send('Runtime.evaluate', { expression, objectGroup: this.group, returnByValue: false, generatePreview: false, throwOnSideEffect: true, silent: true })).result; }
  async domRoot() {
    // 原生CDP节点解析不执行Window.document或DOM方法getter；不能为读根节点关闭副作用守卫。
    const document = await this.send('DOM.getDocument', { depth: 1, pierce: false });
    assert.ok(Number.isInteger(document.root?.nodeId) && document.root.nodeId > 0, '图片CDP document unavailable');
    const matches = await this.send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector: '#root' });
    assert.ok(Array.isArray(matches.nodeIds) && matches.nodeIds.length === 1 && Number.isInteger(matches.nodeIds[0]) && matches.nodeIds[0] > 0, '图片DOM root必须严格唯一');
    const resolved = await this.send('DOM.resolveNode', { nodeId: matches.nodeIds[0], objectGroup: this.group });
    assert.ok(resolved.object?.objectId && resolved.object.type === 'object' && resolved.object.subtype === 'node', '图片DOM root不是原生节点');
    return resolved.object;
  }
  async properties(value, label) {
    assert.ok(value?.objectId && value.type === 'object', `${label} 没有可读对象`); assert.notEqual(value.subtype, 'proxy', `${label} Proxy unavailable`);
    if (!this.cache.has(value.objectId)) this.cache.set(value.objectId, await this.send('Runtime.getProperties', { objectId: value.objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: false }));
    const properties = this.cache.get(value.objectId); assert.ok(properties.result.length <= 50000, `${label} own属性超限`); return properties;
  }
  async data(value, key, required = true) {
    const property = (await this.properties(value, key)).result.find(row => row.name === key);
    assert.ok(!required || property, `图片实际对象缺少 ${key}`);
    assert.ok(!property || (Object.hasOwn(property, 'value') && !property.get && !property.set), `${key} getter/setter unavailable`);
    return property?.value;
  }
  async scalar(value, key, required = true) { const remote = await this.data(value, key, required); assert.ok(!remote?.objectId, `${key} 不是数据标量`); return remote?.value; }
  async array(value, label) {
    assert.equal(value?.subtype, 'array', `${label} 不是原生数组`); const rows = (await this.properties(value, label)).result;
    const length = await this.scalar(value, 'length'); assert.ok(Number.isInteger(length) && length >= 0 && length <= 30000, `${label} 数组超限`);
    const result = []; for (let i = 0; i < length; i++) { const row = rows.find(x => x.name === String(i)); assert.ok(row?.value && !row.get && !row.set, `${label} 稀疏数组/getter`); result.push(row.value); } return result;
  }
  async same(a, b) { return (await this.send('Runtime.callFunctionOn', { objectId: a.objectId, functionDeclaration: 'function(other) { return this === other; }', arguments: [{ objectId: b.objectId }], returnByValue: true, silent: true })).result.value === true; }
  async map(value) {
    assert.equal(value?.subtype, 'map', '图片实际 models 不是原生Map');
    const entries = (await this.properties(value, 'models')).internalProperties?.find(row => row.name === '[[Entries]]')?.value;
    assert.ok(entries, '图片原生Map entries unavailable'); const result = new Map();
    for (const entry of await this.array(entries, 'models entries')) {
      const key = await this.scalar(entry, 'key'); assert.equal(typeof key, 'string'); assert.ok(!result.has(key), '图片models key重复'); result.set(key, await this.data(entry, 'value'));
    }
    return result;
  }
  async invoke(fn, argument) {
    assert.equal(fn?.type, 'function', '缓存图片API不是函数'); assert.notEqual(fn?.subtype, 'proxy', '缓存图片API Proxy unavailable');
    return (await this.send('Runtime.callFunctionOn', { objectId: fn.objectId, objectGroup: this.group,
      functionDeclaration: argument === undefined ? 'function() { return this(); }' : 'function(reference) { return this(reference); }',
      arguments: argument === undefined ? [] : [{ value: argument }], awaitPromise: true, returnByValue: false, generatePreview: false, silent: true })).result;
  }
  async bytes(value, length) {
    assert.equal(value?.subtype, 'typedarray', '缓存图片bytes不是原生typedarray'); assert.equal(value.className, 'Uint8Array', '缓存图片bytes不是Uint8Array');
    const exact = await this.send('Runtime.callFunctionOn', { objectId: value.objectId,
      functionDeclaration: 'function(n) { return this[n] === undefined && typeof this[n-1] === "number"; }', arguments: [{ value: length }], returnByValue: true, silent: true });
    assert.equal(exact.result.value, true, '缓存图片bytes长度漂移');
    const bytes = Buffer.alloc(length);
    for (let start = 0; start < length; start += 16384) {
      const count = Math.min(16384, length - start), response = await this.send('Runtime.callFunctionOn', { objectId: value.objectId,
        functionDeclaration: 'function(start, count) { let out = "["; for(let i=0;i<count;i++) out += (i ? "," : "") + this[start+i]; return out + "]"; }',
        arguments: [{ value: start }, { value: count }], returnByValue: true, silent: true });
      assert.equal(typeof response.result.value, 'string', '缓存图片bytes不是原始JSON数字串'); const chunk = JSON.parse(response.result.value);
      assert.ok(Array.isArray(chunk) && chunk.length === count && chunk.every(x => Number.isInteger(x) && x >= 0 && x <= 255), '缓存图片bytes不可读');
      bytes.set(chunk, start);
    }
    return bytes;
  }
}

async function findRuntime(reader) {
  const root = await reader.domRoot(), rootProperties = await reader.properties(root, 'React root');
  const containers = rootProperties.result.filter(row => row.name.startsWith('__reactContainer$')); assert.equal(containers.length, 1, '图片实际React root不唯一');
  assert.ok(containers[0].value && !containers[0].get && !containers[0].set, 'React root getter unavailable');
  let first = containers[0].value; const stateNode = await reader.data(first, 'stateNode', false);
  if (stateNode?.objectId) first = await reader.data(stateNode, 'current', false) ?? first;
  const stack = [first], seen = new Set(), runtimes = [];
  const visit = async value => {
    if (!value?.objectId || value.type !== 'object' || value.subtype === 'null') return;
    const candidate = await reader.data(value, 'current', false) ?? value;
    if (!candidate?.objectId || candidate.type !== 'object') return;
    const scene = await reader.data(candidate, 'scene', false), assets = await reader.data(candidate, 'assets', false);
    if (!scene?.objectId || !assets?.objectId) return;
    const disposed = await reader.scalar(scene, '_isDisposed'); assert.equal(typeof disposed, 'boolean', '图片runtime释放状态未知'); if (disposed) return;
    assert.equal((await reader.data(assets, 'models')).subtype, 'map', '图片runtime模型表未知');
    if (!(await Promise.all(runtimes.map(x => reader.same(x, candidate)))).some(Boolean)) runtimes.push(candidate);
  };
  while (stack.length) {
    const fiber = stack.pop(); if (!fiber?.objectId || seen.has(fiber.objectId)) continue;
    seen.add(fiber.objectId); assert.ok(seen.size <= 30000, '图片React树超过上限');
    const props = await reader.data(fiber, 'memoizedProps', false);
    if (props?.objectId) {
      await visit(props); for (const row of (await reader.properties(props, 'React props')).result) if (row.value) await visit(row.value);
    }
    let hook = await reader.data(fiber, 'memoizedState', false), count = 0;
    while (hook?.objectId) { assert.ok(++count <= 500, '图片React hook链超过上限'); await visit(await reader.data(hook, 'memoizedState', false)); hook = await reader.data(hook, 'next', false); }
    for (const key of ['child', 'sibling']) { const next = await reader.data(fiber, key, false); if (next?.objectId) stack.push(next); }
  }
  assert.equal(runtimes.length, 1, '图片实际non-disposed runtime必须唯一'); return runtimes[0];
}

async function registryEntries(reader, api, references) {
  const list = await reader.invoke(await reader.data(api, 'listSyncedImages')), entries = new Map();
  for (const entry of await reader.array(list, 'cached images')) {
    const reference = await reader.scalar(entry, 'reference'); if (!references.has(reference)) continue;
    assert.ok(!entries.has(reference), '图片实际缓存登记重复');
    const record = {}; for (const key of ['id', 'iconKey', 'name', 'sortOrder', 'updatedAt', 'fileName', 'filePath', 'sourceUrl', 'reference']) record[key] = await reader.scalar(entry, key);
    entries.set(reference, record);
  }
  return entries;
}

function platformMapping(entry, image, workspaceRoot, revision) {
  for (const [key, value] of Object.entries(image.registry)) assert.equal(entry[key], value, `图片registry ${key} 漂移`);
  const parsed = new URL(entry.sourceUrl); assert.equal(parsed.protocol, 'editor-asset:'); assert.equal(parsed.hostname, 'local');
  assert.equal(parsed.search, image.sourceQuery ?? ''); assert.equal(parsed.hash, image.sourceFragment ?? ''); assert.equal(parsed.username + parsed.password + parsed.port, '');
  const decoded = decodeURIComponent(parsed.pathname.slice(1)); assert.ok(path.isAbsolute(decoded), '图片registry URL不是绝对路径');
  assert.equal(path.relative(path.resolve(entry.filePath), path.resolve(decoded)), '', '图片registry路径与URL不一致');
  const fileKey = '@WORKSPACE/' + inside(workspaceRoot, entry.filePath); assert.equal(fileKey, image.fileKey, '图片registry物理后缀漂移');
  return { fileKey, resolvedUrl: entry.sourceUrl + (revision ? (entry.sourceUrl.includes('?') ? '&' : '?') + 'assetRevision=' + encodeURIComponent(revision) : '') };
}

function dataImageBytes(url, image) {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url); assert.ok(match && match[1] === image.contentType, 'builtin dataURI类型/格式未知');
  assert.ok(match[3].length <= MAX_SCENE_OPEN_LOGICAL_IMAGE_BYTES * 3 + 4, 'builtin dataURI超限');
  if (match[2]) {
    assert.match(match[3], /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'builtin base64格式未知');
    const length = match[3].length / 4 * 3 - (match[3].endsWith('==') ? 2 : match[3].endsWith('=') ? 1 : 0);
    assert.equal(length, image.bytes, 'builtin dataURI字节数漂移/超限'); return Buffer.from(match[3], 'base64');
  }
  const text = match[3], bytes = Buffer.alloc(image.bytes); let length = 0;
  for (let i = 0; i < text.length; i++) {
    assert.ok(length < bytes.length, 'builtin dataURI解码超限');
    if (text[i] === '%') { assert.match(text.slice(i + 1, i + 3), /^[a-f\d]{2}$/i); bytes[length++] = parseInt(text.slice(i + 1, i + 3), 16); i += 2; }
    else { assert.ok(text.charCodeAt(i) <= 127, 'builtin dataURI非ASCII未转义字节'); bytes[length++] = text.charCodeAt(i); }
  }
  assert.equal(length, image.bytes, 'builtin dataURI字节数漂移'); return bytes;
}

/**
 * 在正式ready计时以外调用；只证明实际注入URL与图片输入字节，不证明GPU纹理成功。
 * expected.slots 必须来自同轮已严格核对完整业务投影的 scene。bindingVerified 由宿主核当前owned project后传入。
 */
export async function captureSceneOpenLogicalImages(page, expected, { output, workspaceRoot, bundledRoot, bindingVerified } = {}) {
  assert.equal(bindingVerified, true, '图片缓存读取必须先核当前owned绑定'); const images = validateExpected(expected);
  assert.ok(path.isAbsolute(output) && path.isAbsolute(workspaceRoot) && path.isAbsolute(bundledRoot), '图片根/输出必须绝对路径');
  await noLinks(path.dirname(output)); await fs.mkdir(output); const group = 'scene-open-images-' + randomUUID();
  const receipt = { version: 1, status: 'CAPTURING', provesGpuTextureSuccess: false, slots: [], images: [], cleanupErrors: [] };
  let session, failure;
  try {
    session = await page.context().newCDPSession(page); const reader = new OwnRemoteReader(session, group), runtime = await findRuntime(reader);
    const models = await reader.map(await reader.data(await reader.data(runtime, 'assets'), 'models'));
    const window = await reader.evaluate('this'), api = await reader.data(window, 'editorApi');
    const platformRefs = new Set([...images.values()].filter(x => x.kind === 'platform').map(x => x.logicalReference));
    const entries = platformRefs.size ? await registryEntries(reader, api, platformRefs) : new Map();
    const injected = new Map();
    for (const slot of expected.slots) {
      const model = models.get(slot.entityId); assert.ok(model, `图片实际model缺失 ${slot.entityId}`);
      assert.equal(await reader.scalar(model, 'assetRevision'), slot.modelAssetRevision, '图片实际模型修订漂移');
      const snapshot = await reader.data(model, 'entitySnapshot'), components = await reader.data(snapshot, 'components'), asset = await reader.data(components, 'modelAsset');
      assert.equal(await reader.scalar(await reader.data(asset, 'parameterValues'), slot.key), slot.rawReference, '图片实际原始参数漂移');
      const script = await reader.data(model, 'externalScriptRuntime'), instances = await reader.array(await reader.data(script, 'instances'), 'external instances');
      assert.ok(instances.length > 0, '图片实际脚本实例为空'); const values = [];
      for (const instance of instances) { const value = await reader.scalar(instance, slot.key); assert.equal(typeof value, 'string', '图片注入值不可读'); values.push(value); }
      assert.ok(values.every(value => value === values[0]), '图片多个实例注入URL不一致');
      const actualUrl = values[0], image = images.get(slot.logicalReference); let fileKey;
      if (image.kind === 'platform') { const entry = entries.get(slot.logicalReference); assert.ok(entry, '图片实际registry未登记'); const mapping = platformMapping(entry, image, workspaceRoot, slot.modelAssetRevision); assert.equal(actualUrl, mapping.resolvedUrl, '图片生产注入URL与registry/revision不一致'); fileKey = mapping.fileKey; }
      else if (image.urlKind === 'file') { const url = new URL(actualUrl); assert.equal(url.protocol, 'file:', 'builtin仅接受实际fileURL'); assert.equal(url.hostname, '', 'builtin拒绝UNC/远程fileURL'); assert.equal(url.search, image.sourceQuery ?? ''); assert.equal(url.hash, image.sourceFragment ?? ''); fileKey = '@BUNDLED/' + inside(bundledRoot, fileURLToPath(url)); assert.equal(fileKey, image.fileKey, 'builtin构建文件漂移'); }
      else { assert.ok(actualUrl.startsWith('data:'), 'builtin期望dataURI'); fileKey = '@DATA/' + image.sha256; }
      const previous = injected.get(slot.logicalReference); assert.ok(!previous || previous.fileKey === fileKey, '同逻辑图片映射不一致');
      if (image.kind === 'builtin') assert.ok(!previous || previous.actualUrl === actualUrl, '同逻辑builtin图片实际URL不一致');
      injected.set(slot.logicalReference, { actualUrl, fileKey }); receipt.slots.push({ ...slot, actualResolvedUrl: actualUrl, canonicalFileKey: fileKey, instanceCount: instances.length, imageSha256: image.sha256 });
    }
    for (const [reference, image] of images) {
      const mapping = injected.get(reference); let bytes, physical;
      if (image.kind === 'platform') {
        const entry = entries.get(reference); physical = await readImageFile(entry.filePath, workspaceRoot); assertImageBytes(physical, image);
        const result = await reader.invoke(await reader.data(api, 'readSyncedImage'), reference);
        assert.equal(await reader.scalar(result, 'contentType'), image.contentType, '图片实际contentType漂移');
        bytes = await reader.bytes(await reader.data(result, 'bytes'), image.bytes); assertImageBytes(bytes, image); assert.ok(bytes.equals(physical), '图片cached API与物理文件字节不一致');
      } else if (image.urlKind === 'file') bytes = await readImageFile(fileURLToPath(mapping.actualUrl), bundledRoot);
      else bytes = dataImageBytes(mapping.actualUrl, image);
      assertImageBytes(bytes, image); const file = path.join(output, `${String(receipt.images.length + 1).padStart(2, '0')}-${image.sha256}.bin`);
      await fs.writeFile(file, bytes, { flag: 'wx' }); receipt.images.push({ logicalReference: reference, kind: image.kind, canonicalFileKey: mapping.fileKey, bytes: bytes.length, sha256: digest(bytes), localEvidenceFile: file, independentlyMatchedPhysicalFile: !!physical, actualRegistry: entries.get(reference) ?? null });
    }
    receipt.status = 'PASS_ACTUAL_INPUT_IMAGE_BYTES_ONLY'; receipt.cdpRequests = reader.requests;
  } catch (error) { failure = error; receipt.status = 'FAIL'; receipt.error = { name: error.name, message: error.message, stack: error.stack, cdpException: error.sceneOpenLogicalImageCdpException ?? null }; receipt.cleanupErrors.push(...(fileCleanupErrors.get(error) ?? [])); }
  finally {
    if (session) { for (const [method, params] of [['Runtime.releaseObjectGroup', { objectGroup: group }]]) try { await session.send(method, params); } catch (error) { receipt.cleanupErrors.push({ method, message: error.message }); }
      try { await session.detach(); } catch (error) { receipt.cleanupErrors.push({ method: 'detach', message: error.message }); } }
  }
  if (receipt.cleanupErrors.length) receipt.status = 'FAIL';
  try { await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (!failure) throw error; if (Object.isExtensible(failure)) failure.sceneOpenLogicalImageSecondaryErrors = [...receipt.cleanupErrors, { method: 'writeReceipt', message: error.message }]; throw failure; }
  if (failure) throw failure;
  assert.equal(receipt.cleanupErrors.length, 0, '图片CDP临时对象释放失败'); return receipt;
}
