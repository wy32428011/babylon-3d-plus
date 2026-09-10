import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ModelInitializationScheduler } from '../../src/runtime/babylon/modelInitializationScheduler.ts';

const source = await readFile(new URL('../../src/runtime/babylon/ExternalModelScriptRuntime.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ExternalModelScriptRuntime.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = ast.statements.filter(node => !ts.isImportDeclaration(node)
  && !(ts.isFunctionDeclaration(node) && node.name?.text === 'loadTypeScriptCompiler'));
const executable = ts.transpileModule(statements.map(node => node.getText(ast).replace(/^export /, '')).join('\n')
  + '\n({ loadCompiledExternalModelScript, ExternalModelScriptRuntime, diagnostics: typeof getExternalModelScriptLoadDiagnostics === "function" ? getExternalModelScriptLoadDiagnostics : undefined });',
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const script = 'export default class RuntimeComponent { constructor(node) { node.script = this; } onStart() { this.started = true; } }';
const asset = { name: 'runtime.ts', sourceUrl: 'editor-asset://local/model/runtime.ts' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const compilerGate = deferred<typeof ts>();
  const requests: Array<{ url: string; resolve(value: unknown): void; settled: boolean }> = [];
  let compiles = 0;
  let failNextCompile = false;
  const compiler = { ...ts, transpileModule: (...args: Parameters<typeof ts.transpileModule>) => {
    compiles += 1;
    if (failNextCompile) { failNextCompile = false; throw new Error('临时编译失败'); }
    return ts.transpileModule(...args);
  } };
  const api = runInNewContext(executable, {
    Map, Set, Error, performance, console, BabylonCore: {}, resolveRuntimeAssetUrl: (url: string) => url,
    modelInitializationScheduler: new ModelInitializationScheduler(),
    readUtf8ResponseText: (response: any) => response.text(), loadTypeScriptCompiler: () => compilerGate.promise,
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve, settled: false })),
  });
  return { ...api, requests, compiles: () => compiles, releaseCompiler: () => compilerGate.resolve(compiler),
    failNextCompile: () => { failNextCompile = true; },
    respond(text = script, status = 200) {
      for (const request of requests) {
        if (request.settled) continue;
        request.settled = true;
        request.resolve({ ok: status === 200, status, text: async () => text });
      }
    },
  };
}

test('同版本脚本并发加载只发起一次读取，并在首次编译器等待期间只转译一次', async () => {
  const f = fixture();
  const pending = [1, 2, 3].map(() => f.loadCompiledExternalModelScript(asset, 'v1'));
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].url.includes('assetRevision=v1'));
  f.respond(); await tick();
  assert.equal(f.compiles(), 0, '编译器 barrier 尚未释放');
  f.releaseCompiler();
  const results = await Promise.all(pending);
  assert.equal(f.compiles(), 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});

test('版本 URL 不同分别读取，但同 sourceURL 与源码 hash 在途编译共用一次', async () => {
  const f = fixture();
  const first = f.loadCompiledExternalModelScript(asset, 'v1');
  f.respond(); await tick();
  const second = f.loadCompiledExternalModelScript(asset, 'v2');
  f.respond(); await tick();
  assert.equal(f.requests.length, 2);
  f.releaseCompiler();
  const results = await Promise.all([first, second]);
  assert.equal(f.compiles(), 1);
  assert.equal(results[0], results[1]);
});

test('读取失败向所有并发调用方报告，同 URL 后续读取可以重试', async () => {
  const f = fixture();
  const failed = Promise.allSettled([f.loadCompiledExternalModelScript(asset, 'v1'), f.loadCompiledExternalModelScript(asset, 'v1')]);
  f.respond('', 503);
  assert.ok((await failed).every(result => result.status === 'rejected' && /503/.test(String(result.reason))));
  assert.equal(f.requests.length, 1);
  const retry = f.loadCompiledExternalModelScript(asset, 'v1');
  assert.equal(f.requests.length, 2);
  f.respond(); f.releaseCompiler(); await retry;
  assert.equal(f.compiles(), 1);
});

test('编译失败清除在途缓存，相同源码再次请求可以重新编译', async () => {
  const f = fixture(); f.failNextCompile();
  const failed = Promise.allSettled([f.loadCompiledExternalModelScript(asset, 'v1'), f.loadCompiledExternalModelScript(asset, 'v1')]);
  f.respond(); f.releaseCompiler();
  const results = await failed;
  assert.ok(results.every(result => result.status === 'rejected' && /临时编译失败/.test(String(result.reason))));
  assert.equal(f.compiles(), 1);
  const retry = f.loadCompiledExternalModelScript(asset, 'v1'); f.respond(); await retry;
  assert.equal(f.compiles(), 2);
});

test('未版本化源码后续调用重新读取，已成功源码复用编译类，更新源码产生新编译类', async () => {
  const f = fixture(); f.releaseCompiler();
  const firstPending = f.loadCompiledExternalModelScript(asset, undefined); f.respond();
  const first = await firstPending;
  const cachedPending = f.loadCompiledExternalModelScript(asset, undefined); f.respond();
  const cached = await cachedPending;
  assert.equal(first, cached);
  assert.equal(f.requests.length, 2);
  assert.equal(f.compiles(), 1);
  const changedPending = f.loadCompiledExternalModelScript(asset, undefined);
  f.respond(script.replace('this.started = true', 'this.started = false'));
  const changed = await changedPending;
  assert.notEqual(changed.classes.default, first.classes.default);
  assert.equal(f.requests.length, 3);
  assert.equal(f.compiles(), 2);
});

test('共用编译类仍为各模型创建独立脚本实例，参数和资产编号保持实例隔离', async () => {
  const f = fixture(); const a: any = {}; const b: any = {};
  const runtimeA = new f.ExternalModelScriptRuntime(a, { assetCode: 'A', assetRevision: 'v1', scriptAssets: [asset] });
  const runtimeB = new f.ExternalModelScriptRuntime(b, { assetCode: 'B', assetRevision: 'v1', scriptAssets: [asset] });
  runtimeA.updateParameterValues({ width: 10 }); runtimeB.updateParameterValues({ width: 20 });
  const pending = Promise.all([runtimeA.start(), runtimeB.start()]);
  f.respond(); f.releaseCompiler(); await pending;
  assert.equal(f.requests.length, 1); assert.equal(f.compiles(), 1);
  assert.notEqual(a.script, b.script);
  assert.equal(a.script.constructor, b.script.constructor);
  assert.equal(a.script.assetCode, 'A'); assert.equal(b.script.assetCode, 'B');
  assert.equal(a.script.width, 10); assert.equal(b.script.width, 20);
  runtimeA.dispose(); runtimeB.dispose();
});

test('不同源码或不同 sourceURL 不能共用编译类，保持既有编译缓存身份', async () => {
  const f = fixture();
  const first = f.loadCompiledExternalModelScript(asset, 'v1'); f.respond(); await tick();
  const second = f.loadCompiledExternalModelScript(asset, 'v2');
  f.respond(script.replace('this.started = true', 'this.started = false')); await tick();
  const third = f.loadCompiledExternalModelScript({ ...asset, sourceUrl: 'editor-asset://other/runtime.ts' }, 'v1');
  f.respond(); f.releaseCompiler();
  const results = await Promise.all([first, second, third]);
  assert.equal(f.compiles(), 3);
  assert.notEqual(results[0].classes.default, results[1].classes.default);
  assert.notEqual(results[0].classes.default, results[2].classes.default);
});

test('只读诊断区分共享与实际工作，完成和失败均释放在途计数', async () => {
  const f = fixture();
  const pending = Promise.all([f.loadCompiledExternalModelScript(asset, 'v1'), f.loadCompiledExternalModelScript(asset, 'v1')]);
  assert.equal(f.diagnostics().scope, 'renderer-session');
  assert.equal(f.diagnostics().pendingReads, 1);
  assert.equal(f.diagnostics().readRequests, 1);
  assert.equal(f.diagnostics().sharedReads, 1);
  f.respond(); await tick();
  assert.equal(f.diagnostics().pendingReads, 0);
  assert.equal(f.diagnostics().pendingCompiles, 1);
  f.releaseCompiler(); await pending;
  const settled = f.diagnostics();
  assert.ok(Object.isFrozen(settled));
  assert.equal(settled.pendingCompiles, 0);
  assert.equal(settled.compileRequests, 1);
  assert.equal(settled.sharedCompiles, 1);
  assert.ok(settled.compileElapsedMs >= 0);
  const hit = f.loadCompiledExternalModelScript(asset, 'v1'); f.respond(); await hit;
  assert.equal(f.diagnostics().compiledCacheHits, 1);
  const failure = Promise.allSettled([f.loadCompiledExternalModelScript(asset, 'v2')]);
  f.respond('', 500); await failure;
  assert.equal(f.diagnostics().pendingReads, 0);
  assert.equal(f.diagnostics().pendingCompiles, 0);
});
