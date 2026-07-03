import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const inputPath = process.argv[2]
  ?? 'F:\\3d-models\\【ZDRD98-智能仓储】设备接入图纸.dxf';

const absoluteInputPath = resolve(inputPath);

let server;

try {
  const startedAt = Date.now();
  const content = await readFile(absoluteInputPath, 'utf8');

  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const {
    consumeCadReferenceParseResult,
    createCadReferenceComponentMetadata,
    parseCadReferenceDxf,
    rememberCadReferenceParseResult,
  } = await server.ssrLoadModule('/src/editor/cad/cadReference.ts');
  const result = parseCadReferenceDxf(content);
  const metadata = createCadReferenceComponentMetadata(result);
  const cacheSourceUrl = `editor-asset://local/${encodeURIComponent(absoluteInputPath)}`;

  rememberCadReferenceParseResult(cacheSourceUrl, result);
  const cachedResult = consumeCadReferenceParseResult(cacheSourceUrl, result.unitScaleToMeters);
  const cachedAgain = consumeCadReferenceParseResult(cacheSourceUrl, result.unitScaleToMeters);
  if (cachedResult !== result || cachedAgain !== null) {
    throw new Error('CAD 解析缓存未按一次性复用语义工作。');
  }

  console.log(JSON.stringify({
    ok: true,
    filePath: absoluteInputPath,
    bytes: Buffer.byteLength(content),
    unitScaleToMeters: result.unitScaleToMeters,
    metadataOriginMode: metadata.originMode,
    metadataLineColor: metadata.lineColor,
    cacheReuseOk: true,
    layers: result.layerStats.length,
    polylines: result.polylineCount,
    points: result.pointCount,
    bounds: result.bounds,
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server?.close();
}
