import assert from 'node:assert/strict';
import test from 'node:test';
import { createChartMarkerSurfaceUrl, getChartMarkerSurfaceSize, parseChartMarkerSurfaceResponse } from '../../src/runtime/babylon/chartMarkerSurfaceBridge.ts';

test('环形帧尺寸保留比例且有界', () => {
  assert.deepEqual(getChartMarkerSurfaceSize(320, 180), { width: 1280, height: 720 });
  for (const [width, height] of [[4096, 4096], [16, 4096], [4096, 16]]) {
    const size = getChartMarkerSurfaceSize(width, height);
    assert.ok(size.width >= 1 && size.height >= 1);
    assert.ok(size.width <= 2048 && size.height <= 2048 && size.width * size.height <= 2097152);
  }
});

test('嵌入曲面模式保留原有路由、查询与hash', () => {
  const url = new URL(createChartMarkerSurfaceUrl('https://example.test/?project=1#/screen/2?mode=live'));
  assert.equal(url.searchParams.get('zending3dSurface'), '1');
  assert.equal(url.searchParams.get('project'), '1');
  assert.equal(url.hash, '#/screen/2?mode=live');
});

test('仅接受当前请求的受限位图帧，拒绝任意URL、未知字段和超大内容', () => {
  const frame = { channel: 'babylon-chart-marker-surface', version: 1, type: 'frame', requestId: 'session:1', width: 10, height: 10, dataUrl: 'data:image/png;base64,aGVsbG8=' };
  assert.deepEqual(parseChartMarkerSurfaceResponse(frame, 'session:1'), frame);
  for (const value of [null, [], { ...frame, requestId: 'old:1' }, { ...frame, width: Infinity }, { ...frame, width: 2049 }, { ...frame, height: 1.5 }, { ...frame, dataUrl: 'https://private.test/image' }, { ...frame, dataUrl: 'data:image/svg+xml;base64,aGVsbG8=' }, { ...frame, extra: true }, { ...frame, dataUrl: 'data:image/png;base64,' + 'a'.repeat(4 * 1024 * 1024) }]) {
    assert.equal(parseChartMarkerSurfaceResponse(value, 'session:1'), null);
  }
  assert.ok(parseChartMarkerSurfaceResponse({ channel: frame.channel, version: 1, type: 'frame-error', requestId: frame.requestId, message: '页面没有授权当前来源' }, frame.requestId));
});
