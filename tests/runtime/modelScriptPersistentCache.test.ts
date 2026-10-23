import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { configureModelScriptPersistentCache, ModelScriptCompiler, MODEL_SCRIPT_COMPILATION_CACHE_VERSION, precompileModelScriptFile } from '../../electron/ipc/modelScriptCompiler.ts';
import { ModelScriptPersistentCache, openModelScriptPersistentCache, type ModelScriptCacheKey } from '../../electron/ipc/modelScriptPersistentCache.ts';

const source = 'export default class RuntimeComponent { width: number = 2; onStart() { this.width += 1; } }';
const key = Buffer.alloc(32, 7);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const identity = (compilerVersion: string, text = source): ModelScriptCacheKey => ({ sourceSha256: digest(text), compilerVersion,
  compilationVersion: MODEL_SCRIPT_COMPILATION_CACHE_VERSION });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-script-persistent-'));
  const cache = new ModelScriptPersistentCache(root, key);
  return { root, cache, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('两个独立 Node 进程复用认证产物，暖进程 compilerLoads 与 compilations 均为 0', async () => {
  const f = await fixture();
  try {
    const compilerUrl = pathToFileURL(path.resolve('electron/ipc/modelScriptCompiler.ts')).href;
    const cacheUrl = pathToFileURL(path.resolve('electron/ipc/modelScriptPersistentCache.ts')).href;
    const run = (warm: boolean) => {
      const script = `import {ModelScriptCompiler} from ${JSON.stringify(compilerUrl)};
        import {ModelScriptPersistentCache} from ${JSON.stringify(cacheUrl)};
        const cache = new ModelScriptPersistentCache(${JSON.stringify(f.root)}, Buffer.alloc(32, 7));
        const compiler = new ModelScriptCompiler({cache: async () => cache${warm ? ', loadCompiler: async () => { throw new Error("warm compiler must not load"); }' : ''}});
        const artifact = await compiler.precompile(${JSON.stringify(source)});
        console.log(JSON.stringify({metrics: compiler.getMetrics(), codeSha256: artifact.codeSha256}));`;
      const result = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim()) as { metrics: { compilations: number; compilerLoads: number; persistentHits: number }; codeSha256: string };
    };
    const cold = run(false), warm = run(true);
    assert.equal(cold.metrics.compilations, 1);
    assert.equal(warm.metrics.compilations, 0);
    assert.equal(warm.metrics.compilerLoads, 0);
    assert.equal(warm.metrics.persistentHits, 1);
    assert.equal(cold.codeSha256, warm.codeSha256);
  } finally { await f.dispose(); }
});

test('重算 codeSha256 的篡改产物、外来密钥和未知内容/版本均不能命中', async () => {
  const f = await fixture();
  try {
    const artifact = await new ModelScriptCompiler({ cache: async () => f.cache }).precompile(source);
    const id = identity(artifact.compilerVersion);
    const [filename] = (await readdir(f.root)).filter(name => name.endsWith('.json'));
    const envelope = JSON.parse(await readFile(path.join(f.root, filename), 'utf8'));
    envelope.artifact.code = 'globalThis.compromised = true;';
    envelope.artifact.codeSha256 = digest(envelope.artifact.code);
    await writeFile(path.join(f.root, filename), JSON.stringify(envelope));
    assert.equal(await f.cache.read(id), undefined);
    await f.cache.write(id, artifact);
    assert.equal(await new ModelScriptPersistentCache(f.root, Buffer.alloc(32, 8)).read(id), undefined);
    assert.equal(await f.cache.read({ ...id, sourceSha256: digest(source + ' ') }), undefined);
    assert.equal(await f.cache.read({ ...id, compilerVersion: 'future-version' }), undefined);
    assert.equal(await f.cache.read({ ...id, compilationVersion: 'future-preprocess' }), undefined);
    const repaired = await new ModelScriptCompiler({ cache: async () => f.cache }).precompile(source);
    assert.deepEqual(repaired, artifact);
  } finally { await f.dispose(); }
});

test('同源并发仅编译一次，单等待者取消、编译器加载失败和持久层失败均可恢复', async () => {
  const f = await fixture();
  try {
    let loads = 0;
    const compiler = new ModelScriptCompiler({ cache: async () => f.cache, loadCompiler: async () => {
      loads++;
      if (loads === 1) throw new Error('compiler unavailable');
      return import('typescript');
    } });
    await assert.rejects(compiler.precompile(source), /compiler unavailable/);
    const controller = new AbortController();
    const cancelled = compiler.precompile(source, controller.signal);
    const active = compiler.precompile(source);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.ok((await active).code.length > 0);
    assert.equal(loads, 2);
    assert.equal(compiler.getMetrics().compilations, 1);
    assert.equal(compiler.getMetrics().inFlight, 0);
    const unavailable = new ModelScriptCompiler({ cache: async () => { throw new Error('disk unavailable'); } });
    assert.ok((await unavailable.precompile(source)).code.length > 0);
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
    await assert.rejects(compiler.precompile(source, alreadyCancelled.signal), { name: 'AbortError' });
  } finally { await f.dispose(); }
});

test('并发完整写入可读，容量/过期/遗留 temp 清理不删除密钥或其它文件', async () => {
  const f = await fixture();
  try {
    let now = Date.now();
    const cache = new ModelScriptPersistentCache(f.root, key, { maxEntries: 2, now: () => now, ttlMs: 1000 });
    const artifacts = await Promise.all([source, source + '\n//two', source + '\n//three'].map(text => new ModelScriptCompiler().precompile(text)));
    const id = identity(artifacts[0].compilerVersion);
    await Promise.all([cache.write(id, artifacts[0]), new ModelScriptPersistentCache(f.root, key).write(id, artifacts[0])]);
    assert.deepEqual(await cache.read(id), artifacts[0]);
    for (let i = 1; i < artifacts.length; i++) { now += 10; await cache.write(identity(artifacts[i].compilerVersion, [source, source + '\n//two', source + '\n//three'][i]), artifacts[i]); }
    assert.equal((await readdir(f.root)).filter(name => name.endsWith('.json')).length, 2);
    await writeFile(path.join(f.root, 'authentication.key'), 'keep');
    await writeFile(path.join(f.root, 'unrelated.json'), 'keep');
    const temporary = path.join(f.root, 'a'.repeat(64) + '.' + 'b'.repeat(32) + '.tmp');
    await writeFile(temporary, 'interrupted');
    const old = new Date(now - 2 * 60 * 60 * 1000); await utimes(temporary, old, old);
    now += 2000; await cache.trim();
    assert.equal((await readdir(f.root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 0);
    assert.ok(!(await readdir(f.root)).includes(path.basename(temporary)));
    await cache.clear();
    assert.equal(await readFile(path.join(f.root, 'authentication.key'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(f.root, 'unrelated.json'), 'utf8'), 'keep');
  } finally { await f.dispose(); }
});

test('密钥保护器跨打开保持认证，保护失败不产生可执行缓存', async () => {
  const f = await fixture();
  try {
    const protection = { protect: (bytes: Buffer) => Buffer.concat([Buffer.from('protected:'), bytes]),
      unprotect: (bytes: Buffer) => { assert.equal(bytes.subarray(0, 10).toString(), 'protected:'); return bytes.subarray(10); } };
    const [first, concurrent] = await Promise.all([openModelScriptPersistentCache(f.root, protection), openModelScriptPersistentCache(f.root, protection)]);
    const artifact = await new ModelScriptCompiler({ cache: async () => first }).precompile(source);
    assert.deepEqual(await concurrent.read(identity(artifact.compilerVersion)), artifact);
    const second = await openModelScriptPersistentCache(f.root, protection);
    assert.deepEqual(await second.read(identity(artifact.compilerVersion)), artifact);
    await assert.rejects(openModelScriptPersistentCache(f.root, { ...protection, unprotect: () => { throw new Error('key unavailable'); } }), /key unavailable/);
  } finally { await f.dispose(); }
});

test('磁盘字节上限阻止超预算存储，破损 JSON 可由原源码重新编译覆盖', async () => {
  const f = await fixture();
  try {
    const artifact = await new ModelScriptCompiler().precompile(source);
    const id = identity(artifact.compilerVersion);
    const tiny = new ModelScriptPersistentCache(f.root, key, { maxBytes: 1 });
    await tiny.write(id, artifact);
    assert.equal((await readdir(f.root)).length, 0);
    await f.cache.write(id, artifact);
    const [filename] = (await readdir(f.root)).filter(name => name.endsWith('.json'));
    await writeFile(path.join(f.root, filename), '{broken');
    const compiler = new ModelScriptCompiler({ cache: async () => f.cache });
    assert.deepEqual(await compiler.precompile(source), artifact);
    assert.equal(compiler.getMetrics().compilations, 1);
    assert.deepEqual(await f.cache.read(id), artifact);
  } finally { await f.dispose(); }
});

test('暖缓存仍必须重读原 TS：修改、非法 UTF-8 与文件删除不会被旧路径缓存掩盖', async () => {
  const f = await fixture();
  try {
    configureModelScriptPersistentCache(f.root, { protect: bytes => bytes, unprotect: bytes => bytes });
    const filename = path.join(f.root, 'authorized.model.ts');
    await writeFile(filename, source);
    const first = await precompileModelScriptFile(filename);
    await writeFile(filename, source + '\n//changed-authorized-source');
    const second = await precompileModelScriptFile(filename);
    assert.notEqual(first.sourceFileSha256, second.sourceFileSha256);
    assert.notEqual(first.sourceSha256, second.sourceSha256);
    await writeFile(filename, Buffer.from([0xff, 0xfe, 0xff]));
    await assert.rejects(precompileModelScriptFile(filename), /UTF-8/);
    await rm(filename);
    await assert.rejects(precompileModelScriptFile(filename), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});
