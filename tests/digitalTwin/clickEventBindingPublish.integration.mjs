import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import { build } from 'vite';

const root = await mkdtemp(path.join(tmpdir(), 'zending-click-publish-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));

async function run() {
  const { importManualRoamAvatarIntoProject } = await import('../../dist-electron/ipc/manualRoamAvatarStore.js');
  const { setCurrentProjectRoot } = await import('../../dist-electron/ipc/projectAssetStore.js');
  const { prepareDeploymentExport } = await import('../../dist-electron/ipc/deploymentExportScene.js');
  // 使用构建产物覆盖发布态模块加载，避免 Electron 内动态 SSR 加载长时间挂起。
  const moduleRoot = await mkdtemp(path.resolve('node_modules/.click-publish-'));
  try {
    await build({
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
      build: {
        ssr: true,
        outDir: moduleRoot,
        rollupOptions: {
          input: {
            document: 'src/editor/model/SceneDocument.ts',
            serializer: 'src/editor/project/SceneSerializer.ts',
            click: 'src/player/viewerModelClick.ts',
          },
          output: { entryFileNames: '[name].mjs' },
        },
      },
    });
    const { createEmptySceneDocument, createModelEntity, createClickEventBindingEntity, createLocatorEntity } = await import(pathToFileURL(path.join(moduleRoot, 'document.mjs')).href);
    const { serializeScene, deserializeScene } = await import(pathToFileURL(path.join(moduleRoot, 'serializer.mjs')).href);
    const { createViewerModelClickHandler } = await import(pathToFileURL(path.join(moduleRoot, 'click.mjs')).href);
    const projectRoot = path.join(root, 'project');
    await mkdir(projectRoot);
    setCurrentProjectRoot(projectRoot);
    const asset = await importManualRoamAvatarIntoProject(projectRoot, path.resolve('public/manual-roam/EQ_People.glb'));
    const model = createModelEntity(asset.path, asset.sourceUrl, '点击模型');
    model.components.modelAsset.assetCode = 'DEVICE-001';
    model.components.modelAsset.builtInSlotBindingConfig = { enabledParam: 'enabled', dimensionMapping: { columns: 'columns', layers: 'layers' } };
    const locator = createLocatorEntity();
    locator.components.locator.builtInBinding = { hostEntityId: model.id, originOffset: { x: 0, y: 0, z: 0 } };
    const binding = createClickEventBindingEntity();
    binding.components.clickEventBinding = {
      deviceSlots: [{ id: 'slot', deviceType: {
        id: 'device', assetId: asset.path, displayName: model.name,
        sourcePath: asset.path, sourceUrl: asset.sourceUrl,
      } }],
      events: [
        { id: 'click', eventType: 'click', effects: ['highlight', 'focus', 'show-chart'], chart: { id: 'chart-001', name: '模型图表' } },
        { id: 'cell', eventType: 'click-cell', effects: ['highlight', 'focus', 'show-chart'], chart: { id: 'chart-cell', name: '货格图表' } },
      ],
    };
    const scene = createEmptySceneDocument('发布点击回归');
    scene.entityIds = [model.id, binding.id, locator.id];
    scene.entities = { [model.id]: model, [binding.id]: binding, [locator.id]: locator };
    const content = serializeScene(scene);

    function assertClick(loaded, label) {
      const selections = [], focuses = [], messages = [], highlights = [];
      const handler = createViewerModelClickHandler(loaded, {
        updateSelection: ids => selections.push([...ids]),
        setSlotHighlight: (id, cell) => highlights.push({ id, cell }),
        focusTarget: (id, cell) => focuses.push({ id, cell }),
        triggerManualEvents: () => {},
        emitAssetClicked: payload => messages.push(payload),
      });
      handler(model.id);
      assert.deepEqual(messages, [{ assetCode: 'DEVICE-001', chartId: 'chart-001' }], `${label}必须识别模型点击并发送图表事件`);
      assert.deepEqual(selections, [[model.id]], `${label}必须高亮模型`);
      assert.deepEqual(focuses, [{ id: model.id, cell: undefined }], `${label}必须聚焦模型`);
      const cell = { row: 2, column: 3, layer: 4 };
      handler(locator.id, { locatorEntityId: locator.id, ...cell });
      assert.deepEqual(messages[1], { assetCode: 'DEVICE-001', slot: cell, chartId: 'chart-cell' }, `${label}必须识别货格点击并发送坐标`);
      assert.deepEqual(highlights.at(-1), { id: locator.id, cell });
      assert.deepEqual(focuses.at(-1), { id: locator.id, cell });
      handler(null);
      assert.deepEqual(highlights.at(-1), { id: '', cell: null });
      assert.equal(messages.length, 2, '点击空白不能发送图表事件');
    }

    assertClick(deserializeScene(content), '编辑器保存加载后');
    const deployment = await prepareDeploymentExport(content, '发布点击回归', [], new AbortController().signal, () => {});
    const raw = JSON.parse(deployment.sceneContent).scene.entities;
    const exportedDevice = raw[binding.id].components.clickEventBinding.deviceSlots[0].deviceType;
    assert.equal(exportedDevice.sourceUrl, raw[model.id].components.modelAsset.sourceUrl);
    assert.match(exportedDevice.assetId, /^deployment-model:[a-f0-9]{24}$/);
    assert.equal(deployment.sceneContent.includes(projectRoot.replaceAll('\\', '\\\\')), false, '发布包不能包含本机路径');
    assertClick(deserializeScene(deployment.sceneContent), '发布包加载后');
    const legacy = JSON.parse(deployment.sceneContent);
    delete legacy.scene.entities[binding.id].components.clickEventBinding.deviceSlots[0].deviceType.assetId;
    assertClick(deserializeScene(JSON.stringify(legacy)), '旧发布包缺少 assetId 时');
    assertClick(deserializeScene(serializeScene(deserializeScene(JSON.stringify(legacy)))), '旧发布包再次保存加载后');
    const repeated = await prepareDeploymentExport(content, '发布点击回归', [], new AbortController().signal, () => {});
    assert.equal(JSON.parse(repeated.sceneContent).scene.entities[binding.id].components.clickEventBinding.deviceSlots[0].deviceType.assetId, exportedDevice.assetId, '重复发布的设备标识必须稳定');
    assert.equal(binding.components.clickEventBinding.deviceSlots[0].deviceType.assetId, asset.path, '发布不能修改编辑器中的原始绑定');
    console.log('PASS: 真实发布和 Viewer 加载后的模型/货格点击、高亮、聚焦、图表事件、旧包兼容及本机路径清理。');
  } finally {
    if (path.dirname(moduleRoot) !== path.resolve('node_modules') || !path.basename(moduleRoot).startsWith('.click-publish-')) throw new Error('测试模块目录范围无效');
    await rm(moduleRoot, { recursive: true, force: true });
  }
}

async function finish(code) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('zending-click-publish-')) throw new Error('临时目录范围无效');
  await rm(resolved, { recursive: true, force: true });
  app.exit(code);
}

app.whenReady().then(run).then(() => finish(0), async error => {
  console.error(error);
  await finish(1);
});
