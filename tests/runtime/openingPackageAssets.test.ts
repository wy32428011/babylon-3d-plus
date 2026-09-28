import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OpeningPackageAssets, resolveOpeningAssetUrl } from '../../src/runtime/opening/openingPackageAssets.ts';

const bytes = new TextEncoder().encode('opening asset');
const asset = { id: 'backdrop', path: 'assets/backdrop.svg', type: 'image' as const,
  sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };

test('开场素材只能解析到包目录，兼容发布相对地址和 editor-asset', () => {
  assert.equal(resolveOpeningAssetUrl('https://host/release/openings/a/manifest.json', asset.path), 'https://host/release/openings/a/assets/backdrop.svg');
  const editorManifest = `editor-asset://local/${encodeURIComponent('C:\\project\\Assets\\Openings\\a\\manifest.json')}`;
  assert.equal(resolveOpeningAssetUrl(editorManifest, asset.path), `editor-asset://local/${encodeURIComponent('C:\\project\\Assets\\Openings\\a\\assets\\backdrop.svg')}`);
  assert.throws(() => resolveOpeningAssetUrl('https://evil/a/manifest.json', asset.path, 'https://viewer/app/'), /同源/);
  for (const path of ['', '../secret', 'assets/../../secret', 'https://evil/a', '/root/a', 'assets/%2e%2e/../a', 'assets\\a', 'assets/a?secret=1', 'assets/%zz']) {
    assert.throws(() => resolveOpeningAssetUrl('https://host/opening/manifest.json', path), /素材路径/);
  }
  assert.throws(() => resolveOpeningAssetUrl('javascript:alert(1)', 'assets/a.png'), /协议/);
});

test('SVG槽位替换为PNG时使用实际替换文件MIME，支持编码的Editor路径', async () => {
  let mime = '';
  const resolver = new OpeningPackageAssets('https://host/a/manifest.json', [{ ...asset,
    assetUrl: `editor-asset://local/${encodeURIComponent('C:\\project\\Assets\\OpeningAssets\\replaced.png')}` }], {
    fetch: async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    createObjectURL: blob => { mime = blob.type; return 'blob:png'; }, revokeObjectURL: () => {},
  });
  await resolver.url('backdrop'); assert.equal(mime, 'image/png'); resolver.dispose();
});

test('未知素材拒绝读取；SHA 校验发现等长损坏，缺少长度头仍检查流式上限', async () => {
  const wrong = new TextEncoder().encode('broken! asset');
  assert.equal(wrong.byteLength, bytes.byteLength);
  const resolver = new OpeningPackageAssets('https://host/a/manifest.json', [asset], { fetch: async () => new Response(wrong) });
  await assert.rejects(resolver.url('missing'), /未声明/);
  await assert.rejects(resolver.url('backdrop'), /SHA-256/);
  resolver.dispose();
  const tooBig = new OpeningPackageAssets('https://host/a/manifest.json', [asset], { fetch: async () => new Response(bytes), maxAssetBytes: 3 });
  await assert.rejects(tooBig.url('backdrop'), /超过/); tooBig.dispose();
  const advertised = new OpeningPackageAssets('https://host/a/manifest.json', [asset], {
    fetch: async () => new Response(bytes, { headers: { 'content-length': '100' } }), maxAssetBytes: 3,
  });
  await assert.rejects(advertised.url('backdrop'), /超过/); advertised.dispose();
});

test('同一资源共用请求，释放时只回收本会话的 blob URL', async () => {
  let reads = 0;
  const revoked: string[] = [];
  const resolver = new OpeningPackageAssets('https://host/a/manifest.json', [asset], {
    fetch: async () => { reads++; return new Response(bytes); },
    createObjectURL: () => 'blob:opening', revokeObjectURL: url => revoked.push(url),
  });
  assert.deepEqual(await Promise.all([resolver.url('backdrop'), resolver.url('backdrop')]), ['blob:opening', 'blob:opening']);
  assert.equal(reads, 1);
  resolver.dispose(); resolver.dispose();
  assert.deepEqual(revoked, ['blob:opening']);
  await assert.rejects(resolver.url('backdrop'), /已释放/);
});

test('文件丢失、内容损坏和超限返回明确错误，不创建 blob URL', async () => {
  for (const [response, message] of [[new Response('missing', { status: 404 }), /404/], [new Response('bad'), /完整性/]] as const) {
    const resolver = new OpeningPackageAssets('https://host/a/manifest.json', [asset], {
      fetch: async () => response, createObjectURL: () => { throw new Error('不应创建'); },
    });
    await assert.rejects(resolver.url('backdrop'), message); resolver.dispose();
  }
  const resolver = new OpeningPackageAssets('https://host/a/manifest.json', [asset], { fetch: async () => new Response(bytes), maxAssetBytes: 2 });
  await assert.rejects(resolver.url('backdrop'), /超过/); resolver.dispose();
});

test('准备期间取消会中止读取且迟到结果不能泄露 URL', async () => {
  let release!: (value: Response) => void;
  let fetchSignal: AbortSignal | null | undefined;
  let urls = 0;
  const resolver = new OpeningPackageAssets('https://host/a/manifest.json', [asset], {
    fetch: async (_url, init) => { fetchSignal = init?.signal; return new Promise(resolve => { release = resolve; }); },
    createObjectURL: () => { urls++; return 'blob:late'; },
  });
  const pending = resolver.url('backdrop'); resolver.dispose(); release(new Response(bytes));
  await assert.rejects(pending, /已释放|中止/);
  assert.equal(fetchSignal?.aborted, true); assert.equal(urls, 0);
});
