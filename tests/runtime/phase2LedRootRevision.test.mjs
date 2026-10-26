import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as B from '@babylonjs/core';
import { compileAsset } from '../../scripts/phase2-asset-revisions.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('LED真实方法研究oracle保留Proxy descriptor反例并停止采用，不用收益覆盖语义门', {
  skip: !process.env.PHASE2_LED_ROOT_ARTIFACT_DIR && '须显式提供独立owned研究目录，不修改原LED或现有修订工具',
}, async () => {
  const output = path.resolve(process.env.PHASE2_LED_ROOT_ARTIFACT_DIR);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  const originalBytes = await fs.readFile(manifest.original.file), candidateBytes = await fs.readFile(manifest.candidate.file);
  assert.equal(sha(originalBytes), manifest.original.sha256); assert.equal(sha(candidateBytes), manifest.candidate.sha256);
  const Original = compileAsset(originalBytes.toString('utf8')).classes.ParametricModelRuntimeComponent;
  const Candidate = compileAsset(candidateBytes.toString('utf8')).classes.ParametricModelRuntimeComponent;
  const cases = [];
  const scenario = (name, configure) => {
    const engine = new B.NullEngine(), scene = new B.Scene(engine), labels = new Map(), restores = [];
    let events = [];
    const emit = text => events.push(text);
    const create = name => { const node = new B.TransformNode(name, scene); labels.set(node, name); return node; };
    const own = (object, key, descriptor) => {
      const original = Object.getOwnPropertyDescriptor(object, key);
      Object.defineProperty(object, key, { configurable: true, ...descriptor });
      restores.push(() => { if (original) Object.defineProperty(object, key, original); else delete object[key]; });
    };
    try {
      const root = create('asset-root'), first = create('LED2.first'), second = create('node0.second'), foreign = create('foreign');
      first.parent = root; second.parent = root;
      const original = new Original(root), candidate = new Candidate(root);
      const state = configure({ scene, root, first, second, foreign, original, candidate, create, own, emit, labels }) ?? {};
      const invoke = instance => {
        events = []; state.before?.(); let value, error;
        try { value = state.call ? state.call(instance) : instance.resolveLedContentRoot(); } catch (caught) { error = caught; }
        return { value, error, events: [...events] };
      };
      const left = invoke(original), right = invoke(candidate);
      const row = { name, sameNodeIdentity: left.value === right.value, sameErrorIdentity: left.error === right.error,
        originalNode: labels.get(left.value) ?? null, candidateNode: labels.get(right.value) ?? null,
        originalError: left.error?.message ?? null, candidateError: right.error?.message ?? null,
        originalEvents: left.events, candidateEvents: right.events, sameEvents: isDeepStrictEqual(left.events, right.events) };
      row.semanticPass = row.sameNodeIdentity && row.sameErrorIdentity && row.sameEvents; cases.push(row);
      state.cleanup?.();
    } finally { for (const restore of restores.reverse()) restore(); scene.dispose(); engine.dispose(); }
  };
  scenario('native-first-match-order-and-duplicate', ({ scene, first }) => {
    scene.transformNodes.push(first); return { cleanup: () => scene.transformNodes.pop() };
  });
  scenario('root-renamed-to-led', ({ root }) => { root.name = 'LED2.root'; });
  scenario('first-root-renamed-between-calls', ({ first }) => { first.name = 'other-name'; });
  scenario('reparent-before-call', ({ root, first, foreign }) => { first.parent = foreign; foreign.parent = root; });
  scenario('unparent-delete-add', ({ root, first, second, create }) => {
    first.parent = null; second.dispose(); const later = create('node0.new'); later.parent = root;
  });
  scenario('foreign-name-getter-not-observed-by-original', ({ foreign, own, emit }) => {
    own(foreign, 'name', { get() { emit('foreign.name'); return 'LED2.foreign'; } });
  });
  scenario('descendant-name-getter-after-first-match', ({ root, foreign, own, emit }) => {
    foreign.parent = root; own(foreign, 'name', { get() { emit('late-descendant.name'); return 'LED2.late'; } });
  });
  scenario('foreign-descendant-method-mutates-earlier-name', ({ first, foreign, own, emit }) => {
    own(foreign, 'isDescendantOf', { value() { emit('foreign.descendant'); first.name = 'LED2.changed-by-event'; return false; } });
    return { before: () => { first.name = 'other-before-event'; } };
  });
  scenario('foreign-descendant-getter', ({ foreign, own, emit }) => {
    own(foreign, 'isDescendantOf', { get() { emit('foreign.descendant-getter'); return () => false; } });
  });
  scenario('foreign-parent-getter', ({ root, foreign, own, emit }) => {
    own(foreign, 'parent', { get() { emit('foreign.parent'); return root; } });
  });
  scenario('foreign-parent-outside-scene-directory', ({ root, first, create, own, emit, scene }) => {
    const ancestor = create('not-in-transform-directory'); first.parent = ancestor;
    const index = scene.transformNodes.indexOf(ancestor); scene.transformNodes.splice(index, 1);
    own(ancestor, 'parent', { get() { emit('ancestor.parent'); return root; } });
    return { cleanup: () => { scene.transformNodes.push(ancestor); } };
  });
  scenario('scene-array-getter-once', ({ scene, own, emit }) => {
    const nodes = scene.transformNodes;
    own(scene, 'transformNodes', { get() { emit('scene.transformNodes'); return nodes; } });
  });
  scenario('custom-root-getScene-once', ({ root, scene, own, emit }) => {
    own(root, 'getScene', { value() { emit('root.getScene'); return scene; } });
  });
  scenario('custom-getModelNodes-getter', ({ foreign, original, candidate, own, emit }) => {
    foreign.name = 'LED2.override';
    for (const instance of [original, candidate]) own(instance, 'getModelNodes', { get() {
      emit('runtime.getModelNodes'); return () => { emit('runtime.getModelNodes-call'); return [foreign]; };
    } });
  });
  scenario('root-name-getter-read-order', ({ root, own, emit }) => {
    let reads = 0;
    own(root, 'name', { get() { emit('root.name#' + ++reads); return reads === 1 ? 'not-led-yet' : 'LED2.now'; } });
    return { before: () => { reads = 0; } };
  });
  scenario('early-matching-node-getter-return-read', ({ root, foreign, original, candidate, own, emit }) => {
    root.name = 'LED2.early'; let reads = 0;
    for (const instance of [original, candidate]) own(instance, 'node', { get() { emit('runtime.node#' + ++reads); return reads === 1 ? root : foreign; } });
    return { before: () => { reads = 0; } };
  });
  scenario('foreign-error-object-preserved', ({ foreign, own, emit }) => {
    const sentinel = new Error('intentional-foreign-error');
    own(foreign, 'isDescendantOf', { value() { emit('throw-sentinel'); throw sentinel; } });
  });
  scenario('proxy-descriptor-trap-counterexample', ({ scene, foreign, emit, labels }) => {
    const index = scene.transformNodes.indexOf(foreign);
    const proxy = new Proxy(foreign, {
      getOwnPropertyDescriptor(target, key) { emit('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key, receiver) { if (['name', 'parent', '_parentNode', 'isDescendantOf'].includes(String(key))) emit('get:' + String(key)); return Reflect.get(target, key, receiver); },
    });
    labels.set(proxy, 'foreign-proxy'); scene.transformNodes[index] = proxy;
    return { cleanup: () => { scene.transformNodes[index] = foreign; } };
  });
  const native = cases.filter(row => row.name !== 'proxy-descriptor-trap-counterexample');
  const proxy = cases.find(row => row.name === 'proxy-descriptor-trap-counterexample');
  const report = { status: cases.every(row => row.semanticPass) ? 'SEMANTIC_PASS_NOT_PERFORMANCE_TESTED' : 'STOP_CONTRACT_COUNTEREXAMPLE',
    scope: 'actual original/candidate compiled LED methods and Babylon NullEngine nodes; no scroll/paint/matrix/lifecycle rewrite, no GPU or timing benchmark',
    cases, nativeGuardFixturePassCount: native.filter(row => row.semanticPass).length, nativeGuardFixtureCount: native.length,
    semanticPass: cases.every(row => row.semanticPass), adopted: false, benchmarkBlocksExecuted: 0,
    stopReason: 'Proxy descriptor traps are new observations introduced by protocol introspection; fallback after observing a trap cannot erase it. Do not assume all scene nodes are pure or remove the case.',
    originalAssetUnchanged: sha(await fs.readFile(manifest.source)) === manifest.sourceSha256,
    originalFrozenUnchanged: sha(await fs.readFile(manifest.original.file)) === manifest.original.sha256,
    candidateFrozenUnchanged: sha(await fs.readFile(manifest.candidate.file)) === manifest.candidate.sha256,
    sources: manifest };
  await fs.writeFile(path.join(output, 'semantic-oracle.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const row of native) assert.equal(row.semanticPass, true, row.name + '：' + JSON.stringify(row));
  assert.equal(proxy.sameNodeIdentity, true); assert.equal(proxy.sameErrorIdentity, true);
  assert.equal(proxy.sameEvents, false, '反例不能被排除或改成原生节点假设以通过');
  assert.equal(report.status, 'STOP_CONTRACT_COUNTEREXAMPLE');
  assert.ok(report.originalAssetUnchanged && report.originalFrozenUnchanged && report.candidateFrozenUnchanged);
  console.log(JSON.stringify({ status: report.status, nativeFixtures: native.length, nativePassed: report.nativeGuardFixturePassCount,
    semanticPass: report.semanticPass, adopted: false, benchmarkBlocksExecuted: 0 }));
});
