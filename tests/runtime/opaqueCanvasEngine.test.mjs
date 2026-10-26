import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/runtime/babylon/createEngine.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('createEngine.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const factory = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createBabylonViewport');
assert.ok(factory);
const executable = ts.transpileModule(factory.getText(ast).replace(/^export /, '') + '\ncreateBabylonViewport;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test('基础DPR协调保留旧桥接1e-3容差，并且不重置运动中的同一基础等级', () => {
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'setBaseHardwareScalingLevel') declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(factory); assert.ok(declaration?.initializer);
  const code = ts.transpileModule('const set = ' + declaration.initializer.getText(ast) + '; set;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let level = 1, writes = 0, lifecycle = 0;
  const engine = { getHardwareScalingLevel: () => level, setHardwareScalingLevel: value => { writes++; level = value; } };
  const options = { engine, adaptiveResolution: null, setAdaptiveResolution: () => lifecycle++ };
  const normal = runInNewContext(code, options);
  normal(1.0005); assert.equal(writes, 0); normal(.5); assert.equal(level, .5); assert.equal(writes, 1);
  level = 1.5; options.adaptiveResolution = { getSnapshot: () => ({ baselineLevel: 1 }) };
  const adaptive = runInNewContext(code, { ...options });
  adaptive(1.0005); assert.equal(lifecycle, 0); assert.equal(level, 1.5);
  adaptive(.5); assert.equal(lifecycle, 2); assert.equal(level, .5);
  assert.throws(() => adaptive(NaN), /基础渲染/);
});

function engineArguments(options) {
  let captured;
  const create = runInNewContext(executable, {
    assertWebGLSupported() {}, getErrorMessage: error => error.message,
    Engine: class {
      constructor(canvas, antialias, engineOptions) {
        captured = { canvas, antialias, engineOptions };
        throw new Error('contract stop after native constructor');
      }
    },
  });
  const canvas = {};
  assert.throws(() => create(canvas, undefined, options), /contract stop after native constructor/);
  assert.equal(captured.canvas, canvas);
  return { antialias: captured.antialias, options: JSON.parse(JSON.stringify(captured.engineOptions)) };
}

test('R3只有opaqueCanvas:true创建alpha:false，默认/false保持原透明上下文及其它渲染选项', () => {
  for (const opaqueCanvas of [undefined, false, true, 'true']) {
    const actual = engineArguments({ opaqueCanvas, requireHardwareAcceleration: true });
    assert.equal(actual.antialias, true);
    assert.deepEqual(actual.options, { alpha: opaqueCanvas !== true, preserveDrawingBuffer: false, stencil: true,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true, desynchronized: false });
  }
});

test('R3 PlayerApp将已解析的显式Viewer选项传入共享视口工厂', () => {
  const player = ts.createSourceFile('PlayerApp.tsx', readFileSync(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(player) === 'createBabylonViewport') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(player);
  assert.equal(calls.length, 1);
  const options = calls[0].arguments[2]; assert.ok(ts.isObjectLiteralExpression(options));
  const property = options.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(player) === 'opaqueCanvas');
  assert.ok(property && ts.isPropertyAssignment(property));
  assert.equal(property.initializer.getText(player), 'parsedConfig.viewer.opaqueCanvas');
});
