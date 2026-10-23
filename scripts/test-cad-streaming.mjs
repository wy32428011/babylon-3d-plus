import assert from 'node:assert/strict';
import { createP4SsrTestModules } from '../tests/helpers/p4SsrTestModules.mjs';

const pairs = (...groups) => `${groups.flat(Infinity).join('\n')}\n`;
const document = (entities, blocks = [], header = []) => pairs(
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1032',
  '9', '$DWGCODEPAGE', '3', 'ANSI_936', '9', '$INSUNITS', '70', '6', header,
  '0', 'ENDSEC', '0', 'SECTION', '2', 'BLOCKS', blocks, '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', entities, '0', 'ENDSEC', '0', 'EOF',
);
const line = (layer = '路线', x = 0, y = 0) => ['0', 'LINE', '8', layer, '10', x, '20', y, '11', x + 2, '21', y + 1];
const block = (name, entities, x = 0, y = 0) => ['0', 'BLOCK', '2', name, '10', x, '20', y, entities, '0', 'ENDBLK'];
const insert = (layer, name, x = 0, y = 0, extra = []) => ['0', 'INSERT', '8', layer, '2', name, '10', x, '20', y, extra];

function source(text, { chunkSize = 137, headers = {}, onCancel } = {}) {
  const bytes = new TextEncoder().encode(text);
  return () => Promise.resolve(new Response(new ReadableStream({
    start() { this.offset = 0; },
    pull(controller) {
      if (this.offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(this.offset, this.offset + chunkSize));
      this.offset += chunkSize;
    },
    cancel() { onCancel?.(); },
  }), { headers }));
}

function expandedCoordinates(result) {
  const output = [];
  for (const layer of result.layers) {
    for (let instance = 0; instance < (layer.instanceCount ?? 1); instance += 1) {
      const matrix = layer.instanceMatrices?.subarray(instance * 16, instance * 16 + 16);
      let offset = 0;
      for (const count of layer.polylinePointCounts) {
        const points = [];
        for (let point = 0; point < count; point += 1) {
          const x = layer.positions[offset * 3];
          const z = layer.positions[offset * 3 + 2];
          points.push(matrix ? [matrix[0] * x + matrix[8] * z + matrix[12], matrix[2] * x + matrix[10] * z + matrix[14]] : [x, z]);
          offset += 1;
        }
        output.push(JSON.stringify([layer.name, points.map(([x, z]) => [Math.round(x * 1e5) / 1e5, Math.round(z * 1e5) / 1e5])]));
      }
    }
  }
  return output.sort();
}

let server;
let passed = 0;
async function check(name, test) {
  await test();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
try {
  server = await createP4SsrTestModules([
    '/src/editor/cad/cadReferenceLargeDxf.ts',
  ]);
  const { parseLargeCadReferenceDxf, parseCadReferenceDxfStream } = await server.ssrLoadModule('/src/editor/cad/cadReferenceLargeDxf.ts');
  assert.equal(typeof parseCadReferenceDxfStream, 'function', '新增流式入口必须存在');

  await check('未知长度、跨块中文和 CRLF；两遍结果与旧解析一致', async () => {
    const text = document([line(), ['0', 'ARC', '8', '弧线', '10', 0, '20', 0, '40', 2, '50', 0, '51', 90]]).replaceAll('\n', '\r\n');
    let opens = 0;
    const open = source(text, { chunkSize: 7 });
    const result = await parseCadReferenceDxfStream(async () => { opens += 1; const response = await open();
      response.arrayBuffer = () => { throw new Error('禁止整文件聚合'); }; return response; });
    const legacy = parseLargeCadReferenceDxf(text);
    assert.equal(opens, 2);
    assert.deepEqual(expandedCoordinates(result), expandedCoordinates(legacy));
    assert.deepEqual(result.bounds, legacy.bounds);
    assert.deepEqual(result.layerStats, legacy.layerStats);
    assert.equal(result.budgetLimited, false);
    assert.ok(result.estimatedMemoryBytes > 0);
  });

  await check('嵌套、阵列、基点、法线与环引用沿用既有语义', async () => {
    const text = document([
      insert('最外层', 'A', 10, 20, ['41', 2, '42', 3, '50', 90]),
      insert('第二组', 'B', 0, 0, ['70', 2, '71', 2, '44', 3, '45', 4, '230', -1]),
      insert('环', 'C'),
    ], [block('A', [line('原生', 1, 2), insert('子层', 'B', 4, 5)], 1, 2), block('B', line('原生B', 2, 3), 2, 3), block('C', insert('环', 'C'))]);
    const result = await parseCadReferenceDxfStream(source(text));
    const legacy = parseLargeCadReferenceDxf(text);
    assert.deepEqual(expandedCoordinates(result), expandedCoordinates(legacy));
    assert.deepEqual(result.bounds, legacy.bounds);
    assert.equal(result.pointCount, legacy.pointCount);
    const groups = result.layers.filter((layer) => layer.name === '最外层' || layer.name === '第二组');
    const shared = groups.find((layer) => layer.name === '第二组');
    assert.ok(shared);
    assert.ok(groups.some((layer) => layer !== shared && layer.positions === shared.positions && layer.polylinePointCounts === shared.polylinePointCounts));
  });

  await check('长线保留衔接点；每批最多 60,000 点 / 4,000 折线，逻辑统计不含续段', async () => {
    const vertices = [];
    for (let index = 0; index < 65002; index += 1) vertices.push('10', index, '20', index % 3);
    const result = await parseCadReferenceDxfStream(source(document(['0', 'LWPOLYLINE', '8', '长线', vertices]), { chunkSize: 65536 }));
    assert.equal(result.polylineCount, 1);
    assert.equal(result.pointCount, 65002);
    assert.equal(result.layers.length, 2);
    for (const layer of result.layers) {
      assert.ok(layer.isChunk);
      assert.ok(layer.positions.length <= 60000 * 3);
      assert.ok(layer.polylinePointCounts.length <= 4000);
    }
    assert.equal(result.layers.reduce((sum, layer) => sum + layer.polylineCount, 0), 1);
    assert.equal(result.layers.reduce((sum, layer) => sum + layer.pointCount, 0), 65002);
    assert.deepEqual([...result.layers[0].positions.slice(-3)], [...result.layers[1].positions.slice(0, 3)]);
  });

  await check('折线批次数及只构建可达原型', async () => {
    const lines = [];
    for (let index = 0; index < 4101; index += 1) lines.push(line('原生', index));
    const text = document(insert('显示', 'B'), [block('B', lines), block('未使用', lines)]);
    const result = await parseCadReferenceDxfStream(source(text, { chunkSize: 65536 }));
    assert.equal(result.layers.length, 2);
    assert.equal(result.polylineCount, 4101);
    assert.equal(result.pointCount, 8202);
    assert.equal(result.layers[0].polylinePointCounts.length, 4000);
    assert.deepEqual(result.layerStats, [{ name: '显示', entityCount: 4101, polylineCount: 4101, pointCount: 8202 }]);
    await assert.rejects(parseCadReferenceDxfStream(source(text), { maxGeometryBytes: 1024 }), /几何.*预算|内存.*预算/);
  });

  await check('两遍输入头部变化必须拒绝', async () => {
    let pass = 0;
    const text = document(line());
    await assert.rejects(parseCadReferenceDxfStream(() => source(text, { headers: { etag: String(pass++) } })()), /变化|一致/);
  });
  await check('两遍相同长度字节变化也必须拒绝', async () => {
    let pass = 0;
    await assert.rejects(parseCadReferenceDxfStream(() => source(document(line('路线', pass++)))()), /变化|一致/);
  });
  await check('取消必须关闭当前 reader，保留 AbortError', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const text = document(Array.from({ length: 1000 }, (_, index) => line('线路', index)));
    await assert.rejects(parseCadReferenceDxfStream(source(text, { onCancel: () => { cancelled += 1; } }), {
      signal: controller.signal, onProgress: () => controller.abort(),
    }), (error) => error.name === 'AbortError');
    assert.ok(cancelled >= 1);
  });
  await check('过长行、单实体与过大阵列明确失败', async () => {
    await assert.rejects(parseCadReferenceDxfStream(source(document(line('x'.repeat(1024 * 1024 + 1))), { chunkSize: 65536 })), /行.*上限/);
    const groups = Array.from({ length: 270000 }, () => ['100', 'AcDbEntity']);
    await assert.rejects(parseCadReferenceDxfStream(source(document(['0', 'LINE', groups]), { chunkSize: 65536 })), /实体.*上限/);
    await assert.rejects(parseCadReferenceDxfStream(source(document(insert('阵列', 'B', 0, 0, ['70', 4097]), block('B', line())))), /阵列.*上限/);
    await assert.rejects(parseCadReferenceDxfStream(source(document(['0', 'ARC', '10', 0, '20', 0, '40', 1, '50', '1e300', '51', 0]))), /单实体.*上限/);
  });
  console.log(JSON.stringify({ ok: true, passed }));
} finally {
  await server?.close();
}
