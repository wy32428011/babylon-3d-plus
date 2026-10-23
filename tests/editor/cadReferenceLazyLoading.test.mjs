import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createServer } from 'vite';

const fixture = [
  '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'OUTLINE', '10', '0', '20', '0', '11', '1000', '21', '2000',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

async function createCadServer(t, parserGate) {
  const transformed = [];
  const server = await createServer({ configFile: false, root: process.cwd(),
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
    plugins: [{ name: 'cad-lazy-module-observer',
      async load(id) {
        if (id.endsWith('/cadReferenceParser.ts') && parserGate) {
          parserGate.started();
          await parserGate.wait;
        }
        return null;
      },
      transform(_source, id) { transformed.push(id.replaceAll('\\', '/')); return null; },
    }],
  });
  t.after(() => server.close());
  return { server, transformed };
}

test('纯几何、缓存、Worker分流及流式模块不加载精确解析器，小文件实际解析才加载', async t => {
  const { server, transformed } = await createCadServer(t);
  const client = await server.ssrLoadModule('/src/editor/cad/cadReferenceWorkerClient.ts');
  const core = await server.ssrLoadModule('/src/editor/cad/cadReferenceCore.ts');
  const stream = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  assert.equal(typeof core.convertParsedCadReferenceDxf, 'function');
  assert.equal(typeof stream.parseCadReferenceDxfStream, 'function');
  assert.equal(client.shouldParseCadReferenceDxfInWorker(1024), false);
  assert.ok(!transformed.some(id => /cadReferenceParser|@linkiez\/dxf-renew/.test(id)), transformed.join('\n'));
  const result = await client.parseCadReferenceDxfForImport({ sourceUrl: 'cad://small', fileSizeBytes: 1024,
    readSmallFileText: async () => fixture, onProgress() {} });
  assert.equal(result.polylineCount, 1);
  assert.equal(result.pointCount, 2);
  assert.equal(result.unitScaleToMeters, 0.001);
  assert.deepEqual(result.bounds.size, { x: 1, y: 0, z: 2 });
  assert.ok(transformed.some(id => id.endsWith('/cadReferenceParser.ts')));
  assert.ok(transformed.some(id => id.includes('@linkiez/dxf-renew')));
});

test('同步兼容入口保留解析结果、单位覆盖和与生产Core共用的一次性缓存', async t => {
  const { server } = await createCadServer(t);
  const facade = await server.ssrLoadModule('/src/editor/cad/cadReference.ts');
  const core = await server.ssrLoadModule('/src/editor/cad/cadReferenceCore.ts');
  const parsed = facade.parseCadReferenceDxf(fixture);
  assert.equal(parsed instanceof Promise, false);
  assert.equal(parsed.unitScaleToMeters, 0.001);
  assert.deepEqual(parsed.bounds.size, { x: 1, y: 0, z: 2 });
  assert.deepEqual(facade.parseCadReferenceDxf(fixture, { unitScaleToMeters: 1 }).bounds.size, { x: 1000, y: 0, z: 2000 });
  facade.rememberCadReferenceParseResult('cad://shared-cache', parsed);
  assert.equal(core.consumeCadReferenceParseResult('cad://shared-cache', 0.001), parsed);
  assert.equal(facade.consumeCadReferenceParseResult('cad://shared-cache', 0.001), null);
});

test('精确解析器下载期间取消后不继续解析小文件', async t => {
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  const { server } = await createCadServer(t, { started: started.resolve, wait: gate.promise });
  const client = await server.ssrLoadModule('/src/editor/cad/cadReferenceWorkerClient.ts');
  const controller = new AbortController();
  const result = client.parseCadReferenceDxfForImport({ sourceUrl: 'cad://cancel', fileSizeBytes: 1024,
    signal: controller.signal, readSmallFileText: async () => 'not a valid DXF', onProgress() {} });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await started.promise;
  controller.abort();
  gate.resolve();
  await rejection;
});

function staticDependencyGraph(entry) {
  const files = new Set(), external = new Set(), pending = [path.resolve(entry)];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || statement.isTypeOnly) continue;
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : statement.exportClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings ?? clause;
      if (!clause?.name && bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
        && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) { external.add(specifier); continue; }
      const resolved = path.resolve(path.dirname(file), specifier);
      const candidates = [resolved, ...['.ts', '.tsx', '.cts', '.js', '/index.ts', '/index.tsx'].map(extension => resolved + extension)];
      if (resolved.endsWith('.js')) candidates.unshift(resolved.slice(0, -3) + '.ts');
      const target = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (target && /\.[cm]?[jt]sx?$/.test(target)) pending.push(target);
    }
  }
  return { files: [...files].map(file => file.replaceAll('\\', '/')), external };
}

test('真实生产入口静态依赖图不再到达兼容facade、精确解析器或第三方DXF parser', t => {
  for (const entry of ['src/editor/store/editorStore.ts', 'src/runtime/babylon/SceneRuntime.ts', 'src/editor/cad/cadReference.worker.ts']) {
    const graph = staticDependencyGraph(entry);
    assert.ok(!graph.files.some(file => /\/cadReference(?:Parser)?\.ts$/.test(file)), entry);
    assert.ok(!graph.external.has('@linkiez/dxf-renew'), entry);
    t.diagnostic(`${entry}: ${graph.files.length} 个静态源码模块，DXF parser 不可达`);
  }
});
