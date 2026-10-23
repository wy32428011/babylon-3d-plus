import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Geometry, Matrix, Mesh, MeshBuilder, NullEngine, Scene, SubMesh, VertexBuffer } from '@babylonjs/core';
import { lightingContentHash } from '../../electron/shared/sceneLightingBakeContract.ts';
import type { LightingRuntimeSource } from '../../src/runtime/babylon/lightingClassificationRuntime.ts';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
    const file = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(file)) return { url: file.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts');
const { LightingGeometrySignatureCache, LIGHTING_GEOMETRY_SIGNATURE_CACHE_MAX_BYTES } = await import('../../src/runtime/babylon/lightingGeometrySignatureCache.ts');
hooks.deregister();

function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('signature-source', { updatable: true }, scene);
  for (const kind of [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind]) {
    mesh.setVerticesData(kind, new Float32Array(mesh.getVerticesData(kind)!), true);
  }
  mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(mesh.getVerticesData(VertexBuffer.UVKind)!), true);
  mesh.setVerticesData(VertexBuffer.ColorKind, new Float32Array(mesh.getTotalVertices() * 4).fill(.5), true);
  mesh.setVerticesData(VertexBuffer.TangentKind, new Float32Array(mesh.getTotalVertices() * 4).fill(.25), true);
  mesh.setIndices(new Uint16Array(mesh.getIndices()!));
  const source = { mesh, entry: { key: 'entity/mesh', entityId: 'entity', nodeKey: 'mesh', name: mesh.name,
    mobility: 'static', reason: 'test', parentDynamic: false, bakeIndirect: true, castShadows: true, receiveShadows: true },
    getWorldMatrix: () => mesh.computeWorldMatrix(true) } as LightingRuntimeSource;
  return { engine, scene, mesh, source, sources: [source], dispose() { scene.dispose(); engine.dispose(); } };
}

// 独立保留原算法作为契约依据，不能从新缓存实现推导期望值。
function originalSignature(sources: readonly LightingRuntimeSource[]) {
  const cache = new Map<object, string>();
  const entries = sources.filter(source => source.entry.mobility === 'static' && !source.mesh.isDisposed()
    && source.mesh.isEnabled() && source.mesh.isVisible && source.mesh.visibility > 0)
    .sort((a, b) => a.entry.key.localeCompare(b.entry.key)).map(source => {
      const mesh = source.mesh;
      let geometry = cache.get(mesh);
      if (!geometry) {
        const values = (kind: string) => { const data = mesh.getVerticesData(kind); return data ? Array.from(data) : null; };
        geometry = lightingContentHash({ positions: values(VertexBuffer.PositionKind), normals: values(VertexBuffer.NormalKind),
          indices: Array.from(mesh.getIndices() ?? []), uvs: values(VertexBuffer.UVKind), uvs2: values(VertexBuffer.UV2Kind),
          colors: mesh.useVertexColors ? values(VertexBuffer.ColorKind) : null, tangents: values(VertexBuffer.TangentKind),
          subMeshes: mesh.subMeshes.map(part => [part.materialIndex, part.indexStart, part.indexCount]) });
        cache.set(mesh, geometry);
      }
      return [source.entry.key, geometry, Array.from(source.getWorldMatrix()!.m), source.entry.bakeIndirect,
        source.entry.castShadows, source.entry.receiveShadows];
    });
  return `geometry-v1-${lightingContentHash(entries)}`;
}

test('完整几何签名严格保留原geometry-v1，重复dirty不再重新逐数字编码顶点', t => {
  const f = fixture();
  try {
    const expected = originalSignature(f.sources), stringify = JSON.stringify;
    let numbers = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') numbers++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    });
    assert.equal(getLightingGeometrySignature(f.sources), expected);
    numbers = 0;
    for (let i = 0; i < 4; i++) assert.equal(getLightingGeometrySignature(f.sources), expected);
    assert.equal(numbers, 4 * 16, '暖缓存仍编码每次真实世界矩阵，但不能重新编码相同顶点');
  } finally { f.dispose(); }
});

test('所有属性、索引、subMesh及顶点色开关的无通知同帧修改均与原算法一致', () => {
  const f = fixture();
  try {
    let before = getLightingGeometrySignature(f.sources);
    for (const kind of [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind, VertexBuffer.UV2Kind,
      VertexBuffer.ColorKind, VertexBuffer.TangentKind]) {
      f.mesh.getVerticesData(kind)![0] += .125;
      const after = getLightingGeometrySignature(f.sources);
      assert.equal(after, originalSignature(f.sources)); assert.notEqual(after, before, kind); before = after;
    }
    f.mesh.getIndices()![0] = 2;
    let after = getLightingGeometrySignature(f.sources);
    assert.equal(after, originalSignature(f.sources)); assert.notEqual(after, before); before = after;
    f.mesh.subMeshes[0].materialIndex++;
    after = getLightingGeometrySignature(f.sources);
    assert.equal(after, originalSignature(f.sources)); assert.notEqual(after, before); before = after;
    f.mesh.useVertexColors = false;
    after = getLightingGeometrySignature(f.sources);
    assert.equal(after, originalSignature(f.sources)); assert.notEqual(after, before);
    f.mesh.getVerticesData(VertexBuffer.ColorKind)![0] += .5;
    assert.equal(getLightingGeometrySignature(f.sources), after, '关闭顶点色时颜色数据不属于原签名');
    f.mesh.releaseSubMeshes(); new SubMesh(0, 0, f.mesh.getTotalVertices(), 0, 3, f.mesh);
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
  } finally { f.dispose(); }
});

test('世界变换、显隐、分类标记、Geometry替换与来源顺序继续当帧生效', () => {
  const f = fixture();
  try {
    const check = () => assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
    check(); f.mesh.position.x += 1; check(); f.mesh.setPreTransformMatrix(Matrix.Translation(1, 2, 3)); check();
    f.source.entry.castShadows = false; check(); f.source.entry.receiveShadows = false; check(); f.source.entry.bakeIndirect = false; check();
    f.mesh.visibility = 0; check(); f.mesh.visibility = 1; f.mesh.isVisible = false; check(); f.mesh.isVisible = true;
    const replacement = f.mesh.geometry!.copy('replacement'); replacement.applyToMesh(f.mesh); check();
    f.sources.push({ ...f.source, entry: { ...f.source.entry, key: 'aaa' } }); check(); f.sources.reverse(); check();
  } finally { f.dispose(); }
});

test('未知自定义reader与数据iterator保持原读取顺序、次数和异常，不从Geometry猜测输入', () => {
  const f = fixture();
  try {
    const original = f.mesh.getVerticesData, calls: string[] = [], failure = new Error('reader failure');
    let fail = false;
    f.mesh.getVerticesData = function (kind, ...args) {
      calls.push(kind); if (fail && kind === VertexBuffer.UVKind) throw failure;
      return Reflect.apply(original, this, [kind, ...args]);
    };
    const expected = originalSignature(f.sources), order = calls.slice(); calls.length = 0;
    assert.equal(getLightingGeometrySignature(f.sources), expected); assert.deepEqual(calls, order);
    calls.length = 0; fail = true;
    assert.throws(() => getLightingGeometrySignature(f.sources), error => error === failure);
    assert.deepEqual(calls, [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind]);
    fail = false;
    const data = f.mesh.getVerticesData(VertexBuffer.PositionKind)! as Float32Array;
    let iterations = 0;
    Object.defineProperty(data, Symbol.iterator, { configurable: true, value: function* () { iterations++; yield .5; yield 1; yield 2; } });
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
    assert.equal(iterations, 2);
  } finally { f.dispose(); }
});

test('普通number数组暖刷新免Array.from，数组accessor仍按原iterator顺序只读取一次', t => {
  const engine = new NullEngine(), scene = new Scene(engine), mesh = MeshBuilder.CreateBox('plain-arrays', {}, scene);
  const cache = new LightingGeometrySignatureCache();
  try {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)! as number[], arrayFrom = Array.from;
    assert.ok(Array.isArray(positions));
    const expected = cache.getHash(mesh);
    let copies = 0, reads = 0;
    t.mock.method(Array, 'from', function (value: unknown, ...args: unknown[]) {
      if (value === positions) copies++;
      return Reflect.apply(arrayFrom, Array, [value, ...args]);
    });
    const original = positions[0];
    Object.defineProperty(positions, 0, { configurable: true, enumerable: true, get() { reads++; return original; } });
    assert.equal(cache.getHash(mesh), expected); assert.equal(copies, 0); assert.equal(reads, 1);
    Object.defineProperty(positions, 0, { configurable: true, enumerable: true, writable: true, value: original + .25 });
    assert.notEqual(cache.getHash(mesh), expected);
    assert.equal(cache.getHash(mesh), cache.getHash(mesh));
  } finally { scene.dispose(); engine.dispose(); }
});

test('共享CPU视图只保留一份快照，原位修改不污染另一个宿主的旧基线', () => {
  const f = fixture(), cache = new LightingGeometrySignatureCache();
  try {
    const clone = new Mesh('same-view-new-geometry', f.scene);
    const positions = f.mesh.getVerticesData(VertexBuffer.PositionKind)! as Float32Array;
    clone.setVerticesData(VertexBuffer.PositionKind, positions);
    clone.setIndices(new Uint16Array(0));
    const first = new Mesh('first-shared', f.scene);
    first.setVerticesData(VertexBuffer.PositionKind, positions);
    first.setIndices(new Uint16Array(0));
    const before = cache.getHash(first), used = cache.getMetrics().retainedSnapshotBytes;
    assert.equal(used, positions.byteLength);
    assert.equal(cache.getHash(clone), before); assert.equal(cache.getMetrics().retainedSnapshotBytes, used);
    positions[0] += .75;
    const updated = cache.getHash(clone); assert.notEqual(updated, before);
    assert.equal(cache.getMetrics().retainedSnapshotBytes, used * 2, '另一个宿主仍保留旧快照，不能原地覆盖它');
    assert.equal(cache.getHash(first), updated); assert.equal(cache.getMetrics().retainedSnapshotBytes, used);
    clone.dispose(); assert.equal(cache.getMetrics().retainedSnapshotBytes, used);
    first.dispose(); assert.equal(cache.getMetrics().retainedSnapshotBytes, 0);
  } finally { f.dispose(); }
});

test('总快照预算有硬上限，超预算仍逐轮精确编码，dispose释放后可继续缓存其他场景', t => {
  const f = fixture(), cache = new LightingGeometrySignatureCache(32), stringify = JSON.stringify;
  try {
    assert.equal(new LightingGeometrySignatureCache(Number.MAX_SAFE_INTEGER).getMetrics().budgetBytes, LIGHTING_GEOMETRY_SIGNATURE_CACHE_MAX_BYTES);
    assert.equal(LIGHTING_GEOMETRY_SIGNATURE_CACHE_MAX_BYTES, 16 * 1024 * 1024);
    let numbers = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') numbers++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    });
    const before = cache.getHash(f.mesh); numbers = 0;
    assert.equal(cache.getHash(f.mesh), before); assert.ok(numbers > 32);
    assert.equal(cache.getMetrics().retainedSnapshotBytes, 0);
    f.mesh.getVerticesData(VertexBuffer.UVKind)![0] += .5;
    assert.notEqual(cache.getHash(f.mesh), before, '超预算不能省略原位修改检测');
    const small = new Mesh('small', f.scene); small.setVerticesData(VertexBuffer.PositionKind, new Float32Array([0, 0, 0])); small.setIndices(new Uint16Array(0));
    cache.getHash(small); assert.equal(cache.getMetrics().retainedSnapshotBytes, 12);
    small.dispose(); assert.equal(cache.getMetrics().retainedSnapshotBytes, 0);
    const another = new Scene(f.engine), second = new Mesh('small', another);
    second.setVerticesData(VertexBuffer.PositionKind, new Float32Array([1, 0, 0])); second.setIndices(new Uint16Array(0));
    cache.getHash(second); assert.equal(cache.getMetrics().retainedSnapshotBytes, 12);
    another.dispose(); assert.equal(cache.getMetrics().retainedSnapshotBytes, 0);
  } finally { f.dispose(); }
});

test('连续真实变更不累积dispose回调，显式释放也不保留快照', () => {
  const f = fixture(), cache = new LightingGeometrySignatureCache();
  try {
    const before = f.mesh.onDisposeObservable.observers.length;
    for (let i = 0; i < 20; i++) {
      f.mesh.getVerticesData(VertexBuffer.PositionKind)![0] += .1; cache.getHash(f.mesh);
      assert.equal(f.mesh.onDisposeObservable.observers.length, before + 1);
      assert.ok(cache.getMetrics().retainedSnapshotBytes <= cache.getMetrics().budgetBytes);
    }
    f.mesh.dispose(); assert.equal(cache.getMetrics().retainedSnapshotBytes, 0);
    cache.getHash(f.mesh); assert.equal(cache.getMetrics().retainedSnapshotBytes, 0);
  } finally { f.dispose(); }
});

test('运行时覆盖Geometry原型reader保守回退，公开isDisposed调用次数保持原路径', t => {
  const f = fixture();
  try {
    getLightingGeometrySignature(f.sources);
    const original = Geometry.prototype.getVerticesData, order: string[] = [];
    t.mock.method(Geometry.prototype, 'getVerticesData', function (kind: string, ...args: unknown[]) {
      order.push(kind); return Reflect.apply(original, this, [kind, ...args]);
    });
    const expected = originalSignature(f.sources), expectedOrder = order.slice(); order.length = 0;
    assert.equal(getLightingGeometrySignature(f.sources), expected); assert.deepEqual(order, expectedOrder);
    const isDisposed = f.mesh.isDisposed; let calls = 0;
    f.mesh.isDisposed = function () { calls++; return Reflect.apply(isDisposed, this, []); };
    originalSignature(f.sources); const originalCalls = calls; calls = 0;
    getLightingGeometrySignature(f.sources); assert.equal(calls, originalCalls);
  } finally { f.dispose(); }
});

test('交错buffer的stride/offset及索引TypedArray类型替换仍使用原解码序列', () => {
  const f = fixture();
  try {
    const positions = Array.from(f.mesh.getVerticesData(VertexBuffer.PositionKind)!);
    getLightingGeometrySignature(f.sources);
    f.mesh.setIndices(new Uint32Array(f.mesh.getIndices()!));
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
    const interleaved = new Float32Array(positions.length * 2);
    for (let i = 0; i < positions.length; i++) interleaved[Math.floor(i / 3) * 6 + 3 + i % 3] = positions[i];
    f.mesh.setVerticesBuffer(new VertexBuffer(f.engine, interleaved, VertexBuffer.PositionKind,
      { updatable: true, stride: 6, offset: 3, size: 3 }));
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
    const before = getLightingGeometrySignature(f.sources);
    interleaved[3] += .75;
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
    assert.notEqual(getLightingGeometrySignature(f.sources), before);
    f.mesh.getVertexBuffer(VertexBuffer.PositionKind)!.byteOffset = 0;
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
  } finally { f.dispose(); }
});

test('原生reader返回自定义iterator时保留此前属性的值快照与iterator异常', () => {
  const f = fixture();
  try {
    getLightingGeometrySignature(f.sources);
    const positions = f.mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = f.mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const originalPosition = positions[0], failure = new Error('iterator failure');
    let iterations = 0, fail = false;
    Object.defineProperty(normals, Symbol.iterator, { configurable: true, value: function* () {
      iterations++; positions[0] += .25; if (fail) throw failure;
      for (let i = 0; i < normals.length; i++) yield normals[i];
    } });
    const expected = originalSignature(f.sources); positions[0] = originalPosition;
    assert.equal(getLightingGeometrySignature(f.sources), expected); assert.equal(iterations, 2);
    fail = true;
    assert.throws(() => getLightingGeometrySignature(f.sources), error => error === failure);
  } finally { f.dispose(); }
});

test('TypedArray继承metadata getter被覆盖时不额外求值，保守保持原签名及异常', () => {
  for (const key of ['buffer', 'byteOffset', 'byteLength', 'length']) {
    const f = fixture(), cache = new LightingGeometrySignatureCache();
    const previous = Object.getOwnPropertyDescriptor(Float32Array.prototype, key);
    const failure = new Error(`inherited ${key}`); let reads = 0;
    const original = () => {
      const values = (kind: string) => { const data = f.mesh.getVerticesData(kind); return data ? Array.from(data) : null; };
      return lightingContentHash({ positions: values(VertexBuffer.PositionKind), normals: values(VertexBuffer.NormalKind),
        indices: Array.from(f.mesh.getIndices() ?? []), uvs: values(VertexBuffer.UVKind), uvs2: values(VertexBuffer.UV2Kind),
        colors: f.mesh.useVertexColors ? values(VertexBuffer.ColorKind) : null, tangents: values(VertexBuffer.TangentKind),
        subMeshes: f.mesh.subMeshes.map(part => [part.materialIndex, part.indexStart, part.indexCount]) });
    };
    try {
      const expected = original(); assert.equal(cache.getHash(f.mesh), expected);
      Object.defineProperty(Float32Array.prototype, key, { configurable: true, get() { reads++; throw failure; } });
      let originalError: unknown = null, originalResult: string | null = null;
      try { originalResult = original(); } catch (error) { originalError = error; }
      const expectedReads = reads; reads = 0;
      if (originalError) assert.throws(() => cache.getHash(f.mesh), error => error === originalError);
      else assert.equal(cache.getHash(f.mesh), originalResult);
      assert.equal(reads, expectedReads, key);
    } finally {
      if (previous) Object.defineProperty(Float32Array.prototype, key, previous); else Reflect.deleteProperty(Float32Array.prototype, key);
      f.dispose();
    }
  }
});

test('原生iterator共享next被脚本替换后按原Array.from结果处理', () => {
  const f = fixture();
  const prototype = Object.getPrototypeOf(new Float32Array()[Symbol.iterator]());
  const previous = Object.getOwnPropertyDescriptor(prototype, 'next')!;
  try {
    getLightingGeometrySignature(f.sources);
    Object.defineProperty(prototype, 'next', { ...previous, value: function (this: unknown) {
      const result = previous.value.call(this) as IteratorResult<unknown>;
      if (!result.done && typeof result.value === 'number') return { value: result.value + 1, done: false };
      return result;
    } });
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
  } finally { Object.defineProperty(prototype, 'next', previous); f.dispose(); }
});

test('缓存内部复制不调用后来覆盖的Uint8Array slice/set或Float64Array.from', () => {
  const f = fixture();
  const plain = MeshBuilder.CreateBox('plain-copy-source', {}, f.scene);
  const plainSource = { ...f.source, mesh: plain, getWorldMatrix: () => plain.computeWorldMatrix(true) };
  const byteSlice = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'slice');
  const byteSet = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
  const doubleFrom = Object.getOwnPropertyDescriptor(Float64Array, 'from');
  const fail = () => { throw new Error('new internal copy entry'); };
  try {
    getLightingGeometrySignature(f.sources); getLightingGeometrySignature([plainSource]);
    f.mesh.getVerticesData(VertexBuffer.PositionKind)![0] += .125;
    plain.getVerticesData(VertexBuffer.PositionKind)![0] += .25;
    Object.defineProperty(Uint8Array.prototype, 'slice', { configurable: true, writable: true, value: fail });
    Object.defineProperty(Uint8Array.prototype, 'set', { configurable: true, writable: true, value: fail });
    Object.defineProperty(Float64Array, 'from', { configurable: true, writable: true, value: fail });
    assert.equal(getLightingGeometrySignature(f.sources), originalSignature(f.sources));
    assert.equal(getLightingGeometrySignature([plainSource]), originalSignature([plainSource]));
  } finally {
    if (byteSlice) Object.defineProperty(Uint8Array.prototype, 'slice', byteSlice); else Reflect.deleteProperty(Uint8Array.prototype, 'slice');
    if (byteSet) Object.defineProperty(Uint8Array.prototype, 'set', byteSet); else Reflect.deleteProperty(Uint8Array.prototype, 'set');
    if (doubleFrom) Object.defineProperty(Float64Array, 'from', doubleFrom); else Reflect.deleteProperty(Float64Array, 'from');
    f.dispose();
  }
});

test('未显式dispose的脱离场景Mesh与对照均可GC，快照随finalizer释放', () => {
  const script = `
    import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
    import { LightingGeometrySignatureCache } from ${JSON.stringify(new URL('../../src/runtime/babylon/lightingGeometrySignatureCache.ts', import.meta.url).href)};
    const engine = new NullEngine(), scene = new Scene(engine), cache = new LightingGeometrySignatureCache();
    function make(name, cached) {
      const mesh = MeshBuilder.CreateBox(name, {}, scene);
      if (cached) cache.getHash(mesh);
      scene.removeMesh(mesh); mesh._removeFromSceneRootNodes(); mesh.geometry.releaseForMesh(mesh);
      return new WeakRef(mesh);
    }
    const cached = make('cached', true), control = make('control', false), before = cache.getMetrics();
    for (let index = 0; index < 16; index++) { await new Promise(resolve => setTimeout(resolve, 30)); global.gc(); }
    console.log('CACHE_GC=' + JSON.stringify({ cachedAlive: !!cached.deref(), controlAlive: !!control.deref(), before, after: cache.getMetrics() }));
    cached.deref()?.dispose(); control.deref()?.dispose(); scene.dispose(); engine.dispose();
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-transform-types', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 90_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('CACHE_GC='))!.slice('CACHE_GC='.length));
  assert.equal(report.controlAlive, false); assert.equal(report.cachedAlive, false);
  assert.ok(report.before.retainedSnapshotBytes > 0); assert.equal(report.after.retainedSnapshotBytes, 0);
});
