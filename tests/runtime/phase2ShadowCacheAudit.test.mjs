import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { PerfCounter } from '@babylonjs/core/Misc/perfCounter.js';
import { ObjectRenderer } from '@babylonjs/core/Rendering/objectRenderer.js';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { installPhase2ShadowCacheAudit } from '../../scripts/lib/phase2ShadowCacheAudit.mjs';
import { shadowCacheProtocol, shadowCacheClassificationArm, applyShadowCacheTreatment, evaluateShadowCacheCases, compareShadowCachePixels } from '../../scripts/phase2-lighting-classification-abba.mjs';

const N1_BEFORE_S2_AST = {"preparePlan":"cc1439514da08453c2839f030db388dd28c3c78d9f2a3a66c5f0951d4838024f","bindings":"64327521bef7db5e26e660f78d0a393fc7407750329452a1f5d8cfb29ef4a676","runCase":"89631f0c624e1ed9015532ec6609dc101bb25cf04cf4f58082d93235ec52898a","execute":"4e85fc6b5343abd441175b1dff3c015e6d78fcacf279260400f8c2918654c278","protocol":"1c5adbea8e17645234295da62e287d432a98cfb2b8126e509a890a5bcda818d5","scripts/lib/phase2LightingClassificationAudit.mjs":"e5ce4817d497a7dab2b09cfae28abd6d6db2a2cf865da05b1cb4edffa7c27b56","tests/runtime/phase2LightingClassificationAudit.test.mjs":"662f2b42310f75b1b022ad798107a5170cf66a838cb7d634a3f8e57cece7d98c"};

function fixture() {
  const observable = () => new Observable(), engine = { _drawCalls: new PerfCounter(), currentRenderPassId: 21 };
  let frame = 1;
  const scene = { getEngine: () => engine, getFrameId: () => frame, onBeforeRenderObservable: observable() };
  const target = { name: 'real-api-contract-target', uniqueId: 4, onBeforeRenderObservable: observable(), onAfterRenderObservable: observable(),
    _objectRenderer: { onBeforeRenderingManagerRenderObservable: observable(), onAfterRenderingManagerRenderObservable: observable(), onFastPathRenderObservable: observable() } };
  const generator = { getLight: () => ({ uniqueId: 3, name: 'fixture-light' }), getShadowMap: () => target, getShadowMapForRendering: () => target };
  const metrics = { staticRenders: 2, dynamicRenders: 1, cacheHits: 4, cacheInvalidations: 0 }, cache = { metrics };
  const shadowRuntime = { scene, primaryGenerator: generator, localGenerators: new Map(), secondaryDirectionalGenerators: new Map(), hybridCaches: new Map([[generator, cache]]),
    getHybridMetrics: () => ({ ...metrics, validationErrors: [], cachedFaces: 3, textureBytes: 100 }) };
  return { scene, engine, target, generator, shadowRuntime, metrics, nextFrame: () => { frame++; } };
}

test('installed Babylon9.12明确区分readiness通知和真实RenderingManager face/layer区间', () => {
  const readiness = ObjectRenderer.prototype._checkReadiness.toString(), render = ObjectRenderer.prototype.render.toString(), targetRender = RenderTargetTexture.prototype._renderToTarget.toString();
  assert.match(readiness, /onBeforeRenderObservable\.notifyObservers/); assert.match(readiness, /onAfterRenderObservable\.notifyObservers/);
  assert.doesNotMatch(readiness, /onBeforeRenderingManagerRenderObservable\.notifyObservers/);
  assert.match(render, /onBeforeRenderingManagerRenderObservable\.notifyObservers\(passIndex\)/);
  assert.match(render, /onAfterRenderingManagerRenderObservable\.notifyObservers\(passIndex\)/);
  assert.match(targetRender, /_objectRenderer\.render\(faceIndex\s*\+\s*layer,\s*true\)/);
});

test('真实SDK Observable/PerfCounter合同：readiness不造face，逐面draw/cache差，旧observer与counter不变', async () => {
  const f = fixture(), order = [], before = f.target._objectRenderer.onBeforeRenderingManagerRenderObservable.add(() => order.push('original-before'));
  const originalCounter = f.engine._drawCalls, originalRender = () => {}; f.target.customRenderFunction = originalRender;
  const audit = installPhase2ShadowCacheAudit({ runtime: { scene: f.scene, environment: { shadowRuntime: f.shadowRuntime } } });
  f.target.onBeforeRenderObservable.notifyObservers(0); f.target.onAfterRenderObservable.notifyObservers(0);
  assert.equal(audit.snapshot().completedFaceIntervals, 0);
  for (const face of [0, 1, 2]) { f.target._objectRenderer.onBeforeRenderingManagerRenderObservable.notifyObservers(face);
    originalCounter.addCount(3 + face, false); f.metrics.cacheHits++; f.target._objectRenderer.onAfterRenderingManagerRenderObservable.notifyObservers(face); }
  f.metrics.cacheInvalidations++; const measured = audit.sample('end');
  assert.deepEqual(measured.deltaFromInstall, { staticRenders: 0, dynamicRenders: 0, cacheHits: 3, cacheInvalidations: 1 });
  const result = audit.dispose(); assert.equal(result.completedFaceIntervals, 3); assert.deepEqual(result.faceIntervals.map(row => row.face), [0, 1, 2]);
  assert.deepEqual(result.faceIntervals.map(row => row.drawCalls), [3, 4, 5]); assert.ok(result.faceIntervals.every(row => row.cacheDelta.cacheHits === 1));
  assert.equal(f.engine._drawCalls, originalCounter); assert.equal(f.target.customRenderFunction, originalRender); assert.equal(originalCounter.current, 12);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(f.target._objectRenderer.onBeforeRenderingManagerRenderObservable.observers, [before]);
  assert.equal(f.scene.onBeforeRenderObservable.observers.length, 0); assert.equal(f.target.onBeforeRenderObservable.observers.length, 0);
  f.target._objectRenderer.onBeforeRenderingManagerRenderObservable.notifyObservers(9); assert.equal(audit.snapshot().completedFaceIntervals, 3);
  assert.deepEqual(order, ['original-before', 'original-before', 'original-before', 'original-before']);
});

test('counter reset/缺失、记录上限、target替换和中断面必须明示而非伪零；可序列化安装且幂等释放', () => {
  const f = fixture(), install = new Function('return (' + installPhase2ShadowCacheAudit.toString() + ');')(), audit = install({ scene: f.scene, shadowRuntime: f.shadowRuntime, maxRecords: 1 });
  const renderer = f.target._objectRenderer;
  renderer.onBeforeRenderingManagerRenderObservable.notifyObservers(0); f.engine._drawCalls.fetchNewFrame(); renderer.onAfterRenderingManagerRenderObservable.notifyObservers(0);
  renderer.onBeforeRenderingManagerRenderObservable.notifyObservers(1); f.engine._drawCalls.addCount(2, false); renderer.onAfterRenderingManagerRenderObservable.notifyObservers(1);
  const measured = audit.snapshot(); assert.equal(measured.faceIntervals[0].drawCalls, null); assert.equal(measured.status, 'INCOMPLETE'); assert.equal(measured.completedFaceIntervals, 2); assert.equal(measured.droppedFaceRecords, 1);
  renderer.onBeforeRenderingManagerRenderObservable.notifyObservers(2); f.shadowRuntime.primaryGenerator = null; audit.refreshTargets();
  assert.match(audit.snapshot().problems.at(-1).reason, /unmatched/); audit.dispose(); audit.dispose();
  const missing = fixture(); delete missing.engine._drawCalls;
  const second = install({ scene: missing.scene, shadowRuntime: missing.shadowRuntime });
  missing.target._objectRenderer.onBeforeRenderingManagerRenderObservable.notifyObservers(0); missing.target._objectRenderer.onAfterRenderingManagerRenderObservable.notifyObservers(0);
  assert.equal(second.snapshot().faceIntervals[0].drawCalls, null); assert.match(second.snapshot().faceIntervals[0].drawBefore.reason, /unavailable/); second.dispose();
});

test('scoped实际active窗：只两次边界getHybridMetrics，边缘/功能通知不计，精确恢复data描述符', () => {
  const f = fixture(), state = { active: null }, descriptor = Object.getOwnPropertyDescriptor(state, 'active'); let reads = 0;
  const originalMetrics = f.shadowRuntime.getHybridMetrics; f.shadowRuntime.getHybridMetrics = () => { reads++; return originalMetrics(); };
  const audit = installPhase2ShadowCacheAudit({ scene: f.scene, shadowRuntime: f.shadowRuntime, measurementScoped: true, measurementState: state, maxRecords: 65536 });
  const draw = () => { const renderer = f.target._objectRenderer; renderer.onBeforeRenderingManagerRenderObservable.notifyObservers(0); f.engine._drawCalls.addCount(3, false); f.metrics.staticRenders++; renderer.onAfterRenderingManagerRenderObservable.notifyObservers(0); };
  draw(); assert.equal(reads, 0); const active = { started: 123 }; state.active = active; assert.ok(state.active === active); draw(); state.active = null;
  draw(); assert.equal(reads, 2); const result = audit.dispose(); assert.equal(reads, 2); assert.equal(result.completedFaceIntervals, 1);
  assert.deepEqual(result.samples.map(row => row.label), ['measurement-start', 'measurement-end']); assert.equal(result.samples[1].deltaFromInstall.staticRenders, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(state, 'active'), descriptor); assert.equal(result.status, 'OBSERVED');
});

test('active诊断异常不阻断原赋值/不替换原measurement异常；descriptor新owner绝不覆盖', () => {
  const f = fixture(), state = { active: null }, originalFailure = new Error('original measurement failure');
  f.shadowRuntime.getHybridMetrics = () => { throw new Error('diagnostic failed'); };
  const audit = installPhase2ShadowCacheAudit({ scene: f.scene, shadowRuntime: f.shadowRuntime, measurementScoped: true, measurementState: state });
  const active = {};
  assert.throws(() => { state.active = active; assert.ok(state.active === active); throw originalFailure; }, error => error === originalFailure);
  assert.doesNotThrow(() => { state.active = null; }); assert.equal(audit.dispose().status, 'INCOMPLETE');
  const second = fixture(), other = { active: null }, owner = {};
  const next = installPhase2ShadowCacheAudit({ scene: second.scene, shadowRuntime: second.shadowRuntime, measurementScoped: true, measurementState: other });
  other.active = {}; Object.defineProperty(other, 'active', { value: owner, configurable: true, writable: true }); const replacement = Object.getOwnPropertyDescriptor(other, 'active');
  assert.equal(next.dispose().status, 'INCOMPLETE'); assert.deepEqual(Object.getOwnPropertyDescriptor(other, 'active'), replacement); assert.ok(other.active === owner);
});

test('S2真实owned文档处理只改cache flag；4arm分类均B，独立预算和像素契约预注册', () => {
  const original = { scene: { sceneSettings: { lighting: { shadows: { quality: 'quality', darkness: .5 }, bake: { cacheStaticShadows: true, dynamicShadows: true, enabled: false } } },
    entities: { abc: { components: { transform: { x: 1 }, parameterValues: { LED: true }, scriptFrequency: 60 } } }, mqttConfig: { enabled: false }, camera: [1, 2, 3] } };
  for (const [arm, enabled] of Object.entries({ A1: false, B1: true, B2: true, A2: false })) {
    const input = structuredClone(original), expected = structuredClone(original); expected.scene.sceneSettings.lighting.bake.cacheStaticShadows = enabled;
    assert.ok(applyShadowCacheTreatment(input, arm) === input); assert.deepEqual(input, expected); assert.equal(shadowCacheClassificationArm(arm[0]), 'B');
  }
  assert.equal(shadowCacheProtocol.maxFaceRecords, 65536); assert.equal(shadowCacheProtocol.metadataBudgetBytesPerArm, 128 * 1024 ** 2);
  assert.equal(shadowCacheProtocol.pixelContract.crossTreatmentRgbMaxDelta, 1); assert.equal(shadowCacheProtocol.pixelContract.crossTreatmentAlphaMaxDelta, 0);
});

function cases() {
  return ['A1', 'B1', 'B2', 'A2'].map(name => ({ name, arm: name[0], shadowConditionValid: true, shadowMetadataBytes: 1024,
    performance: { elapsedMs: 60000, frameIntervalsMs: Array(600).fill(100), frameQuantiles: { p95Ms: 100 } }, shadowAudit: { status: 'OBSERVED', measurementScoped: true, disposed: true, droppedFaceRecords: 0,
      initial: { raw: { unsupportedCacheReason: null, validationErrors: [] } }, configuration: { cacheStaticShadows: name[0] === 'B' },
      samples: [{ label: 'measurement-start' }, { label: 'measurement-end', deltaFromInstall: { staticRenders: name[0] === 'A' ? 100 : 0, dynamicRenders: 10, cacheHits: name[0] === 'B' ? 100 : 0, cacheInvalidations: 0 } }],
      targets: [{ observedDrawCalls: name[0] === 'A' ? 200 : 100, unavailableDrawIntervals: 0 }],
    } }));
}
test('S2未知/丢弃/无face/reset/metadata超额/自然AA不稳不能变成性能PASS，不输出N3结论', () => {
  assert.equal(evaluateShadowCacheCases(cases(), true, true).performancePass, true);
  assert.equal(evaluateShadowCacheCases(cases(), false, true).performancePass, false);
  for (const mutate of [rows => { rows[1].shadowAudit.status = 'NO_FACE_OBSERVATIONS'; }, rows => { rows[1].shadowAudit.droppedFaceRecords = 1; },
    rows => { rows[1].shadowAudit.samples[1].deltaFromInstall.staticRenders = null; }, rows => { rows[1].shadowMetadataBytes = shadowCacheProtocol.metadataBudgetBytesPerArm + 1; },
    rows => { rows[1].shadowConditionValid = false; }, rows => { rows[1].performance.frameIntervalsMs = []; }]) { const rows = cases(); mutate(rows); const result = evaluateShadowCacheCases(rows, true, true); assert.equal(result.performancePass, false); assert.equal(result.shadowEvidenceKnown, false); assert.equal(Object.hasOwn(result, 'n3'), false); }
});

test('独立单位反例：FPS吞吐翻倍可让draws/s升而每原measurement帧成本降，不能用每秒误判', () => {
  const rows = cases(); for (const row of rows.filter(row => row.arm === 'B')) { row.performance.frameIntervalsMs = Array(1200).fill(50); row.performance.frameQuantiles.p95Ms = 50; row.shadowAudit.targets[0].observedDrawCalls = 300; }
  const result = evaluateShadowCacheCases(rows, true, true); assert.equal(result.performancePass, true);
  assert.ok(result.pairs.every(pair => pair.B.drawCallsPerSecond > pair.A.drawCallsPerSecond && pair.B.drawCallsPerMeasuredFrame < pair.A.drawCallsPerMeasuredFrame && pair.A.measuredFrames === 600 && pair.B.measuredFrames === 1200));
});

test('独立完整pixel契约：只有跨A/B允许RGB1，alpha与自然AA/同treatment仍exact0', () => {
  const original = Buffer.from([10, 20, 30, 255]), one = Buffer.from([11, 20, 30, 255]), alpha = Buffer.from([10, 20, 30, 254]);
  assert.equal(compareShadowCachePixels(original, one, true).pass, true); assert.equal(compareShadowCachePixels(original, one, false).pass, false);
  assert.equal(compareShadowCachePixels(original, alpha, true).pass, false);
  const two = compareShadowCachePixels(original, Buffer.from([12, 20, 30, 255]), true); assert.equal(two.maxRgbDelta, 2); assert.equal(two.rgbOverOnePixels, 1);
});

test('S2之外默认N1函数体/协议逐AST保持，protected helper/test完整SHA保持；原56行为另独立回归', () => {
  const source = readFileSync(new URL('../../scripts/phase2-lighting-classification-abba.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('driver.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const mode = node => ts.isIdentifier(node) && node.text === 'shadowCacheMode';
  const statements = list => list.flatMap(node => { if (ts.isIfStatement(node) && mode(node.expression)) return node.elseStatement ? ts.isBlock(node.elseStatement) ? statements([...node.elseStatement.statements]) : statements([node.elseStatement]) : []; return [node]; });
  const canonical = node => { let children = [];
    if (ts.isBlock(node)) children = statements([...node.statements]); else ts.forEachChild(node, child => { children.push(child); });
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['bindings', 'runCase'].includes(node.expression.text) && mode(node.arguments.at(-1))) children = children.filter(child => child !== node.arguments.at(-1));
    return [node.kind, ts.isIdentifier(node) || ts.isLiteralExpression(node) ? node.text : null, ts.isVariableDeclarationList(node) ? node.flags : null, children.map(canonical)];
  };
  const digest = node => createHash('sha256').update(JSON.stringify(canonical(node))).digest('hex');
  for (const name of ['preparePlan', 'bindings', 'runCase', 'execute']) { const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.equal(digest(node.body), N1_BEFORE_S2_AST[name], name); }
  const protocol = tree.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(node => node.name.getText(tree) === 'protocol')); assert.equal(digest(protocol), N1_BEFORE_S2_AST.protocol);
  for (const name of ['scripts/lib/phase2LightingClassificationAudit.mjs', 'tests/runtime/phase2LightingClassificationAudit.test.mjs']) assert.equal(createHash('sha256').update(readFileSync(new URL('../../' + name, import.meta.url))).digest('hex'), N1_BEFORE_S2_AST[name]);
});
