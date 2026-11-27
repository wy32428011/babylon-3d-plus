import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import {
  EDITOR_NEW_INSTANCE_ARG,
  buildNewEditorInstanceSpawnSpec,
  resolveEditorInstanceMode,
  shouldPrimaryFocusOnSecondInstance,
} from '../../electron/shared/editorInstanceLaunch.ts';
import {
  ENTITY_CLIPBOARD_SCHEMA_VERSION,
  MAX_ENTITY_CLIPBOARD_BYTES,
  parseEntityClipboardPayload,
  serializeEntityClipboardPayload,
  type CrossSceneEntityClipboardPayload,
  type ReadEntityClipboardResult,
} from '../../electron/shared/entityClipboardTransfer.ts';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'cross-scene-clipboard-'));
after(() => rm(temporary, { recursive: true, force: true }));

const entry = path.join(temporary, 'input.ts');
await writeFile(
  entry,
  [
    ['src/editor/store/editorStore.ts', 'store'],
    ['src/editor/store/slices/entityClipboardOperations.ts', 'clipboard'],
    ['src/editor/model/SceneDocument.ts', 'document'],
    ['src/editor/model/alarmManager.ts', 'alarm'],
    ['src/editor/model/chartMarker.ts', 'chartMarker'],
    ['src/editor/model/deviceSpawner.ts', 'spawner'],
    ['src/editor/model/autoPatrolInspection.ts', 'patrol'],
    ['src/editor/project/SceneSerializer.ts', 'serializer'],
  ]
    .map(([file, name]) => `export * as ${name} from ${JSON.stringify(path.resolve(file).replace(/\\/g, '/'))};`)
    .join('\n'),
);

await build({
  configFile: false,
  logLevel: 'error',
  ssr: { noExternal: true },
  build: {
    ssr: entry,
    outDir: path.join(temporary, 'out'),
    minify: false,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
  },
});

const loaded = await import(pathToFileURL(path.join(temporary, 'out/entry.mjs')).href);
const { useEditorStore } = loaded.store;
const {
  createEntityClipboardSnapshot,
  prepareEntityClipboardPaste,
  collectLightingGroupRulesForClipboard,
  mergeCrossSceneLightingGroupRules,
} = loaded.clipboard;
const {
  createEmptySceneDocument,
  createFolderEntity,
  createMeshEntity,
  createModelEntity,
  createLocatorEntity,
  createSkyboxEntity,
  createManualRoamSpawnEntity,
  createPoiEffectEntity,
} = loaded.document;
const { createAlarmManagerEntity } = loaded.alarm;
const { createChartMarkerEntity } = loaded.chartMarker;
const { createDefaultDeviceSpawner } = loaded.spawner;
const { createDefaultAutoPatrolComponent } = loaded.patrol;
const { serializeScene } = loaded.serializer;

const initialStoreState = useEditorStore.getState();
const originalWindow = (globalThis as { window?: unknown }).window;

after(() => {
  useEditorStore.setState(initialStoreState, true);
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

beforeEach(() => {
  (globalThis as { window: unknown }).window = { editorApi: {} };
  useEditorStore.setState(initialStoreState, true);
});

function createModel(name: string, fileStem: string, assetCode: string, position = { x: 0, y: 0, z: 0 }) {
  const entity = createModelEntity(
    `${fileStem}.glb`,
    `editor-asset://local/${encodeURIComponent(`C:/workspace/${fileStem}.glb`)}`,
    name,
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
    position,
  );
  entity.components.modelAsset.sourcePath = `C:\\workspace\\${fileStem}.glb`;
  entity.components.modelAsset.assetCode = assetCode;
  return entity;
}

function createSceneWithEntities(name: string, entities: Array<Record<string, unknown>>) {
  const scene = createEmptySceneDocument(name);
  scene.entityIds = entities.map((entity) => String(entity.id));
  scene.entities = Object.fromEntries(entities.map((entity) => [String(entity.id), entity]));
  return scene;
}

test('多实例启动策略：主实例、深链退出、普通双开与显式新开判定', () => {
  assert.equal(
    resolveEditorInstanceMode({ argv: ['app.exe'], hasSingleInstanceLock: true, hasDeepLink: false }),
    'primary',
  );
  assert.equal(
    resolveEditorInstanceMode({
      argv: ['app.exe', 'zending3d://open-project?baseUrl=http://127.0.0.1:8086&projectId=1'],
      hasSingleInstanceLock: false,
      hasDeepLink: true,
    }),
    'quit-for-deep-link',
  );
  assert.equal(
    resolveEditorInstanceMode({ argv: ['app.exe'], hasSingleInstanceLock: false, hasDeepLink: false }),
    'secondary',
  );
  assert.equal(
    resolveEditorInstanceMode({
      argv: ['app.exe', EDITOR_NEW_INSTANCE_ARG],
      hasSingleInstanceLock: false,
      hasDeepLink: true,
    }),
    'secondary',
  );
  assert.equal(shouldPrimaryFocusOnSecondInstance(true), true);
  assert.equal(shouldPrimaryFocusOnSecondInstance(false), false);

  assert.deepEqual(
    buildNewEditorInstanceSpawnSpec({ isPackaged: true, execPath: 'C:\\app\\editor.exe', appPath: 'C:\\app' }),
    { command: 'C:\\app\\editor.exe', args: [EDITOR_NEW_INSTANCE_ARG] },
  );
  assert.deepEqual(
    buildNewEditorInstanceSpawnSpec({ isPackaged: false, execPath: 'node.exe', appPath: 'C:\\repo' }),
    { command: 'node.exe', args: ['C:\\repo', EDITOR_NEW_INSTANCE_ARG], cwd: 'C:\\repo' },
  );
});

test('跨场景剪贴板载荷校验：支持往返序列化并拒绝损坏/超限载荷', () => {
  const model = createModel('堆垛机', 'stacker', 'DDJ-01');
  const payload: CrossSceneEntityClipboardPayload = {
    schemaVersion: ENTITY_CLIPBOARD_SCHEMA_VERSION,
    clipboardId: 'clip_1',
    copiedAt: '2026-11-27T00:00:00.000Z',
    sourceContext: {
      sceneSessionId: 'session_a',
      sceneFilePath: 'C:\\proj\\a.scene.json',
      projectRoot: 'C:\\proj',
      dataPlatformBaseUrl: 'http://127.0.0.1:8086',
      dataPlatformProjectId: '42',
    },
    entries: [{ rootId: model.id, entities: [model as unknown as Record<string, unknown>] }],
  };

  const buffer = serializeEntityClipboardPayload(payload);
  const parsed = parseEntityClipboardPayload(buffer);
  assert.ok(parsed);
  assert.equal(parsed.clipboardId, 'clip_1');
  assert.equal(parsed.sourceContext.dataPlatformProjectId, '42');
  assert.equal(parsed.entries[0].entities.length, 1);

  assert.equal(parseEntityClipboardPayload('{invalid'), null);
  assert.equal(parseEntityClipboardPayload(JSON.stringify({ ...payload, schemaVersion: 999 })), null);
  assert.equal(parseEntityClipboardPayload(JSON.stringify({ ...payload, entries: [] })), null);

  const oversized = Buffer.alloc(MAX_ENTITY_CLIPBOARD_BYTES + 1, 0x20);
  assert.equal(parseEntityClipboardPayload(oversized), null);

  assert.throws(
    () =>
      serializeEntityClipboardPayload({
        ...payload,
        entries: [{ rootId: 'x', entities: [{ id: 'x', name: 'x', components: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }, bigText: 'a'.repeat(MAX_ENTITY_CLIPBOARD_BYTES) }] }],
      }),
    /超过 .* 剪贴板限制/,
  );
});

test('阵列子副本在未复制母模型时固化模型资产；同批复制保留阵列关联', () => {
  const source = createModel('货架母体', 'shelf', 'SHELF-001');
  source.components.modelAsset.parameterValues = { rows: 2 };
  const child = createModel('货架副本', 'shelf', 'SHELF-002', { x: 5, y: 0, z: 0 });
  child.components.modelArrayInstance = { sourceEntityId: source.id };
  const scene = createSceneWithEntities('阵列快照', [source, child]);

  const orphanSnapshot = createEntityClipboardSnapshot(scene, [child.id]);
  const copiedOrphan = orphanSnapshot.entries[0].entities[0];
  assert.equal(copiedOrphan.components.modelArrayInstance, undefined, '单独复制阵列副本时必须解除悬空阵列引用');
  assert.equal(copiedOrphan.components.modelAsset?.assetCode, 'SHELF-002');
  assert.deepEqual(copiedOrphan.components.modelAsset?.parameterValues, { rows: 2 });

  const pairSnapshot = createEntityClipboardSnapshot(scene, [source.id, child.id]);
  const pairEntities = pairSnapshot.entries.flatMap((entry) => entry.entities);
  const copiedChildInPair = pairEntities.find((entity) => entity.id === child.id);
  assert.equal(copiedChildInPair?.components.modelArrayInstance?.sourceEntityId, source.id, '母体同批复制时保留阵列源引用');
});

test('跨场景粘贴：保留无冲突名称与编号、重连同批引用、清理悬空外部引用并迁移分组光照规则', () => {
  const folder = createFolderEntity('立库A区');
  const copiedModel = createModel('输送线-01', 'conveyor', 'CV-001', { x: 2, y: 0, z: 1 });
  const conflictModel = createModel('冲突设备', 'agv', 'EXIST-01', { x: 4, y: 0, z: 1 });
  const uncopiedEntity = createMeshEntity('cube', { x: 99, y: 0, z: 0 });
  uncopiedEntity.name = '未复制目标';

  const alarm = createAlarmManagerEntity({ x: 0, y: 1, z: 0 });
  alarm.components.alarmManager.targets = [
    { id: 't_in', model: null, entityId: copiedModel.id },
    { id: 't_out', model: null, entityId: uncopiedEntity.id },
  ];
  const effect = createPoiEffectEntity('alarm-pulse', { x: 0, y: 2, z: 0 });
  effect.components.poiEffect.configuration = {
    version: 1,
    target: {
      mode: 'entity',
      entityId: uncopiedEntity.id,
      entityIds: [copiedModel.id, uncopiedEntity.id],
      generatorId: uncopiedEntity.id,
      model: null,
      sourceId: '',
      deviceType: '',
      assetCode: '',
      selection: 'single',
      maxTargets: 1,
      anchor: 'origin',
      nodePath: '',
      offset: { x: 0, y: 0, z: 0 },
    },
  };
  const marker = createChartMarkerEntity({ x: 1, y: 2, z: 3 });
  marker.components.chartMarker.dataSourceEntityId = uncopiedEntity.id;
  marker.components.chartMarker.clickEvents = [
    {
      type: 'left-click',
      actions: [
        { type: 'focus', targetEntityId: marker.id },
        { type: 'select', targetEntityId: copiedModel.id },
        { type: 'focus', targetEntityId: uncopiedEntity.id },
        { type: 'theme', screen: { projectId: '100', screenId: '200', name: '原项目大屏', screenUrl: 'http://127.0.0.1/s/200' } },
      ],
    },
  ];
  const spawner = createMeshEntity('cube', { x: 0, y: 0, z: 0 });
  spawner.name = '产生器';
  spawner.components.deviceSpawner = {
    ...createDefaultDeviceSpawner(),
    templateEntityId: uncopiedEntity.id,
    templateRules: [{ id: 'r1', attributeName: 'kind', attributeValue: 'a', templateEntityId: copiedModel.id }],
  };
  const patrol = createMeshEntity('cube', { x: 0, y: 0, z: 0 });
  patrol.name = '巡检';
  patrol.components.autoPatrol = {
    ...createDefaultAutoPatrolComponent(),
    events: [
      {
        id: 'ev_1',
        name: '到达',
        enabled: true,
        trigger: { kind: 'manual' },
        responses: ['highlight'],
        targetEntityId: uncopiedEntity.id,
        cooldownSeconds: 0,
        oncePerPatrol: false,
        businessData: {},
      },
    ],
  };

  for (const child of [copiedModel, conflictModel, alarm, effect, marker, spawner, patrol]) {
    child.parentId = folder.id;
  }
  folder.childrenIds = [copiedModel.id, conflictModel.id, alarm.id, effect.id, marker.id, spawner.id, patrol.id];

  const sourceScene = createSceneWithEntities('源场景', [
    folder,
    copiedModel,
    conflictModel,
    alarm,
    effect,
    marker,
    spawner,
    patrol,
    uncopiedEntity,
  ]);
  sourceScene.sceneSettings.lighting.policy = {
    version: 1,
    defaults: {},
    rules: [
      { id: 'rule_group', name: '分组静态规则', enabled: true, target: { kind: 'group', folderId: folder.id }, values: { mobility: 'static' } },
      { id: 'rule_other', name: '无关分组', enabled: true, target: { kind: 'group', folderId: 'missing_folder' }, values: { mobility: 'dynamic' } },
    ],
  };

  const snapshot = createEntityClipboardSnapshot(sourceScene, [folder.id]);
  const rules = collectLightingGroupRulesForClipboard(sourceScene, snapshot.entries);
  assert.equal(rules.length, 1);

  const existingTargetModel = createModel('冲突设备', 'other', 'EXIST-01');
  const targetScene = createSceneWithEntities('目标场景', [existingTargetModel]);

  const prepared = prepareEntityClipboardPaste(
    targetScene,
    { id: 'clip_cross', entries: snapshot.entries },
    null,
    undefined,
    { crossScene: true, sourceProjectId: '100', targetProjectId: '999' },
  );

  const pastedByOldId = new Map<string, Record<string, unknown>>();
  for (const [oldId, newId] of prepared.duplicatedIdBySourceId.entries()) {
    const found = prepared.entities.find((entity) => entity.id === newId);
    if (found) pastedByOldId.set(oldId, found as unknown as Record<string, unknown>);
  }

  const pastedFolder = pastedByOldId.get(folder.id)!;
  const pastedModel = pastedByOldId.get(copiedModel.id)!;
  const pastedConflict = pastedByOldId.get(conflictModel.id)!;
  const pastedAlarm = pastedByOldId.get(alarm.id)!;
  const pastedEffect = pastedByOldId.get(effect.id)!;
  const pastedMarker = pastedByOldId.get(marker.id)!;
  const pastedSpawner = pastedByOldId.get(spawner.id)!;
  const pastedPatrol = pastedByOldId.get(patrol.id)!;

  assert.equal(pastedFolder.name, '立库A区', '无同名冲突时保留原文件夹名');
  assert.equal(pastedModel.name, '输送线-01', '无同名冲突时保留原模型名');
  assert.equal((pastedModel.components as Record<string, Record<string, unknown>>).modelAsset.assetCode, 'CV-001', '无冲突时保留原资产编号');
  assert.equal(pastedConflict.name, '冲突设备 副本', '存在同名对象时生成副本名');
  assert.notEqual((pastedConflict.components as Record<string, Record<string, unknown>>).modelAsset.assetCode, 'EXIST-01', '编号冲突时重新生成');

  const alarmTargets = (pastedAlarm.components as Record<string, { targets: Array<{ entityId: string }> }>).alarmManager.targets;
  assert.deepEqual(alarmTargets.map((item) => item.entityId), [String(pastedModel.id)]);

  const effectCfgTarget = (pastedEffect.components as Record<string, { configuration: { target: { entityId: string | null; entityIds?: string[]; generatorId: string | null } } }>).poiEffect.configuration.target;
  assert.equal(effectCfgTarget.entityId, null);
  assert.deepEqual(effectCfgTarget.entityIds, [String(pastedModel.id)]);
  assert.equal(effectCfgTarget.generatorId, null);

  const markerComp = (pastedMarker.components as Record<string, { dataSourceEntityId?: string; clickEvents: Array<{ actions: Array<Record<string, unknown>> }> }>).chartMarker;
  assert.equal(markerComp.dataSourceEntityId, undefined);
  assert.equal(markerComp.clickEvents[0].actions.length, 3, '保留自聚焦、同批选择与主题动作，清理外部聚焦');
  assert.equal(markerComp.clickEvents[0].actions[0].targetEntityId, pastedMarker.id);
  assert.equal(markerComp.clickEvents[0].actions[1].targetEntityId, pastedModel.id);

  const spawnerComp = (pastedSpawner.components as Record<string, { templateEntityId: string | null; templateRules: Array<{ templateEntityId: string | null }> }>).deviceSpawner;
  assert.equal(spawnerComp.templateEntityId, null);
  assert.equal(spawnerComp.templateRules[0].templateEntityId, pastedModel.id);

  const patrolComp = (pastedPatrol.components as Record<string, { events: Array<{ targetEntityId: string | null }> }>).autoPatrol;
  assert.equal(patrolComp.events[0].targetEntityId, null);

  assert.ok(prepared.warnings.some((item) => item.includes('资产编号与目标场景冲突')));
  assert.ok(prepared.warnings.some((item) => item.includes('关联引用')));
  assert.ok(prepared.warnings.some((item) => item.includes('属于原项目')));

  const mergedScene = mergeCrossSceneLightingGroupRules(
    {
      ...targetScene,
      entityIds: [...targetScene.entityIds, ...prepared.entities.map((entity) => entity.id)],
      entities: {
        ...targetScene.entities,
        ...Object.fromEntries(prepared.entities.map((entity) => [entity.id, entity])),
      },
    },
    rules,
    prepared.duplicatedIdBySourceId,
  );
  assert.equal(mergedScene.sceneSettings.lighting.policy?.rules.length, 1);
  assert.deepEqual(mergedScene.sceneSettings.lighting.policy?.rules[0].target, {
    kind: 'group',
    folderId: String(pastedFolder.id),
  });
});

test('Store 联调：跨场景系统剪贴板写入、切换场景粘贴、撤销/重做及唯一对象拦截', async () => {
  const writtenPayloads: CrossSceneEntityClipboardPayload[] = [];
  let mockedReadResult: ReadEntityClipboardResult = {
    available: false,
    payload: null,
    warnings: [],
    missingResources: [],
  };

  (globalThis as { window: unknown }).window = {
    editorApi: {
      writeEntityClipboard: async ({ payload }: { payload: CrossSceneEntityClipboardPayload }) => {
        writtenPayloads.push(payload);
        mockedReadResult = { available: true, payload, warnings: [], missingResources: [] };
        return { ok: true, byteLength: 1024 };
      },
      readEntityClipboard: async () => mockedReadResult,
      getDigitalTwinPublishContext: async () => ({ projectId: '42' }),
    },
  };

  const folder = createFolderEntity('货架组');
  const rack = createModel('立体货架', 'rack', 'RACK-01', { x: 3, y: 0, z: 4 });
  const slot = createLocatorEntity({ x: 3, y: 0, z: 4 });
  slot.name = '内置货格 第1排';
  slot.components.locator.builtInBinding = { hostEntityId: rack.id, rowIndex: 0, originOffset: { x: 0, y: 0, z: 0 } };
  rack.parentId = folder.id;
  slot.parentId = folder.id;
  folder.childrenIds = [rack.id, slot.id];

  const sceneA = createSceneWithEntities('场景 A', [folder, rack, slot]);
  useEditorStore.getState().loadSceneFromContent(serializeScene(sceneA), 'scene-a.scene.json');
  useEditorStore.getState().selectHierarchyEntities([folder.id], folder.id);
  useEditorStore.getState().copySelectedEntities();

  // 等待异步微任务写入系统剪贴板
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writtenPayloads.length, 1);
  assert.equal(writtenPayloads[0].entries[0].entities.length, 3);

  // 切换到场景 B（内存剪贴板会被清空）
  const sceneB = createEmptySceneDocument('场景 B');
  useEditorStore.getState().loadSceneFromContent(serializeScene(sceneB), 'scene-b.scene.json');
  assert.equal(useEditorStore.getState().entityClipboard, null);

  await useEditorStore.getState().pasteEntityClipboardFromSystem();
  let state = useEditorStore.getState();
  assert.equal(state.scene.entityIds.length, 3);
  assert.equal(state.history.undoStack.length, 1);
  const pastedFolder = state.hierarchySelectionIds.map((id) => state.scene.entities[id])[0];
  assert.equal(pastedFolder.name, '货架组');
  const pastedChildren = pastedFolder.childrenIds.map((id) => state.scene.entities[id]);
  const pastedRack = pastedChildren.find((entity) => Boolean(entity.components.modelAsset));
  const pastedSlot = pastedChildren.find((entity) => Boolean(entity.components.locator));
  assert.equal(pastedRack?.components.modelAsset?.assetCode, 'RACK-01');
  assert.equal(pastedSlot?.components.locator?.builtInBinding?.hostEntityId, pastedRack?.id);

  // 支持单条命令原子撤销与重做
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().scene.entityIds.length, 0);
  useEditorStore.getState().redo();
  assert.equal(useEditorStore.getState().scene.entityIds.length, 3);

  // 拒绝含天空盒或漫游出生点的外部剪贴板载荷
  const skybox = createSkyboxEntity({
    packagePath: 'C:/sky',
    sourcePath: 'C:/sky/env.hdr',
    sourceUrl: 'editor-asset://local/C%3A%2Fsky%2Fenv.hdr',
    format: 'hdr',
    intensity: 1,
    resolution: 512,
    rotationDegrees: 0,
  });
  mockedReadResult = {
    available: true,
    payload: {
      schemaVersion: 1,
      clipboardId: 'clip_sky',
      copiedAt: '2026-11-27T00:00:00.000Z',
      sourceContext: {
        sceneSessionId: 'other_session',
        sceneFilePath: null,
        projectRoot: null,
        dataPlatformBaseUrl: null,
        dataPlatformProjectId: null,
      },
      entries: [{ rootId: skybox.id, entities: [skybox as unknown as Record<string, unknown>] }],
    },
    warnings: [],
    missingResources: [],
  };
  await useEditorStore.getState().pasteEntityClipboardFromSystem();
  state = useEditorStore.getState();
  assert.equal(state.scene.entityIds.length, 3);
  assert.match(state.logs[0].message, /天空背景/);

  const spawn = createManualRoamSpawnEntity({ x: 0, y: 0, z: 0 });
  mockedReadResult = {
    available: true,
    payload: {
      schemaVersion: 1,
      clipboardId: 'clip_spawn',
      copiedAt: '2026-11-27T00:00:00.000Z',
      sourceContext: {
        sceneSessionId: 'other_session',
        sceneFilePath: null,
        projectRoot: null,
        dataPlatformBaseUrl: null,
        dataPlatformProjectId: null,
      },
      entries: [{ rootId: spawn.id, entities: [spawn as unknown as Record<string, unknown>] }],
    },
    warnings: [],
    missingResources: [],
  };
  await useEditorStore.getState().pasteEntityClipboardFromSystem();
  state = useEditorStore.getState();
  assert.equal(state.scene.entityIds.length, 3);
  assert.match(state.logs[0].message, /手动漫游初始位置/);
});

test('跨项目大屏绑定校验覆盖中台到本地与匿名源场景，并支持触发项目资产刷新计数', async () => {
  const screenHolder = createChartMarkerEntity({ x: 0, y: 1, z: 0 });
  screenHolder.components.chartMarker.clickEvents = [
    {
      type: 'left-click',
      actions: [
        { type: 'theme', screen: { projectId: 'proj-a', screenId: 'screen-1', name: '原项目大屏', screenUrl: 'http://127.0.0.1/s/1' } },
      ],
    },
  ];
  const sourceScene = createSceneWithEntities('源场景', [screenHolder]);
  const snapshot = createEntityClipboardSnapshot(sourceScene, [screenHolder.id]);
  const targetScene = createEmptySceneDocument('本地目标场景');

  const toLocalPrepared = prepareEntityClipboardPaste(
    targetScene,
    { id: 'clip_to_local', entries: snapshot.entries },
    null,
    undefined,
    { crossScene: true, sourceProjectId: 'proj-a', targetProjectId: null },
  );
  assert.ok(toLocalPrepared.warnings.some((item) => item.includes('属于原项目')));

  const fromUnboundPrepared = prepareEntityClipboardPaste(
    targetScene,
    { id: 'clip_unbound', entries: snapshot.entries },
    null,
    undefined,
    { crossScene: true, sourceProjectId: null, targetProjectId: 'proj-b' },
  );
  assert.ok(fromUnboundPrepared.warnings.some((item) => item.includes('属于原项目')));

  const plainModel = createModel('独立设备', 'device', 'DEV-01');
  const beforeVersion = useEditorStore.getState().projectAssetsRefreshVersion;
  (globalThis as { window: unknown }).window = {
    editorApi: {
      readEntityClipboard: async (): Promise<ReadEntityClipboardResult> => ({
        available: true,
        payload: {
          schemaVersion: 1,
          clipboardId: 'clip_refresh_assets',
          copiedAt: '2026-11-27T00:00:00.000Z',
          sourceContext: {
            sceneSessionId: 'other_project_session',
            sceneFilePath: null,
            projectRoot: 'C:/ProjectA',
            dataPlatformBaseUrl: null,
            dataPlatformProjectId: null,
          },
          entries: [{ rootId: plainModel.id, entities: [plainModel as unknown as Record<string, unknown>] }],
        },
        warnings: [],
        missingResources: [],
        projectAssetsUpdated: true,
      }),
    },
  };

  await useEditorStore.getState().pasteEntityClipboardFromSystem();
  assert.equal(useEditorStore.getState().projectAssetsRefreshVersion, beforeVersion + 1);
});
