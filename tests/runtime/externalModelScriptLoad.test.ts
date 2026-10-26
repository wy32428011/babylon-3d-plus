import { digestModelScriptText, normalizePrecompiledModelScript, prepareModelScriptCompilation } from '../../electron/shared/modelScriptCompilation.ts';
import { precompileModelScript } from '../../electron/ipc/modelScriptCompiler.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ModelInitializationScheduler } from '../../src/runtime/babylon/modelInitializationScheduler.ts';

const source = await readFile(new URL('../../src/runtime/babylon/ExternalModelScriptRuntime.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ExternalModelScriptRuntime.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements = ast.statements.filter(node => !ts.isImportDeclaration(node)
  && !(ts.isFunctionDeclaration(node) && ['loadTypeScriptCompiler', 'fetchPrecompiledModelScript'].includes(node.name?.text ?? '')));
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
function fixture(precompiled?: unknown, options: { now?: () => number; scheduler?: ModelInitializationScheduler; warn?: (...args: unknown[]) => void; resolveTexture?: (reference: string) => string | null } = {}) {
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
    Map, Set, Error, performance: options.now ? { now: options.now } : performance,
    console: options.warn ? { ...console, warn: options.warn } : console,
    fetchPrecompiledModelScript: async () => precompiled, digestModelScriptText, normalizePrecompiledModelScript, prepareModelScriptCompilation,
    resolveBabylonScriptRuntimeNamespace: async () => ({}), resolveRuntimeAssetUrl: (url: string) => url,
    resolveModelTextureAssetUrl: options.resolveTexture ?? (() => null),
    modelInitializationScheduler: options.scheduler ?? new ModelInitializationScheduler(),
    readUtf8ResponseText: (response: any) => response.text(), loadTypeScriptCompiler: () => compilerGate.promise,
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve, settled: false })), fetchRuntimeAsset: (url: string) => new Promise(resolve => requests.push({ url, resolve, settled: false })),
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
  assert.equal(f.diagnostics().initializationCount, 2);
  assert.ok(f.diagnostics().initializationQueueMs >= 0);
  assert.ok(f.diagnostics().initializationMs >= 0);
  assert.ok(f.diagnostics().maxInitializationMs >= 0);
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

test('可信资源中的预转译产物跳过 renderer TypeScript compiler，保持独立实例', async () => {
  const artifact = await precompileModelScript(script);
  const f = fixture(artifact);
  const a: any = {}; const b: any = {};
  const first = new f.ExternalModelScriptRuntime(a, { assetCode: 'A', scriptAssets: [asset] });
  const second = new f.ExternalModelScriptRuntime(b, { assetCode: 'B', scriptAssets: [asset] });
  const pending = Promise.all([first.start(), second.start()]);
  f.respond();
  await pending;
  assert.equal(f.compiles(), 0);
  assert.equal(f.diagnostics().precompiledHits, 1);
  assert.equal(f.diagnostics().compilerFallbacks, 0);
  assert.equal(a.script.started, true);
  assert.notEqual(a.script, b.script);
  assert.equal(a.script.constructor, b.script.constructor);
  first.dispose(); second.dispose();
});

test('过期或损坏 sidecar 回退原 TS，scene inline code 从不进入执行路径', async () => {
  const artifact = await precompileModelScript(script);
  const malicious = { ...artifact, code: 'throw new Error("不可信 scene code 被执行");' };
  malicious.codeSha256 = await digestModelScriptText(malicious.code);
  for (const sidecar of [undefined, { ...artifact, sourceSha256: 'a'.repeat(64) }, { ...artifact, code: '损坏代码' }]) {
    const f = fixture(sidecar); f.releaseCompiler();
    const node: any = {};
    const runtime = new f.ExternalModelScriptRuntime(node, {
      assetCode: 'safe', scriptAssets: [{ ...asset, precompiled: malicious }],
    });
    const pending = runtime.start(); f.respond(); await pending;
    assert.equal(runtime.getInitializationError(), null);
    assert.equal(node.script.started, true);
    assert.equal(f.compiles(), 1);
    assert.equal(f.diagnostics().precompiledHits, 0);
    runtime.dispose();
  }
});

type InitializationTiming = {
  stage: 'scriptConstructor' | 'scriptOnStart'; scriptAsset: typeof asset; className: string; durationMs: number; failed: boolean;
};

test('同步初始化分段排除读取等待、调度排队和参数 setter 耗时，保留原执行顺序', async () => {
  let clock = 0;
  const queued = deferred<void>(), queueGate = deferred<void>();
  const scheduler = new ModelInitializationScheduler(6, () => clock, async () => {
    queued.resolve(); await queueGate.promise;
  }, { deferFirstSlice: true });
  const f = fixture(undefined, { now: () => clock, scheduler });
  const timings: InitializationTiming[] = [];
  const node = { events: [] as string[], advance: (ms: number) => { clock += ms; } };
  const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'TIMED', scriptAssets: [asset] }, {
    onInitializationTiming: (timing: InitializationTiming) => timings.push(timing),
  });
  runtime.updateParameterValues({ width: 42 });
  const pending = runtime.start();
  try {
    clock = 50;
    f.respond(`export default class FixtureRuntime {
      constructor(node) { this.node=node; node.events.push('constructor'); node.advance(5); }
      set width(value) { this.node.events.push('width:'+value); this.node.advance(12); }
      set assetCode(value) { this.node.events.push('asset:'+value); this.node.advance(17); }
      onStart() { this.node.events.push('onStart'); this.node.advance(7); }
    }`);
    f.releaseCompiler(); await queued.promise;
    clock = 250; queueGate.resolve(); await pending;
    assert.deepEqual(node.events, ['constructor', 'width:42', 'asset:TIMED', 'onStart']);
    assert.deepEqual(timings.map(timing => [timing.stage, timing.durationMs, timing.failed, timing.className]),
      [['scriptConstructor', 5, false, 'default'], ['scriptOnStart', 7, false, 'default']]);
    assert.ok(timings.every(timing => timing.scriptAsset === asset));
    assert.equal(f.diagnostics().initializationQueueMs, 200);
    assert.equal(f.diagnostics().initializationMs, 41, '原同步总段继续包含参数 setter，不能由两个子段相加替代');
    assert.equal(runtime.getInitializationError(), null);
  } finally { queueGate.resolve(); await pending; runtime.dispose(); }
});

test('onStart getter 仅取一次并保持实例 receiver，计时包括同步 dispatch 的 getter', async () => {
  let clock = 0;
  const f = fixture(undefined, { now: () => clock });
  const timings: InitializationTiming[] = [];
  const node = { getters: 0, calls: 0, receiver: false, advance: (ms: number) => { clock += ms; } };
  const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'RECEIVER', scriptAssets: [asset] }, {
    onInitializationTiming: (timing: InitializationTiming) => timings.push(timing),
  });
  const pending = runtime.start();
  f.respond(`export default class FixtureRuntime {
    constructor(node) { this.node=node; node.script=this; }
    get onStart() { this.node.getters++; this.node.advance(2); return function() {
      this.node.calls++; this.node.receiver=this===this.node.script; this.node.advance(7);
    }; }
  }`);
  f.releaseCompiler();
  try {
    await pending;
    assert.equal(node.getters, 1); assert.equal(node.calls, 1); assert.equal(node.receiver, true);
    assert.deepEqual(timings.map(timing => [timing.stage, timing.durationMs, timing.failed]),
      [['scriptConstructor', 0, false], ['scriptOnStart', 9, false]]);
    assert.equal(runtime.getInitializationError(), null);
  } finally { runtime.dispose(); }
});

test('constructor 与 onStart 原始失败分别计时，只有已入列实例在 dispose 时执行 onStop', async () => {
  for (const phase of ['constructor', 'onStart'] as const) {
    let clock = 0;
    const warnings: unknown[][] = [];
    const f = fixture(undefined, { now: () => clock, warn: (...args) => warnings.push(args) });
    const timings: InitializationTiming[] = [];
    const node = { events: [] as string[], phase, advance: (ms: number) => { clock += ms; } };
    const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'FAIL', scriptAssets: [asset] }, {
      onInitializationTiming: (timing: InitializationTiming) => timings.push(timing),
    });
    const pending = runtime.start();
    f.respond(`export default class FixtureRuntime {
      constructor(node) { this.node=node; node.events.push('constructor'); node.advance(3);
        if(node.phase==='constructor') throw new Error('original-constructor-error'); }
      onStart() { this.node.events.push('onStart'); this.node.advance(4); throw new Error('original-onStart-error'); }
      onStop() { this.node.events.push('onStop'); }
    }`);
    f.releaseCompiler();
    await pending;
    assert.match(runtime.getInitializationError(), new RegExp('original-' + phase + '-error'));
    assert.equal(warnings.length, 1, '原异常仍通过既有容错路径记录一次');
    assert.deepEqual(timings.map(timing => [timing.stage, timing.durationMs, timing.failed]), phase === 'constructor'
      ? [['scriptConstructor', 3, true]]
      : [['scriptConstructor', 3, false], ['scriptOnStart', 4, true]]);
    runtime.dispose(); runtime.dispose();
    assert.deepEqual(node.events, phase === 'constructor' ? ['constructor'] : ['constructor', 'onStart', 'onStop']);
  }
});

test('坏诊断 sink 不破坏启动、实例释放或 constructor/onStart 原始错误', async () => {
  for (const phase of ['success', 'constructor', 'onStart'] as const) {
    const warnings: unknown[][] = [];
    const f = fixture(undefined, { warn: (...args) => warnings.push(args) });
    const node = { events: [] as string[], phase };
    const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'BAD-SINK', scriptAssets: [asset] }, {
      onInitializationTiming() { throw new Error('diagnostic-sink-error'); },
    });
    const pending = runtime.start();
    f.respond(`export default class FixtureRuntime {
      constructor(node) { this.node=node; node.events.push('constructor');
        if(node.phase==='constructor') throw new Error('original-constructor-error'); }
      onStart() { this.node.events.push('onStart'); if(this.node.phase==='onStart') throw new Error('original-onStart-error'); }
      onStop() { this.node.events.push('onStop'); }
    }`);
    f.releaseCompiler(); await pending;
    if (phase !== 'success') assert.match(runtime.getInitializationError(), new RegExp('original-' + phase + '-error'));
    else assert.equal(runtime.getInitializationError(), null);
    const failures = phase === 'constructor' ? 1 : 2;
    assert.equal(f.diagnostics().diagnosticFailures, failures);
    assert.equal(warnings.filter(args => String(args[1]).includes('diagnostic-sink-error')).length, failures);
    runtime.dispose();
    assert.deepEqual(node.events, phase === 'constructor' ? ['constructor'] : ['constructor', 'onStart', 'onStop']);
  }
});

test('onStart 返回未完成 Promise 时不等待或扩大同步段，后续异步工作不重复记账', async () => {
  let clock = 0;
  const gate = deferred<void>();
  const f = fixture(undefined, { now: () => clock });
  const timings: InitializationTiming[] = [];
  const node = { events: [] as string[], gate: gate.promise, advance: (ms: number) => { clock += ms; } };
  const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'ASYNC', scriptAssets: [asset] }, {
    onInitializationTiming: (timing: InitializationTiming) => timings.push(timing),
  });
  const pending = runtime.start();
  f.respond(`export default class FixtureRuntime {
    constructor(node) { this.node=node; }
    async onStart() { this.node.events.push('before-await'); this.node.advance(7); await this.node.gate;
      this.node.events.push('after-await'); this.node.advance(100); }
  }`);
  f.releaseCompiler();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([pending.then(() => 'settled'), new Promise(resolve => {
      timer = setTimeout(() => resolve('waiting-onStart'), 1000);
    })]);
    assert.equal(outcome, 'settled', '原 start 合同不等待脚本返回的 Promise');
    assert.deepEqual(node.events, ['before-await']);
    assert.deepEqual(timings.map(timing => [timing.stage, timing.durationMs, timing.failed]),
      [['scriptConstructor', 0, false], ['scriptOnStart', 7, false]]);
    gate.resolve(); await tick();
    assert.deepEqual(node.events, ['before-await', 'after-await']);
    assert.equal(timings.length, 2);
  } finally { clearTimeout(timer); gate.resolve(); await pending; runtime.dispose(); }
});

test('队列中已 dispose 的脚本保持取消语义，不产生虚构 constructor/onStart 分段', async () => {
  const queued = deferred<void>(), gate = deferred<void>();
  const scheduler = new ModelInitializationScheduler(6, undefined, async () => {
    queued.resolve(); await gate.promise;
  }, { deferFirstSlice: true });
  const f = fixture(undefined, { scheduler });
  const timings: InitializationTiming[] = [];
  const node: { script?: unknown } = {};
  const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'CANCEL', scriptAssets: [asset] }, {
    onInitializationTiming: (timing: InitializationTiming) => timings.push(timing),
  });
  const pending = runtime.start(); f.respond(); f.releaseCompiler();
  await queued.promise; runtime.dispose(); gate.resolve(); await pending;
  assert.equal(node.script, undefined); assert.equal(timings.length, 0);
  assert.equal(f.diagnostics().cancelledInitializations, 1);
  assert.equal(runtime.getInitializationError(), null);
});

test('贴图参数使用已恢复缓存URL，未登记逻辑图片明确失败而不把未知协议交给脚本', async () => {
  for (const registered of [true, false]) {
    const localUrl = 'editor-asset://local/cache/logo.png';
    const f = fixture(undefined, { resolveTexture: () => registered ? localUrl : null, warn: () => {} });
    const node: { value?: string; started?: boolean } = {};
    const runtime = new f.ExternalModelScriptRuntime(node, { assetCode: 'IMAGE', scriptAssets: [asset],
      parameterConfig: { parameters: [{ key: 'logo', type: 'texture' }] } });
    runtime.updateParameterValues({ logo: 'editor-image://platform/logo' });
    const pending = runtime.start();
    f.respond('export default class Runtime { constructor(node){this.node=node;} onStart(){this.node.started=true;this.node.value=this.logo;} }');
    f.releaseCompiler(); await pending;
    if (registered) { assert.equal(node.value, localUrl); assert.equal(runtime.getInitializationError(), null); }
    else { assert.equal(node.started, undefined); assert.match(runtime.getInitializationError(), /图片未登记/); }
    runtime.dispose();
  }
});
