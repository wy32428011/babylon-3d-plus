import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [scanner] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/modelPackageScanner'),
]>(['electron/ipc/modelPackageScanner.ts']);

test('超过512MiB的环境GLB以有界读取完成结构校验', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'environment-large-glb-'));
  const filePath = path.join(root, 'large.glb');
  const binaryLength = 768 * 1024 * 1024;
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, buffers: [{ byteLength: binaryLength }], meshes: [{ primitives: [{}] }],
  }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(28 + jsonLength);
  const totalLength = prefix.length + binaryLength;
  prefix.write('glTF'); prefix.writeUInt32LE(2, 4); prefix.writeUInt32LE(totalLength, 8);
  prefix.writeUInt32LE(jsonLength, 12); prefix.writeUInt32LE(0x4e4f534a, 16);
  prefix.fill(0x20, 20, 20 + jsonLength); json.copy(prefix, 20);
  prefix.writeUInt32LE(binaryLength, 20 + jsonLength); prefix.writeUInt32LE(0x004e4942, 24 + jsonLength);
  try {
    // 只写头部并扩展文件长度，不分配或传输768MiB Buffer。
    const handle = await open(filePath, 'w');
    try { await handle.write(prefix); await handle.truncate(totalLength); } finally { await handle.close(); }
    const inspection = await scanner.inspectGlbModelFile(filePath);
    assert.equal(inspection.fileSizeBytes, totalLength);
    // 放开总大小后仍必须校验容器完整性。
    const corrupt = await open(filePath, 'r+');
    try { await corrupt.truncate(totalLength - 4); } finally { await corrupt.close(); }
    await assert.rejects(scanner.inspectGlbModelFile(filePath), /声明长度与实际文件大小不一致/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
