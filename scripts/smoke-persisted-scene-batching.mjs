import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';

const REAL_SCENE_PATH = process.env.ZENDING_SCENE_SOURCE
  ?? 'E:\\公司文件\\数字孪生\\场景\\珀莱雅一楼场景.scene.json';

function assertSerializationWiring() {
  const storeSource = readFileSync('src/editor/store/editorStore.ts', 'utf8');
  const publishSource = readFileSync('src/editor/deployment/useDigitalTwinPublish.ts', 'utf8');
  const exportSource = readFileSync('src/editor/deployment/useDeploymentExport.ts', 'utf8');
  const publishServiceSource = readFileSync('electron/ipc/digitalTwinPublishService.ts', 'utf8');

  assert.match(storeSource, /const content = serializeScene\(sceneSnapshot\);[\s\S]*?saveScene\(\{[\s\S]*?content,/,
    '普通保存必须通过 serializeScene 生成持久化合批快照');
  assert.match(publishSource, /const sceneContent = serializeScene\(useEditorStore\.getState\(\)\.scene\);[\s\S]*?publishDigitalTwin\(\{[\s\S]*?sceneContent,/,
    '数据中台发布必须通过 serializeScene 生成持久化合批快照');
  assert.match(exportSource, /const sceneContent = serializeScene\(sceneSnapshot\);[\s\S]*?exportWebProject\(\{[\s\S]*?sceneContent,/,
    '独立部署导出必须通过 serializeScene 生成持久化合批快照');
  assert.match(publishServiceSource, /saveCurrentScene\([^;]*validated\.sceneContent\);/,
    '发布主进程保存当前场景时必须使用 renderer 提交的同一份 sceneContent');
  assert.match(publishServiceSource, /buildDigitalTwinDistPackage\(\{[\s\S]*?sceneContent: validated\.sceneContent,/,
    'Viewer DIST 必须复用同一份已合批 sceneContent');
}

function createModelAsset(assetCode, options = {}) {
  return {
    sourcePath: options.sourcePath ?? 'F:/fixtures/StaticRack/StaticRack.glb',
    sourceUrl: options.sourceUrl ?? 'editor-asset://local/Assets/Models/StaticRack/StaticRack.glb',
    assetRevision: 'persisted-scene-batching-smoke',
    assetCode,
    lengthUnit: 'millimeter',
    unitScaleToMeters: 0.001,
    ...(options.parameterValues ? { parameterValues: options.parameterValues } : {}),
    ...(options.scriptAssets ? { scriptAssets: options.scriptAssets } : {}),
    ...(options.parameterScriptMetadata ? { parameterScriptMetadata: options.parameterScriptMetadata } : {}),
    ...(options.animationScriptMetadata ? { animationScriptMetadata: options.animationScriptMetadata } : {}),
    ...(options.parameterConfig ? { parameterConfig: options.parameterConfig } : {}),
  };
}

function createEntity(id, modelAsset, options = {}) {
  return {
    id,
    name: options.name ?? id,
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: options.position ?? { x: 0, y: 0, z: 0 },
        rotation: options.rotation ?? { x: 0, y: 0, z: 0 },
        scale: options.scale ?? { x: 1, y: 1, z: 1 },
      },
      modelAsset,
      telemetryBinding: options.telemetryBinding ?? {
        enabled: true,
        sourceId: `source-${id}`,
        deviceType: 'persisted-smoke',
        expectedIntervalMs: 500,
        staleAfterMs: 2_000,
      },
      ...(options.sourceEntityId ? { modelArrayInstance: { sourceEntityId: options.sourceEntityId } } : {}),
    },
  };
}

function createDocument(entities) {
  const entityIds = entities.map((entity) => entity.id);
  return {
    id: 'persisted_scene_batching_smoke',
    name: 'Persisted Scene Batching Smoke',
    entityIds,
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: null,
    mqttConfig: {
      enabled: false,
      ip: '',
      address: '',
      topic: 'zending/stacker/action',
      subscriptions: [{ topic: 'zending/stacker/action', qos: 0, adapter: { kind: 'epv' } }],
      simulatorEnabled: false,
      simulatorAssetCode: 'DDJ2',
      simulatorScenario: 'cycle',
      simulatorIntervalMs: 500,
    },
    fetchConfig: { url: '', apiKey: '' },
    sceneSettings: {
      camera: { savedPose: null, savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 },
      sensitivity: { zoom: 1, pan: 1, rotate: 1 },
      environment: null,
      skybox: null,
    },
  };
}

function snapshotLogicalState(document) {
  return Object.fromEntries(document.entityIds.map((entityId) => {
    const entity = document.entities[entityId];
    const { modelArrayInstance: _batchRelation, ...components } = entity.components;
    return [entityId, {
      name: entity.name,
      visible: entity.visible,
      locked: entity.locked,
      parentId: entity.parentId,
      childrenIds: entity.childrenIds,
      components,
    }];
  }));
}

function snapshotBatchTopology(document) {
  return Object.fromEntries(document.entityIds.map((entityId) => [
    entityId,
    document.entities[entityId].components.modelArrayInstance?.sourceEntityId ?? null,
  ]));
}

function snapshotRequiredPersistedState(document) {
  return Object.fromEntries(document.entityIds.map((entityId) => {
    const entity = document.entities[entityId];
    const modelAsset = entity.components.modelAsset;
    return [entityId, {
      name: entity.name,
      visible: entity.visible,
      locked: entity.locked,
      parentId: entity.parentId,
      childrenIds: entity.childrenIds,
      transform: entity.components.transform,
      telemetryBinding: entity.components.telemetryBinding,
      modelAsset: modelAsset ? {
        assetCode: modelAsset.assetCode,
        sourcePath: modelAsset.sourcePath,
        sourceUrl: modelAsset.sourceUrl,
        parameterValues: modelAsset.parameterValues,
        parameterConfig: modelAsset.parameterConfig,
        scriptAssets: modelAsset.scriptAssets,
        parameterScriptMetadata: modelAsset.parameterScriptMetadata,
        animationScriptMetadata: modelAsset.animationScriptMetadata,
      } : undefined,
    }];
  }));
}

async function run() {
  assertSerializationWiring();
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'error',
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false, port: 0, ws: false },
    preview: { port: 0 },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const [{ serializeScene, deserializeScene }, batching] = await Promise.all([
      server.ssrLoadModule('/src/editor/project/SceneSerializer.ts'),
      server.ssrLoadModule('/src/editor/model/editModeModelThinInstances.ts'),
    ]);
    assert.equal(
      typeof batching.createPersistedModelThinInstanceScene,
      'function',
      '保存/发布必须提供共享的持久化合批入口',
    );

    const staticSource = createEntity('STATIC-A', createModelAsset('ASSET-A'), {
      name: '静态源',
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0.1, y: 0.2, z: 0.3 },
      scale: { x: 1.1, y: 1.2, z: 1.3 },
    });
    const staticInstance = createEntity('STATIC-B', createModelAsset('ASSET-B'), {
      name: '静态实例',
      visible: false,
      locked: true,
      position: { x: 4, y: 5, z: 6 },
      telemetryBinding: {
        enabled: true,
        sourceId: 'source-static-b',
        deviceType: 'static-device',
        expectedIntervalMs: 750,
        staleAfterMs: 3_000,
      },
    });

    const verifiedScript = [{
      name: 'chain-conveyor.model.ts',
      path: 'F:/fixtures/Chain/chain-conveyor.model.ts',
      sourceUrl: 'editor-asset://local/Assets/Models/Chain/chain-conveyor.model.ts',
    }];
    const chainParameterConfig = {
      schema: 'babylon-editor.model-parameters',
      version: 1,
      parameters: [
        { key: 'length', label: '长度', type: 'number', unit: undefined, defaultValue: 10, min: 1, max: 100, step: 1 },
        { key: 'width', label: '宽度', type: 'number', unit: undefined, defaultValue: 2, min: 1, max: 20, step: 1 },
        { key: 'speed', label: '速度', type: 'number', unit: undefined, defaultValue: 1, min: 0, max: 10, step: 0.25 },
      ],
      bindings: [],
    };
    const chainSource = createEntity('CHAIN-A', createModelAsset('CHAIN-001', {
      sourcePath: 'F:/fixtures/Chain/链条机.glb',
      sourceUrl: 'editor-asset://local/Assets/Models/Chain/链条机.glb',
      parameterValues: { length: 10, width: 2, speed: 1.25 },
      parameterConfig: chainParameterConfig,
      scriptAssets: verifiedScript,
      parameterScriptMetadata: [{ scriptFilename: 'chain-conveyor.model.ts', values: {} }],
      animationScriptMetadata: [{ modelFilename: '链条机.glb', scriptFilename: 'chain-conveyor.model.ts', fields: [], values: {} }],
    }), { position: { x: 10, y: 0, z: 0 } });
    const chainInstance = createEntity('CHAIN-B', createModelAsset('CHAIN-002', {
      sourcePath: 'F:/fixtures/Chain/链条机.glb',
      sourceUrl: 'editor-asset://local/Assets/Models/Chain/链条机.glb',
      parameterValues: { length: 12, width: 3, speed: 0.75 },
      parameterConfig: chainParameterConfig,
      scriptAssets: verifiedScript,
      parameterScriptMetadata: [{ scriptFilename: 'chain-conveyor.model.ts', values: {} }],
      animationScriptMetadata: [{ modelFilename: '链条机.glb', scriptFilename: 'chain-conveyor.model.ts', fields: [], values: {} }],
    }), { position: { x: 20, y: 0, z: 0 } });

    const unsupportedScript = [{
      name: 'dynamic-machine.model.ts',
      path: 'F:/fixtures/Dynamic/dynamic-machine.model.ts',
      sourceUrl: 'editor-asset://local/Assets/Models/Dynamic/dynamic-machine.model.ts',
    }];
    const dynamicA = createEntity('DYNAMIC-A', createModelAsset('DYNAMIC-001', { scriptAssets: unsupportedScript }));
    const dynamicB = createEntity('DYNAMIC-B', createModelAsset('DYNAMIC-002', { scriptAssets: unsupportedScript }));
    const scene = createDocument([staticSource, staticInstance, chainSource, chainInstance, dynamicA, dynamicB]);
    const logicalStateBefore = snapshotLogicalState(scene);
    const topologyBefore = snapshotBatchTopology(scene);

    const saved = batching.createPersistedModelThinInstanceScene(scene);
    assert.notEqual(saved, scene, '首次保存存在可合批模型时必须生成独立快照');
    assert.deepEqual(snapshotBatchTopology(scene), topologyBefore, '生成持久化合批快照不得修改输入场景');
    assert.deepEqual(snapshotLogicalState(saved), logicalStateBefore, '合批不得修改参数、assetCode、Transform、显隐、锁定或遥测绑定');
    assert.equal(saved.entities['STATIC-B'].components.modelArrayInstance?.sourceEntityId, 'STATIC-A');
    assert.equal(saved.entities['CHAIN-B'].components.modelArrayInstance?.sourceEntityId, 'CHAIN-A');
    assert.equal(saved.entities['DYNAMIC-A'].components.modelArrayInstance, undefined, '未知脚本模型必须保持独立');
    assert.equal(saved.entities['DYNAMIC-B'].components.modelArrayInstance, undefined, '未知脚本模型必须保持独立');

    const savedTopology = snapshotBatchTopology(saved);
    const serializedDirectly = deserializeScene(serializeScene(scene));
    assert.deepEqual(
      snapshotBatchTopology(serializedDirectly),
      savedTopology,
      '保存与发布共用的 serializeScene 必须自动写入持久化合批关系',
    );
    const savedAgain = batching.createPersistedModelThinInstanceScene(saved);
    assert.deepEqual(snapshotBatchTopology(savedAgain), savedTopology, '保存快照重复合批必须幂等');

    const reopened = deserializeScene(serializeScene(saved));
    assert.deepEqual(snapshotBatchTopology(reopened), savedTopology, '重新打开必须直接恢复持久化合批关系');
    assert.deepEqual(snapshotLogicalState(reopened), logicalStateBefore, '重新打开后必须保留全部逻辑实体参数');
    for (const entityId of reopened.entityIds) {
      const sourceEntityId = reopened.entities[entityId].components.modelArrayInstance?.sourceEntityId;
      if (!sourceEntityId) continue;
      assert.equal(
        reopened.entities[sourceEntityId].components.modelArrayInstance,
        undefined,
        `${entityId} 不得形成链式 modelArrayInstance`,
      );
    }

    let realScene = null;
    if (existsSync(REAL_SCENE_PATH)) {
      const { promises: fs } = await import('node:fs');
      const sourceContent = await fs.readFile(REAL_SCENE_PATH, 'utf8');
      const sourceDocument = deserializeScene(sourceContent);
      const sourceRequiredState = snapshotRequiredPersistedState(sourceDocument);
      const sourceTopology = snapshotBatchTopology(sourceDocument);
      const optimizedContent = serializeScene(sourceDocument);
      const optimizedDocument = deserializeScene(optimizedContent);
      const optimizedTopology = snapshotBatchTopology(optimizedDocument);
      assert.deepEqual(
        snapshotRequiredPersistedState(optimizedDocument),
        sourceRequiredState,
        '真实场景保存并重开后必须保留链条机及全部逻辑实体参数',
      );
      assert.deepEqual(
        snapshotBatchTopology(deserializeScene(serializeScene(optimizedDocument))),
        optimizedTopology,
        '真实场景二次保存不得改变合批拓扑',
      );
      realScene = {
        entityCount: optimizedDocument.entityIds.length,
        persistedBatchCountBefore: Object.values(sourceTopology).filter(Boolean).length,
        persistedBatchCountAfter: Object.values(optimizedTopology).filter(Boolean).length,
        chainConveyorCount: optimizedDocument.entityIds.filter((entityId) => (
          optimizedDocument.entities[entityId].components.modelAsset?.scriptAssets
            ?.some((asset) => ['chain-conveyor.model.ts', 'newchain-conveyor.model.ts'].includes(asset.name.toLowerCase()))
        )).length,
      };
    }

    console.log(JSON.stringify({
      passed: true,
      persistedBatchCount: Object.values(savedTopology).filter(Boolean).length,
      unsupportedScriptEntitiesPreserved: 2,
      parameterizedChainEntitiesPreserved: 2,
      idempotent: true,
      realScene,
    }, null, 2));
  } finally {
    await server.close();
  }
}

await run();
