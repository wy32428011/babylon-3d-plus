import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 预编译同一模块图，避免 Vite SSR 按需传输在大型 Store 依赖图中超时。
const temporary = await mkdtemp(path.join(os.tmpdir(), 'builtin-slot-rows-ssr-'));
after(() => rm(temporary, { recursive: true, force: true }));
const entries = ['src/editor/store/editorStore.ts', 'src/editor/model/SceneDocument.ts'];
const entryFile = path.join(temporary, 'input.ts');
await writeFile(entryFile, entries.map((entry, index) =>
  `export * as module${index} from ${JSON.stringify(path.resolve(entry).replace(/\\/g, '/'))};`).join('\n'));
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true },
  build: { ssr: entryFile, outDir: path.join(temporary, 'out'), minify: false,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } } } }).catch(async error => {
  await rm(temporary, { recursive: true, force: true });
  throw error;
});
(globalThis as any).window ??= {};
const loaded = await import(pathToFileURL(path.join(temporary, 'out/entry.mjs')).href);
const { reconcileBuiltInSlotEntitiesInScene } = loaded.module0 as typeof import('../../src/editor/store/editorStore');
const { createEmptySceneDocument, createFolderEntity, createModelEntity } = loaded.module1 as typeof import('../../src/editor/model/SceneDocument');

const CONFIG = {
  enabledParam: 'enableBuiltInSlots',
  rowCountParam: 'builtInSlotRows',
  dimensionMapping: { columns: 'columnCount', layers: 'layerCount' },
  columnDirection: '-x' as const,
};

function fixture() {
  const scene = createEmptySceneDocument('内置货格多排对账');
  const folder = createFolderEntity('货架组');
  scene.entities[folder.id] = folder;
  scene.entityIds.push(folder.id);

  const host = createModelEntity('C:/rack/model.glb', 'editor-asset://local/rack.glb', '多穿货架');
  host.parentId = folder.id;
  folder.childrenIds.push(host.id);
  const modelAsset = host.components.modelAsset!;
  modelAsset.builtInSlotBindingConfig = CONFIG;
  modelAsset.assetCode = 'RACK-1';
  modelAsset.parameterValues = { enableBuiltInSlots: true, builtInSlotRows: '2', columnCount: 5, layerCount: 3 };
  scene.entities[host.id] = host;
  scene.entityIds.push(host.id);
  return { scene, host, folder };
}

function setParameters(scene: ReturnType<typeof fixture>['scene'], hostId: string, values: Record<string, unknown>) {
  const host = scene.entities[hostId];
  const modelAsset = host.components.modelAsset!;
  return {
    ...scene,
    entities: {
      ...scene.entities,
      [hostId]: { ...host, components: { ...host.components, modelAsset: { ...modelAsset, parameterValues: values } } },
    },
  };
}

function slotsOf(scene: ReturnType<typeof fixture>['scene'], hostId: string) {
  return Object.values(scene.entities)
    .filter((entity) => entity.components.locator?.builtInBinding?.hostEntityId === hostId)
    .sort((left, right) => (
      (left.components.locator?.builtInBinding?.rowIndex ?? 0) - (right.components.locator?.builtInBinding?.rowIndex ?? 0)
    ));
}

function run(scene: ReturnType<typeof fixture>['scene'], hostId: string) {
  return reconcileBuiltInSlotEntitiesInScene(scene, hostId, CONFIG);
}

test('启用 2 排时创建两排货格：排索引、排号、命名与层级顺序一致', () => {
  const { scene, host, folder } = fixture();
  const after = run(scene, host.id);

  const slots = slotsOf(after, host.id);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map((slot) => slot.components.locator?.builtInBinding?.rowIndex), [0, 1]);
  assert.deepEqual(slots.map((slot) => slot.components.locator?.rowNumber), [1, 2]);
  assert.deepEqual(slots.map((slot) => slot.name), ['内置货格 第1排', '内置货格 第2排']);
  assert.deepEqual(slots.map((slot) => slot.components.locator?.assetId), ['RACK-1', 'RACK-1']);
  // 维度按声明从货架参数派生
  assert.deepEqual(slots.map((slot) => slot.components.locator?.columns), [5, 5]);
  assert.deepEqual(slots.map((slot) => slot.components.locator?.layers), [3, 3]);
  // 与宿主同级挂在文件夹下
  assert.deepEqual(slots.map((slot) => slot.parentId), [folder.id, folder.id]);
  assert.deepEqual(after.entities[folder.id].childrenIds, [host.id, ...slots.map((slot) => slot.id)]);
  // 场景顺序：紧跟宿主之后
  const hostIndex = after.entityIds.indexOf(host.id);
  assert.deepEqual(after.entityIds.slice(hostIndex, hostIndex + 3), [host.id, ...slots.map((slot) => slot.id)]);
});

test('2 排升到 4 排保留原有两排的身份，只补齐缺失排', () => {
  const { scene, host } = fixture();
  const twoRows = run(scene, host.id);
  const before = slotsOf(twoRows, host.id).map((slot) => slot.id);

  const fourRows = run(setParameters(twoRows, host.id, { enableBuiltInSlots: true, builtInSlotRows: '4' }), host.id);
  const slots = slotsOf(fourRows, host.id);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((slot) => slot.components.locator?.builtInBinding?.rowIndex), [0, 1, 2, 3]);
  assert.deepEqual(slots.map((slot) => slot.id).slice(0, 2), before, '原有排应保持实体 ID 不变');
  assert.deepEqual(slots.map((slot) => slot.components.locator?.rowNumber), [1, 2, 3, 4]);
});

test('4 排降回 2 排删除多余排并清理文件夹子项', () => {
  const { scene, host, folder } = fixture();
  const fourRows = run(setParameters(run(scene, host.id), host.id, {
    enableBuiltInSlots: true, builtInSlotRows: '4',
  }), host.id);
  const removedIds = slotsOf(fourRows, host.id).slice(2).map((slot) => slot.id);

  const twoRows = run(setParameters(fourRows, host.id, { enableBuiltInSlots: true, builtInSlotRows: '2' }), host.id);
  const slots = slotsOf(twoRows, host.id);
  assert.deepEqual(slots.map((slot) => slot.components.locator?.builtInBinding?.rowIndex), [0, 1]);
  for (const removedId of removedIds) {
    assert.equal(twoRows.entities[removedId], undefined);
    assert.equal(twoRows.entityIds.includes(removedId), false);
  }
  assert.deepEqual(twoRows.entities[folder.id].childrenIds, [host.id, ...slots.map((slot) => slot.id)]);
});

test('关闭开关删除全部货格，重复对账幂等', () => {
  const { scene, host, folder } = fixture();
  const enabled = run(scene, host.id);

  const disabled = run(setParameters(enabled, host.id, { enableBuiltInSlots: false, builtInSlotRows: '4' }), host.id);
  assert.deepEqual(slotsOf(disabled, host.id), []);
  assert.deepEqual(disabled.entities[folder.id].childrenIds, [host.id]);

  // 无增删改时返回同一 scene 引用，避免无谓的文档快照
  assert.equal(run(enabled, host.id), enabled);
  assert.equal(run(disabled, host.id), disabled);
});

test('未声明排数参数时保持单排行为', () => {
  const { scene, host } = fixture();
  const singleRowConfig = { enabledParam: 'enableBuiltInSlots', dimensionMapping: { columns: 'columnCount' } };
  const after = reconcileBuiltInSlotEntitiesInScene(
    setParameters(scene, host.id, { enableBuiltInSlots: true, builtInSlotRows: '4' }),
    host.id,
    singleRowConfig,
  );

  const slots = slotsOf(after, host.id);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].components.locator?.builtInBinding?.rowIndex, 0);
  assert.equal(slots[0].components.locator?.rowNumber, 1);
});
