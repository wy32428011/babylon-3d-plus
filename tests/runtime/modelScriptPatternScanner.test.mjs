import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES, scanModelScriptSource, scanModelScripts } from '../../scripts/scan-model-script-patterns.mjs';

const rules = (findings) => findings.map(finding => finding.rule);

test('逐帧回调内遍历全场节点或按祖先链判断会被标记，按行号定位', () => {
  const findings = scanModelScriptSource([
    'export class Led {',
    '  onUpdate() {',
    '    const nodes = this.scene.transformNodes.filter(node => node.isDescendantOf(this.root));',
    '  }',
    '}',
  ].join('\n'));
  assert.deepEqual(rules(findings), ['per-frame-scene-traversal', 'per-frame-scene-traversal']);
  assert.equal(findings[0].line, 3);
});

test('传给 onBeforeRenderObservable.add 的回调及其同文件直接调用链都属于逐帧范围', () => {
  const findings = scanModelScriptSource([
    'function collect(scene) { return scene.meshes.length; }',
    'function paint(root) { root.computeWorldMatrix(true); }',
    'export function setup(scene, root) {',
    '  scene.onBeforeRenderObservable.add(() => { collect(scene); paint(root); });',
    '}',
  ].join('\n'));
  assert.deepEqual(rules(findings), ['per-frame-scene-traversal', 'per-frame-force-world-matrix']);
});

test('只在初始化阶段执行的遍历不会被标记', () => {
  const findings = scanModelScriptSource([
    'export class Model {',
    '  onStart() { this.nodes = this.scene.meshes.filter(mesh => mesh.name.startsWith("a")); }',
    '  onUpdate() { this.root.position.x += 1; }',
    '}',
  ].join('\n'));
  assert.deepEqual(findings, []);
});

test('逐帧强制矩阵、求逆与纹理重绘分别归类', () => {
  const findings = scanModelScriptSource([
    'export class Screen {',
    '  onUpdate() {',
    '    const inverse = this.root.getWorldMatrix().invert();',
    '    this.root.computeWorldMatrix(true);',
    '    this.screenTexture.update();',
    '    this.root.computeWorldMatrix(false);',
    '  }',
    '}',
  ].join('\n'));
  assert.deepEqual(rules(findings), ['per-frame-force-world-matrix', 'per-frame-force-world-matrix', 'per-frame-texture-update']);
});

test('带写入、自增或集合修改的 getter 被标记，纯计算与局部变量写入不会', () => {
  const findings = scanModelScriptSource([
    'export const config = {',
    '  reads: 0,',
    '  get counted() { this.reads++; return 1; },',
    '  get pure() { let sum = 0; sum += 1; return sum; },',
    '  get tracked() { cache.push(1); return 2; },',
    '};',
    'const cache: number[] = [];',
  ].join('\n'));
  assert.deepEqual(rules(findings), ['getter-side-effect', 'getter-side-effect']);
  assert.deepEqual(findings.map(finding => finding.line), [3, 5]);
});

test('没有帧回调的脚本不产生逐帧提示，所有规则均有说明', () => {
  assert.deepEqual(scanModelScriptSource('export const a = scene.meshes; computeWorldMatrix(true);'), []);
  for (const rule of Object.keys(RULES)) assert.ok(RULES[rule].length > 0);
});

test('扫描目录只读取 .model.ts，汇总各规则次数', async () => {
  const report = await scanModelScripts(['tests/fixtures/model-packages']);
  assert.ok(report.scannedFiles >= 3);
  assert.equal(Object.keys(report.summary).length, Object.keys(RULES).length);
  assert.ok(report.results.every(result => /\.model\.ts$/i.test(result.file)));
});
