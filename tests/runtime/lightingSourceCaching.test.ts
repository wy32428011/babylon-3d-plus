import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Scene, SceneLoader, TransformNode, VertexBuffer } from '@babylonjs/core';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { lightingContentHash } from '../../electron/shared/sceneLightingBakeContract.ts';
import { getNativeLightingInstances } from '../../src/runtime/babylon/lightingNativeInstances.ts';
import { collectLightingRuntimeSources } from '../../src/runtime/babylon/lightingClassificationRuntime.ts';
import { createLightingNodeKey } from '../../src/runtime/babylon/lightingGeometry.ts';
import { HybridShadowMeshState } from '../../src/runtime/babylon/HybridShadowCache.ts';
import { registerGeometryUpdateDelegate, subscribeLightingGeometryUpdates } from '../../src/runtime/babylon/lightingGeometryUpdates.ts';
import type { AbstractMesh, Geometry } from '@babylonjs/core';

function environmentFixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const floor = MeshBuilder.CreateBox('floor', { updatable: true }, scene), wall = MeshBuilder.CreateBox('wall', {}, scene);
  const context = { scene, document: { entities: {}, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined),
    environment: { dataPlatformRevision: 'saved-version', activeVariantUrl: 'saved.glb' } } },
    models: [], primitiveMeshes: new Map(), environment: [{ key: 'floor', mesh: floor }, { key: 'wall', mesh: wall }] as Array<{ key: string; mesh: AbstractMesh }>,
    environmentSource: { sourceUrl: 'actual.glb', assetRevision: 'actual-version' } as { sourceUrl: string; assetRevision?: string | null } | null,
    batches: [], getMotionTargets: () => ({ moving: [], fixed: [], known: false }), readEntityId: () => null };
  const collect = () => collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
  const expected = () => lightingContentHash([context.environmentSource ? context.environmentSource.assetRevision : context.document.sceneSettings.environment.dataPlatformRevision,
    context.environment.map(surface => [surface.key, surface.mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], surface.mesh.getIndices() ?? []])]);
  return { engine, scene, floor, wall, context, collect, expected, dispose() { scene.dispose(); engine.dispose(); } };
}

test('真实Hybrid几何tracker包装后环境fresh collect仍复用canonical缓存', t => {
  const f = environmentFixture(), tracker = new HybridShadowMeshState();
  try {
    const expected = f.expected();
    assert.ok(f.collect().every(source => source.entry.resourceIdentity === expected));
    const dispatcher = f.floor.geometry!.onGeometryUpdated;
    tracker.setMeshes([f.floor, f.wall], new Map([f.floor, f.wall].map(mesh => [mesh,
      { mobility: 'static' as const, castShadows: true, receiveShadows: true }])));
    tracker.refresh();
    assert.notEqual(f.floor.geometry!.onGeometryUpdated, dispatcher, '真实tracker必须在分类订阅上安装自己的包装');
    const original = JSON.stringify; let encodings = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') encodings++;
      return Reflect.apply(original, JSON, [value, ...args]);
    });
    for (let i = 0; i < 3; i++) {
      f.context.environment = f.context.environment.map(surface => ({ ...surface }));
      assert.ok(f.collect().every(source => source.entry.resourceIdentity === expected));
      assert.equal(encodings, 0, '已知Hybrid delegate不能迫使不变环境重新逐数值canonical编码');
    }
  } finally { tracker.dispose(); f.dispose(); }
});

test('可信Geometry delegate链保留receiver、参数、回调顺序和原异常传播', () => {
  const f = environmentFixture(), geometry = f.floor.geometry!, calls: string[] = [], failure = new Error('original callback');
  let throwing = false;
  const check = (receiver: Geometry, updated: Geometry, kind?: string) => {
    assert.equal(receiver, geometry); assert.equal(updated, geometry); assert.equal(kind, VertexBuffer.PositionKind);
  };
  geometry.onGeometryUpdated = function (this: Geometry, updated, kind) {
    check(this, updated, kind); calls.push('original'); if (throwing) throw failure;
  };
  const subscription = subscribeLightingGeometryUpdates(geometry, function (this: Geometry, updated, kind) {
    check(this, updated, kind); calls.push('shared');
  });
  try {
    for (const name of ['inner', 'outer']) {
      const previous = geometry.onGeometryUpdated;
      const callback: Geometry['onGeometryUpdated'] = function (this: Geometry, updated, kind) {
        check(this, updated, kind); calls.push(`${name}:before`); previous.call(this, updated, kind); calls.push(`${name}:after`);
      };
      registerGeometryUpdateDelegate(geometry, callback, previous);
      registerGeometryUpdateDelegate(geometry, callback, previous);
      geometry.onGeometryUpdated = callback;
    }
    assert.ok(subscription.isCurrent());
    geometry.onGeometryUpdated.call(geometry, geometry, VertexBuffer.PositionKind);
    assert.deepEqual(calls, ['outer:before', 'inner:before', 'original', 'shared', 'inner:after', 'outer:after']);
    calls.length = 0; throwing = true;
    assert.throws(() => geometry.onGeometryUpdated.call(geometry, geometry, VertexBuffer.PositionKind), error => error === failure);
    assert.deepEqual(calls, ['outer:before', 'inner:before', 'original', 'shared'], 'dispatcher原finally通知及外层异常短路顺序必须原样保留');
  } finally { subscription.release(); throwing = false; f.dispose(); }
});

test('Geometry delegate未知覆盖、跨Geometry登记、循环和前驱冲突均保守失效', () => {
  const f = environmentFixture(), geometry = f.floor.geometry!, other = f.wall.geometry!;
  const subscription = subscribeLightingGeometryUpdates(geometry, () => undefined), dispatcher = geometry.onGeometryUpdated;
  try {
    const external: Geometry['onGeometryUpdated'] = function (updated, kind) { dispatcher(updated, kind); };
    geometry.onGeometryUpdated = external; assert.equal(subscription.isCurrent(), false);
    const known: Geometry['onGeometryUpdated'] = function (updated, kind) { external(updated, kind); };
    registerGeometryUpdateDelegate(geometry, known, external);
    geometry.onGeometryUpdated = known; assert.equal(subscription.isCurrent(), false, '内部边不能越过未知外部包装');
    registerGeometryUpdateDelegate(other, external, dispatcher);
    assert.equal(subscription.isCurrent(), false, '另一Geometry的登记不能授权当前Geometry');
    const first: Geometry['onGeometryUpdated'] = () => undefined, second: Geometry['onGeometryUpdated'] = () => undefined;
    registerGeometryUpdateDelegate(geometry, first, second); registerGeometryUpdateDelegate(geometry, second, first);
    geometry.onGeometryUpdated = first; assert.equal(subscription.isCurrent(), false, '循环必须有限步拒绝且不执行回调');
    const conflicting: Geometry['onGeometryUpdated'] = function (updated, kind) { dispatcher(updated, kind); };
    registerGeometryUpdateDelegate(geometry, conflicting, dispatcher);
    geometry.onGeometryUpdated = conflicting; assert.ok(subscription.isCurrent());
    registerGeometryUpdateDelegate(geometry, conflicting, external); assert.equal(subscription.isCurrent(), false);
    registerGeometryUpdateDelegate(geometry, conflicting, dispatcher); assert.equal(subscription.isCurrent(), false, '冲突登记不能重新恢复信任');
    geometry.onGeometryUpdated = dispatcher; assert.ok(subscription.isCurrent(), '直接所有权不依赖外层登记');
  } finally { subscription.release(); f.dispose(); }
});

test('Geometry delegate外层存在时释放只移除订阅，乱序释放和后续订阅保留仍可调用的链', () => {
  const f = environmentFixture(), geometry = f.floor.geometry!; let originals = 0, firstCalls = 0, secondCalls = 0;
  const original = () => { originals++; }; geometry.onGeometryUpdated = original;
  const first = subscribeLightingGeometryUpdates(geometry, () => { firstCalls++; });
  const dispatcher = geometry.onGeometryUpdated;
  const inner: Geometry['onGeometryUpdated'] = function (updated, kind) { dispatcher(updated, kind); };
  registerGeometryUpdateDelegate(geometry, inner, dispatcher); geometry.onGeometryUpdated = inner;
  const second = subscribeLightingGeometryUpdates(geometry, () => { secondCalls++; });
  try {
    first.release(); assert.equal(geometry.onGeometryUpdated, inner); assert.ok(second.isCurrent());
    geometry.onGeometryUpdated(geometry); assert.deepEqual([originals, firstCalls, secondCalls], [1, 0, 1]);
    second.release(); assert.equal(geometry.onGeometryUpdated, inner, '最后释放也不能摘除仍直接拥有入口的内部消费者');
    const third = subscribeLightingGeometryUpdates(geometry, () => { secondCalls++; });
    const nextDispatcher = geometry.onGeometryUpdated;
    const outer: Geometry['onGeometryUpdated'] = function (updated, kind) { nextDispatcher(updated, kind); };
    registerGeometryUpdateDelegate(geometry, outer, nextDispatcher); geometry.onGeometryUpdated = outer;
    assert.ok(third.isCurrent()); geometry.onGeometryUpdated(geometry);
    assert.deepEqual([originals, firstCalls, secondCalls], [2, 0, 2]);
    third.release(); assert.equal(geometry.onGeometryUpdated, outer);
    geometry.onGeometryUpdated(geometry); assert.deepEqual([originals, firstCalls, secondCalls], [3, 0, 2]);
    const fourth = subscribeLightingGeometryUpdates(geometry, () => undefined), external = () => undefined;
    geometry.onGeometryUpdated = external; fourth.release(); assert.equal(geometry.onGeometryUpdated, external);
  } finally { first.release(); second.release(); f.dispose(); }
});

test('真实Hybrid delegate下sameframe原地改写和通知更新仍按原canonical即时失效', () => {
  const f = environmentFixture(), tracker = new HybridShadowMeshState();
  try {
    const before = f.collect()[0].entry.resourceIdentity;
    tracker.setMeshes([f.floor], new Map([[f.floor, { mobility: 'static', castShadows: true, receiveShadows: true }]]));
    f.floor.getVerticesData(VertexBuffer.PositionKind)![0] += .5;
    const raw = f.collect()[0].entry.resourceIdentity; assert.equal(raw, f.expected()); assert.notEqual(raw, before);
    const positions = [...f.floor.getVerticesData(VertexBuffer.PositionKind)!]; positions[1] += .5;
    f.floor.updateVerticesData(VertexBuffer.PositionKind, positions);
    const notified = f.collect()[0].entry.resourceIdentity;
    assert.equal(notified, f.expected()); assert.notEqual(notified, raw);
  } finally { tracker.dispose(); f.dispose(); }
});

test('环境整组跨fresh目录collect复用原canonical hash，保持每轮几何核对和全部surface条目', t => {
  const f = environmentFixture();
  try {
    const expected = f.expected(), original = JSON.stringify;
    let encodings = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') encodings++;
      return Reflect.apply(original, JSON, [value, ...args]);
    });
    const reads = new Map<AbstractMesh, number>();
    for (const mesh of [f.floor, f.wall]) {
      const buffer = mesh.getVertexBuffer(VertexBuffer.PositionKind)!, getData = buffer.getData.bind(buffer);
      t.mock.method(buffer, 'getData', () => { reads.set(mesh, (reads.get(mesh) ?? 0) + 1); return getData(); });
    }
    let cold = 0;
    for (let i = 0; i < 4; i++) {
      f.context.environment = f.context.environment.map(surface => ({ ...surface }));
      const before = new Map(reads), sources = f.collect();
      assert.equal(sources.length, 2); assert.ok(sources.every(source => source.entry.resourceIdentity === expected));
      assert.deepEqual(sources.map(source => source.entry.key), ['$environment/floor', '$environment/wall']);
      if (!i) cold = encodings;
      else assert.equal(encodings, cold, '新的目录包装不能迫使相同环境重新逐数值canonical编码');
      for (const mesh of [f.floor, f.wall]) {
        const count = (reads.get(mesh) ?? 0) - (before.get(mesh) ?? 0);
        if (i) assert.equal(count, 1, '后续每轮仍核对一次几何，不能降低检查频率');
        else assert.ok(count >= 1 && count <= 2, '冷轮保留原算法读取，并至多增加一次快照核对');
      }
    }
    assert.equal(cold, [f.floor, f.wall].reduce((sum, mesh) => sum + mesh.getTotalVertices() * 3 + mesh.getTotalIndices(), 0));
  } finally { f.dispose(); }
});

test('环境整组sameframe原地position/index/type、buffer/layout和Geometry变化严格保持原算法', () => {
  const f = environmentFixture();
  try {
    const identity = () => {
      const sources = f.collect(), expected = f.expected();
      assert.ok(sources.every(source => source.entry.resourceIdentity === expected)); return expected;
    };
    let before = identity(); f.floor.getVerticesData(VertexBuffer.PositionKind)![0] += .75;
    let after = identity(); assert.notEqual(after, before); before = after;
    const indices = f.floor.getIndices()!; [indices[0], indices[1]] = [indices[1], indices[0]];
    after = identity(); assert.notEqual(after, before);
    const raw = new Uint16Array([0, 1, 2, 0]); f.floor.setIndices(raw); before = identity();
    Reflect.set(f.floor.geometry!, '_indices', new Uint32Array(raw.buffer));
    after = identity(); assert.notEqual(after, before); before = after;
    const values = [...f.floor.getVerticesData(VertexBuffer.PositionKind)!], interleaved: number[] = [];
    for (let i = 0; i < values.length; i += 3) interleaved.push(777, values[i], values[i + 1], values[i + 2]);
    f.floor.setVerticesBuffer(new VertexBuffer(f.engine, interleaved, VertexBuffer.PositionKind,
      { stride: 4, offset: 1, size: 3, updatable: true }), true, values.length / 3);
    assert.equal(identity(), before, '改变buffer/layout仍按解码后的原positions序列hash');
    f.floor.geometry!.copy('environment-copy').applyToMesh(f.floor);
    assert.equal(identity(), before);
    const external = () => undefined; f.floor.geometry!.onGeometryUpdated = external;
    (f.floor.getVertexBuffer(VertexBuffer.PositionKind)!.getData() as number[] | Float32Array)[1] += 1;
    after = identity(); assert.notEqual(after, before); assert.equal(f.floor.geometry!.onGeometryUpdated, external);
  } finally { f.dispose(); }
});

test('环境目录顺序、key、成员与实际revision变化失效，世界变换和保存的旧revision不改变canonical身份', () => {
  const f = environmentFixture();
  try {
    const identity = () => { const result = f.collect(); assert.ok(result.every(source => source.entry.resourceIdentity === f.expected())); return f.expected(); };
    let before = identity();
    f.floor.position.x = 12; f.context.document.sceneSettings.environment.dataPlatformRevision = 'ignored-saved-version';
    assert.equal(identity(), before, '有实际来源时保持原ternary revision选择，不加入世界变换');
    f.context.environment.reverse(); let after = identity(); assert.notEqual(after, before); before = after;
    f.context.environment[0].key = 'renamed-wall'; after = identity(); assert.notEqual(after, before); before = after;
    f.context.environmentSource!.assetRevision = 'new-actual-version'; after = identity(); assert.notEqual(after, before); before = after;
    f.context.environmentSource = { sourceUrl: 'actual.glb' }; after = identity(); assert.notEqual(after, before); before = after;
    f.context.environmentSource = null; after = identity(); assert.notEqual(after, before); before = after;
    f.context.environment = [f.context.environment[0]]; after = identity(); assert.notEqual(after, before);
    assert.equal(f.collect().length, 1);
  } finally { f.dispose(); }
});

test('环境已知原生InstancedMesh复用同Geometry核对，保持重复surface与ordered canonical输入', t => {
  const f = environmentFixture();
  try {
    const instance = f.floor.createInstance('floor-instance');
    f.context.environment = [{ key: 'base', mesh: f.floor }, { key: 'instance', mesh: instance }];
    const expected = f.expected(), buffer = f.floor.getVertexBuffer(VertexBuffer.PositionKind)!, original = buffer.getData.bind(buffer);
    let reads = 0; t.mock.method(buffer, 'getData', () => { reads++; return original(); });
    assert.ok(f.collect().every(source => source.entry.resourceIdentity === expected));
    const cold = reads;
    assert.ok(f.collect().every(source => source.entry.resourceIdentity === expected));
    assert.equal(reads - cold, 1, '两个标准surface共享同一Geometry时每轮只核对一次，但不改变hash里的重复输入');
  } finally { f.dispose(); }
});

test('环境未知mesh/Geometry读取器和无Geometry保持原调用顺序，不复用可信源的旧快照', t => {
  for (const target of ['mesh', 'geometry', 'none'] as const) {
    const f = environmentFixture();
    try {
      f.collect();
      const original = f.floor.getVerticesData.bind(f.floor), base = [...original(VertexBuffer.PositionKind)!];
      const wall = f.wall.getVerticesData(VertexBuffer.PositionKind)!, wallIndices = f.wall.getIndices()!, floorIndices = f.floor.getIndices()!;
      let reads = 0; const expected: string[] = [];
      const read = (kind: string) => {
        if (kind !== VertexBuffer.PositionKind) return original(kind);
        const positions = base.slice(); positions[0] += ++reads;
        expected.push(lightingContentHash(['actual-version', [['floor', positions, floorIndices], ['wall', wall, wallIndices]]]));
        return positions;
      };
      if (target === 'geometry') t.mock.method(f.floor.geometry!, 'getVerticesData', read);
      else {
        if (target === 'none') { f.floor.geometry!.releaseForMesh(f.floor, false); t.mock.method(f.floor, 'getTotalVertices', () => 24); }
        t.mock.method(f.floor, 'getVerticesData', read);
        t.mock.method(f.floor, 'getIndices', () => floorIndices);
      }
      for (let i = 0; i < 3; i++) {
        const sources = f.collect(); assert.equal(sources.length, 2);
        assert.ok(sources.every(source => source.entry.resourceIdentity === expected[i]));
      }
      assert.equal(reads, 3, '未知getter仍由每次原canonical表达式调用一次，不缓存或降低读取频率');
    } finally { t.mock.restoreAll(); f.dispose(); }
  }
});

test('环境Scene隔离和单last目录清理，移除surface/清空目录/mesh及Scene释放均归还Geometry订阅', () => {
  const a = environmentFixture(), b = environmentFixture();
  try {
    const floorGeometry = a.floor.geometry!, wallGeometry = a.wall.geometry!, original = () => undefined;
    floorGeometry.onGeometryUpdated = original; wallGeometry.onGeometryUpdated = original;
    const before = a.collect()[0].entry.resourceIdentity;
    b.floor.getVerticesData(VertexBuffer.PositionKind)![0] += 8;
    assert.equal(b.collect()[0].entry.resourceIdentity, b.expected()); assert.notEqual(b.expected(), before);
    assert.equal(a.collect()[0].entry.resourceIdentity, before);
    a.context.environment = [a.context.environment[1]]; a.collect();
    assert.equal(floorGeometry.onGeometryUpdated, original, '旧目录的Geometry订阅必须及时释放');
    assert.notEqual(wallGeometry.onGeometryUpdated, original);
    a.context.environment = []; assert.equal(a.collect().length, 0); assert.equal(wallGeometry.onGeometryUpdated, original);
    a.context.environment = [{ key: 'wall-again', mesh: a.wall }]; a.collect();
    a.wall.dispose(); assert.equal(wallGeometry.onGeometryUpdated, original, '源dispose即时清理整组状态');
    const bGeometry = b.floor.geometry!, bOriginal = () => undefined;
    b.context.environment = []; b.collect(); bGeometry.onGeometryUpdated = bOriginal;
    b.context.environment = [{ key: 'floor', mesh: b.floor }]; b.collect();
    b.scene.dispose(); assert.equal(bGeometry.onGeometryUpdated, bOriginal);
  } finally { a.dispose(); b.dispose(); }
});

test('环境大输入四轮只首次canonical编码，保持每次collect调用和相同原始输出', t => {
  const f = environmentFixture();
  try {
    const ground = MeshBuilder.CreateGround('large-ground', { width: 100, height: 100, subdivisions: 100 }, f.scene);
    f.context.environment[0] = { key: 'large-ground', mesh: ground };
    const expected = f.expected(), values = f.context.environment.reduce((sum, surface) => sum
      + (surface.mesh.getVerticesData(VertexBuffer.PositionKind)?.length ?? 0) + (surface.mesh.getIndices()?.length ?? 0), 0);
    const original = JSON.stringify; let encodings = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') encodings++;
      return Reflect.apply(original, JSON, [value, ...args]);
    });
    for (let i = 0; i < 4; i++) {
      f.context.environment = f.context.environment.map(surface => ({ ...surface }));
      const sources = f.collect(); assert.ok(sources.every(source => source.entry.resourceIdentity === expected));
      assert.equal(encodings, values);
    }
    t.diagnostic(JSON.stringify({ surfaces: 2, numericInputValues: values, collects: 4,
      originalNumericEncodings: values * 4, actualNumericEncodings: encodings, warmAdditionalEncodings: 0, scope: 'component counts; no loading or FPS claim' }));
  } finally { f.dispose(); }
});

test('环境object revision原地修改以及accessor/非标准目录始终执行原表达式', t => {
  for (const kind of ['revision', 'index-getter', 'array-prototype', 'custom-every'] as const) {
    const f = environmentFixture();
    try {
      const revision = { version: 'first' };
      if (kind === 'revision') Reflect.set(f.context.environmentSource!, 'assetRevision', revision);
      if (kind === 'index-getter') {
        const surface = f.context.environment[0];
        Object.defineProperty(f.context.environment, '0', { configurable: true, enumerable: true, get: () => surface });
      }
      if (kind === 'array-prototype') Object.setPrototypeOf(f.context.environment, Object.create(Array.prototype));
      if (kind === 'custom-every') Reflect.set(f.context.environment, 'every', () => { throw new Error('缓存检查不能调用自定义every'); });
      const original = JSON.stringify; let encodings = 0;
      t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
        if (typeof value === 'number') encodings++;
        return Reflect.apply(original, JSON, [value, ...args]);
      });
      const first = f.collect()[0].entry.resourceIdentity, cold = encodings;
      if (kind === 'revision') revision.version = 'second';
      const second = f.collect()[0].entry.resourceIdentity;
      if (kind === 'custom-every') {
        assert.equal(encodings, cold, '未被原算法使用的every覆盖不能影响已验证的普通数据目录');
      } else assert.equal(encodings, cold * 2, '未知revision或访问器目录不能复用上一轮身份');
      assert.equal(second, f.expected());
      if (kind === 'revision') assert.notEqual(second, first);
    } finally { t.mock.restoreAll(); f.dispose(); }
  }
});

function primitiveFixture(instances = 1) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('primitive', { updatable: true }, scene);
  if (instances > 1) {
    const matrices = new Float32Array(instances * 16);
    for (let i = 0; i < instances; i++) Matrix.Translation(i, 0, 0).copyToArray(matrices, i * 16);
    mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
  }
  const entity = { id: 'primitive', parentId: null, components: { meshRenderer: { meshKind: 'cube' } } };
  const context = { scene, document: { entities: { primitive: entity }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } },
    models: [], primitiveMeshes: new Map([['primitive', mesh]]), environment: [], batches: [],
    getMotionTargets: () => ({ moving: [], fixed: [], known: false }), readEntityId: () => null };
  const collect = () => collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
  const expected = (partKey = '$mesh') => lightingContentHash([partKey,
    mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], mesh.getIndices() ?? []]);
  return { engine, scene, mesh, entity, context, collect, expected, dispose() { scene.dispose(); engine.dispose(); } };
}

test('非模型薄实例跨collect复用原canonical几何hash，每mesh每轮只核对一次CPU快照', t => {
  const f = primitiveFixture(32);
  try {
    const expected = f.expected(), original = JSON.stringify;
    let numericEncodings = 0, snapshotReads = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') numericEncodings++;
      return Reflect.apply(original, JSON, [value, ...args]);
    });
    const buffer = f.mesh.getVertexBuffer(VertexBuffer.PositionKind)!, getData = buffer.getData.bind(buffer);
    t.mock.method(buffer, 'getData', () => { snapshotReads++; return getData(); });
    let firstEncodings = 0;
    for (let iteration = 0; iteration < 3; iteration++) {
      const before = snapshotReads, sources = f.collect();
      assert.equal(sources.length, 32);
      assert.ok(sources.every(source => source.entry.resourceIdentity === expected));
      assert.equal(new Set(sources.map(source => source.entry.key)).size, 32, '逻辑实例条目不能被缓存合并');
      assert.ok(snapshotReads - before <= (iteration ? 1 : 2), '同一轮只允许一次快照核对及冷轮一次canonical读取');
      if (!iteration) firstEncodings = numericEncodings;
      else assert.equal(numericEncodings, firstEncodings, '跨dirty刷新不能重新逐数值编码相同几何');
    }
    assert.equal(firstEncodings, f.mesh.getTotalVertices() * 3 + f.mesh.getTotalIndices(), '冷轮每个canonical数值只编码一次');
  } finally { f.dispose(); }
});

test('非模型raw position/index、数组类型、buffer/layout及Geometry替换均失效且canonical身份不变形', () => {
  const f = primitiveFixture(8);
  try {
    const identity = () => {
      const sources = f.collect(), expected = f.expected();
      assert.ok(sources.every(source => source.entry.resourceIdentity === expected));
      return expected;
    };
    let before = identity();
    f.mesh.getVerticesData(VertexBuffer.PositionKind)![0] += .5;
    let after = identity(); assert.notEqual(after, before); before = after;
    const indices = f.mesh.getIndices()!; [indices[0], indices[1]] = [indices[1], indices[0]];
    after = identity(); assert.notEqual(after, before); before = after;
    const geometry = f.mesh.geometry!, original = geometry.onGeometryUpdated;
    const vertices = [...f.mesh.getVerticesData(VertexBuffer.PositionKind)!]; vertices[1] += .75;
    f.mesh.setVerticesData(VertexBuffer.PositionKind, vertices, true);
    after = identity(); assert.notEqual(after, before); before = after;
    const interleaved: number[] = [];
    for (let i = 0; i < vertices.length; i += 3) interleaved.push(777, vertices[i], vertices[i + 1], vertices[i + 2]);
    f.mesh.setVerticesBuffer(new VertexBuffer(f.engine, interleaved, VertexBuffer.PositionKind,
      { updatable: true, stride: 4, offset: 1, size: 3 }), true, vertices.length / 3);
    assert.equal(identity(), before, 'offset/stride改变仍须输出原canonical数值序列，不能对raw buffer作替代hash');
    const raw = new Uint16Array([0, 1, 2, 0]); f.mesh.setIndices(raw); identity();
    Reflect.set(f.mesh.geometry!, '_indices', new Uint32Array(raw.buffer));
    after = identity(); assert.notEqual(after, before);
    f.mesh.geometry!.copy('replacement').applyToMesh(f.mesh);
    assert.equal(identity(), f.expected());
    assert.notEqual(f.mesh.geometry, geometry);
    assert.notEqual(f.mesh.geometry!.onGeometryUpdated, original);
    // 外部覆盖回调后继续精确核对数据，不能反抢回调或返回旧结果。
    const external = () => undefined; f.mesh.geometry!.onGeometryUpdated = external;
    const values = f.mesh.getVerticesData(VertexBuffer.PositionKind)!; values[2] += 2;
    identity(); assert.equal(f.mesh.geometry!.onGeometryUpdated, external);
  } finally { f.dispose(); }
});

test('非模型不同logical partKey各保留原hash和策略，消失的key不在后续目录累计', t => {
  const f = primitiveFixture();
  try {
    const left = MeshBuilder.CreateBox('left', {}, f.scene), right = MeshBuilder.CreateBox('right', {}, f.scene);
    const entities = { a: { id: 'a', components: { lighting: { castShadows: false } } }, b: { id: 'b', components: {} } };
    let rows = [{ mesh: f.mesh, sourceMesh: left, entityId: 'a', sourceIndex: 0 },
      { mesh: f.mesh, sourceMesh: right, entityId: 'b', sourceIndex: 1 }];
    const batch = { getLightingInstances: () => rows, getLightingInstanceWorldMatrix: () => Matrix.Identity() };
    const context = { ...f.context, document: { ...f.context.document, entities }, primitiveMeshes: new Map(), batches: [batch] };
    const expectedLeft = f.expected('left'), expectedRight = f.expected('right'), original = JSON.stringify;
    let encodings = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') encodings++;
      return Reflect.apply(original, JSON, [value, ...args]);
    });
    const collect = () => collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
    const [a, b] = collect();
    assert.equal(a.entry.resourceIdentity, expectedLeft); assert.equal(b.entry.resourceIdentity, expectedRight);
    assert.notEqual(expectedLeft, expectedRight); assert.equal(a.entry.castShadows, false); assert.equal(b.entry.castShadows, true);
    const cold = encodings; collect(); assert.equal(encodings, cold);
    const all = rows; rows = [rows[0]]; collect(); assert.equal(encodings, cold);
    rows = all; collect(); assert.equal(encodings - cold, f.mesh.getTotalVertices() * 3 + f.mesh.getTotalIndices(),
      '旧目录只保留仍存活的key，再出现的right必须按原算法生成而非留无限历史');
  } finally { f.dispose(); }
});

test('非模型自定义读取器或没有Geometry保持原逐调用路径，不从Geometry猜测实际输入', t => {
  const f = primitiveFixture(4);
  try {
    const original = f.mesh.getVerticesData.bind(f.mesh);
    const expected: string[] = [];
    let invocation = 0;
    t.mock.method(f.mesh, 'getVerticesData', (kind: string, ...args: [boolean?, boolean?]) => {
      const data = original(kind, ...args);
      if (kind !== VertexBuffer.PositionKind || !data) return data;
      const changed = Array.from(data); changed[0] += ++invocation;
      expected.push(lightingContentHash(['$mesh', changed, f.mesh.getIndices() ?? []]));
      return changed;
    });
    const sources = f.collect();
    assert.equal(invocation, 4);
    assert.deepEqual(sources.map(source => source.entry.resourceIdentity), expected);
    assert.equal(new Set(expected).size, 4, '自定义getter的每次结果不能被缓存合并');
    // 首次标准缓存后再换自定义getter，也不能继续命中原Geometry快照。
    t.mock.restoreAll(); f.collect();
    const altered = [...original(VertexBuffer.PositionKind)!]; altered[1] += 7;
    t.mock.method(f.mesh, 'getVerticesData', (kind: string, ...args: [boolean?, boolean?]) => kind === VertexBuffer.PositionKind ? altered : original(kind, ...args));
    assert.ok(f.collect().every(source => source.entry.resourceIdentity === lightingContentHash(['$mesh', altered, f.mesh.getIndices() ?? []])));
    f.mesh.thinInstanceSetBuffer('matrix', null);
    const geometry = f.mesh.geometry!; geometry.releaseForMesh(f.mesh, false);
    t.mock.method(f.mesh, 'getTotalVertices', () => 24);
    t.mock.method(f.mesh, 'getIndices', () => [0, 1, 2]);
    t.mock.method(f.mesh, 'getVerticesData', () => [0, 0, 0]);
    const withoutGeometry = f.collect(); assert.equal(withoutGeometry.length, 1);
    assert.ok(withoutGeometry.every(source => source.entry.resourceIdentity === lightingContentHash(['$mesh', [0, 0, 0], [0, 1, 2]])));
  } finally { f.dispose(); }
});

test('非模型同名跨场景不混用缓存，mesh及共享Geometry释放恢复回调', () => {
  const a = primitiveFixture(), b = primitiveFixture();
  try {
    const original = () => undefined, geometry = a.mesh.geometry!;
    geometry.onGeometryUpdated = original;
    a.collect(); assert.notEqual(geometry.onGeometryUpdated, original);
    b.mesh.getVerticesData(VertexBuffer.PositionKind)![0] += 4;
    assert.equal(b.collect()[0].entry.resourceIdentity, b.expected());
    assert.notEqual(b.expected(), a.expected());
    const clone = a.mesh.clone('shared')!;
    const entity = { id: 'clone', components: { meshRenderer: { meshKind: 'cube' } } };
    const context = { ...a.context, document: { ...a.context.document, entities: { primitive: a.entity, clone: entity } },
      primitiveMeshes: new Map([['primitive', a.mesh], ['clone', clone]]) };
    collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
    a.mesh.dispose(); assert.notEqual(geometry.onGeometryUpdated, original, '仍存活共享源保留唯一Geometry通知');
    clone.dispose(); assert.equal(geometry.onGeometryUpdated, original, '最后源释放后必须归还原回调');
  } finally { a.dispose(); b.dispose(); }
});

test('1000个原生carrier各1000实例查询保持真实矩阵，边界刷新至多每carrier一次', t => {
  const engine = new NullEngine(), scene = new Scene(engine);
  let totalQueries = 0, boundingRefreshes = 0;
  try {
    for (let carrier = 0; carrier < 1000; carrier++) {
      const mesh = MeshBuilder.CreateBox('carrier-' + carrier, {}, scene);
      const data = new Float32Array(1000 * 16);
      for (let index = 0; index < 1000; index++) Matrix.Translation(index, 0, 0).copyToArray(data, index * 16);
      mesh.thinInstanceSetBuffer('matrix', data, 16, false);
      mesh.position.x = carrier;
      const original = mesh.thinInstanceRefreshBoundingInfo.bind(mesh);
      let refreshes = 0;
      t.mock.method(mesh, 'thinInstanceRefreshBoundingInfo', (force?: boolean) => {
        refreshes++; boundingRefreshes++;
        // 回归实现立即失败，避免先执行10亿次实例边界变换才报告平方复杂度。
        assert.ok(refreshes <= 1, '同一未变carrier重复查询不得反复刷新全部1000实例边界');
        return original(force);
      });
      const adapter = getNativeLightingInstances(mesh, 'owner-' + carrier);
      const geometry = lightingContentHash([mesh.getVerticesData(VertexBuffer.PositionKind), mesh.getIndices()]);
      for (let index = 0; index < 1000; index++) {
        const matrix = adapter.getLightingInstanceWorldMatrix(mesh, index)!;
        assert.equal(matrix.m[12], carrier + index); assert.equal(matrix.m[13], 0);
        totalQueries++;
      }
      assert.equal(mesh._thinInstanceDataStorage.matrixData, data);
      assert.equal(lightingContentHash([mesh.getVerticesData(VertexBuffer.PositionKind), mesh.getIndices()]), geometry);
      assert.equal(mesh.getBoundingInfo().boundingBox.maximumWorld.x, carrier + 999.5);
      mesh.dispose();
    }
    assert.equal(totalQueries, 1_000_000);
    assert.ok(boundingRefreshes <= 1000);
    t.diagnostic(JSON.stringify({ carriers: 1000, instancesPerCarrier: 1000, totalQueries, boundingRefreshes, scope: 'component operation counts, not FPS' }));
  } finally { scene.dispose(); engine.dispose(); }
});

test('同frame根/父多次变换和raw薄实例buffer更新立即可见，读取结果相互独立', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const root = new TransformNode('root', scene), parent = new TransformNode('parent', scene);
    parent.parent = root;
    const mesh = MeshBuilder.CreateBox('native', { updatable: true }, scene); mesh.parent = parent;
    const data = new Float32Array([...Matrix.Translation(2, 0, 0).asArray(), ...Matrix.Translation(7, 0, 0).asArray()]);
    mesh.thinInstanceSetBuffer('matrix', data, 16, false);
    const adapter = getNativeLightingInstances(mesh, 'owner');
    const frame = scene.getRenderId();
    assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 0)!.m[12], 2);
    root.position.x = 3; assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 0)!.m[12], 5);
    parent.position.x = 4; assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 0)!.m[12], 9);
    root.position.x = 8; assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 0)!.m[12], 14);
    // 不调用thinInstanceBufferUpdated，让Babylon的worldMatrices缓存故意保持旧值。
    mesh.thinInstanceGetWorldMatrices(); data[12] = 11;
    const first = adapter.getLightingInstanceWorldMatrix(mesh, 0)!;
    assert.equal(first.m[12], 23);
    data[12] = 13;
    assert.equal(adapter.getLightingInstances()[0].worldMatrix.m[12], 25);
    assert.equal(first.m[12], 23);
    assert.equal(scene.getRenderId(), frame);
    const replacement = new Float32Array(Matrix.Translation(30, 0, 0).asArray());
    mesh.thinInstanceSetBuffer('matrix', replacement, 16, false);
    assert.equal(adapter.getLightingInstances().length, 1);
    assert.equal(adapter.getLightingInstanceWorldMatrix(mesh, 0)!.m[12], 42);
  } finally { scene.dispose(); engine.dispose(); }
});

function classificationFixture() {
  const engine = new NullEngine(), scene = new Scene(engine), root = new TransformNode('root', scene);
  const mesh = MeshBuilder.CreateBox('part', { updatable: true }, scene); mesh.parent = root;
  const entity = { id: 'model', parentId: null, components: { modelAsset: {} } };
  const model = { root, contentRoot: root, meshes: [mesh], assetRevision: 'r1', parameterSignature: 'p1',
    entitySnapshot: entity, assetHandle: null, externalScriptRuntime: null };
  const context = { scene, document: { entities: { model: entity }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } },
    models: [['model', model]], primitiveMeshes: new Map(), environment: [], batches: [],
    getMotionTargets: () => ({ moving: [], fixed: [mesh], known: true }), readEntityId: () => null };
  const collect = () => collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
  const expected = () => lightingContentHash([model.assetRevision, [{ node: createLightingNodeKey(mesh, root),
    positions: mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], indices: mesh.getIndices() ?? [] }]]);
  return { engine, scene, root, mesh, entity, model, context, collect, expected };
}

test('相同模型重复分类复用完整几何hash，身份与原算法逐字一致', t => {
  const f = classificationFixture();
  try {
    const expected = f.expected(), original = f.mesh.getVerticesData.bind(f.mesh);
    let positionReads = 0;
    t.mock.method(f.mesh, 'getVerticesData', (kind: string, ...args: [boolean?, boolean?]) => {
      if (kind === VertexBuffer.PositionKind) positionReads++;
      return original(kind, ...args);
    });
    for (let i = 0; i < 30; i++) assert.equal(f.collect()[0].entry.resourceIdentity, expected);
    assert.equal(positionReads, 1, '未变几何不应每次分类重新扫描全量positions/indices');
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('position/index/Geometry替换、node路径及版本同frame变化严格失效，已有更新回调保留', () => {
  const f = classificationFixture();
  try {
    let callbacks = 0;
    f.mesh.geometry!.onGeometryUpdated = () => { callbacks++; };
    const first = f.collect()[0].entry.resourceIdentity;
    const positions = f.mesh.getVerticesData(VertexBuffer.PositionKind)!; positions[0] += 0.75;
    f.mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    const second = f.collect()[0].entry.resourceIdentity;
    assert.notEqual(second, first); assert.equal(second, f.expected()); assert.ok(callbacks > 0);
    const indices = Array.from(f.mesh.getIndices()!); [indices[0], indices[1]] = [indices[1], indices[0]];
    f.mesh.updateIndices(indices);
    assert.equal(f.collect()[0].entry.resourceIdentity, f.expected());
    assert.notEqual(f.collect()[0].entry.resourceIdentity, second);
    f.mesh.makeGeometryUnique();
    assert.equal(f.collect()[0].entry.resourceIdentity, f.expected());
    f.mesh.name = 'renamed'; assert.equal(f.collect()[0].entry.resourceIdentity, f.expected());
    f.model.assetRevision = 'r2'; assert.equal(f.collect()[0].entry.resourceIdentity, f.expected());
    const beforeReplacement = f.collect()[0].entry.resourceIdentity;
    // 外部覆盖唯一回调后不假定通知仍可信；必须安全重算，不反复套回调链。
    f.mesh.geometry!.onGeometryUpdated = () => { callbacks++; };
    positions[1] += 1; f.mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    assert.notEqual(f.collect()[0].entry.resourceIdentity, beforeReplacement);
    assert.equal(f.collect()[0].entry.resourceIdentity, f.expected());
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('跨设备motion批次按各实体真实source解析资源身份和节点规则，渲染载体仍共享', () => {
  const f = classificationFixture();
  try {
    const rootB = new TransformNode('root-B', f.scene), sourceB = MeshBuilder.CreateBox('part-B', {}, f.scene); sourceB.parent = rootB;
    const entityB = { id: 'other', parentId: null, components: { modelAsset: {}, lighting: { nodeOverrides: { 'part-B[0]/instance:0': { castShadows: false } } } } };
    const modelB = { ...f.model, root: rootB, contentRoot: rootB, meshes: [sourceB], assetRevision: 'asset-B', entitySnapshot: entityB, modelArrayBatch: {} };
    Object.assign(f.model, { modelArrayBatch: {} });
    const carrier = MeshBuilder.CreateBox('shared-carrier', {}, f.scene);
    const batch = { getLightingInstances: () => [
      { mesh: carrier, sourceMesh: f.mesh, entityId: 'model', sourceIndex: 0 },
      { mesh: carrier, sourceMesh: f.mesh, entityId: 'other', sourceIndex: 1 },
    ], getLightingInstanceWorldMatrix: () => Matrix.Identity() };
    const context = { ...f.context, document: { ...f.context.document, entities: { model: f.entity, other: entityB } },
      models: [['model', f.model], ['other', modelB]], batches: [batch],
      resolveBatchSource: (_batch: unknown, id: string, sourceMesh: typeof f.mesh) => id === 'other' ? sourceB : sourceMesh };
    const collect = (input: unknown) => collectLightingRuntimeSources(input as Parameters<typeof collectLightingRuntimeSources>[0]);
    const [a, b] = collect(context);
    assert.equal(a.mesh, carrier); assert.equal(b.mesh, carrier);
    assert.notEqual(a.entry.resourceIdentity, b.entry.resourceIdentity);
    assert.equal(b.entry.name, 'part-B'); assert.equal(b.entry.nodeKey, 'part-B[0]/instance:0');
    assert.equal(a.entry.castShadows, true); assert.equal(b.entry.castShadows, false);
    const legacy = collect({ ...context, resolveBatchSource: undefined });
    assert.equal(legacy[0].entry.resourceIdentity, legacy[1].entry.resourceIdentity, '普通array无callback维持既有来源解析');
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('没有任何Geometry通知的raw position/index数组改写也不能复用旧canonical身份', () => {
  const f = classificationFixture();
  try {
    const before = f.collect()[0].entry.resourceIdentity;
    const positions = f.mesh.getVerticesData(VertexBuffer.PositionKind)!;
    positions[2] += 3;
    const afterPosition = f.collect()[0].entry.resourceIdentity;
    assert.notEqual(afterPosition, before); assert.equal(afterPosition, f.expected());
    const indices = f.mesh.getIndices()!;
    [indices[0], indices[1]] = [indices[1], indices[0]];
    const afterIndex = f.collect()[0].entry.resourceIdentity;
    assert.notEqual(afterIndex, afterPosition); assert.equal(afterIndex, f.expected());
    const rawIndices = new Uint16Array([0, 1, 2, 0]);
    f.mesh.setIndices(rawIndices);
    const beforeType = f.collect()[0].entry.resourceIdentity;
    (f.mesh.geometry! as unknown as { _indices: Uint32Array })._indices = new Uint32Array(rawIndices.buffer);
    assert.notEqual(f.collect()[0].entry.resourceIdentity, beforeType, '相同字节不同TypedArray元素类型不能命中旧identity');
    assert.equal(f.collect()[0].entry.resourceIdentity, f.expected());
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('源宿主dispose释放几何身份监听并恢复原回调，不持有旧模型', () => {
  const f = classificationFixture();
  try {
    const geometry = f.mesh.geometry!, original = () => undefined;
    geometry.onGeometryUpdated = original;
    f.collect(); assert.notEqual(geometry.onGeometryUpdated, original);
    f.root.dispose();
    assert.equal(geometry.onGeometryUpdated, original);
  } finally { f.scene.dispose(); f.engine.dispose(); }
});

test('薄实例策略不扫描无关参数大树，实际设备类型规则仍逐来源隔离', () => {
  const f = classificationFixture();
  try {
    let metadataReads = 0;
    const asset = { dataDrivenConfig: { device: { devType: 'conveyor' } } };
    Object.defineProperty(asset, 'parameterValues', { enumerable: true, get: () => { metadataReads++; return { large: Array(1000).fill(1) }; } });
    Object.assign(f.entity.components.modelAsset, asset);
    // Object.assign 会读取 getter；将观测点放到实际资产对象，记录分类是否无关遍历参数。
    Object.defineProperty(f.entity.components.modelAsset, 'parameterValues', { enumerable: true, get: () => { metadataReads++; return { large: Array(1000).fill(1) }; } });
    const matrices = new Float32Array(200 * 16);
    for (let i = 0; i < 200; i++) Matrix.Translation(i, 0, 0).copyToArray(matrices, i * 16);
    f.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
    const rootB = new TransformNode('other-root', f.scene), meshB = MeshBuilder.CreateBox('other-part', {}, f.scene); meshB.parent = rootB;
    const entityB = { id: 'other', parentId: null, components: { modelAsset: { dataDrivenConfig: { device: { devType: 'rgv' } } } } };
    const modelB = { ...f.model, root: rootB, contentRoot: rootB, meshes: [meshB], entitySnapshot: entityB };
    const context = { ...f.context, models: [['model', f.model], ['other', modelB]], document: { ...f.context.document,
      entities: { model: f.entity, other: entityB }, sceneSettings: { lighting: normalizeSceneLightingConfig({ policy: { version: 1, defaults: {}, rules: [
        { id: 'conveyor', enabled: true, target: { kind: 'type', deviceType: 'conveyor' }, values: { castShadows: false } },
        { id: 'rgv', enabled: true, target: { kind: 'type', deviceType: 'rgv' }, values: { receiveShadows: false } },
      ] } }) } } };
    metadataReads = 0;
    const sources = collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
    assert.equal(sources.length, 201);
    assert.ok(sources.filter(source => source.entry.entityId === 'model').every(source => !source.entry.castShadows && source.entry.receiveShadows));
    const other = sources.find(source => source.entry.entityId === 'other')!;
    assert.equal(other.entry.castShadows, true); assert.equal(other.entry.receiveShadows, false);
    assert.equal(metadataReads, 0, '策略匹配只读取实际目标字段，不能对每个实例哈希无关的参数数据');
  } finally { f.scene.dispose(); f.engine.dispose(); }
});


test('真实glTF多primitive共享VB只保留唯一CPU视图快照，稳定fresh collect不重编码', async t => {
  await import('@babylonjs/loaders/glTF/index.js');
  const engine = new NullEngine(), scene = new Scene(engine), primitiveCount = 32, vertexCount = 1024;
  const positionBytes = vertexCount * 24, data = Buffer.alloc(positionBytes + 12);
  const values = new Float32Array(data.buffer, data.byteOffset, vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) values.set([i % 32, Math.floor(i / 32), 0, 0, 0, 1], i * 6);
  new Uint32Array(data.buffer, data.byteOffset + positionBytes, 3).set([0, 1, 2]);
  const primitive = { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 };
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: Array.from({ length: primitiveCount }, () => structuredClone(primitive)) }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + data.toString('base64'), byteLength: data.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBytes, byteStride: 24 }, { buffer: 0, byteOffset: positionBytes, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: [0, 0, 0], max: [31, 31, 0] },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' }] };
  try {
    const container = await SceneLoader.LoadAssetContainerAsync('', 'data:' + JSON.stringify(gltf), scene, undefined, '.gltf');
    container.addAllToScene();
    const meshes = container.meshes.filter(mesh => mesh.geometry), geometries = meshes.map(mesh => mesh.geometry!);
    const positionBuffers = geometries.map(geometry => geometry.getVertexBuffer(VertexBuffer.PositionKind)!);
    assert.equal(new Set(geometries).size, primitiveCount, '真实loader为各primitive创建独立Geometry');
    assert.equal(new Set(positionBuffers).size, 1, '真实loader复用同一accessor的VertexBuffer');
    const raw = positionBuffers[0].getData() as Uint8Array, indices = geometries[0].getIndices() as Uint32Array;
    assert.ok(positionBuffers.every(buffer => buffer.getData() === raw));
    const context = { scene, document: { entities: {}, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined),
      environment: { dataPlatformRevision: 'r', activeVariantUrl: 'shared.glb' } } }, models: [], primitiveMeshes: new Map(),
      environment: meshes.map((mesh, i) => ({ key: 'part-' + i, mesh })), environmentSource: { sourceUrl: 'shared.glb', assetRevision: 'r' },
      batches: [], getMotionTargets: () => ({ moving: [], fixed: [], known: false }), readEntityId: () => null };
    const expected = lightingContentHash(['r', context.environment.map(surface => [surface.key,
      surface.mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], surface.mesh.getIndices() ?? []])]);
    const stringify = JSON.stringify, slice = Uint8Array.prototype.slice; let encodings = 0, snapshotBytes = 0, snapshotCopies = 0;
    t.mock.method(JSON, 'stringify', function (value: unknown, ...args: unknown[]) {
      if (typeof value === 'number') encodings++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    });
    t.mock.method(Uint8Array.prototype, 'slice', function (this: Uint8Array, start?: number, end?: number) {
      const result = slice.call(this, start, end);
      if ([raw, indices].some(view => this.buffer === view.buffer && this.byteOffset === view.byteOffset && this.byteLength === view.byteLength)) {
        snapshotBytes += result.byteLength; snapshotCopies++;
      }
      return result;
    });
    const collect = () => collectLightingRuntimeSources(context as unknown as Parameters<typeof collectLightingRuntimeSources>[0]);
    assert.ok(collect().every(source => source.entry.resourceIdentity === expected));
    assert.equal(snapshotBytes, raw.byteLength + indices.byteLength, '快照存储必须按唯一数据视图计量，不能按Geometry复制');
    assert.equal(snapshotCopies, 2);
    const firstEncodings = encodings;
    assert.ok(firstEncodings > 0, '首次摘要仍执行原canonical算法');
    for (let i = 0; i < 3; i++) {
      context.environment = context.environment.map(surface => ({ ...surface }));
      assert.ok(collect().every(source => source.entry.resourceIdentity === expected));
    }
    assert.equal(encodings, firstEncodings, '稳定数据不应重复canonical编码');
    assert.equal(snapshotCopies, 2, '稳定collect不应新增同一数据快照');
    t.diagnostic(JSON.stringify({ primitiveCount, uniquePositionBuffers: 1, snapshotBytes,
      perGeometrySnapshotBytes: primitiveCount * (raw.byteLength + indices.byteLength) }));
  } finally { scene.dispose(); engine.dispose(); }
});

test('共享CPU数据原地修改创建新快照，不污染另一模型仍持有的旧快照', () => {
  const first = classificationFixture(), second = classificationFixture();
  try {
    const positions = new Float32Array(first.mesh.getVerticesData(VertexBuffer.PositionKind)!);
    const indices = new Uint32Array(first.mesh.getIndices()!);
    for (const current of [first, second]) { current.mesh.setVerticesData(VertexBuffer.PositionKind, positions, true); current.mesh.setIndices(indices); }
    assert.equal(first.mesh.getVertexBuffer(VertexBuffer.PositionKind)!.getData(), second.mesh.getVertexBuffer(VertexBuffer.PositionKind)!.getData());
    const beforeFirst = first.collect()[0].entry.resourceIdentity, beforeSecond = second.collect()[0].entry.resourceIdentity;
    positions[0] += .75;
    assert.equal(first.collect()[0].entry.resourceIdentity, first.expected());
    const afterSecond = second.collect()[0].entry.resourceIdentity;
    assert.equal(afterSecond, second.expected()); assert.notEqual(afterSecond, beforeSecond);
    [indices[0], indices[1]] = [indices[1], indices[0]];
    assert.equal(second.collect()[0].entry.resourceIdentity, second.expected());
    const afterFirst = first.collect()[0].entry.resourceIdentity;
    assert.equal(afterFirst, first.expected()); assert.notEqual(afterFirst, beforeFirst);
  } finally { first.scene.dispose(); first.engine.dispose(); second.scene.dispose(); second.engine.dispose(); }
});
