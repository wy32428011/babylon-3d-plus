import assert from 'node:assert/strict';
import test from 'node:test';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('CAD 任务进度提供取消按钮，失败状态保留可关闭的错误说明', async () => {
  const server = await createP4SsrTestModules([
    '/src/editor/deployment/ToolbarTaskProgress.tsx',
  ]);
  try {
    const { ToolbarTaskProgress } = await server.ssrLoadModule('/src/editor/deployment/ToolbarTaskProgress.tsx');
    const active = renderToStaticMarkup(createElement(ToolbarTaskProgress, { label: '解析 CAD', percent: 31, detail: '正在扫描', onCancel() {} }));
    assert.match(active, /取消/);
    assert.match(active, /<button[^>]*type="button"/);
    const failed = renderToStaticMarkup(createElement(ToolbarTaskProgress, { label: '导入失败', percent: 31, detail: '内存预算不足', tone: 'error', onDismiss() {} }));
    assert.match(failed, /内存预算不足/);
    assert.match(failed, /toolbar-task-progress-error/);
    assert.match(failed, /关闭/);
    assert.doesNotMatch(failed, />取消</);
  } finally { await server.close(); }
});
