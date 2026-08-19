import assert from 'node:assert/strict';
import { LinesMesh, NullEngine, Scene, VertexData } from '@babylonjs/core';
import { createServer } from 'vite';

const fixture = [
  '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '2', 'B', '10', '1', '20', '2',
  '0', 'LINE', '8', 'B-LINE', '10', '1', '20', '2', '11', '3', '21', '2',
  '0', 'ENDBLK',
  '0', 'BLOCK', '2', 'A', '10', '0', '20', '0',
  '0', 'LINE', '8', 'A-LINE', '10', '0', '20', '0', '11', '1', '21', '0',
  '0', 'INSERT', '8', 'NESTED', '2', 'B', '10', '5', '20', '0',
  '0', 'ENDBLK',
  '0', 'BLOCK', '2', 'CYCLE', '10', '0', '20', '0',
  '0', 'INSERT', '8', 'CYCLE', '2', 'CYCLE', '10', '0', '20', '0',
  '0', 'ENDBLK', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'INSERT', '8', 'ROOT-A', '2', 'A', '10', '10', '20', '20', '41', '2', '42', '2', '50', '90',
  '0', 'INSERT', '8', 'ROOT-B', '2', 'B', '10', '0', '20', '0', '70', '2', '44', '3',
  '0', 'INSERT', '8', 'CYCLE', '2', 'CYCLE', '10', '0', '20', '0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

let server;
try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  const module = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const result = module.parseLargeCadReferenceDxf(fixture);
  const matrixLengths = result.layers
    .map((layer) => layer.instanceMatrices?.length ?? 0)
    .filter(Boolean)
    .sort((left, right) => left - right);

  assert.deepEqual(matrixLengths, [16, 16, 32]);
  assert.equal(result.polylineCount, 4);
  assert.equal(result.pointCount, 8);
  assert.equal(result.budgetLimited, false);
  assert.ok(Math.abs(result.bounds.size.x - 10) < 1e-6);
  assert.ok(Math.abs(result.bounds.size.z - 34) < 1e-6);
  assert.equal(result.layers.filter((layer) => layer.name === 'ROOT-A').length, 2);

  const arrayLayer = result.layers.find((layer) => layer.instanceCount === 2);
  assert.ok(arrayLayer?.instanceMatrices);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = new LinesMesh('cad-instance-smoke', scene, null, null, undefined, false, true);
  const vertexData = new VertexData();
  vertexData.positions = arrayLayer.positions;
  vertexData.indices = new Uint16Array([0, 1]);
  vertexData.applyToMesh(mesh, false);
  mesh.thinInstanceSetBuffer('matrix', arrayLayer.instanceMatrices, 16, true);
  mesh.thinInstanceRefreshBoundingInfo(true);
  assert.equal(mesh.thinInstanceCount, 2);
  scene.dispose();
  engine.dispose();
  console.log(JSON.stringify({ ok: true, matrixLengths, bounds: result.bounds }, null, 2));
} finally {
  await server?.close();
}
