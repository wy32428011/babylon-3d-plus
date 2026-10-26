import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const source = await fs.readFile(new URL('../../electron/ipc/dataPlatformImageSync.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('dataPlatformImageSync.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
// 只替换外部I/O依赖；运行真实分页、同步事务、索引合并与原子rename，不加载Electron或访问网络。
function createApi(request, downloads = async () => { throw new Error('unexpected image download'); }, authorized = [], oldShortPageStop = false) {
  let body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast).replace(/^export\s+/, '')).join('\n');
  if (oldShortPageStop) {
    // 明确标记的内存错误变体：只重新加入本次已报告的旧<200终止规则，不冒称旧HEAD实跑。
    const changed = body.replace('if (received === total) return records;',
      'if (page.records.length < IMAGE_QUERY_PAGE_SIZE || received === total) return records;');
    assert.ok(changed !== body, '旧终止错误变体未准确应用'); body = changed;
  }
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('BrowserWindow', 'randomUUID', 'closeSync', 'openSync', 'readSync', 'fs', 'path', 'readUtf8File',
    'authorizeAssetFile', 'encodeAssetUrl', 'getProjectImagesRoot', 'assertPathInside', 'requestDataPlatformJson', 'downloadRemoteFile',
    code + '\nreturn {queryAllIcons,startDataPlatformImageSync,getLatestDataPlatformImageSyncProgress,wait:()=>activeImageSync?.promise};')(
    { getAllWindows: () => [] }, randomUUID, closeSync, openSync, readSync, fs, path, file => fs.readFile(file, 'utf8'),
    file => authorized.push(file), file => 'editor-asset://local/' + encodeURIComponent(file), directory => path.join(directory, 'Assets', 'Images'),
    (directory, file) => { const relative = path.relative(path.resolve(directory), path.resolve(file)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); },
    request, downloads);
}
const record = index => ({ id: (90071992547410000n + BigInt(index)).toString(), iconKey: 'icon_' + index, iconName: '图标 ' + index,
  iconType: 'IMAGE', iconSource: 'CUSTOM', status: 'ACTIVE', updatedAt: '2026-10-25T00:00:00', iconUrl: '/api/v1/files/icon-' + index + '.png' });
function catalog(count = 201, { size = 100, metadata = true, change = () => {} } = {}) {
  const rows = Array.from({ length: count }, (_, index) => record(index)), calls = [];
  const request = async options => {
    calls.push(options);
    assert.equal(options.baseUrl, 'http://catalog.invalid');
    assert.equal(options.endpointPath, 'api/v1/bigscreen-icons/query');
    assert.deepEqual(Object.keys(options.body).sort(), ['iconSource', 'pageNum', 'pageSize']);
    assert.equal(options.body.pageSize, 200); assert.equal(options.body.iconSource, 'CUSTOM');
    assert.equal(options.timeoutMs, 20000);
    const pageNum = options.body.pageNum;
    const data = { records: rows.slice((pageNum - 1) * size, pageNum * size).map(value => ({ ...value })), total: count,
      ...(metadata ? { pageNum, pageSize: size } : {}) };
    const payload = { success: true, data }; change({ payload, data, pageNum, rows }); return payload;
  };
  return { rows, calls, request, api: createApi(request) };
}
const query = fixture => fixture.api.queryAllIcons('http://catalog.invalid', new AbortController().signal);

test('真实100 clamp按raw total完整取201，旧200及缺page字段shape均兼容且大ID不变', async () => {
  for (const options of [{ size: 100 }, { size: 200 }, { size: 100, metadata: false }, { size: 200, metadata: false },
    { size: 100, change({ data }) { data.total = String(data.total); data.pageNum = String(data.pageNum); data.pageSize = String(data.pageSize); } }]) {
    const f = catalog(201, options), result = await query(f);
    assert.deepEqual(result.map(value => value.id), f.rows.map(value => value.id));
    assert.deepEqual(f.calls.map(value => value.body.pageNum), options.size === 100 ? [1, 2, 3] : [1, 2]);
    assert.ok(result.every(value => typeof value.id === 'string'));
  }
});

test('过滤非图片/BUILTIN/删除项不改变raw分页计数，末尾图片不能漏掉', async () => {
  const f = catalog(201, { change({ data }) {
    for (const value of data.records) if (value.iconKey !== 'icon_200') value.iconType = 'FONT';
  } });
  assert.deepEqual((await query(f)).map(value => value.iconKey), ['icon_200']);
  assert.equal(f.calls.length, 3);
});

test('只有明确total0和空records是真空目录，缺total/失败/缺data不伪装空成功', async () => {
  assert.deepEqual(await query(catalog(0)), []);
  for (const change of [({ data }) => { delete data.total; }, ({ payload }) => { payload.success = false; payload.message = 'declared failure'; },
    ({ payload }) => { delete payload.data; }, ({ data }) => { data.total = 1; }]) {
    await assert.rejects(query(catalog(0, { change })));
  }
  for (const total of [-1, 1.5, 'bad', null, true, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(query(catalog(0, { change({ data }) { data.total = total; } })), /total/);
});

const invalidCatalogs = [
  ['duplicate-id', ({ data, pageNum }) => { if (pageNum === 2) data.records[0].id = record(0).id; }, /重复 ID/],
  ['duplicate-icon-key', ({ data, pageNum }) => { if (pageNum === 2) data.records[0].iconKey = 'icon_0'; }, /重复 iconKey/],
  ['wrong-page', ({ data, pageNum }) => { if (pageNum === 2) data.pageNum = 1; }, /页号/],
  ['total-drift', ({ data, pageNum }) => { if (pageNum === 2) data.total = 202; }, /total.*漂移/],
  ['capacity-drift', ({ data, pageNum }) => { if (pageNum === 2) data.pageSize = 200; }, /pageSize.*漂移/],
  ['early-empty', ({ data, pageNum }) => { if (pageNum === 2) data.records = []; }, /为空/],
  ['early-short', ({ data, pageNum }) => { if (pageNum === 2) data.records.pop(); }, /记录数不符/],
];
test('重复ID/key、页号/total/容量漂移、提前空/短页都有明确失败', async () => {
  for (const [name, change, pattern] of invalidCatalogs) await assert.rejects(query(catalog(201, { change })), pattern, name);
  for (const size of [0, 50, 201, 'bad', null]) await assert.rejects(query(catalog(201, { change({ data }) { data.pageSize = size; } })), /容量|pageSize/);
  await assert.rejects(query(catalog(201, { change({ data }) { data.records.push(record(1000)); } })), /记录数不符/);
  await assert.rejects(query(catalog(201, { change({ data, rows }) { data.records = rows; data.pageSize = 200; } })), /records.*超过/);
});

test('20k原始记录旧容量边界可完成，超过记录/100页上限或取消时停止请求', async () => {
  const maximum = catalog(20000, { size: 200 }); assert.equal((await query(maximum)).length, 20000); assert.equal(maximum.calls.length, 100);
  const tooMany = catalog(20001); await assert.rejects(query(tooMany), /20000/); assert.equal(tooMany.calls.length, 1);
  const pages = catalog(10001); await assert.rejects(query(pages), /100.*页/); assert.ok(pages.calls.length <= 100);
  const controller = new AbortController(), canceled = catalog(); controller.abort(new Error('controlled catalog cancel'));
  await assert.rejects(canceled.api.queryAllIcons('http://catalog.invalid', controller.signal), /controlled catalog cancel/); assert.equal(canceled.calls.length, 0);
  const late = new AbortController(), during = catalog(1, { change() { late.abort(new Error('late cancel')); } });
  await assert.rejects(during.api.queryAllIcons('http://catalog.invalid', late.signal), /late cancel/);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=', 'base64');
async function cacheFixture(t, change = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-image-pagination-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('phase2-image-pagination-')); await fs.rm(root, { recursive: true, force: true }); });
  const image = path.join(root, 'Assets', 'Images', 'icon_0.png'), index = path.join(root, '.babylon-editor', 'synced-images.json');
  await fs.mkdir(path.dirname(image), { recursive: true }); await fs.mkdir(path.dirname(index)); await fs.writeFile(image, png);
  const previous = Buffer.from(JSON.stringify({ version: 1, images: [{ id: '1', iconKey: 'icon_0', name: 'previous', updatedAt: 'old', fileName: 'icon_0.png',
    filePath: image, sourceUrl: 'editor-asset://local/' + encodeURIComponent(image), reference: 'editor-image://platform/icon_0' }] }));
  await fs.writeFile(index, previous);
  const f = catalog(201, { change }), downloads = [], authorized = [];
  const api = createApi(f.request, async options => { downloads.push(options); await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
    await fs.writeFile(options.destinationPath, png); return { contentType: 'image/png' }; }, authorized);
  return { ...f, api, root, image, index, previous, downloads, authorized };
}

test('真实同步入口分页错误在index/stage/下载前失败，旧索引和旧图片逐byte保留', async t => {
  for (const [name, change, pattern] of invalidCatalogs) {
    const f = await cacheFixture(t, change);
    assert.equal(f.api.startDataPlatformImageSync('http://catalog.invalid', f.root), true); await f.api.wait();
    const progress = f.api.getLatestDataPlatformImageSyncProgress();
    assert.equal(progress.phase, 'failed', name); assert.match(progress.error, pattern);
    assert.deepEqual(await fs.readFile(f.index), f.previous); assert.deepEqual(await fs.readFile(f.image), png);
    assert.deepEqual(await fs.readdir(path.dirname(f.index)), ['synced-images.json']);
    assert.equal(f.downloads.length, 0); assert.equal(f.authorized.length, 0);
  }
});

test('真实同步入口成功201项才原子提交version1索引，保留旧schema且只授权精确下载文件', async t => {
  const f = await cacheFixture(t);
  assert.equal(f.api.startDataPlatformImageSync('http://catalog.invalid', f.root), true); await f.api.wait();
  assert.equal(f.api.getLatestDataPlatformImageSyncProgress().phase, 'completed');
  const index = JSON.parse(await fs.readFile(f.index, 'utf8'));
  assert.equal(index.version, 1); assert.equal(index.images.length, 201);
  assert.deepEqual(index.images.map(value => value.id).sort(), f.rows.map(value => value.id).sort());
  assert.equal(f.downloads.length, 201); assert.equal(f.authorized.length, 201);
  assert.ok(f.authorized.every(file => path.dirname(file) === path.join(f.root, 'Assets', 'Images')));
  assert.deepEqual(await fs.readdir(path.dirname(f.index)), ['synced-images.json']);
});

test('相同201项输入下重加旧<200终止规则会漏101项，现全量oracle明确排除该错误变体', async () => {
  const old = catalog(); old.api = createApi(old.request, undefined, [], true);
  const truncated = await query(old);
  assert.equal(truncated.length, 100); assert.equal(old.calls.length, 1);
  const current = catalog(), complete = await query(current);
  assert.equal(complete.length, 201); assert.equal(current.calls.length, 3);
  assert.notEqual(truncated.length, complete.length);
});
