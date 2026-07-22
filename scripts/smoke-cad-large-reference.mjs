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
  if (customBudget && (result.polylineCount > customBudget.maxPolylines || result.pointCount > customBudget.maxPoints)) {
    throw new Error('目标大图纸超过显式 smoke 几何预算。');
  }
  if (!boundValues.every((value) => Number.isFinite(value) && Math.abs(value) < 1e12)) {
    throw new Error('目标大图纸包围盒仍包含异常哨兵坐标。');
  }

  let packedPolylineCount = 0;
  let packedPointCount = 0;
  let compactBufferBytes = 0;
  for (const layer of result.layers) {
    const layerPointCount = Array.from(layer.polylinePointCounts).reduce((sum, count) => sum + count, 0);
    if (layer.positions.length !== layerPointCount * 3) throw new Error('CAD 紧凑位置缓冲区与折线点数不一致。');
    if (layer.polylinePointCounts.length !== layer.polylineCount) throw new Error('CAD 折线计数缓冲区与图层统计不一致。');
    if (layerPointCount !== layer.pointCount) throw new Error('CAD 图层点数统计与紧凑缓冲区不一致。');
    packedPolylineCount += layer.polylinePointCounts.length;
    packedPointCount += layerPointCount;
    compactBufferBytes += layer.positions.byteLength + layer.polylinePointCounts.byteLength;
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
    compactBufferBytes,
    bounds: result.bounds,
    memory: process.memoryUsage(),
  }, null, 2));
} finally {
  await server?.close();
}
