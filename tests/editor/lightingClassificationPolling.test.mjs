import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(open = false, entityIds = []) {
  const effects = [], intervals = new Set(), classification = [{ key: 'full' }];
  const summary = { entries: [{ key: 'selected' }], stale: true };
  const calls = { full: 0, peek: [], errors: 0, diagnostics: 0, profile: 0 };
  const state = { lightingInspectorEntityIds: entityIds, lightingManagerOpen: open, lightingManagerTab: 'objects', lightingGpuCapabilityProfile: null,
    setLightingGpuCapabilityProfile(profile) { state.lightingGpuCapabilityProfile = profile; },
    setLightingClassification(entries) { state.lightingClassification = entries; },
    setLightingBakeRuntimeError() { calls.errors++; }, setLightingRuntimeDiagnostic() { calls.diagnostics++; } };
  const store = selector => selector(state);
  store.getState = () => state;
  store.setState = patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  const runtime = {
    getGpuCapabilityProfile() { calls.profile++; return null; },
    getLightingClassification() { calls.full++; return classification; },
    peekLightingClassificationForEntities(ids) { calls.peek.push([...ids]); return summary; },
    getLightingBakeRuntimeError() { return null; }, getLightingRuntimeDiagnostic() { return null; },
  };
  const module = { exports: {} };
  const source = readFileSync(new URL('../../src/editor/panels/scene-view/useSceneLightingPreview.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require(id) {
    if (id === 'react') return { useEffect: effect => effects.push(effect), useRef: value => ({ current: value }) };
    if (id.includes('editorStore')) return { useEditorStore: store };
    if (id.includes('scenePreparationProgress')) return { isScenePreparationActive: () => false };
    throw new Error('unexpected import: ' + id);
  }, window: { setInterval(callback) { intervals.add(callback); return callback; }, clearInterval(callback) { intervals.delete(callback); } } });
  module.exports.useSceneLightingPreview({ lightingManagerOpen: open, sceneSessionId: 'session', runtimeRef: { current: runtime }, sceneDocument: {} });
  const cleanup = effects.at(-1)();
  return { calls, state, summary, classification, cleanup, intervals,
    poll() { for (const callback of intervals) callback(); } };
}

test('关闭管理器且未显示摘要时60秒轮询不收集分类，错误与诊断仍可读', () => {
  const f = fixture();
  for (let i = 0; i < 150; i++) f.poll();
  assert.equal(f.calls.full, 0);
  assert.equal(f.calls.peek.length, 0);
  assert.equal(f.calls.profile, 0);
  assert.ok(f.calls.errors >= 150 && f.calls.diagnostics >= 150);
  f.cleanup(); assert.equal(f.intervals.size, 0);
});

test('打开管理器立即收集且后续保持400ms刷新', () => {
  const f = fixture(true);
  assert.equal(f.calls.full, 1);
  assert.equal(f.state.lightingClassification, f.classification);
  assert.equal(f.calls.profile, 1);
  f.poll(); assert.equal(f.calls.full, 2); assert.equal(f.calls.profile, 2);
  f.cleanup(); f.poll(); assert.equal(f.calls.full, 2);
});

test('Inspector仅peek选中实体并呈现过期状态，不消费完整分类', () => {
  const f = fixture(false, ['chosen']);
  assert.equal(f.calls.full, 0);
  assert.deepEqual(f.calls.peek.map(ids => Array.from(ids)), [['chosen']]);
  assert.equal(f.state.lightingInspectorClassification, f.summary.entries);
  assert.equal(f.state.lightingInspectorClassificationStale, true);
  assert.equal(f.calls.profile, 0);
  f.summary.stale = false; f.poll();
  assert.equal(f.state.lightingInspectorClassificationStale, false);
  assert.equal(f.calls.full, 0);
  f.cleanup();
});
