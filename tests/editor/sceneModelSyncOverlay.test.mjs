import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../../src/editor/loading/ScenePreparationOverlay.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function render(policy, { explicit = true, issues = ['模型123参数冲突'], transaction = null } = {}) {
  const state = { sceneSessionId: 'A', completed: true, editingAllowed: false, phase: 'completed', percent: 100,
    modelSyncRunId: explicit ? 'explicit-scene-test' : 'local-scene-A', runtime: { forcedSettled: false } };
  const editor = { sceneResourcePolicy: policy, sceneResourceIssues: issues,
    latestSceneResourceTransaction: transaction, localSceneEnvironmentRecoveryChoice: null };
  const environment = { sceneSessionId: 'A', error: issues.join('\n') || null, retrying: false };
  const dependencies = {
    '../store/editorStore': { useEditorStore: selector => selector(editor) },
    './scenePreparationProgress': { getScenePreparationSnapshot: () => state, subscribeScenePreparation: () => () => {},
      isScenePreparationSettled: value => value.completed, allowScenePreparationEditing() {} },
    './environmentPreparationProgress': { environmentPreparationStore: { getSnapshot: () => environment,
      subscribe: () => () => {}, retry() {} } },
    './sceneRemoteDownloadProgress': { sceneRemoteDownloadStore: { getSnapshot: () => ({}), subscribe: () => () => {} } },
    '../../shared/ui/SceneLoadingMask.module.css': {},
    '../../shared/ui/SceneLoadingMask': { SceneLoadingMask: props => React.createElement('div', { 'data-loading-mask': true }, props.label) },
    './RemoteDownloadDetail': { RemoteDownloadDetail: () => null },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => id in dependencies ? dependencies[id] : require(id), module, module.exports);
  return renderToStaticMarkup(React.createElement(module.exports.ScenePreparationOverlay, { onCancel() {} }));
}

test('本地和快照场景主动同步冲突后展示可编辑的问题与重试入口', () => {
  for (const policy of ['local-refresh', 'preserve-snapshot', 'data-platform-refresh']) {
    const html = render(policy);
    assert.match(html, /aria-label="场景资源状态"/);
    assert.match(html, /模型123参数冲突/); assert.match(html, /重新同步场景资源/);
    assert.doesNotMatch(html, /data-loading-mask/);
  }
});

test('原版本本地恢复失败继续阻断，不被主动升级的部分成功语义放行', () => {
  assert.match(render('local-refresh', { explicit: false }), /data-loading-mask/);
});

test('即使上一帧completed为true，未结束的模型更新事务也不能提前隐藏蒙版', () => {
  assert.match(render('preserve-snapshot', { issues: [], transaction: { after: {} } }), /data-loading-mask/);
  assert.equal(render('preserve-snapshot', { issues: [] }), '');
});
