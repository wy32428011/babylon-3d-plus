import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';
import { getSceneLightingBakeError, getSceneLightingBakeSignature } from '../../dist-electron/shared/sceneLightingBakeContract.js';
import { openGiArtifactReader } from './phase2GiArchiveReader.mjs';
import { decodeLightingGeometryResource } from '../../dist-electron/shared/sceneLightingBakeGeometryBinary.js';

export const giArtifactSha = bytes => createHash('sha256').update(bytes).digest('hex');
export const insideGiRoot = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export async function extractGiArchive(archivePath, destination) {
  await fs.mkdir(destination);
  const archive = await unzipper.Open.file(archivePath); let bytes = 0;
  assert.ok(archive.files.length <= 100000);
  for (const entry of archive.files) {
    const name = entry.path.replaceAll('\\', '/'), file = path.resolve(destination, name);
    assert.ok(!path.isAbsolute(name) && !name.includes('\0') && !name.split('/').includes('..') && insideGiRoot(destination, file));
    assert.ok(['File', 'Directory'].includes(entry.type));
    if (entry.type === 'Directory') { await fs.mkdir(file, { recursive: true }); continue; }
    bytes += entry.uncompressedSize; assert.ok(bytes <= 2 * 1024 ** 3);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, await entry.buffer(), { flag: 'wx' });
  }
  return { files: archive.files.length, unpackedBytes: bytes };
}

/** 搬迁合同会按目标引用重新签名；逐context自洽，并严格比较所有非地址的烘焙输出。 */
export function assertPortableGiContract(scene, expectedSnapshot, expectedScene) {
  assert.equal(scene.sceneSettings.lighting.bake.enabled, true);
  assert.equal(getSceneLightingBakeError(scene), null);
  const snapshot = scene.sceneSettings.lighting.result;
  assert.equal(snapshot.signature, getSceneLightingBakeSignature(scene), '当前地址上下文的正式签名必须自洽');
  assert.equal(snapshot.geometrySignature, expectedSnapshot.geometrySignature);
  assert.deepEqual(snapshot.surfaces, expectedSnapshot.surfaces);
  assert.deepEqual(snapshot.statistics, expectedSnapshot.statistics);
  const meta = assets => assets.map(({ url: _location, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(meta(snapshot.assets), meta(expectedSnapshot.assets), '仅允许资源URL搬迁，身份/编码/SHA/大小等不可变化');
  if (expectedScene) {
    assert.deepEqual(scene.entityIds, expectedScene.entityIds);
    for (const id of scene.entityIds) {
      const current = scene.entities[id], expected = expectedScene.entities[id];
      assert.equal(current.parentId, expected.parentId); assert.deepEqual(current.childrenIds, expected.childrenIds);
      assert.deepEqual(current.components.transform, expected.components.transform);
      assert.deepEqual(current.components.modelAsset?.parameterValues, expected.components.modelAsset?.parameterValues);
    }
    const { result: _sourceResult, ...expectedLighting } = expectedScene.sceneSettings.lighting;
    const { result: _targetResult, ...actualLighting } = scene.sceneSettings.lighting;
    assert.deepEqual(actualLighting, expectedLighting, '原灯光、画质、烘焙设置不能在运输时变化');
  }
  return snapshot;
}

export async function verifyGiSourceReadback({ root, entryScenePath, expectedSnapshot, expectedScene, expectedReceiverTriangles }) {
  const reader = await openGiArtifactReader(root);
  const scene = JSON.parse((await reader.read(entryScenePath)).toString('utf8')).scene;
  const snapshot = assertPortableGiContract(scene, expectedSnapshot, expectedScene), assets = [], geometryTriangles = new Map();
  for (const asset of snapshot.assets) {
    const reference = /^[a-z][a-z0-9+.-]*:/i.test(asset.url) ? decodeURIComponent(new URL(asset.url).pathname.slice(1)) : decodeURIComponent(asset.url);
    assert.ok(!path.isAbsolute(reference));
    const bytes = await reader.read(reference);
    assert.equal(bytes.length, asset.byteLength); assert.equal(giArtifactSha(bytes), asset.sha256);
    if (expectedReceiverTriangles !== undefined && asset.kind === 'geometry') {
      const geometry = decodeLightingGeometryResource(new Uint8Array(bytes), asset.encoding);
      assert.ok(geometry.positions.length > 0 && geometry.indices.length > 0 && geometry.indices.length % 3 === 0);
      geometryTriangles.set(asset.id, geometry.indices.length / 3);
    }
    assets.push({ id: asset.id, bytes: bytes.length, sha256: giArtifactSha(bytes) });
  }
  let receiverTriangles;
  if (expectedReceiverTriangles !== undefined) {
    assert.ok(Number.isSafeInteger(expectedReceiverTriangles) && expectedReceiverTriangles > 0);
    receiverTriangles = snapshot.surfaces.reduce((sum, surface) => {
      assert.ok(geometryTriangles.has(surface.geometryAssetId), 'SOURCE接收表面缺少已独立解码几何'); return sum + geometryTriangles.get(surface.geometryAssetId);
    }, 0);
    assert.equal(receiverTriangles, expectedReceiverTriangles, 'SOURCE独立解码几何必须等于fresh capture的receiver总量');
  }
  return { reader: reader.kind, signature: snapshot.signature, geometrySignature: snapshot.geometrySignature, surfaces: snapshot.surfaces.length, assets,
    ...(expectedReceiverTriangles === undefined ? {} : { receiverTriangles }) };
}
