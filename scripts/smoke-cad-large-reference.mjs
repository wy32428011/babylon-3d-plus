import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const inputPath = resolve(process.argv[2] ?? 'F:/3d-models/test.dxf');
let server;

try {
  const startedAt = Date.now();
  const content = await readFile(inputPath, 'utf8');
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  const { parseLargeCadReferenceDxf } = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const budget = { maxPolylines: Number(process.env.CAD_SMOKE_POLYLINES ?? 200000), maxPoints: Number(process.env.CAD_SMOKE_POINTS ?? 800000) };
  const result = parseLargeCadReferenceDxf(content, budget);
  const boundValues = [
    result.bounds.min.x, result.bounds.min.y, result.bounds.min.z,
    result.bounds.max.x, result.bounds.max.y, result.bounds.max.z,
  ];

  if (!result.budgetLimited) throw new Error('目标大图纸未触发几何预算。');
  if (result.polylineCount > budget.maxPolylines || result.pointCount > budget.maxPoints) throw new Error('目标大图纸超过预览几何预算。');
  if (!boundValues.every((value) => Number.isFinite(value) && Math.abs(value) < 1e12)) {
    throw new Error('目标大图纸包围盒仍包含异常哨兵坐标。');
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
    bounds: result.bounds,
    memory: process.memoryUsage(),
  }, null, 2));
} finally {
  await server?.close();
}
