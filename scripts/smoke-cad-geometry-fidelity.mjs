import assert from 'node:assert/strict';
import { createServer } from 'vite';

function createCadGeometryFixture() {
  const lines = [];
  for (let index = 0; index < 130; index += 1) {
    lines.push(
      '0', 'LINE', '8', 'BLOCK_LINES',
      '10', String(index), '20', '0',
      '11', String(index), '21', '1',
    );
  }

  return [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$INSUNITS', '70', '6',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', 'FULL_BLOCK', '3', 'FULL_BLOCK', '70', '0', '10', '0', '20', '0', '30', '0',
    ...lines,
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', 'BLOCK_INSERT', '2', 'FULL_BLOCK', '10', '0', '20', '0', '41', '1', '42', '1', '50', '0',
    '0', 'LINE', '8', 'ORIENTATION', '10', '0', '20', '0', '11', '0', '21', '2',
    '0', 'ELLIPSE', '8', 'ELLIPSE', '10', '0', '20', '0', '11', '2', '21', '0', '40', '0.5', '41', '0', '42', String(Math.PI * 2),
    '0', 'SPLINE', '8', 'SPLINE', '70', '8', '71', '2', '72', '6', '73', '3',
    '40', '0', '40', '0', '40', '0', '40', '1', '40', '1', '40', '1',
    '10', '0', '20', '0', '30', '0',
    '10', '1', '20', '2', '30', '0',
    '10', '2', '20', '0', '30', '0',
    '0', 'ENDSEC',
    '0', 'EOF',
    '',
  ].join('\n');
}

function assertPackedGeometry(result) {
  let polylineCount = 0;
  let pointCount = 0;
  for (const layer of result.layers) {
    const layerPointCount = Array.from(layer.polylinePointCounts).reduce((sum, count) => sum + count, 0);
    assert.equal(layer.positions.length, layerPointCount * 3);
    assert.ok(layer.positions.every(Number.isFinite), 'CAD 紧凑位置缓冲区不得包含 NaN/Infinity');
    assert.equal(layer.polylinePointCounts.length, layer.polylineCount);
    assert.equal(layerPointCount, layer.pointCount);
    polylineCount += layer.polylineCount;
    pointCount += layer.pointCount;
  }
  assert.equal(polylineCount, result.polylineCount);
  assert.equal(pointCount, result.pointCount);
}

function assertSameGeometry(actual, expected) {
  assert.equal(actual.polylineCount, expected.polylineCount);
  assert.equal(actual.pointCount, expected.pointCount);
  assert.deepEqual(actual.bounds, expected.bounds);
  assert.equal(actual.layers.length, expected.layers.length);
  for (let index = 0; index < actual.layers.length; index += 1) {
    const actualLayer = actual.layers[index];
    const expectedLayer = expected.layers[index];
    assert.equal(actualLayer.name, expectedLayer.name);
    assert.deepEqual(Array.from(actualLayer.polylinePointCounts), Array.from(expectedLayer.polylinePointCounts));
    assert.deepEqual(Array.from(actualLayer.positions), Array.from(expectedLayer.positions));
  }
}

let server;
try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  const exactModule = await server.ssrLoadModule('/src/editor/cad/cadReference.ts');
  const largeModule = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const content = createCadGeometryFixture();
  const exact = exactModule.parseCadReferenceDxf(content);
  const large = largeModule.parseLargeCadReferenceDxf(content);

  assert.equal(exact.polylineCount, 133, '130 条块内 LINE 与 3 条顶层图元必须全部保留');
  assert.equal(large.budgetLimited, false, '默认大文件路径不得按旧的每块 128 图元上限截断');
  assertPackedGeometry(exact);
  assertPackedGeometry(large);
  assertSameGeometry(large, exact);

  const blockLayer = large.layers.find((layer) => layer.name === 'BLOCK_INSERT');
  assert.equal(blockLayer?.polylineCount, 130, 'INSERT 引用的完整块几何必须保留');
  const ellipseLayer = large.layers.find((layer) => layer.name === 'ELLIPSE');
  assert.ok((ellipseLayer?.polylinePointCounts[0] ?? 0) > 2, 'ELLIPSE 必须转换为可见折线');
  const splineLayer = large.layers.find((layer) => layer.name === 'SPLINE');
  assert.ok((splineLayer?.polylinePointCounts[0] ?? 0) > 2, 'SPLINE 必须转换为可见折线');
  const splineZValues = splineLayer
    ? Array.from({ length: splineLayer.positions.length / 3 }, (_, index) => splineLayer.positions[index * 3 + 2])
    : [];
  assert.ok(
    splineZValues.length > 2 && Math.max(...splineZValues) > Math.max(splineZValues[0], splineZValues[splineZValues.length - 1]),
    'SPLINE 采样必须保留控制点形成的曲率，而不是退化为端点直线',
  );

  const orientationLayer = large.layers.find((layer) => layer.name === 'ORIENTATION');
  assert.equal(orientationLayer?.polylineCount, 1);
  assert.ok(
    orientationLayer && orientationLayer.positions[5] > orientationLayer.positions[2],
    'DXF 正 Y 必须映射到 Babylon 正 Z，避免俯视图上下镜像',
  );

  const limited = largeModule.parseLargeCadReferenceDxf(content, { maxPolylines: 10, maxPoints: 20 });
  assert.equal(limited.budgetLimited, true, '显式低预算仍必须提供极端文件保护');
  assert.ok(limited.polylineCount <= 10 && limited.pointCount <= 20);

  console.log(JSON.stringify({
    ok: true,
    exactPolylines: exact.polylineCount,
    exactPoints: exact.pointCount,
    largePolylines: large.polylineCount,
    largePoints: large.pointCount,
    blockPolylineCount: blockLayer?.polylineCount,
    ellipsePointCount: ellipseLayer?.polylinePointCounts[0],
    splinePointCount: splineLayer?.polylinePointCounts[0],
    orientationStartZ: orientationLayer?.positions[2],
    orientationEndZ: orientationLayer?.positions[5],
  }, null, 2));
} finally {
  await server?.close();
}
