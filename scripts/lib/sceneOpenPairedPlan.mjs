/* global document */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const sceneOpenSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const child = (parent, key) => parent + '/' + escape(key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function createSceneOpenPairedSchedule(count = 5) {
  assert.ok(Number.isInteger(count) && count > 0 && count <= 10);
  return Array.from({ length: count }, (_, index) => [{ name: `C${index + 1}`, kind: 'cold', index: index + 1, pair: index + 1 },
    { name: `W${index + 1}`, kind: 'warm', index: index + 1, pair: index + 1 }]).flat();
}

export async function createFreshSceneOpenOutput(output, allowedRoot) {
  const target = path.resolve(output), root = path.resolve(allowedRoot), relative = path.relative(root, target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'paired output必须为允许根内的新目录');
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { assert.equal((await fs.lstat(cursor)).isSymbolicLink(), false, '拒绝output祖先junction/符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; break; }
  }
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(target); return target;
}

/** JSON全部字段参与，负零保留；不以可忽略字段白名单吞掉业务差异。 */
export function stableSceneOpenJson(value) {
  if (typeof value === 'number') { assert.ok(Number.isFinite(value), '非有限JSON数值'); return Object.is(value, -0) ? '-0' : JSON.stringify(value); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSceneOpenJson).join(',') + ']';
  assert.ok(plain(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), '未知非JSON业务对象');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableSceneOpenJson(value[key])).join(',') + '}';
}

/** 只接受产品已有资源owner枚举，不遍历parameterValues猜sourcePath字段。 */
function detailedSceneOpenLocations(envelope, traversal) {
  const pointers = new WeakMap();
  const visit = (value, pointer) => {
    if (!value || typeof value !== 'object') return;
    pointers.set(value, pointer); for (const [key, item] of Object.entries(value)) visit(item, child(pointer, key));
  };
  visit(envelope, ''); const scene = envelope.scene ?? envelope, refs = traversal.collectSceneResourceReferences(scene, 'tolerant');
  const identities = new Map();
  const identity = (owner, kind) => {
    const declared = owner?.dataPlatformModel;
    const sourceKey = declared?.sourceKey ?? owner?.dataPlatformSourceKey;
    const resourceId = declared?.resourceId ?? owner?.dataPlatformResourceId;
    const revision = owner?.assetRevision ?? owner?.dataPlatformRevision;
    return typeof sourceKey === 'string' && /^[a-f\d]{64}$/i.test(sourceKey) && typeof resourceId === 'string'
      && /^[1-9]\d{0,63}$/.test(resourceId) && typeof revision === 'string' && revision
      ? { kind: declared?.kind ?? kind, sourceKey, resourceId, revision } : null;
  };
  for (const item of refs.models) for (const owner of [item.asset, item.target, item.packageOwner]) if (owner) identities.set(owner, identity(item.asset, 'model'));
  for (const item of refs.environments) for (const owner of [item.environment, ...item.variants]) identities.set(owner, identity(item.environment, 'environment'));
  for (const item of refs.skyboxes) identities.set(item.skybox, identity(item.skybox, 'skybox'));
  const owners = new Set([...refs.models.flatMap(item => [item.asset, item.target, item.packageOwner]),
    ...refs.environments.flatMap(item => [item.environment, ...item.variants]), ...refs.skyboxes.map(item => item.skybox),
    ...refs.cadReferences.map(item => item.cad), ...refs.images, ...refs.entityResources.map(item => item.value),
    ...refs.clickEventBindings.map(item => item.deviceType), ...traversal.collectLightingPolicyResourceModels(scene)]);
  const result = [];
  for (const owner of owners) if (owner) for (const field of traversal.collectLocalSceneResourceFields(owner)) {
    const base = pointers.get(field.parent); if (base === undefined) throw new Error('资源枚举返回输入以外对象');
    result.push({ pointer: child(base, field.key), identity: identities.get(owner) ?? null });
  }
  const addPhysicalAlias=(owner,knownOwners,declaredIdentity)=>{
    if(!owner||typeof owner.assetId!=='string')return;let alias;
    try{alias=decodeSceneOpenLocalLocation(owner.assetId);}catch{return;}
    if(!alias)return;
    const absolute=value=>/^[A-Za-z]:[\\/]/.test(value)||(/^\//.test(value)&&!/^\/\//.test(value));
    if(!absolute(alias.physical))return;const win=/^[A-Za-z]:[\\/]/.test(alias.physical),api=win?path.win32:path.posix,candidates=[];
    for(const known of knownOwners)for(const key of ['modelPath','sourcePath','sourceUrl']){
      let decoded;try{decoded=decodeSceneOpenLocalLocation(known?.[key]);}catch{continue;}
      if(decoded&&absolute(decoded.physical))candidates.push(decoded);
    }
    if(!candidates.length||candidates.some(value=>win!==/^[A-Za-z]:[\\/]/.test(value.physical)||api.relative(api.resolve(alias.physical),api.resolve(value.physical))!==''))return;
    if(!candidates.some(value=>value.suffix===alias.suffix))return;
    const base=pointers.get(owner);if(base===undefined)throw new Error('typed assetId owner不属于输入');
    result.push({pointer:child(base,'assetId'),identity:declaredIdentity});
  };
  // assetId通常是业务ID；仅这两个真实schema owner中与已声明文件精确一致的物理别名可换根。
  for(const entity of Object.values(scene.entities??{})){
    const target=entity?.components?.modelGenerator?.defaultTarget;
    if(target?.kind==='model')addPhysicalAlias(target,[target,target.modelAsset],identities.get(target)??identity(target.modelAsset,'model'));
    for(const slot of entity?.components?.clickEventBinding?.deviceSlots??[]){const device=slot?.deviceType;
      addPhysicalAlias(device,[device],identities.get(device)??identity(device,'model'));
    }
  }
  const opening=scene.sceneSettings?.openingAnimation?.package;
  if(typeof opening?.manifestUrl==='string'){
    const base=pointers.get(opening);if(base===undefined)throw new Error('opening package owner不属于输入');
    result.push({pointer:child(base,'manifestUrl'),identity:null});
  }
  return [...new Map(result.map(row => [row.pointer, row])).values()].sort((a, b) => a.pointer.localeCompare(b.pointer));
}
export function collectSceneOpenLocationPointers(envelope, traversal) {
  return detailedSceneOpenLocations(envelope, traversal).map(row => row.pointer);
}
export function collectSceneOpenLocationRules(envelope, traversal) {
  return Object.fromEntries(detailedSceneOpenLocations(envelope, traversal).filter(row => row.identity).map(row => [row.pointer, row.identity]));
}

export function decodeSceneOpenLocalLocation(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('editor-asset://local/')) {
    const url = new URL(value); return { physical: decodeURIComponent(url.pathname.slice(1)), suffix: url.search + url.hash, representation: 'editor-asset' };
  }
  if (value.startsWith('file:')) {
    const url = new URL(value); assert.ok(!url.hostname || url.hostname === 'localhost', '不读取UNC资源');
    let physical = decodeURIComponent(url.pathname); if (/^\/[A-Za-z]:\//.test(physical)) physical = physical.slice(1);
    return { physical, suffix: url.search + url.hash, representation: 'file' };
  }
  return /^[A-Za-z]:[\\/]|^\//.test(value) ? { physical: value, suffix: '', representation: 'path' } : null;
}

function locationToken(value, roots, identity) {
  const decoded = decodeSceneOpenLocalLocation(value); if (!decoded) return null;
  const win = /^[A-Za-z]:[\\/]/.test(decoded.physical), api = win ? path.win32 : path.posix;
  const actual = api.resolve(decoded.physical);
  for (const root of [...roots].sort((a, b) => b.path.length - a.path.length)) {
    if (win !== /^[A-Za-z]:[\\/]/.test(root.path)) continue;
    const relative = api.relative(api.resolve(root.path), actual);
    if (relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative))) {
      const normalized = actual.replaceAll('\\', '/'), assets = /\/(Assets\/(?:Models|Environments|Skyboxes|Cad|Images|Compositions|LightingBakes)\/.*)$/i.exec(normalized);
      const pin = /\/\.babylon-editor\/scene-model-versions\/([a-f\d]{64})\/([a-f\d]{64})\//i.exec(normalized);
      if (identity && assets) {
        if (pin) { assert.equal(pin[1], identity.sourceKey, '物理pin来源变化不能当Location忽略'); assert.equal(pin[2], identity.revision, '物理pin修订变化不能当Location忽略'); }
        return { token: `@E3_RESOURCE_LOCATION/${identity.kind}/${identity.sourceKey}/${identity.resourceId}/${identity.revision}/${assets[1]}${decoded.suffix}`,
          rootTag: root.tag, relative: relative.replaceAll('\\', '/'), original: value, representation: decoded.representation,
          basis: 'schema resource owner identity+unchanged sourceKey/id/revision+complete Assets suffix; actual file bytes independently frozen from C1' };
      }
      return { token: `@E3_LOCATION/${root.tag}/${relative.replaceAll('\\', '/')}${decoded.suffix}`,
        rootTag: root.tag, relative: relative.replaceAll('\\', '/'), original: value, representation: decoded.representation };
    }
  }
  return null;
}

/** 仅在精确资源pointer处重定位；可逆映射附在结果，其余所有字段/版本原样比较。 */
export function freezeSceneOpenInput(sourceBytes, { roots = [], locationPointers = [], locationRules = {} } = {}) {
  const raw = Buffer.from(sourceBytes), text = raw.toString('utf8'), document = JSON.parse(text), allowed = new Set(locationPointers), rewrites = [];
  const project = (value, pointer) => {
    if (typeof value === 'string' && allowed.has(pointer)) {
      const token = locationToken(value, roots, locationRules[pointer]); if (token) { rewrites.push({ pointer, ...token }); return token.token; }
    }
    if (Array.isArray(value)) return value.map((item, index) => project(item, child(pointer, index)));
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item, child(pointer, key))]));
    return value;
  };
  const projection = project(document, ''), byPointer = new Map(rewrites.map(row => [row.pointer, row]));
  const restore = (value, pointer) => {
    if (byPointer.has(pointer)) return byPointer.get(pointer).original;
    if (Array.isArray(value)) return value.map((item, index) => restore(item, child(pointer, index)));
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, child(pointer, key))]));
    return value;
  };
  assert.equal(stableSceneOpenJson(restore(projection, '')), stableSceneOpenJson(document), 'Location投影不可逆');
  const ast = ts.parseJsonText('source.scene.json', text), edits = [];
  const spans = (node, pointer) => {
    if (ts.isStringLiteral(node) && byPointer.has(pointer)) edits.push({ start: node.getStart(ast), end: node.end, text: JSON.stringify(byPointer.get(pointer).token) });
    else if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
      assert.ok(ts.isPropertyAssignment(property)); spans(property.initializer, child(pointer, property.name.text));
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach((element, index) => spans(element, child(pointer, index)));
  };
  spans(ast.statements[0].expression, ''); let canonicalSourceText = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) canonicalSourceText = canonicalSourceText.slice(0, edit.start) + edit.text + canonicalSourceText.slice(edit.end);
  assert.equal(edits.length, rewrites.length, 'JSON字符串location span未完整定位');
  return { rawSha256: sceneOpenSha256(raw), bytes: raw.length, projectionSha256: sceneOpenSha256(Buffer.from(stableSceneOpenJson(projection))),
    locationOnlySourceSha256: sceneOpenSha256(Buffer.from(canonicalSourceText)), projection, rewrites, reversible: true };
}

export function diffSceneOpenProjection(left, right, limit = 64) {
  const differences = [];
  const compare = (a, b, pointer) => {
    if (Object.is(a, b) || differences.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) differences.push({ pointer, reason: 'array-length', before: a.length, after: b.length });
      for (let index = 0; index < Math.max(a.length, b.length); index++) compare(a[index], b[index], child(pointer, index));
    } else if (plain(a) && plain(b)) for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) differences.push({ pointer: child(pointer, key), reason: 'field-presence' });
      else compare(a[key], b[key], child(pointer, key));
    } else differences.push({ pointer, reason: 'value-or-type', before: a, after: b });
  };
  compare(left, right, ''); return differences;
}

export function compareSceneOpenInputs(reference, actual, { requireCanonicalSourceBytes = true } = {}) {
  const differences = diffSceneOpenProjection(reference.projection, actual.projection);
  return { equal: differences.length === 0 && (!requireCanonicalSourceBytes || reference.locationOnlySourceSha256 === actual.locationOnlySourceSha256),
    businessAndVersionEqual: differences.length === 0, rawBytesEqual: reference.rawSha256 === actual.rawSha256,
    locationOnlySourceBytesEqual: reference.locationOnlySourceSha256 === actual.locationOnlySourceSha256, differences };
}

/** 显式批准的新运行基线与原SOURCE分开冻结；这不会放宽旧基线的来源/修订检查。 */
export function validateSceneOpenResolvedBaseline(baseline, manifest, resolvedBytes, derived) {
  assert.equal(baseline?.status,'FROZEN_CURRENT_RESOLVED_BASELINE_NOT_PERFORMANCE_EVIDENCE');
  assert.equal(baseline.assetsByteVerified,true,'新基线必须先独立校验实际引用字节');
  assert.equal(baseline.projectId,manifest.projectId);assert.equal(baseline.rawSourceSha256,manifest.inputSceneSha256);
  assert.equal(baseline.sourceVersionNumber,manifest.project.source.versionNumber);
  assert.equal(baseline.resourceRevision,manifest.project.currentResourceRevision);
  assert.match(baseline.sourceArchiveSha256,/^[a-f0-9]{64}$/);
  assert.equal(baseline.resolvedLiveSha256,sceneOpenSha256(resolvedBytes),'已批准运行场景字节漂移');
  assert.ok(stableSceneOpenJson(baseline.locationPointers)===stableSceneOpenJson(derived.locationPointers),'新基线资源pointer不能自行扩展或省略');
  assert.ok(stableSceneOpenJson(baseline.locationRules)===stableSceneOpenJson(derived.locationRules),'新基线资源身份规则必须来自实际schema');
  assert.ok(Array.isArray(baseline.roots)&&baseline.roots.length>0&&baseline.roots.every(row=>typeof row.tag==='string'&&typeof row.path==='string'&&row.path));
  assert.ok(Array.isArray(baseline.resources)&&baseline.resources.length>0&&baseline.resources.every(row=>typeof row.key==='string'
      &&/^@(?:PROJECT|WORKSPACE|BUNDLED\/skybox-environments)\//.test(row.key)&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&/^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(new Set(baseline.resources.map(row=>row.key)).size,baseline.resources.length,'新基线引用文件键不能重复');
  const frozen=freezeSceneOpenInput(resolvedBytes,{roots:baseline.roots,locationPointers:derived.locationPointers,locationRules:derived.locationRules});
  assert.ok(stableSceneOpenJson(frozen)===stableSceneOpenJson(baseline.frozen),'新基线投影/可逆映射收据漂移');
  return frozen;
}

/** 文件逐个流式hash；仅owned根内、无链接的真实引用文件，不读原工程缓存凑warm。 */
export async function hashSceneOpenReferencedFiles(document, { locationPointers, workspaceRoot, projectRoot, bundledSkyboxRoot }) {
  const values = new Map(); const walk = (value, pointer) => { values.set(pointer, value); if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, child(pointer, key)); };
  walk(document, ''); const files = new Map(), pending = [],checkedAncestors=new Set(),scene=document.scene??document;
  const openingPointer=(document.scene?'/scene':'')+'/sceneSettings/openingAnimation/package/manifestUrl',opening=scene.sceneSettings?.openingAnimation?.package;
  const withinRoot = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
  // 原生天空可引用随应用交付的只读 ENV；仅允许调用方明确指定的这一资源根，仍校验链接和实际字节。
  const rootFor = file => withinRoot(workspaceRoot, file) ? workspaceRoot
    : bundledSkyboxRoot && withinRoot(bundledSkyboxRoot, file) ? bundledSkyboxRoot : null;
  const within = file => rootFor(file) !== null;
  const noAncestorLinks=async file=>{
    const root=rootFor(file);assert.ok(root);const relative=path.relative(root,file);let cursor=path.resolve(root);
    for(const part of ['',...relative.split(path.sep).filter(Boolean)]){if(part)cursor=path.join(cursor,part);if(checkedAncestors.has(cursor))continue;
      assert.equal((await fs.lstat(cursor)).isSymbolicLink(),false,'引用资源祖先含junction/符号链接');checkedAncestors.add(cursor);}
  };
  for (const pointer of locationPointers) {
    const local = decodeSceneOpenLocalLocation(values.get(pointer));
    if(pointer===openingPointer)assert.ok(local,'opening manifest必须是可hash的本地typed引用');
    if (!local) continue;
    const actual = path.resolve(local.physical); assert.ok(within(actual), '资源引用仍在owned workspace以外：' + pointer);
    pending.push(actual);
    if(pointer===openingPointer){
      const safe=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
      assert.ok(opening&&safe(opening.id)&&typeof opening.version==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(opening.version)
        &&typeof opening.contentHash==='string'&&/^[a-f0-9]{64}$/.test(opening.contentHash),'opening package身份无效');
      const expected=path.resolve(projectRoot,'Assets','OpeningPackages',opening.id,opening.version+'-'+opening.contentHash,'manifest.json');
      assert.equal(path.relative(expected,actual),'','opening manifest路径必须精确对应id/version/contentHash');
      // 只扩展这个已验证开场包目录；不从任意manifest向workspace扩散。
      pending.push(path.dirname(actual));
    }
  }
  const visited = new Set();
  while (pending.length) {
    const actual = pending.pop(); if (visited.has(actual)) continue; visited.add(actual);
    assert.ok(visited.size <= 100000, '引用文件展开超界');
    await noAncestorLinks(actual);const stat = await fs.lstat(actual); assert.equal(stat.isSymbolicLink(), false, '引用资源含链接');
    const real = await fs.realpath(actual); assert.ok(within(real));
    if (stat.isDirectory()) for (const entry of await fs.readdir(actual)) pending.push(path.join(actual, entry));
    else if (stat.isFile()) {
      const hash = createHash('sha256'); for await (const chunk of createReadStream(actual)) hash.update(chunk);
      const projectRelative = path.relative(projectRoot, actual), project = projectRelative === '' || (!projectRelative.startsWith('..') && !path.isAbsolute(projectRelative));
      const key = (project ? '@PROJECT/' + projectRelative : withinRoot(workspaceRoot, actual)
        ? '@WORKSPACE/' + path.relative(workspaceRoot, actual)
        : '@BUNDLED/skybox-environments/' + path.relative(bundledSkyboxRoot, actual)).replaceAll('\\', '/');
      files.set(key, { key, bytes: stat.size, sha256: hash.digest('hex') });
    } else throw new Error('未知资源文件类型');
  }
  return [...files.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeSceneOpenMemory(samples) {
  const processes = new Map(); let simultaneousWorkingSetMaxBytes = null, rendererHeapMaxObservedBytes = null;
  for (const sample of samples) {
    let sum = 0, known = true;
    for (const row of sample.processes ?? []) {
      const key = `${row.pid}:${row.creationTime}`, previous = processes.get(key) ?? { pid: row.pid, creationTime: row.creationTime, type: row.type, lifetimePeakWorkingSetBytes: null };
      if (Number.isFinite(row.peakWorkingSetBytes) && row.peakWorkingSetBytes > 0) previous.lifetimePeakWorkingSetBytes = Math.max(previous.lifetimePeakWorkingSetBytes ?? 0, row.peakWorkingSetBytes);
      processes.set(key, previous);
      if (Number.isFinite(row.workingSetBytes) && row.workingSetBytes > 0) sum += row.workingSetBytes; else known = false;
    }
    if (known && sample.processes?.length) simultaneousWorkingSetMaxBytes = Math.max(simultaneousWorkingSetMaxBytes ?? 0, sum);
    if (Number.isFinite(sample.rendererHeapBytes) && sample.rendererHeapBytes > 0) rendererHeapMaxObservedBytes = Math.max(rendererHeapMaxObservedBytes ?? 0, sample.rendererHeapBytes);
  }
  const list = [...processes.values()];
  return { simultaneousWorkingSetMaxObservedBytes: simultaneousWorkingSetMaxBytes, rendererHeapMaxObservedBytes,
    processes: list, sumPerProcessLifetimePeaksUpperBoundBytes: list.length && list.every(row => row.lifetimePeakWorkingSetBytes !== null)
      ? list.reduce((sum, row) => sum + row.lifetimePeakWorkingSetBytes, 0) : null,
    gpuUploadDurationMs: null, gpuVramPeakBytes: null,
    scope: 'sampled simultaneous CPU working sets; sum of per-process lifetime peaks is an upper bound, not measured simultaneous peak; GPU-process CPU memory is not VRAM' };
}

/** 只收当前useSyncExternalStore selector，不从旧ref/历史场景中挑“看起来匹配”的输入。 */
export function readSceneOpenLogicalInput() {
  const element = document.getElementById('root'), key = Object.keys(element ?? {}).find(value => value.startsWith('__reactContainer$'));
  const first = element?.[key], stack = first ? [first.stateNode?.current ?? first] : [], seen = new Set(), scenes = new Set();
  const isScene = value => value && typeof value === 'object' && Array.isArray(value.entityIds) && value.entities && value.sceneSettings;
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    let hook = fiber.memoizedState;
    for (let index = 0; hook && index < 500; index++, hook = hook.next) {
      if (isScene(hook.memoizedState) && typeof hook.queue?.getSnapshot === 'function') {
        const current = hook.queue.getSnapshot(); if (isScene(current)) scenes.add(current);
      }
    }
    stack.push(fiber.child, fiber.sibling);
  }
  if (scenes.size !== 1) throw new Error('E3_CURRENT_LOGICAL_SCENE_UNREACHABLE_OR_AMBIGUOUS:' + scenes.size);
  const omittedUndefined = [];
  const encode = (value, pointer) => {
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('非有限业务值'); return Object.is(value, -0) ? '-0' : JSON.stringify(value); }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map((item, index) => encode(item, pointer + '/' + index)).join(',') + ']';
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('未知非JSON业务值');
    const fields = [];
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue; if (!Object.hasOwn(descriptor, 'value')) throw new Error('业务JSON含accessor');
      if (descriptor.value === undefined) { omittedUndefined.push(pointer + '/' + name); continue; }
      fields.push(JSON.stringify(name) + ':' + encode(descriptor.value, pointer + '/' + name));
    }
    return '{' + fields.join(',') + '}';
  };
  const scene = [...scenes][0];
  return { text: encode({ scene }, ''), entityCount: scene.entityIds.length, omittedUndefined,
    basis: 'current selector snapshots agree by reference; all enumerable JSON fields retained, only nonpersistable undefined object fields logged' };
}

export function collectSceneOpenAuthorizedExclusions(envelope) {
  const scene = envelope.scene ?? envelope, result = [];
  for (const [entityId, entity] of Object.entries(scene.entities ?? {})) {
    const component = entity.components?.dataPlatformScreen;
    if (component?.screenId !== '2100824337532211202') continue;
    for (const field of ['screenUrl', 'thumbnailUrl']) if (typeof component[field] === 'string' && component[field]) {
      const url = new URL(component[field]); assert.ok(!url.username && !url.password && ['http:', 'https:'].includes(url.protocol));
      const originalUrl = url.href; url.hash = '';
      result.push({ kind: 'authorized-unavailable-screen', url: url.href, originalUrl, screenId: component.screenId, entityId, field,
        reason: 'human-authorized exact unavailable screen2100824337532211202; no other screen/error exemption' });
    }
  }
  if (scene.mqttConfig?.address === 'ws://192.168.18.100:8083/mqtt') result.push({ kind: 'authorized-unavailable-mqtt', url: scene.mqttConfig.address,
    reason: 'human-authorized exact old MQTT broker; no messages manufactured, no other broker exemption' });
  return result;
}
