import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const scenePanelSource = await readFile(
  new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
  'utf8',
);

test('编辑器场景准备把当前环境作为独立模型计入总数与稳定条件', () => {
  assert.match(
    scenePanelSource,
    /totalSceneModels = modelEntityIds\.length \+ \(sceneRuntimeEnvironmentExpected \? 1 : 0\)/,
  );
  assert.match(
    scenePanelSource,
    /environmentSnapshot\.phase === 'ready'[\s\S]*?environmentSnapshot\.sourceUrl === sceneRuntimeEnvironmentSourceUrl/,
  );
  assert.match(
    scenePanelSource,
    /if \(sceneRuntimeEnvironmentSourceUrl && environmentReady\) settledModels \+= 1/,
  );
  assert.match(
    scenePanelSource,
    /readyNow = settledModels >= totalSceneModels[\s\S]*?batchedEntities >= expectedBatchedEntities/,
  );
});

// 直接执行真实准备表达式；期望来自环境必须独立结算的合同，不复制产品算法。
test('环境尚无运行URL仍计总数，真实准备表达式拒绝未就绪环境或不完整合批', () => {
  const ast = ts.createSourceFile('SceneViewPanel.tsx', scenePanelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  const initializer = (name: string): string => {
    const matches = nodes.filter((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
    assert.equal(matches.length, 1, '必须唯一定位真实准备表达式：' + name);
    return matches[0].initializer!.getText(ast);
  };
  const evaluate = (expression: string, values: Record<string, unknown>): unknown => {
    const javascript = ts.transpileModule('return (' + expression + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(values), javascript)(...Object.values(values));
  };
  const expectedExpression = initializer('sceneRuntimeEnvironmentExpected');
  const totalExpression = initializer('totalSceneModels');
  const environmentExpression = initializer('environmentReady');
  const readyExpression = initializer('readyNow');
  const settlements = nodes.filter((node): node is ts.IfStatement => ts.isIfStatement(node)
    && node.expression.getText(ast) === 'sceneRuntimeEnvironmentSourceUrl && environmentReady');
  assert.equal(settlements.length, 1, '必须唯一定位真实环境结算入口');
  const settle = new Function('sceneRuntimeEnvironmentSourceUrl', 'environmentReady', 'settledModels',
    ts.transpileModule(settlements[0].getText(ast) + '; return settledModels;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  const cases = [
    { name: '无环境', declared: false, url: null, phase: 'idle', snapshotUrl: null, total: 2, environmentReady: true, settled: 2, ready: true },
    { name: '声明环境尚无URL', declared: true, url: null, phase: 'ready', snapshotUrl: null, total: 3, environmentReady: false, settled: 2, ready: false },
    { name: '旧URL不能结算新环境', declared: true, url: 'new', phase: 'ready', snapshotUrl: 'old', total: 3, environmentReady: false, settled: 2, ready: false },
    { name: 'URL匹配但尚未ready', declared: true, url: 'new', phase: 'loading', snapshotUrl: 'new', total: 3, environmentReady: false, settled: 2, ready: false },
    { name: '环境独立结算一次', declared: true, url: 'new', phase: 'ready', snapshotUrl: 'new', total: 3, environmentReady: true, settled: 3, ready: true },
    { name: '合批未齐不能ready', declared: true, url: 'new', phase: 'ready', snapshotUrl: 'new', batches: 1, total: 3, environmentReady: true, settled: 3, ready: false },
    { name: '天空盒仍在加载', declared: true, url: 'new', phase: 'ready', snapshotUrl: 'new', skybox: 'loading', total: 3, environmentReady: true, settled: 3, ready: false },
    { name: '待应用环境尚无URL', declared: false, pendingEnvironment: true, url: null, phase: 'idle', snapshotUrl: null, total: 3, environmentReady: false, settled: 2, ready: false },
  ];
  for (const entry of cases) {
    const expected = evaluate(expectedExpression, {
      environmentApplyRequest: entry.pendingEnvironment ? { environment: {} } : null,
      sceneDocument: { sceneSettings: { environment: entry.declared ? {} : null } },
    });
    const total = evaluate(totalExpression, { modelEntityIds: ['model-a', 'model-b'], sceneRuntimeEnvironmentExpected: expected });
    const environmentReady = evaluate(environmentExpression, { sceneRuntimeEnvironmentExpected: expected,
      sceneRuntimeEnvironmentSourceUrl: entry.url, environmentSnapshot: { phase: entry.phase, sourceUrl: entry.snapshotUrl } });
    const settled = settle(entry.url, environmentReady, 2);
    const ready = evaluate(readyExpression, { settledModels: settled, totalSceneModels: total,
      batchedEntities: entry.batches ?? 2, expectedBatchedEntities: 2, skyboxReadiness: { phase: entry.skybox ?? 'ready' } });
    assert.equal(total, entry.total, entry.name + '：环境必须独立计总数');
    assert.equal(environmentReady, entry.environmentReady, entry.name + '：必须匹配当前URL和ready状态');
    assert.equal(settled, entry.settled, entry.name + '：环境只有实际就绪才结算一次');
    assert.equal(ready, entry.ready, entry.name + '：环境、合批和天空盒门控必须同时满足');
  }
});
