import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('图表立标拖放输入与嵌套边界', async (t) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
  t.after(() => server.close());
  const { decodeDataPlatformScreenDragPayload: decode } = await server.ssrLoadModule('/src/editor/assets/dataPlatformScreenDrag.ts');
  const { canEmbedChartMarkerScreen } = await server.ssrLoadModule('/src/shared/chartMarkerEmbed.ts');
  const source = { chartType: 'SCREEN', projectId: '1', screenId: '2', name: '  能耗总览  ', screenUrl: 'https://example.com/#/screen/2' };
  const decoded = decode(JSON.stringify(source));
  assert.equal(decoded.name, '能耗总览');
  assert.equal(decoded.screenUrl, source.screenUrl);
  for (const raw of ['', '{', 'null', '[]', 'a'.repeat(16385)]) assert.equal(decode(raw), null);
  for (const screenUrl of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,hi', '/screen', '']) {
    assert.equal(decode(JSON.stringify({ ...source, screenUrl, thumbnailUrl: 'https://example.com/thumb.png' })), null);
  }
  assert.equal(decode(JSON.stringify({ ...source, chartType: 'BAR' })), null);
  const top = {};
  top.parent = top;
  let frame = top;
  for (let depth = 0; depth < 4; depth += 1) {
    assert.equal(canEmbedChartMarkerScreen(frame), true, `支持 ${depth} 层宿主页`);
    frame = { parent: frame };
  }
  assert.equal(canEmbedChartMarkerScreen(frame), false, '四层以上停止循环嵌套');
});
