import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as Babylon from '@babylonjs/core';
import { prepareModelScriptCompilation } from '../../electron/shared/modelScriptCompilation.ts';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.led-telemetry-inspector-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
after(async () => {
  if (store && originalState) store.setState(originalState, true);
  diagnosticsStore?.clear();
  deviceStore?.clear();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.led-telemetry-inspector-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { TelemetryBindingInspector } from '../../src/editor/panels/TelemetryBindingInspector.tsx';",
  "export { resolveModelTelemetryDataDrivenConfig } from '../../src/editor/model/telemetryBinding.ts';",
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { telemetryRuntimeDiagnosticsStore } from '../../src/runtime/mqtt/telemetryRuntimeDiagnostics.ts';",
  "export { deviceTelemetryStore } from '../../src/runtime/mqtt/deviceTelemetry.ts';",
].join('\n'));
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: {
    ssr: entry,
    outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } },
  },
});
const {
  TelemetryBindingInspector,
  resolveModelTelemetryDataDrivenConfig,
  useEditorStore,
  createEmptySceneDocument,
  createModelEntity,
  createCommandHistory,
  telemetryRuntimeDiagnosticsStore,
  deviceTelemetryStore,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
const store = useEditorStore;
const originalState = store.getState();
const diagnosticsStore = telemetryRuntimeDiagnosticsStore;
const deviceStore = deviceTelemetryStore;

test('旧 LED 场景显示数据驱动和运行时诊断，并可恢复默认绑定', () => {
  diagnosticsStore.clear();
  deviceStore.clear();
  const scene = createEmptySceneDocument('LED 数据驱动验收');
  const entity = createModelEntity('LED.glb', 'editor-asset://local/LED.glb', 'LED');
  entity.components.modelAsset.deviceType = 'led';
  entity.components.modelAsset.assetCode = 'LED-01';
  delete entity.components.modelAsset.dataDrivenConfig;
  delete entity.components.telemetryBinding;
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;
  scene.selectedEntityId = entity.id;
  store.setState({
    scene,
    history: createCommandHistory(),
    runtimeMode: 'edit',
    hierarchySelectionIds: [entity.id],
    entityClipboard: null,
    logs: [],
  });
  diagnosticsStore.upsert(entity.id, {
    online: true,
    stale: false,
    faulted: false,
    conflict: false,
    lastReceivedAt: 1000,
    errors: [],
    sourceId: 'default',
    deviceType: 'led',
    assetCode: 'LED-01',
    topic: 'dt/factory/logistics/led/LED-01/twindatadriven/joint',
    sequence: 1,
    sourceTimestamp: null,
    fields: { wmsShowMessage: 'WMS 文字', deviceErrorMessage: '' },
    message: '',
    nodeTargets: [],
    boneTargets: [],
    animationTargets: [],
  });

  assert.equal(store.getState().scene.selectedEntityId, entity.id);
  assert.equal(store.getState().scene.name, 'LED 数据驱动验收');
  const dataDrivenConfig = resolveModelTelemetryDataDrivenConfig(entity.components.modelAsset);
  assert.equal(dataDrivenConfig?.device.devType, 'led');
  const renderPanel = () => renderToStaticMarkup(createElement(TelemetryBindingInspector, {
    entityId: entity.id,
    binding: store.getState().scene.entities[entity.id].components.telemetryBinding,
    dataDrivenConfig,
    disabled: false,
    modelAssetCode: 'LED-01',
    onChange() {},
    onRestoreDefault() {},
  }));
  const withoutBinding = renderPanel();
  assert.match(withoutBinding, /数据驱动/);
  assert.match(withoutBinding, /运行时诊断/);
  assert.match(withoutBinding, /WMS 文字/);
  assert.match(withoutBinding, /恢复模型默认绑定/);

  store.getState().restoreSelectedTelemetryBindingDefault();
  assert.equal(store.getState().scene.entities[entity.id].components.telemetryBinding?.deviceType, 'led');
  const withBinding = renderPanel();
  assert.match(withBinding, /启用绑定/);
  assert.match(withBinding, /deviceType：led/);
  assert.match(withBinding, /运行时诊断/);
});


test('LED 共享几何时仍使用 MQTT 文字初始化屏幕', () => {
  const source = readFileSync('Assets/Models/Model-2080102163768123393-LED/led.model.ts', 'utf8');
  const prepared = prepareModelScriptCompilation(source);
  const { outputText } = ts.transpileModule(prepared.sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  });
  const compiled = new Function('__babylon', '__decorator', `${outputText}\n${prepared.returnStatement}`)(
    Babylon,
    () => () => {},
  );
  const LedRuntimeComponent = compiled.classes.ParametricModelRuntimeComponent;
  const instance = new LedRuntimeComponent({ metadata: { scripts: [] } });
  instance.runtimeMode = 'runtime';
  instance.runtimeTelemetry = {
    deviceType: 'led',
    assetCode: 'led01',
    faulted: false,
    fields: { wmsShowMessage: 'MQTT测试文字', deviceErrorMessage: '' },
  };
  const sharedMesh = { name: 'Box010', instances: [{}] };
  let displayedText = '';
  instance.captureSnapshots = () => {};
  instance.getMeshesByNodeNamePattern = () => [sharedMesh];
  instance.setLedDiagnostic = () => {};
  instance.ensureLedScrollingText = values => {
    displayedText = instance.readDisplayText(values);
  };

  instance.onStart();
  assert.equal(displayedText, 'MQTT测试文字');
});
