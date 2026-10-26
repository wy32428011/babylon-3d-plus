import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import unzipper from 'unzipper';
import ts from 'typescript';
import { encodeLightingLightmapMips } from '../../electron/shared/sceneLightingLightmapMips.ts';
import { collectLightingMipArchiveStorePaths, applyLightingMipArchiveStore } from '../../electron/ipc/lightingMipArchiveStore.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packagerSources = await Promise.all(['digitalTwinDistPackage', 'digitalTwinSourcePackage'].map(async name => {
  const source = await fs.readFile(new URL('../../electron/ipc/' + name + '.ts', import.meta.url), 'utf8');
  return { name, source, ast: ts.createSourceFile(name + '.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}));
const fsSource = await fs.readFile(new URL('../../electron/ipc/deploymentExportFileSystem.ts', import.meta.url), 'utf8');
const fsAst = ts.createSourceFile('deploymentExportFileSystem.ts', fsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function functionText(ast, name) {
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, '真实产品函数不存在：' + name);
  return declaration.getText(ast).replace(/^export\s+/, '');
}
function archiveWriter(packager, directoryCalls) {
  class ObservedArchive extends ZipArchive {
    directory(...args) { directoryCalls.push({ argumentCount: args.length, callback: typeof args[2] === 'function' }); return super.directory(...args); }
  }
  const guard = packager.name === 'digitalTwinDistPackage'
    ? functionText(fsAst, 'createDeploymentExportAbortError') + '\n' + functionText(fsAst, 'throwIfDeploymentExportAborted')
    : functionText(packager.ast, 'throwIfAborted');
  const code = ts.transpileModule(guard + '\n' + functionText(packager.ast, 'archiveDirectoryContents'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // 直接执行真实私有writer及取消guard，仅注入Node/archiver依赖；不替换归档逻辑。
  return new Function('createWriteStream', 'ZipArchive', 'applyLightingMipArchiveStore', code + '\nreturn archiveDirectoryContents;')(
    createWriteStream, ObservedArchive, applyLightingMipArchiveStore);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-mip-archive-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('phase2-mip-archive-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const staging = path.join(root, 'staging'), relative = 'Assets/LightingBakes/task/lightmap-0.bin';
  await fs.mkdir(path.dirname(path.join(staging, relative)), { recursive: true });
  const width = 256, height = 256, textureBytes = width * height * 5;
  const bytes = encodeLightingLightmapMips({ baseEncoding: 'rgbm', rgbmRange: 1, maxTextureBytes: textureBytes,
    levels: [{ width, height, rgba: new Uint8Array(width * height * 4) },
      { width: width / 2, height: height / 2, rgba: new Uint8Array(width * height) }] });
  await fs.writeFile(path.join(staging, relative), bytes);
  await fs.writeFile(path.join(staging, 'ordinary.bin'), Buffer.alloc(4096, 17));
  await fs.writeFile(path.join(staging, 'ordinary.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=', 'base64'));
  const asset = { id: 'atlas', kind: 'lightmap', encoding: 'rgbm-linear-mips-v1', url: '../' + relative,
    sha256: sha(bytes), byteLength: bytes.length, rgbmRange: 1, width, height, levelCount: 2, textureBytes };
  const file = { version: 6, scene: { sceneSettings: { lighting: { version: 3, bake: { maxTextureMiB: 16 }, result: { assets: [asset] } } } } };
  const entries = value => [{ relativePath: 'Scenes/current.scene.json', content: JSON.stringify(value) }];
  const collect = value => collectLightingMipArchiveStorePaths(staging, entries(value ?? file), new AbortController().signal);
  return { root, staging, relative, bytes, asset, file, entries, collect };
}

test('只选择清单/SHA/容器实读全部通过的mip文件，旧bin和无mip旧场景不改变', async t => {
  const f = await fixture(t), paths = await f.collect();
  assert.deepEqual([...paths], [f.relative]);
  const old = { version: 6, scene: { sceneSettings: { lighting: { version: 2, result: { assets: [] } } } } };
  assert.equal((await f.collect(old)).size, 0);
  const data = { name: 'ordinary.bin', type: 'file' };
  assert.equal(applyLightingMipArchiveStore(data, paths), data);
  assert.equal(applyLightingMipArchiveStore({ name: f.relative, type: 'file' }, paths).store, true);
});

test('SOURCE/DIST实际使用的editor-asset虚拟URL按archive根解析，不能当本机绝对路径', async t => {
  const f = await fixture(t);
  f.asset.url = 'editor-asset://local/' + encodeURIComponent(f.relative);
  assert.deepEqual([...(await f.collect())], [f.relative]);
  const distPath = 'project/assets/lighting-bakes/lightmap-0.bin';
  await fs.mkdir(path.dirname(path.join(f.staging, distPath)), { recursive: true });
  await fs.writeFile(path.join(f.staging, distPath), f.bytes);
  f.asset.url = 'editor-asset://local/' + encodeURIComponent(distPath);
  const entries = [{ relativePath: 'project/scene.json', content: JSON.stringify(f.file) }];
  assert.deepEqual([...(await collectLightingMipArchiveStorePaths(f.staging, entries, new AbortController().signal))], [distPath]);
  f.asset.url = 'editor-asset://local/' + encodeURIComponent('F:/private/lightmap.bin');
  await assert.rejects(f.collect(), /路径无效/);
});

test('新mip资产坏SHA/大小/header/版本/路径/白名单和预先取消均拒绝', async t => {
  const f = await fixture(t);
  const mutate = callback => { const file = structuredClone(f.file); callback(file.scene.sceneSettings.lighting); return file; };
  for (const file of [
    mutate(lighting => { lighting.version = 2; }),
    mutate(lighting => { lighting.result.assets[0].sha256 = '0'.repeat(64); }),
    mutate(lighting => { delete lighting.result.assets[0].sha256; }),
    mutate(lighting => { lighting.result.assets[0].byteLength++; }),
    mutate(lighting => { lighting.result.assets[0].levelCount++; }),
    mutate(lighting => { lighting.result.assets[0].kind = 'probes'; }),
    mutate(lighting => { lighting.result.assets[0].url = 'https://external.invalid/asset.bin'; }),
    mutate(lighting => { lighting.result.assets[0].url += '?file=private'; }),
    mutate(lighting => { lighting.result.assets[0].url = '../%2e%2e/%2e%2e/private.bin'; }),
  ]) await assert.rejects(f.collect(file));
  const controller = new AbortController(); controller.abort(new Error('user-cancel'));
  await assert.rejects(collectLightingMipArchiveStorePaths(f.staging, f.entries(f.file), controller.signal), /user-cancel/);
  const bad = f.bytes.slice(); bad[0] ^= 1; await fs.writeFile(path.join(f.staging, f.relative), bad);
  f.asset.sha256 = sha(bad); // 排除SHA先失败，独立证明容器门仍生效。
  await assert.rejects(f.collect(), /容器无效/);
});

test('真实ZIP的高重复mip为STORE且完整字节不变，普通bin继续DEFLATE', async t => {
  const f = await fixture(t), paths = await f.collect(), target = path.join(f.root, 'actual.zip');
  const archive = new ZipArchive({ zlib: { level: 9 } }), output = createWriteStream(target, { flags: 'wx' });
  archive.on('error', error => output.destroy(error)); archive.pipe(output);
  const completion = once(output, 'close');
  archive.directory(f.staging, false, entry => applyLightingMipArchiveStore(entry, paths));
  await archive.finalize(); await completion;
  const zip = await unzipper.Open.file(target), mip = zip.files.find(file => file.path === f.relative);
  const ordinary = zip.files.find(file => file.path === 'ordinary.bin');
  assert.equal(mip.compressionMethod, 0); assert.equal(mip.compressedSize, mip.uncompressedSize);
  assert.deepEqual(await mip.buffer(), Buffer.from(f.bytes));
  assert.equal(ordinary.compressionMethod, 8); assert.deepEqual(await ordinary.buffer(), Buffer.alloc(4096, 17));
});

test('不可信长度不能先诱发超出场景预算的大型readFile分配', async t => {
  const f = await fixture(t), size = 20 * 1024 * 1024;
  await fs.truncate(path.join(f.staging, f.relative), size); f.asset.byteLength = size;
  await assert.rejects(f.collect(), /有界读取预算/);
});

test('无mip旧场景有效的#名称不经过新增严格路径门，空STORE不改变原entry对象', async t => {
  const f = await fixture(t);
  const old = JSON.stringify({ version: 6, scene: { id: 'legacy', name: '旧场景 #1', entityIds: [], entities: {},
    sceneSettings: { lighting: { version: 2, bake: { enabled: false }, result: null } } } });
  const entries = [{ relativePath: 'Scenes/旧场景 #1.scene.json', content: old }];
  const paths = await collectLightingMipArchiveStorePaths(f.staging, entries, new AbortController().signal);
  assert.equal(paths.size, 0);
  const entry = { name: f.relative, type: 'file', store: false };
  assert.ok(applyLightingMipArchiveStore(entry, paths) === entry);
  await fs.mkdir(path.join(f.staging, 'Scenes'));
  await fs.writeFile(path.join(f.staging, entries[0].relativePath), old);
  for (const packager of packagerSources) {
    const writer = archiveWriter(packager, []), zipPath = path.join(f.root, packager.name + '-legacy-name.zip');
    await writer(f.staging, zipPath, new AbortController().signal, paths);
    const saved = (await unzipper.Open.file(zipPath)).files.find(file => file.path === entries[0].relativePath);
    assert.ok(saved); assert.equal(saved.compressionMethod, 8); assert.equal((await saved.buffer()).toString('utf8'), old);
  }
  await assert.rejects(collectLightingMipArchiveStorePaths(f.staging,
    [{ relativePath: 'Scenes/scene#1.scene.json', content: JSON.stringify(f.file) }], new AbortController().signal), /场景路径无效/);
});

test('实际case生成STORE键，Windows不同引用大小写仍与ZIP目录条目一致', async t => {
  const f = await fixture(t);
  const reference = process.platform === 'win32' ? f.relative.toLowerCase() : f.relative;
  f.asset.url = 'editor-asset://local/' + encodeURIComponent(reference);
  const paths = await f.collect();
  assert.deepEqual([...paths], [f.relative]);
  const calls = [], writer = archiveWriter(packagerSources[0], calls), target = path.join(f.root, 'case.zip');
  await writer(f.staging, target, new AbortController().signal, paths);
  const zip = await unzipper.Open.file(target);
  assert.equal(zip.files.find(file => file.path === f.relative).compressionMethod, 0);
});

test('根内及根外中间junction/symlink均拒绝，不能让别名绕过精确文件集合', async t => {
  const f = await fixture(t);
  for (const internal of [true, false]) {
    const directory = internal ? path.join(f.staging, 'Assets') : path.join(f.root, 'outside-owned');
    if (!internal) { await fs.mkdir(path.join(directory, 'LightingBakes/task'), { recursive: true }); await fs.writeFile(path.join(directory, 'LightingBakes/task/lightmap-0.bin'), f.bytes); }
    const alias = path.join(f.staging, internal ? 'internal-alias' : 'external-alias');
    await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    f.asset.url = 'editor-asset://local/' + encodeURIComponent(path.basename(alias) + '/LightingBakes/task/lightmap-0.bin');
    await assert.rejects(f.collect(), /链接/);
  }
});

test('多个逻辑mip资产合计按实际全链RGBA预算拒绝，不能只过逐文件预算', async t => {
  const f = await fixture(t);
  f.file.scene.sceneSettings.lighting.result.assets = Array.from({ length: 52 }, (_, index) => ({ ...f.asset, id: 'atlas-' + index }));
  await assert.rejects(f.collect(), /纹理总量超过场景预算/);
});

for (const packager of packagerSources) {
  test(`${packager.name}真实私有ZIP writer仅新mip STORE，空集合保持原directory调用和DEFLATE`, async t => {
    const f = await fixture(t), paths = await f.collect(), calls = [], writer = archiveWriter(packager, calls);
    const storedZip = path.join(f.root, packager.name + '-store.zip');
    await writer(f.staging, storedZip, new AbortController().signal, paths);
    let zip = await unzipper.Open.file(storedZip);
    const mip = zip.files.find(file => file.path === f.relative);
    assert.equal(mip.compressionMethod, 0); assert.equal(mip.compressedSize, mip.uncompressedSize);
    assert.deepEqual(await mip.buffer(), Buffer.from(f.bytes));
    for (const name of ['ordinary.bin', 'ordinary.png']) assert.equal(zip.files.find(file => file.path === name).compressionMethod, 8);
    const defaultZip = path.join(f.root, packager.name + '-default.zip');
    await writer(f.staging, defaultZip, new AbortController().signal, new Set());
    zip = await unzipper.Open.file(defaultZip);
    assert.equal(zip.files.find(file => file.path === f.relative).compressionMethod, 8, '不能按bin/magic推断STORE');
    assert.deepEqual(calls, [{ argumentCount: 3, callback: true }, { argumentCount: 2, callback: false }]);
    const abort = new AbortController(); abort.abort();
    const canceled = path.join(f.root, packager.name + '-cancel.zip');
    await assert.rejects(writer(f.staging, canceled, abort.signal, paths), { name: 'AbortError' });
    await assert.rejects(fs.stat(canceled), { code: 'ENOENT' });
  });
}

test('两packager从prepared/portable内容collect；DIST两次归档含预算fallback复用同一set', () => {
  for (const packager of packagerSources) {
    const calls = [], collections = [];
    function walk(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'archiveDirectoryContents') calls.push(node);
        if (node.expression.text === 'collectLightingMipArchiveStorePaths') collections.push(node);
      }
      ts.forEachChild(node, walk);
    }
    walk(packager.ast);
    assert.equal(collections.length, 1);
    assert.equal(calls.length, packager.name === 'digitalTwinDistPackage' ? 2 : 1);
    const collector = collections[0], declaration = collector.parent?.parent;
    assert.ok(ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name));
    const setName = declaration.name.text;
    for (const call of calls) { assert.equal(call.arguments.length, 4); assert.equal(call.arguments[3].getText(packager.ast), setName); }
    const prepared = collector.arguments[1].getText(packager.ast);
    assert.match(prepared, packager.name === 'digitalTwinDistPackage' ? /prepared\.sceneContent/ : /scene\.portableContent/);
    assert.ok(collector.pos < calls[0].pos && calls.every(call => call.pos > collector.end));
  }
});

test('DIST真实ZIP预算回退块移除sidecar后仍以同一已验证集合STORE，不降低接收上限', async t => {
  const f = await fixture(t), packager = packagerSources[0], paths = await f.collect(), calls = [];
  const writer = archiveWriter(packager, calls), signal = new AbortController().signal;
  const baseline = path.join(f.root, 'baseline.zip');
  await writer(f.staging, baseline, signal, paths);
  const maxPackageBytes = (await fs.stat(baseline)).size;
  const sidecarPath = 'sidecar.js.gz';
  const sidecar = Buffer.concat(Array.from({ length: 1024 }, (_, index) => createHash('sha256').update('transport-' + index).digest()));
  await fs.writeFile(path.join(f.staging, sidecarPath), sidecar);
  const archivePath = path.join(f.root, 'fallback.zip');
  await writer(f.staging, archivePath, signal, paths);
  assert.ok((await fs.stat(archivePath)).size > maxPackageBytes);
  let fallback;
  function visit(node) {
    if (ts.isIfStatement(node) && /stat\.size\s*>\s*maxPackageBytes/.test(node.expression.getText(packager.ast))
      && node.expression.getText(packager.ast).includes('precompression')) fallback = node;
    ts.forEachChild(node, visit);
  }
  visit(packager.ast); assert.ok(fallback);
  const code = ts.transpileModule('async function run(){let stat=await fs.stat(archivePath);let zipBudgetFallback=false;'
    + fallback.getText(packager.ast) + ';return {stat,zipBudgetFallback};}', {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const baselineEntries = (await unzipper.Open.file(baseline)).files;
  const budget = { originalBytes: baselineEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
    originalFiles: baselineEntries.filter(entry => entry.type === 'File').length, originalEntries: baselineEntries.length };
  const prepared = { warnings: [] }, precompression = { files: [{ path: sidecarPath }], budget };
  const forwardedSets = [];
  const recordedWriter = async (...args) => { forwardedSets.push(args[3]); return writer(...args); };
  // 执行实际fallback控制块与真实ZIP writer；这里只提供已准备场景之后的上下文，不冒充完整mip格式入口。
  const run = new Function('fs', 'options', 'prepared', 'precompression', 'maxPackageBytes', 'stagingRoot', 'archivePath',
    'storedLightmaps', 'archiveDirectoryContents', 'resolveDeploymentDestination', 'throwIfDeploymentExportAborted', code + '\nreturn run;')(
    fs, { signal }, prepared, precompression, maxPackageBytes, f.staging, archivePath, paths, recordedWriter,
    (root, relative) => path.join(root, relative), abort => abort.throwIfAborted());
  const result = await run();
  assert.equal(result.zipBudgetFallback, true); assert.ok(result.stat.size <= maxPackageBytes);
  assert.ok(forwardedSets.length === 1 && forwardedSets[0] === paths, '预算回退必须复用同一精确集合');
  await assert.rejects(fs.stat(path.join(f.staging, sidecarPath)), { code: 'ENOENT' });
  const zip = await unzipper.Open.file(archivePath);
  const mip = zip.files.find(file => file.path === f.relative);
  assert.equal(mip.compressionMethod, 0); assert.deepEqual(await mip.buffer(), Buffer.from(f.bytes));
  assert.equal(zip.files.find(file => file.path === 'ordinary.bin').compressionMethod, 8);
  assert.equal(zip.files.some(file => file.path === sidecarPath), false);
  assert.equal(budget.finalBytes, budget.originalBytes); assert.equal(budget.finalFiles, budget.originalFiles);
  assert.equal(budget.finalEntries, budget.originalEntries);
});
