import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { precompileModelScript, precompileModelScriptFile } from '../../electron/ipc/modelScriptCompiler.ts';
import { digestModelScriptText, normalizePrecompiledModelScript, serializePrecompiledModelScript, MODEL_SCRIPT_CACHE_MAX_BYTES } from '../../electron/shared/modelScriptCompilation.ts';

const source = `import { Vector3 as Position } from '@babylonjs/core';
import { visibleAsNumber } from 'babylonjs-editor-tools';
export const dataDriven = { deviceType: 'conveyor', motion: { nodeName: 'belt' } };
export default class RuntimeComponent {
  @visibleAsNumber('width')
  width: number = 2;
  constructor(public node: any) {}
  onStart() { this.node.width = this.width; this.node.position = new Position(1, 2, 3); }
}`;

test('Node 转译不执行脚本，同内容共用缓存，装饰器/默认类/遥测声明语义保持', async () => {
  const [a, b] = await Promise.all([precompileModelScript(source), precompileModelScript(source)]);
  assert.equal(a, b);
  assert.equal(a.sourceSha256, await digestModelScriptText(source));
  assert.equal(a.codeSha256, createHash('sha256').update(a.code).digest('hex'));
  assert.equal(normalizePrecompiledModelScript(a)?.format, 'babylon-model-script-v1');
  assert.equal(a.initializationError, undefined);
  const module = new Function('__babylon', '__decorator', a.code)({ Vector3: class {
    constructor(public x: number, public y: number, public z: number) {}
  } }, () => () => undefined);
  const node: Record<string, unknown> = {};
  const instance = new module.classes.default(node);
  assert.deepEqual(node, {});
  instance.width = 7;
  instance.onStart();
  assert.equal(node.width, 7);
  assert.equal((node.position as { y: number }).y, 2);
  assert.equal(module.dataDriven.deviceType, 'conveyor');
  assert.notEqual((await precompileModelScript(source + '\n// 修改内容')).sourceSha256, a.sourceSha256);
});

test('BOM 源文件原字节摘要与文本摘要分别保存，不改写源文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-compiler-'));
  try {
    const file = path.join(root, 'example.model.ts');
    const bytes = Buffer.from('\ufeff' + source);
    await writeFile(file, bytes);
    const artifact = await precompileModelScriptFile(file);
    assert.equal(artifact.sourceFileSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(artifact.sourceSha256, await digestModelScriptText(source));
    assert.deepEqual(await readFile(file), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('预转译保留源码语法诊断，未知格式和损坏派生元数据不被当成有效缓存', async () => {
  const artifact = await precompileModelScript('export default class Broken { broken: = ; }');
  assert.ok(artifact.initializationError);
  assert.equal(normalizePrecompiledModelScript({ ...artifact, format: 'unknown' }), undefined);
  assert.equal(normalizePrecompiledModelScript({ ...artifact, sourceSha256: 'invalid' }), undefined);
  assert.equal(normalizePrecompiledModelScript({ ...artifact, code: 1 }), undefined);
});

test('中文产物按整个 JSON 的 UTF-8 字节统一计量，不因超过旧 2MiB 限额回退编译器', async () => {
  const artifact = await precompileModelScript('export default class RuntimeComponent { text = "' + '中'.repeat(800_000) + '"; }');
  const content = serializePrecompiledModelScript(artifact);
  const length = new TextEncoder().encode(content).byteLength;
  assert.ok(length > 2 * 1024 * 1024);
  assert.ok(length < MODEL_SCRIPT_CACHE_MAX_BYTES);
  assert.ok(normalizePrecompiledModelScript(JSON.parse(content)));
  assert.throws(() => serializePrecompiledModelScript({ ...artifact, code: '中'.repeat(MODEL_SCRIPT_CACHE_MAX_BYTES / 2) }), /MiB 上限/);
});
