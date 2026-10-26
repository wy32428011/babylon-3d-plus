import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';
const entries = ['/src/editor/panels/LightingBakeManagerOverview.tsx', '/src/editor/model/SceneDocument.ts', '/electron/shared/sceneLightingConfig.ts'];
const modules = await createP4SsrTestModules(entries); test.after(() => modules.close());
const { LightingBakeManagerOverview } = await modules.ssrLoadModule(entries[0]);
const { createEmptySceneDocument } = await modules.ssrLoadModule(entries[1]);
const { getSceneLightingConfig, getSceneAppearanceConfig } = await modules.ssrLoadModule(entries[2]);
function render(profile) {
  const scene = createEmptySceneDocument();
  return renderToStaticMarkup(createElement(LightingBakeManagerOverview, { scene, lighting: getSceneLightingConfig(scene),
    appearance: getSceneAppearanceConfig(scene), gpuProfile: profile, result: null, resultLabel: '未烘焙', disabled: false, dirty: false,
    previewDraftActive: false, previewDraftSuppressed: false, previewDraftRules: false, preflightBusy: false, engineStatus: null,
    engineStatusLoading: false, preview: null, debug: false, comparison: false, motionPreview: false, busy: false,
    onLightingChange() {}, onAppearanceChange() {}, onPreset() {}, onConfigureEngine() {}, onRefreshDevices() {}, onPreviewDraft() {},
    onCheck() {}, onDebug() {}, onComparison() {}, onMotion() {}, onRefresh() {} }));
}
test('总览显示仅建议/未校准范围，原画质控件继续存在', () => {
  const measured = render({ status: 'measured', tier: 'T0', source: 'cache', driver: { renderer: 'Intel UHD630' }, measurement: { medianMs: 2, p95Ms: 3 } });
  for (const value of ['本机图形能力', 'T0', '已读取本机缓存', 'Intel UHD630', 'CPU 提交与同步等待', '不是 GPU 计时器或整场景帧率', '尚未跨显卡校准', '当前设置未作任何调整', '启用阴影', '烘焙质量', '烘焙计算设备']) assert.ok(measured.includes(value), value);
  const unavailable = render({ status: 'unavailable', tier: null, reason: '没有DOM', driver: null, measurement: null });
  assert.match(unavailable, /本机检测不可用/); assert.doesNotMatch(unavailable, /建议档位[^<]*T0|已完成本机检测/);
  assert.match(render(null), /尚无本机检测结果/);
});
test('profile读取沿原poll和runtime forward只调用只读getter，不新增prepare或分类调用点', () => {
  const hook = ts.createSourceFile('hook.ts', readFileSync('src/editor/panels/scene-view/useSceneLightingPreview.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const effects = []; function visit(node) { if (ts.isCallExpression(node) && node.expression.getText(hook) === 'useEffect' && node.getText(hook).includes('setLightingGpuCapabilityProfile')) effects.push(node); ts.forEachChild(node, visit); } visit(hook);
  assert.equal(effects.length, 1); const body = effects[0].getText(hook);
  assert.match(body, /getGpuCapabilityProfile/); assert.doesNotMatch(body, /prepareGpuCapabilityProfile/);
  const guarded = []; function guard(node) { if (ts.isIfStatement(node) && node.expression.getText(hook) === 'lightingManagerOpen' && node.thenStatement.getText(hook).includes('getGpuCapabilityProfile')) guarded.push(node); ts.forEachChild(node, guard); } guard(effects[0]);
  assert.equal(guarded.length, 1, 'profile只在已有manager-open poll分支读取');
  const classifications = []; function count(node) { if (ts.isCallExpression(node) && node.expression.getText(hook).endsWith('.getLightingClassification')) classifications.push(node); ts.forEachChild(node, count); } count(hook);
  assert.equal(classifications.length, 1, '保持R1之前仅一个完整分类调用点，不新增');
  const runtime = ts.createSourceFile('runtime.ts', readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  let forward; function find(node) { if (ts.isMethodDeclaration(node) && node.name.getText(runtime) === 'getGpuCapabilityProfile') forward = node; ts.forEachChild(node, find); } find(runtime);
  assert.ok(forward); assert.doesNotMatch(forward.getText(runtime), /prepareGpu|readiness|getLightingClassification/);
});
