import assert from 'node:assert/strict';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import { createBusinessGiViewerServer } from '../helpers/phase2GiViewer.mjs';
import { openGiArtifactReader } from '../helpers/phase2GiArchiveReader.mjs';

async function archive(t, entries) {
  const root = await fs.mkdtemp(path.resolve('output', '.phase2-gi-zip-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('output')); assert.ok(path.basename(root).startsWith('.phase2-gi-zip-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'fixture.zip');
  await new Promise((resolve, reject) => {
    const output = createWriteStream(file), zip = new ZipArchive({ zlib: { level: 9 } });
    output.once('close', resolve); output.once('error', reject); zip.once('error', reject); zip.pipe(output);
    for (const [name, value] of entries) zip.append(value, { name }); void zip.finalize().catch(reject);
  });
  return { root, file };
}

test('GI归档只读原ZIP的精确字节/长度/模块列表，HTTP不生成额外解压副本', async t => {
  const f = await archive(t, [['index.html', '<p>real archive bytes</p>'], ['assets/engineStore-test.js', 'export const marker=1;'], ['project/assets/原几何.bin', Buffer.from([0, 1, 2, 255])]]);
  const reader = await openGiArtifactReader(f.file);
  assert.equal(reader.kind, 'zip'); assert.deepEqual(await reader.list('assets'), ['engineStore-test.js']);
  assert.deepEqual(await reader.read('project/assets/原几何.bin'), Buffer.from([0, 1, 2, 255]));
  await assert.rejects(reader.read('../outside'), /越界/);
  const hosted = await createBusinessGiViewerServer(f.file, '7', []); t.after(() => new Promise(resolve => hosted.server.close(resolve)));
  const response = await fetch(hosted.origin + '/assets/engineStore-test.js');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(await response.text(), 'export const marker=1;');
  assert.deepEqual(await fs.readdir(f.root), ['fixture.zip']);
});

test('GI ZIP Reader拒绝大小写歧义资源，不能以解压覆盖隐藏一个版本', async t => {
  const f = await archive(t, [['Assets/X.bin', 'first'], ['Assets/x.bin', 'second']]);
  await assert.rejects(openGiArtifactReader(f.file), /大小写歧义/);
});
