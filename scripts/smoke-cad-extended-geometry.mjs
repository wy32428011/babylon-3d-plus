import assert from 'node:assert/strict';
import { createServer } from 'vite';

const content = [
  '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'HATCH', '8', 'HATCH_BOUNDARY', '10', '0', '20', '0', '30', '0', '70', '1', '91', '1',
  '92', '3', '72', '0', '73', '1', '93', '4',
  '10', '0', '20', '0', '10', '2', '20', '0', '10', '2', '20', '2', '10', '0', '20', '2', '97', '0',
  '0', 'SOLID', '8', 'SOLID_OUTLINE',
  '10', '4', '20', '0', '11', '6', '21', '0', '12', '6', '22', '2', '13', '4', '23', '2',
  '0', 'LEADER', '8', 'LEADER_PATH', '76', '3',
  '10', '8', '20', '0', '10', '9', '20', '1', '10', '10', '20', '0',
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
  const exactModule = await server.ssrLoadModule('/src/editor/cad/cadReference.ts');
  const largeModule = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  const exact = exactModule.parseCadReferenceDxf(content);
  const large = largeModule.parseLargeCadReferenceDxf(content);

  for (const result of [exact, large]) {
    assert.equal(result.budgetLimited, false);
    assert.equal(result.polylineCount, 3);
    assert.equal(result.layers.find((layer) => layer.name === 'HATCH_BOUNDARY')?.polylineCount, 1);
    assert.equal(result.layers.find((layer) => layer.name === 'SOLID_OUTLINE')?.polylineCount, 1);
    assert.equal(result.layers.find((layer) => layer.name === 'LEADER_PATH')?.polylineCount, 1);
  }

  assert.deepEqual(
    large.layers.map((layer) => [layer.name, Array.from(layer.polylinePointCounts)]),
    exact.layers.map((layer) => [layer.name, Array.from(layer.polylinePointCounts)]),
  );
  console.log(JSON.stringify({ ok: true, polylines: exact.polylineCount }, null, 2));
} finally {
  await server?.close();
}
