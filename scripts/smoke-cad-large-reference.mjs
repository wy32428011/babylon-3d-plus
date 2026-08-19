import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const inputPath = resolve(process.argv[2] ?? 'F:/3d-models/test.dxf');
const customBudget = process.env.CAD_SMOKE_POLYLINES && process.env.CAD_SMOKE_POINTS
  ? {
      maxPolylines: Number(process.env.CAD_SMOKE_POLYLINES),
      maxPoints: Number(process.env.CAD_SMOKE_POINTS),
    }
  : null;
let server;

try {
  const startedAt = Date.now();
  const content = await readFile(inputPath, 'utf8');
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  const { parseLargeCadReferenceDxf } = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const result = customBudget
    ? parseLargeCadReferenceDxf(content, customBudget)
    : parseLargeCadReferenceDxf(content);
  const boundValues = [
    result.bounds.min.x, result.bounds.min.y, result.bounds.min.z,
    result.bounds.max.x, result.bounds.max.y, result.bounds.max.z,
  ];

  if (!customBudget && result.budgetLimited) throw new Error('目标大图纸仍触发默认几何预算，存在尾部图元丢失。');
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
    if (layer.polylinePointCounts.length * layerInstanceCount !== layer.polylineCount) {
      throw new Error('CAD 原型折线数、实例数量与逻辑图层统计不一致。');
    }
    if (layerSourcePointCount * layerInstanceCount !== layer.pointCount) {
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
    bytes: Buffer.byteLength(content),
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
