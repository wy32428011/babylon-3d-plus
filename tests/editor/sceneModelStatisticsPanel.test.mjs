import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../../src/editor/panels/SceneModelStatisticsPanel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;

function render(snapshot, { sceneId = 'scene-A', runtimeMode = 'edit' } = {}) {
  const state = { scene: { id: sceneId }, sceneModelStatistics: snapshot, runtimeMode };
  const dependencies = {
    '../store/editorStore': { useEditorStore: selector => selector(state) },
    './SceneModelStatisticsPanel.css': {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(
    id => id in dependencies ? dependencies[id] : require(id), module, module.exports,
  );
  return renderToStaticMarkup(React.createElement(module.exports.SceneModelStatisticsPanel));
}

test('面数总量使用完整千分位整数，明细与说明默认收起', () => {
  const html = render({ sceneId: 'scene-A', phase: 'ready', modelTriangleCount: 986240, environmentTriangleCount: 298120 });
  assert.match(html, />1,284,360<\/span>/);
  assert.match(html, /<dd>986,240<\/dd>/);
  assert.match(html, /<dd>298,120<\/dd>/);
  assert.match(html, /aria-label="面数统计说明" aria-expanded="false" aria-controls="[^"]+"/);
  assert.match(html, /<div id="[^"]+" hidden=""><dl/);
});

test('空场景显示零，运行预览仍可查看统计说明和明细', () => {
  const html = render({ sceneId: 'scene-A', phase: 'ready', modelTriangleCount: 0, environmentTriangleCount: 0 }, { runtimeMode: 'preview' });
  assert.match(html, /role="status"[^>]*>0<\/span>/);
  assert.doesNotMatch(html, /disabled/);
});

test('加载和失败阶段不把局部面数展示为完整结果', () => {
  for (const [phase, text] of [['loading', '— · 统计中…'], ['error', '— · 统计未完成']]) {
    const html = render({ sceneId: 'scene-A', phase, modelTriangleCount: 123456, environmentTriangleCount: 7890 });
    assert.ok(html.includes(text));
    assert.doesNotMatch(html, /123,456|7,890|131,346/);
    assert.equal((html.match(/<dd>—<\/dd>/g) || []).length, 2);
  }
});

test('场景切换或统计尚未登记时不展示上一场景数字', () => {
  for (const snapshot of [null, { sceneId: 'scene-B', phase: 'ready', modelTriangleCount: 100000, environmentTriangleCount: 20 }]) {
    const html = render(snapshot);
    assert.ok(html.includes('— · 统计中…'));
    assert.doesNotMatch(html, /100,020|100,000/);
  }
});
