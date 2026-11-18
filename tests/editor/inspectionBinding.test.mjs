import assert from 'node:assert/strict';
import test from 'node:test';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const entries = [
  '/src/editor/model/inspectionBinding.ts',
  '/src/editor/project/SceneSerializer.ts',
  '/src/editor/model/SceneDocument.ts',
  '/src/editor/store/editorStore.ts',
  '/src/editor/store/slices/entityClipboardOperations.ts',
  '/src/editor/model/clickEventBinding.ts',
  '/src/editor/model/modelGenerator.ts',
  '/src/editor/store/slices/projectAssetRefresh.ts',
  '/src/editor/panels/InspectionBindingInspector.tsx',
];
const paths = { model: 'C:/models/high/part.glb', meta: 'C:/models/high/inspection.json' };
const url = (path) => 'editor-asset://local/' + encodeURIComponent(path);
const binding = () => ({
  schemaVersion: 1,
  model: {
    dataPlatformModel: { sourceKey: 'a'.repeat(64), kind: 'model', resourceId: '123456789123456789', modelPath: 'part.glb' },
    versionId: '2023000000000000001', contentSha256: 'b'.repeat(64),
    sourcePath: paths.model, sourceUrl: url(paths.model), metaPath: paths.meta, metaUrl: url(paths.meta), unitScaleToMeters: 0.001,
  },
  configuration: { id: 'cfg-6', parameters: { width: 6 } },
  device: { namespace: 'factory', deviceType: 'conveyor', deviceNo: 'CV021' },
  parts: [
    { partKey: 'assembly', name: '总成', nodePath: '.', axis: { x: 0, y: 1, z: 0 }, distanceMeters: 0, fixed: true },
    { partKey: 'motor', name: '电机', nodePath: 'Drive/Motor', parentPartKey: 'assembly', axis: { x: 1, y: 0, z: 0 }, distanceMeters: 0.5, fixed: false },
  ],
});
const config = { schema: 'babylon-editor.model-parameters', version: 1,
  parameters: [{ key: 'width', label: '宽度', type: 'number', defaultValue: 6 }], bindings: [] };

test('高精度绑定、场景和复制行为', async (t) => {
  const modules = await createP4SsrTestModules(entries);
  t.after(() => modules.close());
  const [inspection, serializer, document, storeModule, clipboard, click, generator, refresh, panel] = await Promise.all(
    entries.map((entry) => modules.ssrLoadModule(entry)),
  );
  const { useEditorStore } = storeModule;
  const makeScene = (withBinding = true) => {
    const scene = document.createEmptySceneDocument('详情测试');
    const model = document.createModelEntity('C:/models/low/device.glb', url('C:/models/low/device.glb'), '设备', undefined, undefined, config);
    if (withBinding) model.components.modelAsset.inspection = binding();
    scene.entities[model.id] = model;
    scene.entityIds.push(model.id);
    scene.selectedEntityId = model.id;
    return { scene, model };
  };

  await t.test('完整绑定和旧文档均可往返，查看状态不会进入绑定', () => {
    const original = binding();
    original.camera = { position: [1, 2, 3] };
    original.parts[1].expanded = 0.5;
    const normalized = inspection.normalizeInspectionBinding(original);
    assert.deepEqual(normalized, binding());
    const { scene, model } = makeScene();
    const roundtrip = serializer.deserializeScene(serializer.serializeScene(scene));
    assert.deepEqual(roundtrip.entities[model.id].components.modelAsset.inspection, binding());
    const legacy = makeScene(false);
    const loaded = serializer.deserializeScene(serializer.serializeScene(legacy.scene));
    assert.equal(loaded.entities[legacy.model.id].components.modelAsset.inspection, undefined);
    delete original.device;
    assert.equal(inspection.normalizeInspectionBinding(original).device, undefined);
  });

  await t.test('拒绝身份、摘要、资源路径、零件及方向错误', () => {
    const cases = [
      (x) => { x.model.dataPlatformModel.kind = 'combo'; },
      (x) => { x.model.dataPlatformModel.sourceKey = 'wrong'; },
      (x) => { x.model.dataPlatformModel.modelPath = 'other.glb'; },
      (x) => { x.model.versionId = 1; },
      (x) => { x.model.versionId = '0'; },
      (x) => { x.model.versionId = '01'; },
      (x) => { x.model.versionId = '-1'; },
      (x) => { x.model.versionId = '1.0'; },
      (x) => { x.model.versionId = '1'.repeat(65); },
      (x) => { x.model.contentSha256 = 'abc'; },
      (x) => { x.model.sourceUrl = 'https://example.test/part.glb'; },
      (x) => { x.model.metaUrl = url('C:/models/high/other.json'); },
      (x) => { x.model.metaPath = 'C:/other/inspection.json'; x.model.metaUrl = url(x.model.metaPath); },
      (x) => { x.model.unitScaleToMeters = 0; },
      (x) => { x.device.deviceNo = ''; },
      (x) => { x.device.deviceNo = 'bad\u0000id'; },
      (x) => { x.parts[1].name = 'bad\u007fid'; },
      (x) => { x.parts[1].partKey = 'assembly'; },
      (x) => { x.parts[1].nodePath = 'Drive//Motor'; },
      (x) => { x.parts[1].nodePath = 'Drive/../Motor'; },
      (x) => { x.parts[1].nodePath = 'Drive;Motor'; },
      (x) => { x.parts[1].parentPartKey = 'missing'; },
      (x) => { x.parts[0].parentPartKey = 'motor'; },
      (x) => { x.parts[1].axis = { x: 0, y: 0, z: 0 }; },
      (x) => { x.parts[1].distanceMeters = -1; },
      (x) => { x.parts[1].fixed = 1; },
      (x) => { x.configuration.parameters.width = Infinity; },
    ];
    for (const mutate of cases) {
      const value = binding(); mutate(value);
      assert.throws(() => inspection.normalizeInspectionBinding(value));
      const { scene, model } = makeScene();
      scene.entities[model.id].components.modelAsset.inspection = value;
      assert.throws(() => serializer.deserializeScene(serializer.serializeScene(scene)));
    }
    const maximumVersion = binding();
    maximumVersion.model.versionId = '9'.repeat(64);
    assert.equal(inspection.normalizeInspectionBinding(maximumVersion).model.versionId, maximumVersion.model.versionId);
    assert.equal(inspection.inspectionConfigurationMatches(binding(), { width: 6 }), true);
    assert.equal(inspection.inspectionConfigurationMatches(binding(), { width: 10 }), false);
  });

  await t.test('Store 校验不匹配，应用、移除及撤销重做保持完整快照', () => {
    const previous = useEditorStore.getState();
    const { scene, model } = makeScene(false);
    try {
      useEditorStore.setState({ scene, runtimeMode: 'edit', hierarchySelectionIds: [model.id] });
      const mismatch = binding(); mismatch.configuration.parameters.width = 10;
      useEditorStore.getState().updateSelectedInspectionBinding(mismatch);
      assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection, undefined);
      const input = binding();
      useEditorStore.getState().updateSelectedInspectionBinding(input);
      input.device.deviceNo = 'mutated';
      assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection.device.deviceNo, 'CV021');
      useEditorStore.getState().undo();
      assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection, undefined);
      useEditorStore.getState().redo();
      assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection.device.deviceNo, 'CV021');
      useEditorStore.getState().updateSelectedInspectionBinding(null);
      assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection, undefined);
      useEditorStore.getState().undo();
      assert.deepEqual(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection, binding());
      useEditorStore.getState().updateSelectedModelParameterValue('width', 9);
      const current = useEditorStore.getState().scene.entities[model.id].components.modelAsset;
      assert.deepEqual(current.inspection, binding());
      assert.equal(inspection.inspectionConfigurationMatches(current.inspection, current.parameterValues), false);
      useEditorStore.getState().undo();
      assert.equal(inspection.inspectionConfigurationMatches(useEditorStore.getState().scene.entities[model.id].components.modelAsset.inspection, { width: 6 }), true);
    } finally { useEditorStore.setState(previous); }
  });

  await t.test('普通复制、轻量阵列和旧阵列迁移保留配置并清除设备映射', () => {
    const { scene, model } = makeScene();
    const copy = clipboard.createDuplicatedRuntimeEntity(model, null, null, new Set());
    const array = clipboard.createModelArrayInstanceEntity(model, model.id, { x: 1, y: 0, z: 0 }, '阵列', 'A2', new Set());
    for (const duplicate of [copy, array]) {
      const actual = duplicate.components.modelAsset.inspection;
      const expected = binding(); delete expected.device;
      assert.deepEqual(actual, expected);
      assert.notEqual(actual.parts, model.components.modelAsset.inspection.parts);
    }
    model.components.modelArray = { items: [{ id: 'legacy-item', name: '旧阵列', assetCode: 'A3', offset: { x: 1, y: 0, z: 0 } }] };
    const migrated = serializer.deserializeScene(serializer.serializeScene(scene));
    const expected = binding(); delete expected.device;
    assert.deepEqual(migrated.entities['legacy-item'].components.modelAsset.inspection, expected);
    assert.equal(migrated.entities[model.id].components.modelAsset.inspection.device.deviceNo, 'CV021');
  });

  await t.test('模型生成器模板不携带设备映射，刷新模型保留固定绑定', () => {
    const { model } = makeScene();
    const template = generator.sanitizeModelAssetTemplate(model.components.modelAsset);
    assert.equal(template.inspection, undefined);
    const asset = { path: 'C:/models/low/device2.glb', sourceUrl: url('C:/models/low/device2.glb'), lengthUnit: 'meter', parameterConfig: config };
    const refreshed = refresh.createRefreshedModelAsset(model.components.modelAsset, asset);
    assert.deepEqual(refreshed.inspection, binding());
    assert.deepEqual(refreshed.parameterValues, { width: 6 });
  });

  await t.test('明确的打开设备详情动作经过白名单和点击决议', () => {
    const component = click.sanitizeClickEventBindingComponent({
      deviceSlots: [{ id: 'slot', deviceType: { id: 'device', assetId: 'a', displayName: '设备', sourcePath: 'C:/models/low/device.glb', sourceUrl: url('C:/models/low/device.glb') } }],
      events: [{ id: 'event', eventType: 'click', effects: ['open-inspection-detail', 'open-inspection-detail'] }],
    });
    assert.deepEqual(component.events[0].effects, ['open-inspection-detail']);
    const { scene, model } = makeScene();
    scene.entities.marker = { id: 'marker', components: { clickEventBinding: component } };
    const resolution = click.resolveClickEventBindingClick(scene, model.id);
    assert.equal(resolution.kind, 'trigger');
    assert.deepEqual(resolution.effects, ['open-inspection-detail']);
  });

  await t.test('详情表单只组合已准备资源与明确设备和零件规则', () => {
    const expected = binding();
    const prepared = { model: expected.model };
    assert.equal(panel.inspectionResourceConfigurationMatches(prepared, { width: 6 }), true);
    const configured = { ...prepared, configuration: expected.configuration };
    assert.equal(panel.inspectionResourceConfigurationMatches(configured, { width: 6 }), true);
    assert.equal(panel.inspectionResourceConfigurationMatches(configured, { width: 9 }), false);
    assert.deepEqual(panel.createInspectionBindingFromFields(prepared, expected.configuration, expected.device, JSON.stringify(expected.parts)), expected);
    assert.throws(() => panel.createInspectionBindingFromFields(null, expected.configuration, expected.device, JSON.stringify(expected.parts)), /先选择并准备/);
    assert.throws(() => panel.createInspectionBindingFromFields(prepared, expected.configuration, expected.device, '[]'), /parts/);
    assert.throws(() => panel.createInspectionBindingFromFields(prepared, expected.configuration, expected.device, '{'), /有效的 JSON/);
    assert.throws(() => panel.createInspectionBindingFromFields(prepared, expected.configuration, { namespace: 'factory', deviceType: '', deviceNo: '' }, JSON.stringify(expected.parts)), /device/);
    const unbound = panel.createInspectionBindingFromFields(prepared, expected.configuration, { namespace: '', deviceType: '', deviceNo: '' }, JSON.stringify(expected.parts));
    assert.equal(unbound.device, undefined);
  });

  await t.test('Inspector 提供版本、设备和零件规则标签及不匹配提示', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { model } = makeScene();
    model.components.modelAsset.parameterValues.width = 10;
    const markup = renderToStaticMarkup(React.createElement(panel.InspectionBindingInspector, { modelAsset: model.components.modelAsset }));
    assert.match(markup, /高模/);
    assert.match(markup, /固定版本/);
    assert.match(markup, /设备编号/);
    assert.match(markup, /零件规则 JSON/);
    assert.match(markup, /<label[^>]*for=/);
    assert.match(markup, /<textarea[^>]*aria-describedby=/);
    assert.match(markup, /role="alert"[^>]*>固定配置参数与当前设备参数不匹配/);
  });
});
