import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { CreateBox, InstancedMesh, NullEngine, Scene, StandardMaterial, TransformNode } from '@babylonjs/core';
import ts from 'typescript';

import { createDefaultTelemetryBinding, normalizeModelDataDrivenConfig } from '../../src/editor/model/telemetryBinding';
import type { ExternalModelScriptTelemetrySnapshot } from '../../src/runtime/babylon/ExternalModelScriptRuntime';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import type { SpecializedTelemetryHost } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import type { Entity } from '../../src/editor/model/Entity';
import type { ModelAssetComponent } from '../../src/editor/model/components';
import { ModelArrayRuntimeController } from '../../src/runtime/babylon/scene-runtime/ModelArrayRuntimeController';
import { SceneTelemetryController } from '../../src/runtime/babylon/scene-runtime/SceneTelemetryController';
import { deviceTelemetryStore } from '../../src/runtime/mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore } from '../../src/runtime/mqtt/telemetryRuntimeDiagnostics';

const LED_SCRIPT_PATH = 'SharedResources/Assets/Models/Model-2080102163768123393-LED/led.model.ts';
const LED_META_PATH = 'SharedResources/Assets/Models/Model-2080102163768123393-LED/meta.json';

function createDisplayTextReader() {
  const source = readFileSync(LED_SCRIPT_PATH, 'utf8');
  const ast = ts.createSourceFile(LED_SCRIPT_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defaults = ast.statements.find((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'DEFAULT_VALUES'));
  const runtimeClass = ast.statements.find((statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement)
    && statement.name?.text === 'ParametricModelRuntimeComponent');
  const readDisplayText = runtimeClass?.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member)
    && member.name.getText(ast) === 'readDisplayText');
  const updateCompletion = runtimeClass?.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member)
    && member.name.getText(ast) === 'updateTelemetryDisplayCompletion');
  assert.ok(defaults);
  assert.ok(readDisplayText);
  assert.ok(updateCompletion);
  assert.match(source, /export const dataDriven = \{[\s\S]*?devType:\s*"led"/);

  const executable = ts.transpileModule([
    defaults.getText(ast),
    `class LedDisplayTextRuntime { ${readDisplayText.getText(ast)} ${updateCompletion.getText(ast)} }`,
    `({
      read(values, mode, telemetry) {
        const instance = new LedDisplayTextRuntime();
        instance.runtimeMode = mode;
        instance.runtimeTelemetry = telemetry;
        return instance.readDisplayText(values);
      },
      create(values, telemetry) {
        const instance = new LedDisplayTextRuntime();
        instance.runtimeMode = 'runtime';
        instance.runtimeTelemetry = telemetry;
        instance.lastTelemetryDisplayText = '';
        instance.telemetryDisplayCompleted = true;
        instance.scrollPhaseText = '';
        instance.scrollXPx = 0;
        return {
          read(nextTelemetry) {
            instance.runtimeTelemetry = nextTelemetry;
            return instance.readDisplayText(values);
          },
          complete(period) {
            instance.scrollPhaseText = instance.lastTelemetryDisplayText;
            instance.scrollXPx = period;
            instance.updateTelemetryDisplayCompletion(period);
          },
        };
      },
    })`,
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return runInNewContext(executable) as {
    read(values: Record<string, unknown>, mode: string, telemetry: unknown): string;
    create(values: Record<string, unknown>, telemetry: unknown): {
      read(nextTelemetry: unknown): string;
      complete(period: number): void;
    };
  };
}

test('LED 模型包声明 led 设备类型并通过配置归一化', () => {
  const metadata = JSON.parse(readFileSync(LED_META_PATH, 'utf8')) as { dataDriven?: unknown };
  assert.equal(normalizeModelDataDrivenConfig(metadata.dataDriven)?.device.devType, 'led');
});

test('LED 遥测按完整设备主键注入模型脚本上下文', () => {
  deviceTelemetryStore.clear();
  telemetryRuntimeDiagnosticsStore.clear();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('led', scene);
  const contentRoot = new TransformNode('led_content', scene);
  let activeTelemetry: ExternalModelScriptTelemetrySnapshot | null = null;
  const model = {
    root,
    contentRoot,
    assetCode: 'LED-01',
    assetHandle: {},
    stackerTelemetryReady: true,
    stackerCapable: false,
    conveyorCapable: false,
    rgvCapable: false,
    liftCapable: false,
    telemetryBinding: createDefaultTelemetryBinding('led'),
    entitySnapshot: { components: { modelAsset: { deviceType: 'led' } } },
    externalScriptRuntime: {
      getDataDrivenConfigs: () => [],
      hasRuntimeTelemetrySnapshot: () => activeTelemetry !== null,
    },
  } as unknown as ModelRuntimeEntry;
  const contexts: Array<ExternalModelScriptTelemetrySnapshot | null> = [];
  const host = {
    collectModels: () => [{ entityId: 'led-entity', model }],
    pushLog: () => {},
    updateExternalScriptContext: (_model: ModelRuntimeEntry, context: ExternalModelScriptTelemetrySnapshot | null) => {
      activeTelemetry = context;
      contexts.push(context);
      return false;
    },
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  try {
    assert.equal(runtime.resolveDeviceType(model), 'led');
    deviceTelemetryStore.upsert({
      sourceId: 'default', topic: 'dt/factory/logistics/led/LED-01/twindatadriven/joint',
      deviceType: 'led', assetCode: 'LED-01', payloadDeviceCode: 'LED-01', sourceTimestamp: null,
      sequence: 1, receivedAt: Date.now(), fields: { wmsShowMessage: 'WMS 文字' },
      currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false, faulted: false, message: '',
    });
    runtime.applyFrame(1 / 60);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.deviceType, 'led');
    assert.deepEqual(contexts[0]?.fields, { wmsShowMessage: 'WMS 文字' });
    assert.equal(telemetryRuntimeDiagnosticsStore.getSnapshot('led-entity')?.deviceType, 'led');
    assert.deepEqual(telemetryRuntimeDiagnosticsStore.getSnapshot('led-entity')?.fields, { wmsShowMessage: 'WMS 文字' });

    activeTelemetry = null;
    runtime.applyFrame(1 / 60);
    assert.equal(contexts.length, 2, '外部同步清空遥测后，即使快照签名不变也必须恢复注入');
    assert.deepEqual((activeTelemetry as ExternalModelScriptTelemetrySnapshot | null)?.fields, { wmsShowMessage: 'WMS 文字' });
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    deviceTelemetryStore.clear();
    telemetryRuntimeDiagnosticsStore.clear();
  }
});

test('LED 展示内容按故障、WMS、模型参数的顺序取值', () => {
  const reader = createDisplayTextReader();
  const values = { displayText: '模型参数文字' };
  assert.equal(reader.read(values, 'runtime', {
    deviceType: 'led', fields: { deviceErrorMessage: '设备故障', wmsShowMessage: 'WMS 文字' },
  }), '设备故障');
  assert.equal(reader.read(values, 'runtime', {
    deviceType: 'led', fields: { deviceErrorMessage: '  ', wmsShowMessage: ' WMS 文字 ' },
  }), 'WMS 文字');
  assert.equal(reader.read(values, 'runtime', {
    deviceType: 'led', fields: { deviceErrorMessage: '', wmsShowMessage: null },
  }), '模型参数文字');
  assert.equal(reader.read(values, 'runtime', null), '模型参数文字');
  assert.equal(reader.read(values, 'edit', {
    deviceType: 'led', fields: { deviceErrorMessage: '编辑态不消费' },
  }), '模型参数文字');
  assert.equal(reader.read({ displayText: '  ' }, 'runtime', {
    deviceType: 'led', fields: {},
  }), '欢迎光临，新年快乐！');
});


test('LED 断流保留未完整显示的 MQTT 文案，完整滚动后才回退模型参数', () => {
  const reader = createDisplayTextReader();
  const longText = '这是一条需要较长时间才能完整滚动展示一遍的 MQTT 长文案';
  const telemetry = { deviceType: 'led', fields: { deviceErrorMessage: '', wmsShowMessage: longText } };
  const session = reader.create({ displayText: '欢迎光临' }, telemetry);
  assert.equal(session.read(telemetry), longText);
  assert.equal(session.read(null), longText, '断流时不能提前回退');
  session.complete(100);
  assert.equal(session.read(null), '欢迎光临', '完整滚动一遍后才允许回退');

  const explicitEmpty = reader.create({ displayText: '欢迎光临' }, telemetry);
  const emptyTelemetry = { deviceType: 'led', fields: { deviceErrorMessage: '', wmsShowMessage: ' ' } };
  assert.equal(explicitEmpty.read(emptyTelemetry), '欢迎光临');
  assert.equal(explicitEmpty.read(null), '欢迎光临', '显式空消息不能在后续断流时恢复旧文案');
});


test('LED 同源代理替代宿主和参数变体消费遥测，避免重复设备主键冲突', () => {
  const scene = new Scene(new NullEngine());
  const host = { root: new TransformNode('host', scene) } as ModelRuntimeEntry;
  const variant = { root: new TransformNode('variant', scene) } as ModelRuntimeEntry;
  const proxy = { root: new TransformNode('proxy', scene) } as ModelRuntimeEntry;
  const other = { root: new TransformNode('other', scene) } as ModelRuntimeEntry;
  const controller = new SceneTelemetryController({ scene } as never, {
    assets: { models: new Map([['led-source', host], ['other', other]]) },
    variants: { modelArrayParameterVariants: new Map([['variant', { model: variant, representativeEntityId: 'led-source' }]]) },
    arrays: { modelArrayTelemetryProxies: new Map([['led-source', proxy]]), devicePartTelemetryProxies: new Map() },
    outputs: { spawnedDeviceModels: new Map() },
  } as never);
  try {
    const collected = controller.createSpecializedTelemetryHost().collectModels();
    assert.deepEqual([...collected].map(entry => [entry.entityId, entry.model]), [
      ['other', other],
      ['led-source', proxy],
    ]);
  } finally {
    scene.dispose();
  }
});


test('LED 阵列代理共享屏幕几何但保留独立脚本和释放所有权', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const hostRoot = new TransformNode('host-root', scene);
  hostRoot.position.set(4, 5, 6);
  hostRoot.scaling.setAll(2);
  const hostContent = new TransformNode('LED2', scene);
  hostContent.parent = hostRoot;
  hostContent.scaling.setAll(0.01);
  const source = CreateBox('Box010', { size: 1 }, scene);
  source.parent = hostContent;
  source.position.set(0.2, 1.5, -0.1);
  source.material = new StandardMaterial('source-screen', scene);
  const sharedSource = new InstancedMesh('Box010', source);
  sharedSource.parent = hostContent;
  const host = {
    sourceUrl: 'editor-asset://local/LED.glb',
    assetSignature: 'host',
    assetHandle: {},
    stackerTelemetryReady: true,
    root: hostRoot,
    contentRoot: hostContent,
    meshes: [sharedSource],
    modelArrayBatch: null,
    modelArraySuspendedMeshes: new Set(),
  } as unknown as ModelRuntimeEntry;
  const entity = {
    id: 'led-copy',
    components: {
      transform: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {
        assetCode: 'led01',
        deviceType: 'led',
        sourcePath: 'LED.glb',
        sourceUrl: 'editor-asset://local/LED.glb',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
        dataDrivenConfig: { device: { devType: 'led' }, fixedNodes: [] },
        parameterValues: { displayText: '模型参数文字' },
        scriptAssets: [],
      },
      telemetryBinding: createDefaultTelemetryBinding('led'),
      modelArrayInstance: { sourceEntityId: 'source' },
    },
  } as unknown as Entity;
  const sourceEntity = {
    ...entity,
    id: 'source',
    components: {
      ...entity.components,
      modelArrayInstance: undefined,
    },
  } as unknown as Entity;
  host.entitySnapshot = sourceEntity;
  const telemetry = { telemetryPreviewActive: true };
  const controller = new ModelArrayRuntimeController({ scene } as never, {
    presentation: { applyTransform: () => {} },
    telemetry,
    variants: {
      modelArrayParameterVariantByEntityId: new Map([[entity.id, {
        model: host, sourceEntityId: 'source', representativeEntityId: entity.id,
      }]]),
      modelArrayParameterVariants: new Map(),
    },
    assets: { models: new Map([['source', host]]) },
  } as never);
  controller.modelArrayInstanceEntities.set(entity.id, entity);
  const previewBatchRefreshes: ModelRuntimeEntry[] = [];
  const refreshRepresentation = controller.refreshModelArrayRuntimeRepresentation.bind(controller);
  controller.refreshModelArrayRuntimeRepresentation = model => {
    previewBatchRefreshes.push(model);
    refreshRepresentation(model);
  };
  try {
    controller.syncModelArrayTelemetryProxies();
    await Promise.resolve();
    const proxy = controller.modelArrayTelemetryProxies.get(entity.id)!;
    assert.ok(proxy);
    assert.ok(controller.modelArrayTelemetryProxies.get('source'), '源 LED 也必须有独立文字层');
    assert.equal(proxy.conveyorCapable, false);
    assert.equal(proxy.meshes.length, 1);
    const overlay = proxy.meshes[0];
    assert.notEqual(overlay, sharedSource);
    assert.equal(overlay instanceof InstancedMesh, false, '独立文字材质不能使用 InstancedMesh');
    assert.equal(overlay.geometry, sharedSource.geometry);
    assert.equal(overlay.isDescendantOf(proxy.contentRoot), true);
    assert.equal(overlay.isEnabled(), true);
    assert.equal(overlay.isVisible, true);
    assert.equal(overlay.isPickable, true);
    assert.equal(overlay.metadata?.editorEntityId, entity.id, '屏幕点击必须映射回整块 LED 实体');
    const sourceRelativeMatrix = sharedSource.getWorldMatrix().multiply(hostRoot.getWorldMatrix().clone().invert());
    overlay.computeWorldMatrix(true);
    overlay.getWorldMatrix().m.forEach((value, index) => {
      assert.ok(Math.abs(value - sourceRelativeMatrix.m[index]) < 1e-10, `文字层矩阵[${index}]必须与原屏一致`);
    });
    const sourceMaterial = source.material;
    overlay.material = new StandardMaterial('independent-screen', scene);
    assert.equal(source.material, sourceMaterial, '代理更换文字材质不能改写共享宿主材质');
    assert.equal(sharedSource.material, sourceMaterial);
    assert.ok(proxy.externalScriptRuntime);
    assert.deepEqual(previewBatchRefreshes, [host], '进入运行预览必须立即重建原 LED 批次');
    proxy.externalScriptRuntime!.updateRuntimeContext({
      mode: 'runtime',
      telemetry: {
        deviceType: 'led', assetCode: 'led01', faulted: false,
        fields: { wmsShowMessage: '阵列 MQTT 文字' },
      },
    });
    assert.equal(proxy.externalScriptRuntime!.hasRuntimeTelemetrySnapshot(), true);
    telemetry.telemetryPreviewActive = false;
    controller.syncModelArrayTelemetryProxies();
    assert.equal(controller.modelArrayTelemetryProxies.size, 0, '退出运行预览后必须归还编辑态原屏');
    assert.deepEqual(previewBatchRefreshes, [host, host], '退出运行预览必须立即恢复原 LED 屏幕批次');
  } finally {
    controller.dispose();
    assert.equal(source.isDisposed(), false);
    assert.equal(sharedSource.isDisposed(), false);
    scene.dispose();
    engine.dispose();
  }
});


test('LED 运行态展示内容和 MQTT 身份不分组，编辑态按展示内容创建参数变体', () => {
  const telemetry = { telemetryPreviewActive: true };
  const controller = new ModelArrayRuntimeController({} as never, { telemetry } as never);
  const asset = {
    assetCode: 'led01',
    deviceType: 'led',
    sourcePath: 'LED.glb',
    sourceUrl: 'editor-asset://local/LED.glb',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    dataDrivenConfig: { device: { devType: 'led' }, fixedNodes: [] },
    parameterValues: { length: 1.2, displayText: '文字 A', runningColor: '#ff0000' },
  } as ModelAssetComponent;
  const first = controller.createModelArrayRenderSignature(asset, createDefaultTelemetryBinding('led'));
  const changedTextAndDevice = controller.createModelArrayRenderSignature({
    ...asset,
    assetCode: 'led02',
    parameterValues: { ...asset.parameterValues, displayText: '文字 B' },
  }, { ...createDefaultTelemetryBinding('led'), assetCode: 'led02' });
  const changedGeometry = controller.createModelArrayRenderSignature({
    ...asset,
    parameterValues: { ...asset.parameterValues, length: 1.3 },
  }, createDefaultTelemetryBinding('led'));

  assert.equal(changedTextAndDevice, first);
  assert.notEqual(changedGeometry, first);

  telemetry.telemetryPreviewActive = false;
  const editingText = controller.createModelArrayRenderSignature(asset, createDefaultTelemetryBinding('led'));
  const editingChangedText = controller.createModelArrayRenderSignature({
    ...asset,
    parameterValues: { ...asset.parameterValues, displayText: '文字 B' },
  }, createDefaultTelemetryBinding('led'));
  assert.equal(controller.createModelArrayRenderSignature(asset, createDefaultTelemetryBinding('led')), editingText);
  assert.notEqual(editingChangedText, editingText, '编辑态副本修改展示内容后必须拥有独立参数宿主');
});


test('LED 编辑态保留电子屏，运行态批量仅排除动态文字屏幕', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('led-root', scene);
  const contentRoot = new TransformNode('LED2', scene);
  contentRoot.parent = root;
  const frame = CreateBox('Box009', { size: 1 }, scene);
  const screen = CreateBox('Box010', { size: 2 }, scene);
  frame.parent = contentRoot;
  screen.parent = contentRoot;
  const model = {
    root,
    contentRoot,
    assetHandle: {},
    measurementReady: true,
    meshes: [frame, screen],
    externalScriptRuntime: { getDataDrivenConfigs: () => [{ device: { devType: 'led' } }] },
    modelArrayBatch: null,
    modelArraySourceSignature: '',
    modelArrayFailureSignature: '',
  } as unknown as ModelRuntimeEntry;
  const entity = {
    id: 'led-source',
    components: {
      modelAsset: { deviceType: 'led' },
      transform: {
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      },
    },
  } as unknown as Entity;
  const telemetry = { motionStaticBatchRuntime: { markModelDirty: () => {} }, telemetryPreviewActive: false };
  const controller = new ModelArrayRuntimeController({ scene } as never, {
    telemetry,
    bounds: { isModelBoundsMesh: () => true },
    assets: { suspendModelArrayHost: () => {}, applyModelInteractivity: () => {} },
    document: { isEntityVisible: () => true, isEntityScenePickable: () => true },
    transforms: { refreshGroupTransformPreviewTargets: () => {} },
    readiness: { loadDiagnostics: { beginTraceTask: () => ({ end: () => {} }) } },
    selection: { outlinedModelArrayBatches: new Set() },
  } as never);
  try {
    controller.syncModelArrayBatchForEntities(entity, model, [entity], [], {
      sourceEntityId: entity.id,
      namePrefix: '__led_test',
      renderSignature: 'led-signature',
    });
    assert.ok(model.modelArrayBatch);
    assert.ok(model.modelArrayBatch!.meshes[0].getTotalVertices() > frame.getTotalVertices(), '编辑态必须保留原电子屏顶点');

    telemetry.telemetryPreviewActive = true;
    controller.syncModelArrayBatchForEntities(entity, model, [entity], [], {
      sourceEntityId: entity.id,
      namePrefix: '__led_test',
      renderSignature: 'led-signature',
    });
    assert.equal(model.modelArrayBatch!.meshes.length, 1);
    assert.equal(model.modelArrayBatch!.meshes.some(mesh => mesh.name.includes('Box010')), false);
  } finally {
    model.modelArrayBatch?.dispose();
    scene.dispose();
    engine.dispose();
  }
});


test('LED 编辑态更换文字材质后刷新批次，避免继续渲染已释放材质', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('led-root', scene);
  const contentRoot = new TransformNode('LED2', scene);
  contentRoot.parent = root;
  const frame = CreateBox('Box009', { size: 1 }, scene);
  const screen = CreateBox('Box010', { size: 2 }, scene);
  frame.parent = contentRoot;
  screen.parent = contentRoot;
  frame.material = new StandardMaterial('frame-material', scene);
  const previousMaterial = new StandardMaterial('previous-text-material', scene);
  screen.material = previousMaterial;
  const model = {
    root,
    contentRoot,
    assetHandle: {},
    measurementReady: true,
    meshes: [frame, screen],
    externalScriptRuntime: { getDataDrivenConfigs: () => [{ device: { devType: 'led' } }] },
    modelArrayBatch: null,
    modelArraySourceSignature: '',
    modelArrayFailureSignature: '',
  } as unknown as ModelRuntimeEntry;
  const entity = {
    id: 'led-source',
    components: {
      modelAsset: { deviceType: 'led' },
      transform: {
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      },
    },
  } as unknown as Entity;
  const controller = new ModelArrayRuntimeController({ scene } as never, {
    telemetry: { motionStaticBatchRuntime: { markModelDirty: () => {} }, telemetryPreviewActive: false },
    bounds: { isModelBoundsMesh: () => true },
    assets: { suspendModelArrayHost: () => {}, applyModelInteractivity: () => {} },
    document: { isEntityVisible: () => true, isEntityScenePickable: () => true },
    transforms: { refreshGroupTransformPreviewTargets: () => {} },
    readiness: { loadDiagnostics: { beginTraceTask: () => ({ end: () => {} }) } },
    selection: { outlinedModelArrayBatches: new Set() },
  } as never);
  const syncBatch = (parameterOnlyChangedEntityId?: string) => controller.syncModelArrayBatchForEntities(
    entity,
    model,
    [entity],
    [],
    {
      sourceEntityId: entity.id,
      namePrefix: '__led_text_edit_test',
      renderSignature: 'led-signature',
      parameterOnlyChangedEntityId,
    },
  );
  try {
    syncBatch();
    const previousBatch = model.modelArrayBatch;
    assert.ok(previousBatch?.meshes.some(mesh => mesh.material === previousMaterial));

    const nextMaterial = new StandardMaterial('next-text-material', scene);
    screen.material = nextMaterial;
    previousMaterial.dispose(false, false);
    syncBatch(entity.id);

    assert.notEqual(model.modelArrayBatch, previousBatch, '材质身份变化必须重建批次');
    assert.ok(model.modelArrayBatch?.meshes.some(mesh => mesh.material === nextMaterial));
    assert.equal(model.modelArrayBatch?.meshes.some(mesh => mesh.material === previousMaterial), false);
  } finally {
    model.modelArrayBatch?.dispose();
    scene.dispose();
    engine.dispose();
  }
});
