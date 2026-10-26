import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** 仅调用已由本地controller确认的只读路由；不接受任意POST/文件/凭据参数。 */
const routes = {
  screen: { method: 'POST', path: 'api/v1/screens/detail', body: ids => ({ id: ids.screenId }) },
  projectScreens: { method: 'POST', path: ids => `api/v1/projects/${ids.projectId}/config/screens/query`, body: () => ({ pageNum: 1, pageSize: 20, keyword: '' }) },
  runtime: { method: 'POST', path: 'api/v1/digital-twin/runtime-config/detail', body: ids => ({ projectId: ids.projectId }) },
  status: { method: 'POST', path: 'api/v1/digital-twin/projects/status', body: ids => ({ projectId: ids.projectId }) },
  published: { method: 'GET', path: ids => `api/v1/screens/${ids.screenId}/published` },
};
function safeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    url.username = ''; url.password = '';
    for (const key of url.searchParams.keys()) if (/token|auth|secret|password|signature|session|api.?key/i.test(key)) url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch { return 'INVALID_URL'; }
}
function advertisedWebSockets(value, base, scope = '', found = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 24) return found;
  for (const [key, data] of Object.entries(value)) {
    if (typeof data === 'string' && /^wss?:\/\//i.test(data)) found.push({ field: scope ? scope + '.' + key : key, url: safeUrl(data, base) });
    else if (typeof data === 'string' && /^(?:configJson|jsonContent|snapshotJson)$/.test(key)) {
      try { advertisedWebSockets(JSON.parse(data), base, scope ? scope + '.' + key : key, found, depth + 1); } catch { /* 只读元数据不输出原配置。 */ }
    } else if (data && typeof data === 'object') advertisedWebSockets(data, base, scope ? scope + '.' + key : key, found, depth + 1);
  }
  return found;
}
async function curlRead(url, { method, body }) {
  const args = ['--silent', '--show-error', '--connect-timeout', '3', '--max-time', '15', '--request', method,
    '--write-out', '\n__PHASE2_HTTP__%{http_code}', '--url', url];
  if (body) args.push('--header', 'Content-Type: application/json', '--data-raw', JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; let bytes = 0, stderr = '';
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
    child.on('error', reject);
    child.on('close', code => {
      if (bytes > 8 * 1024 * 1024) return reject(new Error('只读JSON响应超过8MiB预算'));
      const text = Buffer.concat(chunks).toString('utf8'), marker = text.lastIndexOf('\n__PHASE2_HTTP__');
      const responseBody = marker >= 0 ? text.slice(0, marker) : text;
      let payload = null; try { payload = JSON.parse(responseBody); } catch { /* 非JSON只记状态/类型，不输出原文。 */ }
      resolve({ code, httpStatus: marker >= 0 ? Number(text.slice(marker + 16)) : null, payload, error: stderr || null });
    });
  });
}
async function curlHead(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--silent', '--show-error', '--head',
      '--connect-timeout', '3', '--max-time', '15', '--url', url], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let headers = '', stderr = '';
    child.stdout.on('data', chunk => { headers = (headers + String(chunk)).slice(-16000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
    child.on('error', reject);
    child.on('close', code => resolve({ curlExitCode: code, httpStatus: Number(headers.match(/^HTTP\/[^ ]+ (\d+)/m)?.[1] ?? 0),
      contentType: headers.match(/^content-type:\s*([^\r\n]+)/im)?.[1] ?? null,
      contentLength: headers.match(/^content-length:\s*([^\r\n]+)/im)?.[1] ?? null, error: stderr || null }));
  });
}
/** 只校验平台status明确回显的发布URL，不替换host/port或发起部署。 */
export async function inspectPublishedHeaders(report) {
  const selected = report.requests.find(request => request.kind === 'status')?.selected ?? {};
  const results = [];
  for (const field of ['stableUrl', 'releaseUrl']) {
    const value = selected[field]; if (!value) continue;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    results.push({ source: 'projects/status.' + field, url: value, ...await curlHead(value) });
  }
  return results;
}
export async function inspectService({ baseUrl, projectId, screenId, output, probeHeaders = false }) {
  assert.match(projectId, /^[1-9]\d{0,63}$/); assert.match(screenId, /^[1-9]\d{0,63}$/);
  const base = new URL(baseUrl); assert.ok(['http:', 'https:'].includes(base.protocol));
  assert.equal(base.username, ''); assert.equal(base.password, ''); assert.equal(base.search, '');
  const ids = { projectId, screenId };
  const requests = await Promise.all(Object.entries(routes).map(async ([kind, route]) => {
    const routePath = typeof route.path === 'function' ? route.path(ids) : route.path;
    const url = new URL(routePath, base.href.endsWith('/') ? base.href : base.href + '/').href;
    const response = await curlRead(url, { method: route.method, body: route.body?.(ids) });
    const payload = response.payload, data = payload?.data;
    const selected = {};
    for (const key of ['id', 'projectId', 'screenId', 'screenName', 'screenCode', 'versionNumber', 'versionStatus', 'status', 'runtimeEnabled']) {
      if (data && Object.hasOwn(data, key)) selected[key] = typeof data[key] === 'number' && !Number.isSafeInteger(data[key]) ? 'UNSAFE_NUMERIC_ID_NOT_USED' : data[key];
    }
    for (const key of ['screenUrl', 'thumbnailUrl', 'mqttBrokerUrl', 'apiBaseUrl', 'nginxPublishUrl', 'nginxReleaseUrl', 'stableUrl', 'releaseUrl']) {
      if (data && Object.hasOwn(data, key)) selected[key] = safeUrl(data[key], base);
    }
    let ws = advertisedWebSockets(data, base);
    for (const key of ['configJson', 'jsonContent', 'snapshotJson']) {
      if (typeof data?.[key] !== 'string') continue;
      try { JSON.parse(data[key]); } catch { selected[key + 'ParseFailed'] = true; }
    }
    if (kind === 'projectScreens') {
      const records = data?.records ?? data?.list ?? data?.items ?? [];
      selected.total = data?.total ?? null; selected.returnedRecords = Array.isArray(records) ? records.length : null;
      selected.boundScreens = Array.isArray(records) ? records.map(item => ({
        screenId: String(item.screenId ?? item.id), screenName: item.screenName, screenCode: item.screenCode,
        screenUrl: safeUrl(item.screenUrl, base), thumbnailUrl: safeUrl(item.thumbnailUrl, base),
      })) : [];
      selected.targetRecords = selected.boundScreens.filter(item => item.screenId === screenId);
    }
    return { kind, method: route.method, url, httpStatus: response.httpStatus, curlExitCode: response.code,
      success: payload?.success ?? null, apiCode: payload?.code ?? null, message: payload?.message ?? null, selected,
      advertisedWebSockets: ws, error: response.error };
  }));
  const thumbnailHeads = [];
  if (probeHeaders) {
    const targets = requests.find(request => request.kind === 'projectScreens')?.selected.boundScreens
      .filter(screen => screen.thumbnailUrl && new URL(screen.thumbnailUrl).origin === base.origin).slice(0, 2) ?? [];
    for (const target of targets) thumbnailHeads.push({ screenId: target.screenId, url: target.thumbnailUrl, ...await curlHead(target.thumbnailUrl) });
  }
  const report = { scope: 'read-only service metadata; no writes, publication or MQTT messages', baseUrl: base.href, projectId, screenId, requests, thumbnailHeads,
    credentials: 'not requested, logged or persisted; raw jsonContent/configJson/snapshotJson omitted',
    browserPreflight: 'web-access CDP Chrome11323 detected; proxy connection timed out; no browser/tab operations; static curl path used',
    mqttProbe: 'NOT_RUN; first report advertised broker provenance; do not guess replacement host/port' };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), get = key => args[args.indexOf(key) + 1];
  for (const key of ['--base', '--project', '--screen', '--out']) assert.ok(args.includes(key), '缺少只读诊断参数 ' + key);
  const report = await inspectService({ baseUrl: get('--base'), projectId: get('--project'), screenId: get('--screen'), output: get('--out'), probeHeaders: args.includes('--probe-headers') });
  console.log(JSON.stringify(report, null, 2));
}
