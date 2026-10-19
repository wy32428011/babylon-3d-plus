import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { Matrix, Mesh, MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import type { LocatorFetchRuntime as FetchRuntime, FetchContainerRecord } from '../../src/runtime/babylon/LocatorFetchRuntime.ts';
import type { LocatorRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime.ts';
import type { LocatorComponent, ModelGeneratorComponent, ModelGeneratorTarget } from '../../src/editor/model/components.ts';

// 直接执行实际运行时；补足 bundler 相对导入，图片仅提供 URL 占位，不替换 Babylon 或业务依赖。
const resolution = registerHooks({ resolve(specifier, context, nextResolve) {
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(specifier)) {
    return nextResolve('data:text/javascript,export default ""', context);
  }
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && context.parentURL && (!/\.[a-z]+$/i.test(specifier) || specifier.endsWith('.js'))) {
      const source = new URL(specifier.endsWith('.js') ? specifier.replace(/\.js$/, '.ts') : `${specifier}.ts`, context.parentURL);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    throw error;
  }
} });
after(() => resolution.deregister());
const { LocatorFetchRuntime } = await import('../../src/runtime/babylon/LocatorFetchRuntime.ts');

const locator = { entityId: 'statistics-locator' } as LocatorRuntimeEntry;
const locatorComponent = { rowNumber: 1, assetId: 'L1' } as LocatorComponent;
const modelTarget = { kind: 'model', assetId: 'cargo', displayName: '货箱',
  modelAsset: { sourcePath: 'cargo.glb', sourceUrl: 'cargo.glb', assetRevision: null } } as ModelGeneratorTarget;
const generator = { defaultTarget: modelTarget, rules: [] } as ModelGeneratorComponent;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function record(column: number, overrides: Partial<FetchContainerRecord> = {}): FetchContainerRecord {
  return { containerCode: `C-${column}`, containerType: 'box', isEmpty: false, locType: '', row: '1',
    column, layer: 1, tier: 0, stackingRow: '1', stackingColumn: column, stackingLayer: 1, ...overrides };
}

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new LocatorFetchRuntime(scene, 'statistics-locator');
  return { scene, runtime, dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}

function apply(runtime: FetchRuntime, records: FetchContainerRecord[], options: {
  generator?: ModelGeneratorComponent | null;
  matrix?: (locator: LocatorRuntimeEntry, column: number, layer: number) => Matrix | null;
  load?: (target: ModelGeneratorTarget) => Promise<{ meshes: Mesh[]; dispose(): void } | null>;
} = {}) {
  return runtime.applyRecords(records, locator, locatorComponent, options.generator ?? null,
    options.matrix ?? (() => Matrix.Identity()), options.load ?? (async () => { throw new Error('内置几何不应加载模板'); }));
}

test('Fetch 实际 10 个立方体共 120 面，空格与其它排不计，隐藏不改变统计', async () => {
  const context = fixture();
  try {
    await apply(context.runtime, [...Array.from({ length: 10 }, (_, index) => record(index + 1)),
      record(11, { isEmpty: true }), record(12, { row: '2' })]);
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 120, phase: 'ready' });
    const batch = context.scene.meshes.find(mesh => mesh.name.startsWith('fetch_batch_'))!;
    batch.setEnabled(false); batch.isVisible = false; batch.visibility = 0;
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 120, phase: 'ready' });
  } finally { context.dispose(); }
});

test('多 mesh 模板只统计批次实际矩阵，模板及零矩阵批次不额外计一份', async () => {
  const context = fixture();
  try {
    const box = MeshBuilder.CreateBox('source-box', {}, context.scene);
    const plane = MeshBuilder.CreatePlane('source-plane', {}, context.scene);
    const load = async () => ({ meshes: [box, plane], dispose() { box.dispose(); plane.dispose(); } });
    await apply(context.runtime, [record(1), record(2), record(3)], { generator, load });
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 42, phase: 'ready' });
    await apply(context.runtime, [record(1), record(2)], { generator, load, matrix: () => null });
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 0, phase: 'error' });
    assert.ok(context.scene.meshes.every(mesh => mesh.thinInstanceCount === 0));
    await apply(context.runtime, [record(1), record(2)], { generator, load });
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 28, phase: 'ready' });
  } finally { context.dispose(); }
});

test('非 model 目标加载也阻止提前 ready，加载失败与空模板保留 error 状态', async () => {
  const context = fixture();
  try {
    const composition = { kind: 'composition', assetId: 'composition-cargo', displayName: '组合货物',
      composition: { entityIds: [], entities: {} } } as unknown as ModelGeneratorTarget;
    const component = { defaultTarget: composition, rules: [] };
    let resolve!: (value: null) => void;
    const pending = apply(context.runtime, [record(1)], { generator: component,
      load: () => new Promise(complete => { resolve = complete; }) });
    assert.equal(context.runtime.getTriangleStatistics().phase, 'loading');
    assert.equal(context.runtime.getEffectTargets().length, 0);
    resolve(null);
    await pending;
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 0, phase: 'error' });
    await apply(context.runtime, [record(1)], { generator: component, load: async () => { throw new Error('下载失败'); } });
    assert.equal(context.runtime.getTriangleStatistics().phase, 'error');
    await apply(context.runtime, [], { generator: component });
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 0, phase: 'ready' });
  } finally { context.dispose(); }
});

test('抑制货格和恢复、清空会通知统计变化，同一拍清空合并通知', async () => {
  const context = fixture();
  try {
    const notifications: ReturnType<FetchRuntime['getTriangleStatistics']>[] = [];
    context.runtime.onStatisticsChanged = () => notifications.push(context.runtime.getTriangleStatistics());
    await apply(context.runtime, [record(1), record(2), record(3)]);
    await flush();
    context.runtime.suppressCell(1, 1);
    await flush();
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 24, phase: 'ready' });
    context.runtime.clearSuppressedCells();
    await flush();
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 36, phase: 'ready' });
    const before = notifications.length;
    context.runtime.clearAllBatches(); context.runtime.clearAllBatches(); context.runtime.clearAllBatches();
    await flush();
    assert.equal(notifications.length - before, 1);
    assert.deepEqual(notifications.at(-1), { triangleCount: 0, phase: 'ready' });
    assert.ok(notifications.some(value => value.triangleCount === 24));
  } finally { context.dispose(); }
});

test('过期加载不会复活清空后的批次或覆盖新一轮状态', async () => {
  const context = fixture();
  try {
    const source = MeshBuilder.CreateBox('stale-template', {}, context.scene);
    let resolve!: (value: { meshes: Mesh[]; dispose(): void }) => void;
    const pending = apply(context.runtime, [record(1)], { generator,
      load: () => new Promise(complete => { resolve = complete; }) });
    assert.equal(context.runtime.getTriangleStatistics().phase, 'loading');
    context.runtime.clearAllBatches();
    await apply(context.runtime, [record(2), record(3)]);
    resolve({ meshes: [source], dispose() { source.dispose(); } });
    await pending;
    assert.equal(source.isDisposed(), true);
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 24, phase: 'ready' });
  } finally { context.dispose(); }
});

test('dispose 清空统计并阻止排队或过期异步通知', async () => {
  const context = fixture();
  try {
    let changes = 0;
    context.runtime.onStatisticsChanged = () => { changes += 1; };
    const source = MeshBuilder.CreateBox('disposed-template', {}, context.scene);
    let resolve!: (value: { meshes: Mesh[]; dispose(): void }) => void;
    const pending = apply(context.runtime, [record(1)], { generator,
      load: () => new Promise(complete => { resolve = complete; }) });
    context.runtime.dispose();
    resolve({ meshes: [source], dispose() { source.dispose(); } });
    await pending;
    await flush();
    assert.equal(changes, 0);
    assert.deepEqual(context.runtime.getTriangleStatistics(), { triangleCount: 0, phase: 'ready' });
  } finally { context.dispose(); }
});
