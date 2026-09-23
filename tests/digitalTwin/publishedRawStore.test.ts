import assert from 'node:assert/strict';
import test from 'node:test';
import { PublishedRawStore } from '../../src/runtime/assets/publishedRawStore.ts';

function memory() {
  const records = new Map<string, unknown>();
  return { records, async get(key: string) { return records.get(key); }, async put(key: string, value: unknown) { records.set(key, value); }, async delete(key: string) { records.delete(key); }, close() {} };
}

test('原始文件分块存储，只有所有块提交后才发布完整记录，刷新可还原相同字节', async () => {
  const store = memory();
  const first = new PublishedRawStore('test', store, 3);
  await first.put('model', { blob: new Blob(['abcdefgh']), type: 'model/gltf-binary', sha256: 'hash' }, 8);
  assert.equal(store.records.size, 4);
  const value = await new PublishedRawStore('test', store, 3).get('model') as { blob: Blob; type: string; sha256: string };
  assert.equal(await value.blob.text(), 'abcdefgh');
  assert.equal(value.sha256, 'hash');
  assert.equal(value.type, 'model/gltf-binary');
});

test('中途存储失败不能标记完成，缺块记录也不能当成有效缓存', async () => {
  const store = memory();
  const raw = new PublishedRawStore('test', store, 3);
  const put = store.put;
  let count = 0;
  store.put = async (key, value) => { if (++count === 2) throw new Error('quota'); await put(key, value); };
  await assert.rejects(raw.put('model', { blob: new Blob(['abcdefgh']), type: 'x' }, 8), /quota/);
  assert.equal(await raw.get('model'), undefined);
  assert.equal(store.records.size, 0);
  store.put = put;
  await raw.put('model', { blob: new Blob(['abcdefgh']), type: 'x' }, 8);
  store.records.delete([...store.records.keys()].find(key => key !== 'model')!);
  assert.equal(await raw.get('model'), undefined);
});
