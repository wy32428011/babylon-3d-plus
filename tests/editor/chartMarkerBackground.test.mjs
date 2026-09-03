import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('背景拖放通过同一图片登记表读取内置、同步网络和同步本地资源', async t => {
  const server = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
  t.after(() => server.close());
  const { loadChartMarkerLibraryBackground: load } = await server.ssrLoadModule('/src/editor/assets/chartMarkerBackground.ts');
  const { BUILT_IN_IMAGE_ASSETS } = await server.ssrLoadModule('/src/assets/imageAssets.ts');
  const { setSyncedImageAssets } = await server.ssrLoadModule('/src/assets/syncedImageAssets.ts');
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch; setSyncedImageAssets([]); });
  const local = { id: 'local', name: '同步本地图片', reference: 'editor-image://platform/local_image', sourceUrl: 'editor-asset://local/C%3A%5CImages%5Clocal.png' };
  const remote = { id: 'remote', name: '同步网络图片', reference: 'editor-image://platform/remote_image', sourceUrl: 'https://assets.example/image.png' };
  setSyncedImageAssets([local, remote]);
  const bytes = Uint8Array.from([137,80,78,71,13,10,26,10]);
  const reads = [], fetches = [];
  globalThis.window = { editorApi: { readSyncedImage: async reference => { reads.push(reference); return { bytes, contentType: 'image/png' }; } } };
  globalThis.fetch = async source => { fetches.push(source); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); };
  const signal = new AbortController().signal;
  for (const asset of [BUILT_IN_IMAGE_ASSETS[0], remote, local]) {
    const blob = await load(JSON.stringify(asset), signal);
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  }
  assert.deepEqual(reads, [local.reference]);
  assert.deepEqual(fetches, [BUILT_IN_IMAGE_ASSETS[0].sourceUrl, remote.sourceUrl]);
  await assert.rejects(load(JSON.stringify({ ...local, sourceUrl: 'editor-asset://local/other.png' }), signal), /有效图片/);
  assert.deepEqual(reads, [local.reference], '伪造路径不得进入桥接');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(load(JSON.stringify(local), aborted.signal), { name: 'AbortError' });
  const during = new AbortController();
  globalThis.window.editorApi.readSyncedImage = async () => { during.abort(); return { bytes, contentType: 'image/png' }; };
  await assert.rejects(load(JSON.stringify(local), during.signal), { name: 'AbortError' });
  const pending = new AbortController();
  globalThis.window.editorApi.readSyncedImage = () => new Promise(() => {});
  const waiting = load(JSON.stringify(local), pending.signal);
  pending.abort();
  let timer;
  try {
    await assert.rejects(Promise.race([waiting, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('IPC 取消后仍在等待')), 100);
    })]), { name: 'AbortError' });
  } finally { clearTimeout(timer); }
  globalThis.window.editorApi.readSyncedImage = async () => ({ bytes, contentType: 'text/html' });
  await assert.rejects(load(JSON.stringify(local), signal), /格式不受支持/);
});
