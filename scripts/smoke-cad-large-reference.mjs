import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const inputPath = resolve(process.argv[2] ?? 'C:/Users/WY/Downloads/4-五期焊接物流配送路线图-26.1.10 (1).dxf');
const customBudget = process.env.CAD_SMOKE_GEOMETRY_BYTES ? { maxGeometryBytes: Number(process.env.CAD_SMOKE_GEOMETRY_BYTES) } : {};
let server;

try {
  const startedAt = Date.now();
  const source = await stat(inputPath);
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  const { parseCadReferenceDxfStream } = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const result = await parseCadReferenceDxfStream(async () => new Response(
    Readable.toWeb(createReadStream(inputPath, { highWaterMark: 1024 * 1024 })),
    { headers: { 'Content-Length': String(source.size) } },
  ), customBudget);
  const boundValues = [
    result.bounds.min.x, result.bounds.min.y, result.bounds.min.z,
    result.bounds.max.x, result.bounds.max.y, result.bounds.max.z,
  ];

  if (result.budgetLimited) throw new Error('目标大图纸仍触发默认几何预算，存在尾部图元丢失。');
  if (!boundValues.every((value) => Number.isFinite(value) && Math.abs(value) < 1e12)) {
    throw new Error('目标大图纸包围盒仍包含异常哨兵坐标。');
  }

  let packedPolylineCount = 0;
  let packedPointCount = 0;
  let sourcePolylineCount = 0;
  let sourcePointCount = 0;
  let instanceCount = 0;
  let compactBufferBytes = 0;
  for (const layer of result.layers) {
    const layerSourcePointCount = Array.from(layer.polylinePointCounts).reduce((sum, count) => sum + count, 0);
    const layerInstanceCount = layer.instanceCount ?? 1;
    if (layer.positions.length !== layerSourcePointCount * 3) throw new Error('CAD 紧凑位置缓冲区与原型点数不一致。');
    if (layer.instanceMatrices && layer.instanceMatrices.length !== layerInstanceCount * 16) {
      throw new Error('CAD 实例矩阵缓冲区与实例数量不一致。');
    }
    if (!layer.isChunk && layer.polylinePointCounts.length * layerInstanceCount !== layer.polylineCount) {
      throw new Error('CAD 原型折线数、实例数量与逻辑图层统计不一致。');
    }
    if (!layer.isChunk && layerSourcePointCount * layerInstanceCount !== layer.pointCount) {
      throw new Error('CAD 原型点数、实例数量与逻辑图层统计不一致。');
    }
    sourcePolylineCount += layer.polylinePointCounts.length;
    sourcePointCount += layerSourcePointCount;
    instanceCount += layer.instanceCount ?? 0;
    packedPolylineCount += layer.polylineCount;
    packedPointCount += layer.pointCount;
    compactBufferBytes += layer.positions.byteLength
      + layer.polylinePointCounts.byteLength
      + (layer.instanceMatrices?.byteLength ?? 0);
  }
  if (packedPolylineCount !== result.polylineCount || packedPointCount !== result.pointCount) {
    throw new Error('CAD 全局统计与图层紧凑缓冲区不一致。');
  }

  console.log(JSON.stringify({
    ok: true,
    inputPath,
    bytes: source.size,
    estimatedMemoryBytes: result.estimatedMemoryBytes,
    elapsedMs: Date.now() - startedAt,
    budgetLimited: result.budgetLimited,
    layers: result.layers.length,
    polylines: result.polylineCount,
    points: result.pointCount,
    sourcePolylines: sourcePolylineCount,
    sourcePoints: sourcePointCount,
    instances: instanceCount,
    compactBufferBytes,
    bounds: result.bounds,
    memory: process.memoryUsage(),
  }, null, 2));
} finally {
  await server?.close();
}
