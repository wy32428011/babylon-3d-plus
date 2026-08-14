import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

function makeFolderEntity(id, visible = true, locked = false, childrenIds = []) {
  return {
    id, name: id, visible, locked, parentId: null, childrenIds, isFolder: true,
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    },
  };
}

function makeModelEntity(id, visible = true, locked = false, parentId = null) {
  return {
    id, name: id, visible, locked, parentId, childrenIds: [],
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelAsset: {
        assetCode: 'BOX_' + id,
        sourcePath: 'box.glb',
        sourceUrl: 'editor-asset://local/Assets/Models/box.glb',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
    },
  };
}

function makeSceneDocument(folder, model) {
  return {
    id: 'scene-toggle', name: 'Toggle Scene', entityIds: [folder.id, model.id],
    entities: { [folder.id]: folder, [model.id]: model },
    selectedEntityId: null,
    mqttConfig: { enabled: false, ip: '', address: '', topic: 'zending/stacker/action', subscriptions: [], simulatorEnabled: false, simulatorAssetCode: '', simulatorScenario: '', simulatorIntervalMs: 500 },
    fetchConfig: { url: '', apiKey: '' },
    sceneSettings: { camera: { savedPose: null, savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 }, sensitivity: { zoom: 1, pan: 1, rotate: 1 }, environment: null, skybox: null },
  };
}

function serializeSceneDocument(scene) {
  return JSON.stringify({ version: 3, units: { length: 'meter' }, scene });
}

test('隐藏文件夹后点击子模型“显示”必须真正显示模型，且保存重开后仍可显示', async (context) => {
  const server = await createServer({
    configFile: false, root: process.cwd(), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  context.after(async () => server.close());

  // 避免 store 内部 fire-and-forget 的环境同步访问 window 报错
  globalThis.window = globalThis.window ?? {};
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const store = useEditorStore;

  const folder = makeFolderEntity('F', true, false, ['A']);
  const model = makeModelEntity('A', true, false, 'F');
  store.getState().loadSceneFromContent(serializeSceneDocument(makeSceneDocument(folder, model)), 'test');

  // 1. 隐藏文件夹：子模型有效不可见，但自身 visible 仍为 true
  store.getState().toggleEntityVisible('F');
  let state = store.getState();
  assert.equal(state.scene.entities.F.visible, false);
  assert.equal(state.scene.entities.A.visible, true);

  // 2. 点击子模型的眼睛（图标为“显示”）：
  //    必须真正让模型可见（同时显示隐藏的祖先），而不是把自身 visible 翻转为 false
  store.getState().toggleEntityVisible('A');
  state = store.getState();
  assert.equal(state.scene.entities.A.visible, true, '点击“显示”不得把自身 visible 翻转为 false');
  assert.equal(state.scene.entities.F.visible, true, '点击“显示”被祖先隐藏的模型时必须同步显示隐藏祖先');
  assert.equal(state.scene.entities.A.visible !== false && state.scene.entities.F.visible !== false, true, '模型必须有效可见');

  // 3. 保存并重开：模型保持可见
  const saved = serializeSceneDocument(state.scene);
  store.getState().loadSceneFromContent(saved, 'test-reopen');
  state = store.getState();
  assert.equal(state.scene.entities.A.visible, true);
  assert.equal(state.scene.entities.F.visible, true);

  // 4. 重开后再次隐藏文件夹并点击子模型“显示”，行为一致
  store.getState().toggleEntityVisible('F');
  state = store.getState();
  assert.equal(state.scene.entities.A.visible, true);
  store.getState().toggleEntityVisible('A');
  state = store.getState();
  assert.equal(state.scene.entities.A.visible, true);
  assert.equal(state.scene.entities.F.visible, true, '重开后点击“显示”仍必须恢复有效可见');
});

test('锁定文件夹后点击子模型“解锁”必须真正解锁，而不是把自身 locked 翻转为 true', async (context) => {
  const server = await createServer({
    configFile: false, root: process.cwd(), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  context.after(async () => server.close());

  globalThis.window = globalThis.window ?? {};
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const store = useEditorStore;

  const folder = makeFolderEntity('F', true, true, ['A']);
  const model = makeModelEntity('A', true, false, 'F');
  store.getState().loadSceneFromContent(serializeSceneDocument(makeSceneDocument(folder, model)), 'test-lock');

  store.getState().toggleEntityLocked('A');
  const state = store.getState();
  assert.equal(state.scene.entities.A.locked, false, '点击“解锁”不得把自身 locked 翻转为 true');
  assert.equal(state.scene.entities.F.locked, false, '解锁被祖先锁定的模型时必须同步解锁锁定祖先');
});
