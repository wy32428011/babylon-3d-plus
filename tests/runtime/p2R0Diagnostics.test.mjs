import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createEditorPerformanceRunSession } from '../../src/editor/runtime/editorPerformanceRunSession.ts';
import { startPlayerPerformanceSession } from '../../src/player/playerPerformanceDiagnostics.ts';

const telemetry = { frames: 0, candidateRebuilds: 0, contextSignatureBuilds: 0, diagnosticWrites: 0, lastFrameTimeMs: null, maxFrameTimeMs: null };
const sample = value => ({ sampledAt: new Date(3000).toISOString(), fps: 10,
  frameTimeMs: value, renderTimeMs: value, activeMeshesEvaluationMs: value,
  gpuFrameTimeMs: null, shaderCompilationMs: value, drawCalls: value,
  activeMeshes: 0, totalMeshes: 0, totalVertices: 0, thinInstances: 0,
  activeThinInstances: 0, estimatedActiveVertexInvocations: 0, estimatedActiveTriangleInvocations: 0,
  longTaskCount: 0, longTaskDurationMs: 0,
  gpuMaterialTotals: { doubleSidedVertexInvocations: 0, alphaTestedVertexInvocations: 0, alphaBlendedVertexInvocations: 0 },
  runtime: { modelArrayDetailedEntityCount: 0, modelArrayProxyEntityCount: 0, lastFullSyncDurationMs: 0, lastSelectionSyncDurationMs: 0, lastSelectionChangedEntityCount: 0 },
  editThinInstancePlan: { lastDurationMs: 0, entityCount: 0 } });

test('Editor 报告保留缺失计数器为 null，真实零值参与统计', () => {
  let now = 0;
  const session = createEditorPerformanceRunSession(telemetry, () => now);
  now = 3000;
  session.record(sample(null), telemetry);
  let report = JSON.parse(session.createReport());
  for (const field of ['frameTimeMs', 'renderTimeMs', 'activeMeshesEvaluationMs', 'shaderCompilationMs', 'drawCalls']) assert.equal(report.samples[0][field], null);
  assert.equal(report.summary.p95SampleFrameTimeMs, null);
  assert.equal(report.summary.maximumDrawCalls, null);
  session.record(sample(0), telemetry);
  report = JSON.parse(session.createReport());
  assert.equal(report.summary.p95SampleFrameTimeMs, 0);
  assert.equal(report.summary.maximumDrawCalls, 0);
});

test('Viewer 报告的分位与最大 Draw 排除缺失值而保留零值', () => {
  let onSample;
  const session = startPlayerPerformanceSession(true, () => ({ start: callback => { onSample = callback; }, dispose() {} }), () => {}, () => 3000);
  onSample(sample(null));
  let report = JSON.parse(session.createReport());
  assert.equal(report.samples[0].drawCalls, null);
  assert.equal(report.summary.p95SampleFrameTimeMs, null);
  assert.equal(report.summary.maximumDrawCalls, null);
  onSample(sample(0));
  report = JSON.parse(session.createReport());
  assert.equal(report.summary.p95SampleFrameTimeMs, 0);
  assert.equal(report.summary.maximumDrawCalls, 0);
  session.dispose();
});

// 执行实际 JSX；仅提供展示所需的受控快照，不替换指标归一化正文。
test('实际 Editor HUD 展示不可用，不崩溃或显示虚假零', () => {
  const hudFile = new URL('../../src/editor/panels/scene-view/ScenePerformanceHud.tsx', import.meta.url);
  const hudSource = readFileSync(hudFile, 'utf8');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(hudSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: module.exports, module, require: createRequire(hudFile) });
  const props = { showPerformanceHud: true, isPerformanceHudExpanded: true, performanceSnapshot: sample(null),
    hasStoppedPerformanceReport: false, isPerformanceRun: false };
  const html = renderToStaticMarkup(React.createElement(module.exports.ScenePerformanceHud, props));
  assert.match(html, /N\/A DC/);
  assert.match(html, /Draw Calls<\/dt><dd>N\/A/);
  assert.doesNotMatch(html, /NaN|undefined/);
  const zeroHtml = renderToStaticMarkup(React.createElement(module.exports.ScenePerformanceHud, { ...props, performanceSnapshot: sample(0) }));
  assert.match(zeroHtml, /0 DC/);
  assert.match(zeroHtml, /Draw Calls<\/dt><dd>0/);
});

test('实际 Viewer 指标 JSX 对缺失 CPU/Draw 不调用 toFixed 或渲染空值', () => {
  const file = new URL('../../src/player/PlayerApp.tsx', import.meta.url);
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const paragraphs = [];
  const visit = node => { if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'p'
    && /CPU 帧|绘制.*GPU|活动网格评估|Draw Call/.test(node.getText(ast))) paragraphs.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  assert.equal(paragraphs.length, 4);
  for (const paragraph of paragraphs) {
    const expression = ts.transpileModule('result = (' + paragraph.getText(ast) + ');', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
    const context = { React, performanceSnapshot: sample(null), formatPlayerStatusFps: String, result: null };
    runInNewContext(expression, context);
    assert.match(renderToStaticMarkup(context.result), /不可用/);
    context.performanceSnapshot = { ...sample(0), gpuFrameTimeMs: 0 };
    runInNewContext(expression, context);
    assert.doesNotMatch(renderToStaticMarkup(context.result), /不可用|NaN|undefined/);
  }
});
