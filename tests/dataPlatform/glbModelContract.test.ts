import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ inspectGlbModelFile, validateEnvironmentGlbFile, validateGlbModelFile }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/modelPackageScanner'),
]>(['electron/ipc/modelPackageScanner.ts']);

function createGlb(document: Record<string, unknown>, binary = Buffer.from([0, 0, 0, 0])): Buffer {
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const paddedJsonLength = Math.ceil(json.length / 4) * 4;
  const jsonChunk = Buffer.alloc(paddedJsonLength, 0x20);
  json.copy(jsonChunk);
  const chunks: Buffer[] = [];
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  chunks.push(jsonHeader, jsonChunk);
  if (binary.length > 0) {
    const paddedBinaryLength = Math.ceil(binary.length / 4) * 4;
    const binaryChunk = Buffer.alloc(paddedBinaryLength);
    binary.copy(binaryChunk);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(binaryChunk.length, 0);
    binaryHeader.writeUInt32LE(0x004e4942, 4);
    chunks.push(binaryHeader, binaryChunk);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + body.length, 8);
  return Buffer.concat([header, body]);
}

async function withTempGlb(content: Buffer, run: (filePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glb-contract-'));
  const filePath = path.join(root, 'environment.glb');
  try {
    await writeFile(filePath, content);
    await run(filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const MINIMAL_DOCUMENT = {
  asset: { version: '2.0' },
  buffers: [{ byteLength: 4 }],
  meshes: [{ primitives: [{}] }],
};

test('接受最小自包含 glTF 2.0 Binary，并报告运行时忽略项', async () => {
  await withTempGlb(createGlb({
    ...MINIMAL_DOCUMENT,
    extensionsUsed: ['KHR_lights_punctual', 'VENDOR_optional'],
    cameras: [{}],
    animations: [{}],
  }), async (filePath) => {
    const inspection = await inspectGlbModelFile(filePath);
    assert.equal(inspection.fileSizeBytes > 20, true);
    assert.deepEqual(inspection.extensionsUsed, ['KHR_lights_punctual', 'VENDOR_optional']);
    assert.equal(inspection.warnings.some((item) => item.includes('相机')), true);
    assert.equal(inspection.warnings.some((item) => item.includes('灯光')), true);
    assert.equal(inspection.warnings.some((item) => item.includes('未知非必需扩展')), true);
  });
});

test('拒绝外部 URI、未知必需扩展和无 Mesh 的伪 GLB', async () => {
  await withTempGlb(createGlb({
    ...MINIMAL_DOCUMENT,
    images: [{ uri: 'texture.png' }],
  }), async (filePath) => assert.equal(await validateEnvironmentGlbFile(filePath), false));

  await withTempGlb(createGlb({
    ...MINIMAL_DOCUMENT,
    extensionsUsed: ['VENDOR_required'],
    extensionsRequired: ['VENDOR_required'],
  }), async (filePath) => assert.equal(await validateEnvironmentGlbFile(filePath), false));

  await withTempGlb(createGlb({ asset: { version: '2.0' } }, Buffer.alloc(0)), async (filePath) => {
    assert.equal(await validateEnvironmentGlbFile(filePath), false);
  });
});

test('拒绝声明长度被篡改的 GLB', async () => {
  const invalid = createGlb(MINIMAL_DOCUMENT);
  invalid.writeUInt32LE(invalid.length + 4, 8);
  await withTempGlb(invalid, async (filePath) => assert.equal(await validateGlbModelFile(filePath), false));
});


test('普通模型 GLB 结构校验不套用环境模型专用规则', async () => {
  await withTempGlb(createGlb({
    asset: { version: '2.0' },
    extensionsUsed: ['VENDOR_required'],
    extensionsRequired: ['VENDOR_required'],
    images: [{ uri: 'texture.png' }],
  }), async (filePath) => {
    assert.equal(await validateGlbModelFile(filePath), true);
    assert.equal(await validateEnvironmentGlbFile(filePath), false);
  });
});
