import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, createWriteStream, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ZipArchive } from 'archiver';
import unzipper from 'unzipper';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { binaryFixture, geometryFixture } from '../lightingBake/lightingGeometryBinaryFixture.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { precompressDeploymentFiles } = await import('../../electron/ipc/deploymentPrecompression.ts');
const { decodeLightingGeometryBinary } = await import('../../electron/shared/sceneLightingBakeGeometryBinary.ts');
const { createDeploymentReleaseCacheManifest } = await import('../../electron/ipc/deploymentReleaseCacheManifest.ts');
test.after(() => hooks.deregister());
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-precompression-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('dist-precompression-')); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(files)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); }
  const manifest = await createDeploymentReleaseCacheManifest(root, 'fixture-r1', new AbortController().signal);
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(path.join(root, 'release-cache-manifest.json'), manifestBytes);
  const snapshot = await tree(root);
  return { root, manifest, manifestBytes, snapshot };
}
async function tree(root) {
  const result = {};
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else { const bytes = await fs.readFile(file); result[path.relative(root, file).replaceAll('\\', '/')] = { size: bytes.length, sha256: sha(bytes) }; } } }
  await walk(root); return result;
}
const repeated = 'const resource = "原始字节不变";\n'.repeat(2048);
async function checkOriginals(f) { const now = await tree(f.root); for (const [file, expected] of Object.entries(f.snapshot)) assert.deepEqual(now[file], expected, file); assert.deepEqual(await fs.readFile(path.join(f.root, 'release-cache-manifest.json')), f.manifestBytes); }

test('静态JS/CSS/JSON/WASM生成更小br/gzip，原文/完整清单SHA与revision不变', async t => {
  const f = await fixture(t, { 'assets/main.js': repeated, 'assets/main.css': '.box{color:#fff}\n'.repeat(4096), 'project/scene.json': JSON.stringify({ rows: Array(1000).fill({ name: '场景', visible: true }) }), 'project/assets/GI几何.json': JSON.stringify({ positions: Array(4096).fill(0.123) }), 'decoders/decoder.wasm': Buffer.concat([Buffer.from([0,97,115,109]), Buffer.alloc(65536, 65)]), 'runtime-config.json': repeated, 'published-cache-worker.js': repeated, 'README.md': repeated, 'image.png': Buffer.alloc(4096, 1) });
  const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal);
  assert.equal(result.files.length, 10); assert.equal(result.budget.originalFiles, Object.keys(f.snapshot).length);
  assert.equal(result.budget.originalBytes, Object.values(f.snapshot).reduce((n, row) => n + row.size, 0));
  assert.equal(result.budget.finalFiles, result.budget.originalFiles + 10);
  for (const file of result.files) { const original = await fs.readFile(path.join(f.root, file.sourcePath)), encoded = await fs.readFile(path.join(f.root, file.path)); assert.ok(encoded.length < original.length); assert.deepEqual(file.encoding === 'br' ? brotliDecompressSync(encoded) : gunzipSync(encoded), original); assert.equal(file.size, encoded.length); }
  assert.ok(result.files.every(file => !/runtime-config|release-cache-manifest|published-cache-worker|README/.test(file.path)));
  assert.equal(f.manifest.cacheRevision, 'fixture-r1'); await checkOriginals(f);
});

test('B7有效binary几何生成无损侧车，原始SHA/清单保持且预算不足时只跳过侧车', async t => {
  const geometry = { ...geometryFixture, indices: Array.from({ length: 4096 }, () => [0, 1, 2]).flat() };
  const bytes = binaryFixture(geometry);
  assert.equal(decodeLightingGeometryBinary(bytes).geometry.indices.length, geometry.indices.length);
  for (const limited of [false, true]) {
    const f = await fixture(t, { 'project/assets/几何.bin': bytes });
    const originalBytes = Object.values(f.snapshot).reduce((n, row) => n + row.size, 0);
    const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal,
      limited ? { maxUnpackedBytes: originalBytes + 1 } : {});
    if (limited) {
      assert.equal(result.files.length, 0); assert.equal(result.skipped.filter(x => x.reason === 'byte-budget').length, 2);
      assert.deepEqual(await tree(f.root), f.snapshot);
    } else {
      assert.deepEqual(result.files.map(x => x.encoding), ['br', 'gzip']);
      for (const file of result.files) {
        const encoded = await fs.readFile(path.join(f.root, file.path));
        const restored = file.encoding === 'br' ? brotliDecompressSync(encoded) : gunzipSync(encoded);
        assert.ok(encoded.length < bytes.length); assert.deepEqual(restored, Buffer.from(bytes));
        assert.equal(sha(restored), sha(bytes));
        assert.deepEqual(Array.from(decodeLightingGeometryBinary(restored).geometry.indices), geometry.indices);
      }
      assert.ok(f.manifest.files.every(file => !/\.(?:br|gz)$/.test(file.path)));
    }
    await checkOriginals(f);
  }
});

test('URL编码中文、空格、#、%路径还原一次，输出对应真实文件而非编码文件名', async t => {
  const f = await fixture(t, { 'project/assets/模型 #1%/几何%2F #.json': repeated });
  const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal);
  assert.deepEqual(result.files.map(x => x.path), ['project/assets/模型 #1%/几何%2F #.json.br', 'project/assets/模型 #1%/几何%2F #.json.gz']); await checkOriginals(f);
});

test('小于压缩头的文件保留原文，不写膨胀侧车', async t => {
  const f = await fixture(t, { 'tiny.json': '{}', 'empty.js': '' });
  const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal);
  assert.equal(result.files.length, 0); assert.equal(result.skipped.filter(x => x.reason === 'not-smaller').length, 4); assert.deepEqual(await tree(f.root), f.snapshot);
});

test('原包已超过receiver字节或文件预算时只跳过侧车，不增加原业务硬失败', async t => {
  for (const kind of ['bytes', 'files']) {
    const f = await fixture(t, { 'large.js': repeated, 'runtime-config.json': repeated });
    const originalBytes = Object.values(f.snapshot).reduce((n, row) => n + row.size, 0);
    const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal, kind === 'bytes' ? { maxUnpackedBytes: originalBytes - 1 } : { maxFiles: Object.keys(f.snapshot).length - 1 });
    assert.equal(result.files.length, 0); assert.equal(result.budget.originalExceedsLimit, true); assert.ok(result.diagnostics.some(x => /原包/.test(x))); assert.deepEqual(await tree(f.root), f.snapshot);
  }
});

test('原控制文件和清单都计入预算；仅余一个file slot时确定性保留首个br', async t => {
  const f = await fixture(t, { 'a.js': repeated, 'runtime-config.json': repeated, 'README.md': repeated });
  const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal, { maxFiles: Object.keys(f.snapshot).length + 1 });
  assert.deepEqual(result.files.map(x => x.path), ['a.js.br']); assert.equal(result.budget.finalFiles, result.budget.originalFiles + 1); assert.equal(result.skipped.filter(x => x.reason === 'file-budget').length, 1); await checkOriginals(f);
});

test('receiver字节余量不足时不纳入侧车，原文件不受影响', async t => {
  const f = await fixture(t, { 'a.js': repeated }); const originalBytes = Object.values(f.snapshot).reduce((n, row) => n + row.size, 0);
  const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal, { maxUnpackedBytes: originalBytes + 1 });
  assert.equal(result.files.length, 0); assert.equal(result.skipped.filter(x => x.reason === 'byte-budget').length, 2); assert.deepEqual(await tree(f.root), f.snapshot);
});

test('原包同名侧车或目录不得覆盖；可选冲突跳过并诊断，不阻断既有原包', async t => {
  for (const directory of [false, true]) {
    const f = await fixture(t, { 'a.js': repeated, 'b.json': repeated }); const collision = path.join(f.root, 'b.json.gz');
    if (directory) await fs.mkdir(collision); else await fs.writeFile(collision, '既有侧车');
    const before = await tree(f.root); const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal); const after = await tree(f.root); for (const [name, bytes] of Object.entries(before)) assert.deepEqual(after[name], bytes); assert.equal(result.files.some(x => x.path === 'b.json.gz'), false); assert.ok(result.skipped.some(x => x.path === 'b.json.gz' && x.reason === 'existing-path')); assert.ok(result.diagnostics.some(x => x.includes('existing-path')));
  }
});

test('重复或越界清单在写入前拒绝，不能触达stage以外', async t => {
  for (const invalid of ['../outside.js', '%2e%2e/outside.js', 'assets%2Fescape.js', 'C%3A/escape.js', 'assets/%5Cescape.js']) {
    const f = await fixture(t, { 'a.js': repeated }); f.manifest.files.push({ ...f.manifest.files[0], path: invalid });
    await assert.rejects(precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal), /路径|越界/); assert.deepEqual(await tree(f.root), f.snapshot);
  }
  const f = await fixture(t, { 'a.js': repeated }); f.manifest.files.push({ ...f.manifest.files[0] });
  await assert.rejects(precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal), /重复|冲突/); assert.deepEqual(await tree(f.root), f.snapshot);
});

test('原文在清单生成后改变时SHA失败，排空并回收其他并发临时文件', async t => {
  const f = await fixture(t, { 'a.js': repeated, 'b.js': repeated, 'c.js': repeated });
  await fs.writeFile(path.join(f.root, 'b.js'), Buffer.alloc(Buffer.byteLength(repeated), 66)); const changed = await tree(f.root);
  await assert.rejects(precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal), /SHA|哈希|校验/); assert.deepEqual(await tree(f.root), changed);
});

test('取消压缩中或提交中任务时原子清理所有本次输出，保留原文', async t => {
  for (const phase of ['compressing', 'committing']) {
    const f = await fixture(t, { 'a.js': repeated.repeat(20), 'b.js': repeated.repeat(20), 'c.js': repeated.repeat(20) }); const controller = new AbortController();
    await assert.rejects(precompressDeploymentFiles(f.root, f.manifest, controller.signal, { onProgress(value) { if (value.phase === phase && value.completed === 1) controller.abort(); } }), { name: 'AbortError' });
    assert.deepEqual(await tree(f.root), f.snapshot);
  }
});

test('提交文件系统失败回收已提交与所有临时侧车，不留下伪成功', async t => {
  const f = await fixture(t, { 'a.js': repeated, 'b.js': repeated }); const original = fs.rename; let calls = 0;
  t.mock.method(fs, 'rename', async (...args) => { if (++calls === 2) throw new Error('fixture commit failure'); return original(...args); });
  await assert.rejects(precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal), /fixture commit failure/); assert.deepEqual(await tree(f.root), f.snapshot);
});


test('内部可调预算只能收紧，不能扩大接收端2GiB与100000文件上限', async t => {
  const f = await fixture(t, { 'a.js': repeated });
  const result = await precompressDeploymentFiles(f.root, f.manifest, new AbortController().signal, { maxUnpackedBytes: 3 * 1024 * 1024 * 1024, maxFiles: 200000 });
  assert.equal(result.budget.maxUnpackedBytes, 2 * 1024 * 1024 * 1024); assert.equal(result.budget.maxFiles, 100000); await checkOriginals(f);
});

// 模拟原清单既有扫描上限刚满、写入清单后多一个文件；不为该边界创建20万个真实文件。
test('清单落盘后盘点不叠加scanner默认200000文件硬限', () => {
  const code=`
    import {registerHooks} from 'node:module';
    import {existsSync} from 'node:fs';
    const virtual=Array.from({length:200001},()=>({sourcePath:'virtual',relativePath:'virtual',size:1,mtimeMs:0}));
    registerHooks({resolve(specifier,context,next){
      if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.includes('/electron/')) {
        const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL); if(existsSync(source))return {url:source.href,shortCircuit:true};
      }return next(specifier,context);
    },load(url,context,next){
      const loaded=next(url,context);
      if(url.endsWith('/deploymentExportFileSystem.ts')) {
        const source=String(loaded.source);
        const start=source.indexOf('export async function scanSafeSourceRoot('),body=source.indexOf('): Promise<SafeSourceFile[]> {',start);
        if(body<0)throw new Error('scanner boundary fixture missing');
        const position=body+'): Promise<SafeSourceFile[]> {'.length;
        return {...loaded,source:source.slice(0,position)+'\\n if(globalThis.__virtualRows){if(globalThis.__virtualRows.length>maxFiles)throw new Error("new-hard-limit");return globalThis.__virtualRows;}\\n'+source.slice(position)};
      }return loaded;
    }});
    const {promises:fs}=await import('node:fs');const originalReadDir=fs.readdir;fs.readdir=async(...args)=>args[0]==='virtual'?[]:originalReadDir(...args);
    globalThis.__virtualRows=virtual;
    const {precompressDeploymentFiles}=await import(${JSON.stringify(pathToFileURL(path.resolve('electron/ipc/deploymentPrecompression.ts')).href)});
    const result=await precompressDeploymentFiles('virtual',{version:1,cacheRevision:'r1',files:[],totalBytes:0},new AbortController().signal);
    if(!result.budget.originalExceedsLimit||result.budget.originalFiles!==200001||result.files.length)throw new Error('budget-contract');
    console.log('PASS');
  `;
  const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr); assert.equal(child.stdout.trim(),'PASS');
});

test('接收端ZIP条目预算包含目录与空目录，不能只用文件数扩展侧车', async t => {
  const f=await fixture(t,{'a/deep/main.js':repeated,'b/empty/.keep':'x'});
  await fs.mkdir(path.join(f.root,'extra-empty'));
  const originalDirectories=5,originalFiles=Object.keys(f.snapshot).length,maxEntries=originalFiles+originalDirectories+1;
  const result=await precompressDeploymentFiles(f.root,f.manifest,new AbortController().signal,{maxFiles:maxEntries});
  assert.equal(result.budget.originalDirectories,originalDirectories); assert.equal(result.budget.originalEntries,originalFiles+originalDirectories);
  assert.deepEqual(result.files.map(file=>file.path),['a/deep/main.js.br']);
  const zipPath=f.root+'-archive.zip';t.after(async()=>{assert.equal(path.dirname(zipPath),path.resolve(os.tmpdir()));await fs.rm(zipPath,{force:true});});
  await new Promise((resolve,reject)=>{const output=createWriteStream(zipPath),archive=new ZipArchive({zlib:{level:9}});output.once('close',resolve);output.once('error',reject);archive.once('error',reject);archive.pipe(output);archive.directory(f.root,false);void archive.finalize().catch(reject);});
  const zip=await unzipper.Open.file(zipPath);assert.equal(zip.files.length,maxEntries);assert.equal(result.budget.finalEntries,zip.files.length);
  assert.equal(result.budget.finalFiles,zip.files.filter(file=>file.type==='File').length);await checkOriginals(f);
  const over=await fixture(t,{'a/b/main.js':repeated});
  const skipped=await precompressDeploymentFiles(over.root,over.manifest,new AbortController().signal,{maxFiles:3});
  assert.equal(skipped.budget.originalFiles,2);assert.equal(skipped.budget.originalEntries,4);assert.equal(skipped.budget.originalExceedsLimit,true);assert.equal(skipped.files.length,0);await checkOriginals(over);
});

test('合法长basename用短临时名；最终侧车组件过长仅跳过，不新增原包硬失败', async t => {
  for(const length of [220,253]) {
    const name='a'.repeat(length-3)+'.js',f=await fixture(t,{[name]:repeated});
    const result=await precompressDeploymentFiles(f.root,f.manifest,new AbortController().signal);
    assert.equal(result.files.length,length===220?2:0);
    if(length===253) {assert.equal(result.skipped.filter(file=>file.reason==='path-too-long').length,2);assert.ok(result.diagnostics.some(message=>message.includes('path-too-long')));}
    await checkOriginals(f);
  }
});
