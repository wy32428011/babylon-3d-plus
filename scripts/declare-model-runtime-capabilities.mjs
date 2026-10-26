import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashModelRuntimeConfiguration } from '../electron/shared/modelRuntimeCapabilities.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
function json(value) {
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return Object.is(value, -0) ? '-0' : JSON.stringify(value); }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? '[' + value.map(json).join(',') + ']'
    : '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ':' + json(item)).join(',') + '}';
}

/** 仅替换 GLB JSON 块中的声明，原二进制及所有后续块逐字节保留。 */
export function embedRuntimeCapabilities(bytes, capability) {
  assert.ok(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, '仅支持GLB2');
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const size = bytes.readUInt32LE(12);
  assert.ok(size <= 64 * 1024 ** 2 && size % 4 === 0 && 20 + size <= bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + size)));
  const updated = structuredClone(original);
  assert.ok(updated.asset && typeof updated.asset === 'object' && !Array.isArray(updated.asset));
  assert.ok(updated.asset.extras == null || (typeof updated.asset.extras === 'object' && !Array.isArray(updated.asset.extras)));
  updated.asset.extras = { ...updated.asset.extras, runtimeCapabilities: capability };
  const text = Buffer.from(json(updated));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20); text.copy(padded);
  const output = Buffer.concat([bytes.subarray(0, 12), Buffer.alloc(8), padded, bytes.subarray(20 + size)]);
  output.writeUInt32LE(output.length, 8); output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16);
  const comparison = structuredClone(updated);
  if (original.asset.extras === undefined) delete comparison.asset.extras;
  else comparison.asset.extras = structuredClone(original.asset.extras);
  assert.deepEqual(comparison, original, '声明不得改变模型语义');
  assert.ok(output.subarray(20 + padded.length).equals(bytes.subarray(20 + size)), '二进制块必须保持');
  return output;
}

/** 显式作者契约工具，不根据扫描结果自动宣称任意脚本只读。原包不写入，目标必须全新。 */
export async function declareReadonlyPackage({ scene, entityId, output, acknowledgeReadonlyGeometry }) {
  assert.equal(acknowledgeReadonlyGeometry, true, '必须显式确认所有生命周期/参数/动画均不修改Geometry');
  const document = JSON.parse(await fs.readFile(scene, 'utf8'));
  const model = document.scene?.entities?.[entityId]?.components?.modelAsset;
  assert.ok(model && typeof model.sourcePath === 'string' && /\.glb$/i.test(model.sourcePath), '请选择本地GLB模型实体');
  const sourceFile = path.resolve(model.sourcePath), root = path.dirname(sourceFile), target = path.resolve(output);
  assert.ok(!inside(root, target) && !inside(target, root), '新目录不能与原模型包互相包含');
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false, '源包不能是Junction');
  const files = [];
  let totalBytes = 0;
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = await fs.lstat(file);
      assert.equal(stat.isSymbolicLink(), false, '模型包不能包含符号链接/Junction');
      if (stat.isDirectory()) await collect(file);
      else {
        assert.ok(stat.isFile()); files.push(file); totalBytes += stat.size;
        assert.ok(files.length <= 4096 && totalBytes <= 512 * 1024 ** 2, '候选包超出工具预算');
      }
    }
  }
  await collect(root);
  const scripts = {};
  for (const script of model.scriptAssets ?? []) {
    const file = path.resolve(script.path);
    assert.ok(inside(root, file) && files.includes(file), '脚本必须位于完整原包内');
    assert.equal(script.name, path.basename(file));
    assert.ok(!Object.hasOwn(scripts, script.name), '脚本名必须唯一');
    scripts[script.name] = hash(new TextEncoder().encode(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file))));
  }
  const capability = { version: 1, geometry: 'shared-readonly', materials: 'owned',
    configurationSha256: await hashModelRuntimeConfiguration(model), scripts };
  const sourceBytes = await fs.readFile(sourceFile), candidate = embedRuntimeCapabilities(sourceBytes, capability);
  const metadataPath = path.join(root, 'meta.json');
  const metadata = files.includes(metadataPath) ? JSON.parse(await fs.readFile(metadataPath, 'utf8')) : {};
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
  await fs.mkdir(target);
  for (const file of files) {
    const destination = path.join(target, path.relative(root, file));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file, destination, 1);
  }
  await fs.writeFile(path.join(target, path.basename(sourceFile)), candidate);
  await fs.writeFile(path.join(target, 'meta.json'), json({ ...metadata, runtimeCapabilities: capability }) + '\n');
  assert.equal(hash(await fs.readFile(sourceFile)), hash(sourceBytes), '原GLB必须不变');
  return { output: target, runtimeCapabilities: capability, sourceSha256: hash(sourceBytes), candidateSha256: hash(candidate),
    binaryPreserved: true, authorDeclarationOnly: true, requiresBehaviorAcceptance: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { scene: { type: 'string' }, entity: { type: 'string' }, output: { type: 'string' },
    'acknowledge-readonly-geometry': { type: 'boolean', default: false } } });
  assert.ok(values.scene && values.entity && values.output, '--scene、--entity、--output必填');
  console.log(JSON.stringify(await declareReadonlyPackage({ scene: values.scene, entityId: values.entity, output: values.output,
    acknowledgeReadonlyGeometry: values['acknowledge-readonly-geometry'] }), null, 2));
}
