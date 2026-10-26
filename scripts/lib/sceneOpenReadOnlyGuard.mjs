import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SCENE_OPEN_QUERY_BODY_LIMIT = 64 * 1024;
export const SCENE_OPEN_JSON_LIMIT = 5 * 1024 ** 2;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const page = value => Number.isSafeInteger(value) && value > 0;
export function sceneOpenQueryCanonicalJson(value) {
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return Object.is(value, -0) ? '-0' : JSON.stringify(value); }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(sceneOpenQueryCanonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + sceneOpenQueryCanonicalJson(value[key])).join(',') + '}';
}
export const isStringId = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
export const isStringRevision = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function normalizeSceneOpenBase(value) {
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'base仅允许无凭据HTTP(S)');
  return url.href.replace(/\/+$/, '');
}

export function normalizeSceneOpenDownload(baseUrl, value) {
  assert.equal(typeof value, 'string'); assert.ok(value.trim());
  const url = new URL(value, normalizeSceneOpenBase(baseUrl) + '/');
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, '未知/不安全下载URL');
  return url.href;
}

export function matchSceneOpenExclusion(exclusions, { url, frameSourceUrl }) {
  let parsed; try { parsed = new URL(url); } catch { return null; }
  const raw = parsed.href; parsed.hash = '';
  return exclusions.find(entry => entry.kind === 'authorized-unavailable-mqtt' ? entry.url === raw
    : entry.kind === 'authorized-unavailable-screen' && entry.url === parsed.href
      && (entry.field === 'thumbnailUrl' || (entry.field === 'screenUrl' && frameSourceUrl === entry.originalUrl))) ?? null;
}

/** 表只来自现有产品调用定义；ID/修订保持字符串，不转Number。 */
export function classifySceneOpenReadOnlyRequest({ baseUrl, projectId, method = 'GET', url, body, downloads = [], exclusions = [], modelIds }) {
  try {
    assert.ok(isStringId(projectId), 'projectId必须为精确字符串');
    const base = new URL(normalizeSceneOpenBase(baseUrl)), target = new URL(url, base.href + '/');
    assert.ok(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && !target.hash);
    const verb = method.toUpperCase();
    if (verb === 'GET' && (body === undefined || body === null || body === '')) {
      if (matchSceneOpenExclusion(exclusions, { url: target.href })) return { allowed: false, excluded: true, reason: 'EXACT_AUTHORIZED_SCREEN_EXCLUDED' };
      const found = downloads.find(entry => entry.url === target.href);
      return found ? { allowed: true, kind: 'download', role: found.role, resourceId: found.resourceId ?? null }
        : { allowed: false, reason: 'GET_NOT_IN_TRUSTED_MANIFEST' };
    }
    if (verb !== 'POST') return { allowed: false, reason: 'METHOD_NOT_READ_ONLY_QUERY' };
    if (target.origin !== base.origin || target.search) return { allowed: false, reason: 'QUERY_ORIGIN_OR_QUERYSTRING_NOT_ALLOWED' };
    assert.equal(typeof body, 'string'); assert.ok(Buffer.byteLength(body) <= SCENE_OPEN_QUERY_BODY_LIMIT);
    const value = JSON.parse(body), prefix = base.pathname.replace(/\/+$/, '') + '/';
    assert.ok(target.pathname.startsWith(prefix)); const endpoint = target.pathname.slice(prefix.length);
    let valid = false;
    if (endpoint === 'api/v1/projects/query') valid = keys(value, ['pageNum', 'pageSize', 'projectName']) && page(value.pageNum) && [12, 100].includes(value.pageSize) && typeof value.projectName === 'string';
    else if (endpoint === 'api/v1/projects/detail') valid = keys(value, ['id']) && value.id === projectId;
    else if (endpoint === 'api/v1/digital-twin/projects/status') valid = keys(value, ['projectId']) && value.projectId === projectId;
    else if (['api/v1/models/detail', 'api/v1/combo-models/detail'].includes(endpoint)) valid = keys(value, ['id']) && isStringId(value.id)
      && (!modelIds || modelIds.includes(value.id));
    else if (['api/v1/models/query', 'api/v1/combo-models/query'].includes(endpoint)) {
      const field = endpoint.includes('combo-models') ? 'comboModelName' : 'modelName';
      valid = keys(value, ['pageNum', 'pageSize', field, 'excludeIds']) && page(value.pageNum) && value.pageSize === 100 && value[field] === '' && Array.isArray(value.excludeIds) && value.excludeIds.length === 0;
    } else if (endpoint === 'api/v1/env-models/sync-manifest/query') valid = keys(value, ['cursorId', 'pageSize', 'manifestRevision'])
      && (value.cursorId === null || isStringId(value.cursorId)) && value.pageSize === 200
      && (value.manifestRevision === null || (typeof value.manifestRevision === 'string' && /^\d{1,64}$/.test(value.manifestRevision)));
    else if (endpoint === 'api/v1/skyboxes/query') valid = keys(value, ['pageNum', 'pageSize', 'skyboxName']) && page(value.pageNum) && value.pageSize === 100 && value.skyboxName === '';
    else if (endpoint === 'api/v1/bigscreen-icons/query') valid = keys(value, ['pageNum', 'pageSize', 'iconSource']) && page(value.pageNum) && value.pageSize === 200 && value.iconSource === 'CUSTOM';
    else if (endpoint === `api/v1/projects/${projectId}/config/screens/query`) valid = keys(value, ['pageNum', 'pageSize', 'keyword']) && page(value.pageNum) && value.pageSize === 100 && value.keyword === '';
    return valid ? { allowed: true, kind: 'query', endpoint, bodySha256: sha(Buffer.from(sceneOpenQueryCanonicalJson(value))) }
      : { allowed: false, reason: 'UNKNOWN_ENDPOINT_OR_UNCONFIRMED_PARAMETERS' };
  } catch (error) { return { allowed: false, reason: 'INVALID_QUERY_OR_ID', detail: error.message }; }
}

/** 仅安装于owned Electron main；同一传输流旁路SHA，无额外请求或响应clone。 */
export function installSceneOpenNetGuard(net, manifest, { limit = 10000 } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(net, 'fetch'), previous = net.fetch;
  assert.equal(typeof previous, 'function');
  const state = { receipts: [], denied: [], dropped: 0, trial: 'startup', activeBodies: 0 };
  const record = row => {
    if (state.receipts.length >= limit) { state.dropped++; throw new Error('E3 guard receipt limit exceeded'); }
    state.receipts.push(row); return row;
  };
  const wrapper = async function (input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : '';
    const decision = classifySceneOpenReadOnlyRequest({ ...manifest, method: init.method ?? 'GET', url, body: init.body,
      modelIds: manifest.resources?.filter(item => ['model', 'combo'].includes(item.kind)).map(item => item.id) });
    const receipt = record({ trial: state.trial, method: (init.method ?? 'GET').toUpperCase(), urlSha256: sha(Buffer.from(url)),
      url: (() => { try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; return parsed.href; } catch { return 'invalid-url'; } })(),
      kind: decision.kind ?? null, role: decision.role ?? null, excluded: decision.excluded === true, allowed: decision.allowed,
      startedAtMs: performance.now(), headersAtMs: null, bodyEndedAtMs: null, actualBytes: null, actualSha256: null,
      httpStatus: null, complete: false, clockDomain: 'owned-electron-main-performance' });
    if (!decision.allowed || init.redirect !== 'error') {
      receipt.reason = decision.reason ?? 'REDIRECT_POLICY_UNCONFIRMED'; state.denied.push(receipt);
      const error = new Error('E3_READ_ONLY_GUARD: ' + receipt.reason); error.code = 'E3_READ_ONLY_GUARD'; throw error;
    }
    let response;
    try { response = await Reflect.apply(previous, this, [input, init]); }
    catch (error) { receipt.error = String(error).replaceAll(url, receipt.url); throw error; }
    receipt.headersAtMs = performance.now(); receipt.httpStatus = response.status;
    if (!response.body) return response;
    const hash = createHash('sha256'), reader = response.body.getReader(), metadata = []; let bytes = 0, settled = false; state.activeBodies++;
    const settle = () => { if (!settled) { settled = true; state.activeBodies--; } };
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            receipt.actualSha256 = hash.digest('hex'); receipt.actualBytes = bytes; receipt.bodyEndedAtMs = performance.now();
            if (decision.kind === 'query' && response.ok && manifest.queryEvidence) {
              const started = performance.now(), payload = JSON.parse(Buffer.concat(metadata).toString('utf8'));
              receipt.responseCanonicalSha256 = sha(Buffer.from(sceneOpenQueryCanonicalJson(payload)));
              const expected = manifest.queryEvidence.filter(row => row.endpoint === decision.endpoint && row.bodySha256 === decision.bodySha256);
              assert.ok(expected.length && expected.every(row => row.responseSha256 === receipt.responseCanonicalSha256), 'E3_QUERY_DECLARATION_DRIFT_OR_UNCONFIRMED');
              receipt.queryAuditParseDurationMs = performance.now() - started;
            }
            if (decision.kind === 'download' && response.ok) {
              const expected = manifest.downloads.find(row => row.url === url);
              if (expected?.declaredSha256) assert.equal(receipt.actualSha256, expected.declaredSha256, 'E3_DECLARED_DOWNLOAD_SHA_MISMATCH');
              if (expected?.declared?.fileSizeBytes !== undefined) assert.equal(String(bytes), expected.declared.fileSizeBytes, 'E3_DECLARED_DOWNLOAD_SIZE_MISMATCH');
            }
            receipt.complete = true;
            settle(); controller.close(); return;
          }
          hash.update(result.value); bytes += result.value.byteLength;
          if (decision.kind === 'query') { assert.ok(bytes <= SCENE_OPEN_JSON_LIMIT, 'E3_QUERY_BODY_TOO_LARGE'); metadata.push(Buffer.from(result.value)); }
          controller.enqueue(result.value);
        } catch (error) { receipt.error = String(error).replaceAll(url, receipt.url); state.denied.push(receipt); settle(); controller.error(error); }
      },
      cancel(reason) { receipt.error = 'body cancelled'; settle(); return reader.cancel(reason); },
    });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const field of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, field, { value: response[field], configurable: true });
    return wrapped;
  };
  Object.defineProperty(net, 'fetch', { value: wrapper, configurable: true, writable: true });
  return { state, setTrial: trial => { state.trial = trial; }, restore: () => {
    if (descriptor) Object.defineProperty(net, 'fetch', descriptor); else delete net.fetch;
  } };
}
