import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

const tempRoot = await mkdtemp(path.join(tmpdir(), 'babylon-skybox-assets-'));

function createHdrFixture(comment, baseValue) {
  const header = Buffer.from(`#?RADIANCE\nCOMMENT=${comment}\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n`, 'ascii');
  const scanline = [Buffer.from([2, 2, 0, 8])];
  for (let channel = 0; channel < 4; channel += 1) {
    scanline.push(Buffer.from([8]), Buffer.alloc(8, baseValue + channel));
  }
  return Buffer.concat([header, ...scanline]);
}

function createCorruptHdrFixture() {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', 'ascii');
  return Buffer.concat([header, Buffer.from([2, 2, 0, 8, 137, 10])]);
}

function createExrFixture(width = 8, height = 1) {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2);
  const dataWindowSize = Buffer.alloc(4);
  dataWindowSize.writeUInt32LE(16);
  const dataWindow = Buffer.alloc(16);
  dataWindow.writeInt32LE(0, 0);
  dataWindow.writeInt32LE(0, 4);
  dataWindow.writeInt32LE(width - 1, 8);
  dataWindow.writeInt32LE(height - 1, 12);
  return Buffer.concat([
    Buffer.from([0x76, 0x2f, 0x31, 0x01]),
    version,
    Buffer.from('dataWindow\0box2i\0', 'ascii'),
    dataWindowSize,
    dataWindow,
    Buffer.from([0]),
    Buffer.from('EXR-DATA'),
  ]);
}

let server;
try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  const {
    importSkyboxFileIntoRoot,
    listSkyboxAssetsInRoot,
    validateSkyboxSourceFile,
  } = await server.ssrLoadModule('/electron/ipc/skyboxAssetStore.ts');

  const sourceRoot = path.join(tempRoot, 'source');
  const skyboxRoot = path.join(tempRoot, 'project', 'Assets', 'Skyboxes');
  await mkdir(sourceRoot, { recursive: true });

  const hdrPath = path.join(sourceRoot, 'shared-name.hdr');
  const exrPath = path.join(sourceRoot, 'shared-name.exr');
  const badPath = path.join(sourceRoot, 'invalid.hdr');
  const hiddenPath = path.join(sourceRoot, '.hidden.hdr');
  const hugeExrPath = path.join(sourceRoot, 'huge.exr');
  const corruptPath = path.join(sourceRoot, 'corrupt.hdr');
  const firstHdrFixture = createHdrFixture('original', 32);
  await writeFile(hdrPath, firstHdrFixture);
  const exrFixture = createExrFixture();
  await writeFile(exrPath, exrFixture);
  await writeFile(badPath, Buffer.from('not-an-hdr', 'ascii'));
  await writeFile(hiddenPath, createHdrFixture('hidden', 24));
  await writeFile(hugeExrPath, createExrFixture(16384, 4096));
  await writeFile(corruptPath, createCorruptHdrFixture());

  assert.deepEqual(await validateSkyboxSourceFile(hdrPath), { format: 'hdr', fileSizeBytes: firstHdrFixture.length });
  assert.deepEqual(await validateSkyboxSourceFile(exrPath), { format: 'exr', fileSizeBytes: exrFixture.length });
  await assert.rejects(() => validateSkyboxSourceFile(badPath), /HDR 文件头/);
  await assert.rejects(() => validateSkyboxSourceFile(corruptPath), /RLE 数据越界/);
  await assert.rejects(() => validateSkyboxSourceFile(hugeExrPath), /安全解码上限/);

  const firstHdr = await importSkyboxFileIntoRoot(hdrPath, skyboxRoot);
  const firstExr = await importSkyboxFileIntoRoot(exrPath, skyboxRoot);
  const hiddenHdr = await importSkyboxFileIntoRoot(hiddenPath, skyboxRoot);
  assert.equal(firstHdr.format, 'hdr');
  assert.equal(firstExr.format, 'exr');
  assert.notEqual(firstHdr.packagePath, firstExr.packagePath, '同 stem 的 HDR 与 EXR 必须共存');
  assert.equal(path.basename(hiddenHdr.packagePath), '_hidden.hdr', '前导点文件名不能与隐藏暂存目录规则冲突');

  await writeFile(hdrPath, createHdrFixture('replacement', 48));
  const replacedHdr = await importSkyboxFileIntoRoot(hdrPath, skyboxRoot);
  assert.equal(replacedHdr.path, firstHdr.path, '同名导入必须复用稳定项目路径');
  assert.notEqual(replacedHdr.assetRevision, firstHdr.assetRevision, '同名替换必须刷新资源版本');
  assert.match((await readFile(replacedHdr.path)).toString('ascii'), /replacement/);

  await writeFile(hdrPath, createCorruptHdrFixture());
  await assert.rejects(() => importSkyboxFileIntoRoot(hdrPath, skyboxRoot), /RLE 数据越界/);
  assert.match(
    (await readFile(replacedHdr.path)).toString('ascii'),
    /replacement/,
    '损坏的同名重导失败后必须保留已提交天空盒',
  );

  const assets = await listSkyboxAssetsInRoot(skyboxRoot);
  assert.equal(assets.length, 3);
  assert.deepEqual(assets.map((asset) => asset.format).sort(), ['exr', 'hdr', 'hdr']);
  assert.ok(assets.every((asset) => asset.sourceUrl.startsWith('editor-asset://local/')));

  console.info('Skybox asset smoke test passed.');
} finally {
  await server?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
