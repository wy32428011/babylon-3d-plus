import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifySceneOpenReadOnlyRequest, isStringId, normalizeSceneOpenBase, normalizeSceneOpenDownload, sceneOpenQueryCanonicalJson, SCENE_OPEN_JSON_LIMIT } from './sceneOpenReadOnlyGuard.mjs';
import { stableSceneOpenJson } from './sceneOpenPairedPlan.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const id = (value, label) => { assert.ok(isStringId(value), label + '必须是精确十进制字符串，禁止Number转换'); return value; };
const count = (value, label) => {
  assert.ok((typeof value === 'string' && /^\d+$/.test(value)) || (Number.isSafeInteger(value) && value >= 0), label + '计数无效');
  const integer = BigInt(value); assert.ok(integer <= 100000n, label + '计数超上限'); return Number(integer);
};
const declaration = (record, fields) => Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => {
  const value = record[key]; assert.ok(value === null || typeof value === 'string', key + '修订/声明必须为string或null'); return [key, value];
}));

/** 显式非计时元数据前置；仅注入的POST查询，无GET/下载/快照/发布。 */
export async function prepareSceneOpenReadOnlyManifest({ baseUrl, projectId, inputSceneSha256, inputModelResources = [], requiredEnvironmentIds = [],
  query, locationPointers = [], locationRules = {}, originalRoots = [], exclusions = [], maxPages = 1000 }) {
  baseUrl = normalizeSceneOpenBase(baseUrl); id(projectId, 'projectId');
  assert.match(inputSceneSha256, /^[a-f0-9]{64}$/);
  const evidence = [], requests = [];
  const post = async (endpoint, body) => {
    const decision = classifySceneOpenReadOnlyRequest({ baseUrl, projectId, method: 'POST', url: new URL(endpoint, baseUrl + '/').href, body: JSON.stringify(body) });
    assert.ok(decision.allowed && decision.kind === 'query', '前置拒绝未知查询/参数：' + endpoint);
    requests.push({ endpoint, body });
    const payload = await query(endpoint, body);
    assert.ok(object(payload) && payload.success === true && object(payload.data), endpoint + '无可信success/data或无权限');
    const serialized = stableSceneOpenJson(payload); assert.ok(Buffer.byteLength(serialized) <= SCENE_OPEN_JSON_LIMIT);
    evidence.push({ endpoint, bodySha256: sha(Buffer.from(sceneOpenQueryCanonicalJson(body))), responseSha256: sha(Buffer.from(serialized)),
      provenance: 'trusted read-only POST response; not downloaded bytes' });
    return payload.data;
  };
  const pages = async (endpoint, pageSize, rest, idField = 'id', pagination) => {
    const records = [], seen = new Set(); let total;
    // 后端BigscreenIconAppService.normalizePageSize明确将请求200 clamp为100；其它接口不能类推放宽。
    const iconContract = endpoint === 'api/v1/bigscreen-icons/query', effectivePageSize = iconContract ? 100 : pageSize;
    const observation = { endpoint, requestedPageSize:pageSize, effectivePageSize, total:null, pages:[] };
    if (pagination) pagination.push(observation);
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const data = await post(endpoint, { pageNum, pageSize, ...rest }); assert.ok(Array.isArray(data.records));
      const currentTotal = count(data.total, endpoint + ' total');
      if (total === undefined) total = currentTotal; else assert.equal(currentTotal, total, '分页total漂移');
      if (iconContract || data.pageNum !== undefined) assert.equal(count(data.pageNum, 'pageNum'), pageNum);
      if (iconContract || data.pageSize !== undefined) assert.equal(count(data.pageSize, 'pageSize'), effectivePageSize, '已核effective pageSize不符');
      assert.ok(data.records.length <= effectivePageSize, 'records超过已核effective pageSize');
      for (const record of data.records) { assert.ok(object(record)); const identity = id(record[idField], endpoint + ' ' + idField); assert.ok(!seen.has(identity), '分页重复ID'); seen.add(identity); records.push(record); }
      observation.total=total; observation.pages.push({pageNum,effectivePageSize,recordCount:data.records.length,ids:data.records.map(record=>record[idField])});
      assert.ok(records.length <= total);
      if (records.length === total) return records;
      assert.ok(data.records.length > 0, '分页提前结束');
    }
    throw new Error('只读前置分页超上限');
  };
  const sweep = async () => {
    const pagination = [];
    const detail = await post('api/v1/projects/detail', { id: projectId }); assert.equal(id(detail.id, 'detail.id'), projectId);
    assert.ok(typeof detail.projectName === 'string' && detail.projectName.trim());
    assert.ok(typeof detail.currentResourceRevision === 'string' && /^\d{1,64}$/.test(detail.currentResourceRevision),
      'project resourceRevision必须有明确string；缺失声明不能冻结为0或等到正式计时才发现');
    await post('api/v1/projects/query', { pageNum: 1, pageSize: 12, projectName: '' });
    await post('api/v1/projects/query', { pageNum: 1, pageSize: 12, projectName: detail.projectName.trim() });
    const status = await post('api/v1/digital-twin/projects/status', { projectId }); assert.equal(id(status.projectId, 'status.projectId'), projectId);
    assert.ok(object(status.runtimeConfig) && status.runtimeConfig.projectId === projectId && typeof status.runtimeConfig.runtimeEnabled === 'boolean', 'status runtimeConfig项目身份不符');
    let source;
    if (status.latestVersionId !== null && status.latestVersionId !== undefined) {
      const editorProjectId = id(status.editorProjectId, 'editorProjectId'), versionId = id(status.latestVersionId, 'latestVersionId');
      assert.ok(Number.isSafeInteger(status.latestVersionNumber) && status.latestVersionNumber > 0, 'versionNumber无效');
      source = { editorProjectId, versionId, versionNumber: status.latestVersionNumber,
        url: new URL(`api/v1/editor/projects/${encodeURIComponent(editorProjectId)}/versions/${encodeURIComponent(versionId)}/package/export`, baseUrl + '/').href };
    } else {
      assert.equal(status.status, 'UNBOUND', '已绑定但缺SOURCE版本，不猜测旧包');
      const projectRows = await pages('api/v1/projects/query', 100, { projectName: '' }), current = projectRows.find(record => record.id === projectId);
      assert.ok(current?.latestEditorProjectPackageUrl, '当前项目缺SOURCE，拒绝空工程');
      source = { editorProjectId: id(current.latestEditorProjectId, 'latestEditorProjectId'), versionId: id(current.latestEditorProjectVersionId, 'latestEditorProjectVersionId'),
        versionNumber: current.latestEditorProjectVersionNumber, url: normalizeSceneOpenDownload(baseUrl, current.latestEditorProjectPackageUrl) };
      assert.ok(Number.isSafeInteger(source.versionNumber) && source.versionNumber > 0);
    }
    const downloads = [], resources = [], add = (role, resourceId, value, declared = {}) => {
      if (value === null || value === undefined || value === '') return;
      const shaFields = role === 'metadata' ? ['metaFileSha256', 'metaSha256'] : role === 'thumbnail' ? ['thumbnailSha256', 'thumbnailHash']
        : ['model', 'script', 'environment', 'skybox'].includes(role) ? ['fileSha256', 'fileHash'] : [];
      const declaredSha256 = shaFields.map(key => declared[key]).find(item => typeof item === 'string' && /^[a-fA-F0-9]{64}$/.test(item))?.toLowerCase() ?? null;
      downloads.push({ role, resourceId, url: normalizeSceneOpenDownload(baseUrl, value), declared, declaredSha256,
        byteVerification: 'NOT_DOWNLOADED_NOT_BYTE_VERIFIED', actualSha256: null, actualBytes: null });
    };
    add('source', projectId, source.url, { versionId: source.versionId });
    const models = await pages('api/v1/models/query', 100, { modelName: '', excludeIds: [] });
    const combos = await pages('api/v1/combo-models/query', 100, { comboModelName: '', excludeIds: [] });
    const modelRows = new Map([...models.map(record => ['model:' + record.id, record]), ...combos.map(record => ['combo:' + record.id, record])]);
    for (const expected of inputModelResources) {
      assert.ok(['model', 'combo'].includes(expected.kind)); id(expected.resourceId, 'input resourceId');
      const endpoint = expected.kind === 'model' ? 'api/v1/models/detail' : 'api/v1/combo-models/detail';
      const record = await post(endpoint, { id: expected.resourceId }); assert.equal(id(record.id, 'resource detail.id'), expected.resourceId);
      const previous = modelRows.get(expected.kind + ':' + record.id);
      if (previous?.fileUrl !== undefined) assert.equal(previous.fileUrl, record.fileUrl, '模型catalog/detail URL漂移');
      modelRows.set(expected.kind + ':' + record.id, record);
    }
    for (const [key, record] of modelRows) {
      const kind = key.startsWith('combo:') ? 'combo' : 'model'; assert.ok(typeof record.fileUrl === 'string' && record.fileUrl.trim(), '模型缺fileUrl，不猜downloadUrl');
      const revision = declaration(record, ['packageRevision', 'modelRevision', 'comboModelRevision', 'resourceRevision', 'revision', 'updatedAt', 'updateTime',
        'fileSha256', 'fileHash', 'fileRevision', 'metaFileSha256', 'metaSha256', 'metaRevision', 'scriptsRevision', 'scriptRevision', 'thumbnailSha256', 'thumbnailHash']);
      resources.push({ kind, id: record.id, declaredRevisions: revision }); add('model', record.id, record.fileUrl, revision);
      add('metadata', record.id, record.metaFileUrl, revision); add('thumbnail', record.id, record.thumbnailUrl, revision);
      if (kind === 'model') {
        const scripts = Array.isArray(record.scriptFiles) ? record.scriptFiles.filter(item => object(item) && typeof item.fileUrl === 'string' && item.fileUrl.trim()) : [];
        if (scripts.length) for (const script of scripts) add('script', record.id, script.fileUrl, declaration(script, ['fileSha256', 'fileHash', 'revision', 'fileRevision', 'updatedAt']));
        else if (typeof record.scriptFileUrl === 'string') for (const url of record.scriptFileUrl.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) add('script', record.id, url,
          declaration(record, ['scriptsRevision', 'scriptRevision']));
      }
    }
    let cursorId = null, manifestRevision = null, protocolVersion = null; const environments = [], environmentIds = new Set();
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const data = await post('api/v1/env-models/sync-manifest/query', { cursorId, pageSize: 200, manifestRevision });
      assert.ok(Array.isArray(data.records) && data.records.length <= 200 && typeof data.hasMore === 'boolean');
      assert.ok(typeof data.manifestRevision === 'string' && /^\d{1,64}$/.test(data.manifestRevision));
      if (manifestRevision === null) { manifestRevision = data.manifestRevision; protocolVersion = data.protocolVersion; }
      else { assert.equal(manifestRevision, data.manifestRevision, '环境manifest revision漂移'); assert.equal(protocolVersion, data.protocolVersion); }
      for (const record of data.records) { id(record.id, 'environment.id'); assert.ok(!environmentIds.has(record.id)); environmentIds.add(record.id); environments.push(record); }
      if (!data.hasMore) break;
      cursorId = id(data.nextCursorId, 'environment.nextCursorId'); if (pageIndex === maxPages - 1) throw new Error('环境分页超上限');
    }
    for (const required of requiredEnvironmentIds) assert.ok(environments.some(record => record.id === required && record.fileStatus === 'GLB_READY'), '当前清单缺所需GLB_READY环境');
    for (const record of environments) if (record.fileStatus === 'GLB_READY') {
      assert.ok(typeof record.fileSha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(record.fileSha256));
      const declared = declaration(record, ['fileRevision', 'runtimeRevision', 'fileSha256']);
      assert.ok(declared.fileRevision && declared.runtimeRevision, 'GLB_READY缺修订');
      const bytes = record.fileSizeBytes ?? record.fileSize;
      assert.ok((typeof bytes === 'string' && /^\d+$/.test(bytes)) || (Number.isSafeInteger(bytes) && bytes > 0)); declared.fileSizeBytes = String(bytes);
      resources.push({ kind: 'environment', id: record.id, declaredRevisions: declared }); add('environment', record.id, record.downloadUrl ?? record.fileUrl, declared);
    }
    const skyboxes = await pages('api/v1/skyboxes/query', 100, { skyboxName: '' });
    for (const record of skyboxes) {
      const declared = declaration(record, ['fileSha256', 'fileRevision', 'updatedAt']);
      assert.ok(typeof record.fileUrl === 'string' && /^[a-fA-F0-9]{64}$/.test(record.fileSha256));
      resources.push({ kind: 'skybox', id: record.id, declaredRevisions: declared }); add('skybox', record.id, record.fileUrl, declared);
    }
    const icons = await pages('api/v1/bigscreen-icons/query', 200, { iconSource: 'CUSTOM' }, 'id', pagination);
    for (const record of icons) if (record.iconSource === 'CUSTOM' && ['IMAGE', 'SVG'].includes(record.iconType) && record.status !== 'DELETED') add('icon', record.id, record.iconUrl,
      declaration(record, ['updatedAt']));
    // 实际接口在schema中已确认；仅收thumbnail，不把交互screenUrl当GET下载许可。
    const screens = await pages(`api/v1/projects/${projectId}/config/screens/query`, 100, { keyword: '' }, 'screenId');
    for (const record of screens) add('screen-thumbnail', record.screenId, record.thumbnailUrl);
    const unique = new Map();
    for (const entry of downloads) {
      const prior = unique.get(entry.url);
      const owner = { role: entry.role, resourceId: entry.resourceId, declared: entry.declared };
      if (prior) {
        if (prior.declaredSha256 && entry.declaredSha256) assert.equal(prior.declaredSha256, entry.declaredSha256, '同URL字节SHA声明冲突');
        prior.declaredSha256 ??= entry.declaredSha256; prior.owners.push(owner);
      } else unique.set(entry.url, { ...entry, owners: [owner] });
    }
    return { project: { id: projectId, projectName: detail.projectName.trim(), currentResourceRevision: detail.currentResourceRevision ?? null,
      source, status: status.status }, resources: resources.sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id)),
    downloads: [...unique.values()].sort((a, b) => a.url.localeCompare(b.url)), environmentManifest: { manifestRevision, protocolVersion }, pagination };
  };
  const first = await sweep(), second = await sweep();
  assert.equal(stableSceneOpenJson(first), stableSceneOpenJson(second), '只读前置两次元数据观察不一致，保留漂移失败');
  const observed = new Map();
  for (const row of evidence) {
    const key = row.endpoint + ':' + row.bodySha256;
    if (observed.has(key)) assert.equal(row.responseSha256, observed.get(key), '同一只读查询响应字段漂移');
    else observed.set(key, row.responseSha256);
  }
  return { version: 1, status: 'TRUSTED_METADATA_NOT_DOWNLOADED_NOT_BYTE_VERIFIED', baseUrl, projectId, inputSceneSha256,
    ...first, locationPointers, locationRules, originalRoots, exclusions, queryEvidence: evidence, queryCount: requests.length,
    preparationObservation: 'two explicit POST-only metadata sweeps; outside formal timing; no GET/source/resource bytes read',
    sourceActualSha256: null, actualBytesVerified: false };
}

export async function requestSceneOpenQueryJson(net, baseUrl, projectId, endpoint, body, { timeoutMs = 20000 } = {}) {
  const url = new URL(endpoint, normalizeSceneOpenBase(baseUrl) + '/').href, encoded = JSON.stringify(body);
  assert.ok(classifySceneOpenReadOnlyRequest({ baseUrl, projectId, method: 'POST', url, body: encoded }).allowed);
  const response = await net.fetch(url, { method: 'POST', redirect: 'error', headers: { Accept: 'application/json', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' },
    body: encoded, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`只读前置HTTP ${response.status}：${endpoint}`);
  assert.ok(response.body); const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.byteLength; assert.ok(bytes <= SCENE_OPEN_JSON_LIMIT, '元数据超过5MiB'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
