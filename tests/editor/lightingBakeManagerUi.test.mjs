import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
const temporary = await mkdtemp(path.resolve('node_modules/.lighting-manager-render-test-'));
after(async () => {
  if (path.dirname(temporary) !== path.resolve('node_modules') || !path.basename(temporary).startsWith('.lighting-manager-render-test-')) throw new Error('渲染测试临时目录不在预期范围');
  await rm(temporary, { recursive: true, force: true });
});
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { LightingBakeManagerResources } from '../../src/editor/panels/LightingBakeManagerResources.tsx'; import { LightingBakeManagerTaskTools } from '../../src/editor/panels/LightingBakeManagerTaskTools.tsx'; export const renderTools = props => renderToStaticMarkup(createElement(LightingBakeManagerTaskTools, props)); export const renderResources = props => renderToStaticMarkup(createElement(LightingBakeManagerResources, props));");
await build({ configFile: false, publicDir: false, logLevel: 'silent', build: { ssr: entry, outDir: path.join(temporary, 'ssr'), rolldownOptions: { output: { entryFileNames: 'ui.mjs' } } } });
const { renderResources, renderTools } = await import(pathToFileURL(path.join(temporary, 'ssr/ui.mjs')).href);
const props = () => ({ result: null, status: { phase: 'idle', message: null }, resultLabel: '未烘焙', busy: false, disabled: false, dirty: false,
  onCancel() {}, onClear() {}, onInspect() {}, onFocus() {}, onRule() {}, onRetry() {}, issues: [] });
test('任务页诊断按严重级别展示，并保留对象、节点、规则和资产的可操作入口', () => {
  const markup = renderResources({ ...props(), issues: [{ id: 'node-error', kind: 'missing-node', severity: 'error', message: '部件缺失',
    entityId: 'machine', entityName: '设备一', nodeKey: 'root/deck', runtimeNodeKey: 'root/current', ruleId: 'rule-one', assetId: 'asset-one', locatable: true },
    { id: 'check', kind: 'loading', severity: 'info', message: '重新检查资源', action: 'retry-preflight' }] });
  assert.match(markup, /阻止烘焙/); assert.match(markup, /提示/); assert.match(markup, /设备一/); assert.ok(markup.includes('root/deck'));
  assert.match(markup, /asset-one/); assert.match(markup, /定位部件/); assert.match(markup, /查看对象/); assert.match(markup, /查看规则/); assert.match(markup, /重新检查/);
});
test('没有可定位部件的旧例外不显示失效的定位入口', () => {
  const markup = renderResources({ ...props(), issues: [{ id: 'legacy', kind: 'legacy-override', severity: 'warning', message: '旧例外未匹配',
    entityId: 'machine', nodeKey: 'old', locatable: false }] });
  assert.match(markup, /需要处理/); assert.match(markup, /查看对象/); assert.doesNotMatch(markup, /定位部件/);
});


test('烘焙预检明确图集下界和不同内存口径，超限信息保持阻止状态', () => {
  const markup = renderTools({ preflight: { phase: 'blocked', report: { signature: 'current', meshCount: 2, receiverCount: 1, triangleCount: 24, vertexCount: 8, inputEstimate: true, atlasEstimate: true, bounds: { min: [-8, -0.3, -5], max: [8, 10, 5] },
    receiverArea: 6, geometryBytes: 1024, binaryGeometryBytes: 900, estimatedDerivedNumericBytes: 2112, probeCountExact: false, estimatedInputBytes: 4000, sourceTextureCount: 3, minAtlasCount: 1, minTextureBytes: 4194304,
    probeCount: 8000, probeLimit: 4096, issues: [{ code: 'probe-limit', severity: 'error', message: '探针超过上限' }] } },
    currentSignature: 'current', costs: null, history: null, historyError: null, disabled: false, dirty: false,
    onCheck() {}, onRefreshHistory() {}, onCleanup() {}, onReadLog() {} });
  assert.match(markup, /图集面积下界/); assert.match(markup, /几何数字数据/); assert.match(markup, /二进制输入估算/);
  assert.match(markup, /至少 8,?000/); assert.match(markup, /4096/); assert.match(markup, /探针超过上限/);
  assert.match(markup, /不能代表总内存/);
  assert.match(markup, /派生数字数据估算/); assert.match(markup, /裁切前/); assert.match(markup, /不是内存上界/);
  assert.match(markup, /探针覆盖范围（世界米）/); assert.match(markup, /X -8.00 ～ 8.00/);
  assert.match(markup, /源纹理（编码字节）/); assert.match(markup, /未测字节/);
});

test('任务历史区分恢复记录和运行任务，保留日志入口且运行中不能清理', () => {
  const task = { taskId: 'job-one', sceneName: '工厂', startedAt: '2026-10-23T00:00:00Z', status: 'interrupted',
    durationMs: 2000, stagingBytes: 3000, outputBytes: 1000, logAvailable: true, message: '进程已中断', phaseMetrics: [{ phase: 'baking', durationMs: 1800, mainRssBytes: null, mainHeapUsedBytes: null, cyclesPeakRssBytes: null }] };
  const markup = renderTools({ preflight: { phase: 'idle' }, currentSignature: 'current', costs: null,
    history: { tasks: [task, { ...task, taskId: 'job-two', status: 'baking', sceneName: '运行任务' }], totalStagingBytes: 6000 },
    historyError: null, disabled: false, dirty: false, onCheck() {}, onRefreshHistory() {}, onCleanup() {}, onReadLog() {} });
  assert.match(markup, /已中断/); assert.match(markup, /查看日志/); assert.match(markup, /清理临时文件/);
  assert.match(markup, /disabled=""[^>]*>清理临时文件/);
  assert.ok(markup.replace(/<[^>]+>/g, '').includes('未测 / 未测'), '主进程无法计量时显示未测，不伪造0字节');
});
