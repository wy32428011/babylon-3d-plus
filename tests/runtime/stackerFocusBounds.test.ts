import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

// 与运行时就绪测试一致，预编译大模块图，避免 SSR 按需传输超时。
const output = await mkdtemp(path.resolve('node_modules/.stacker-focus-'));
after(async () => {
  assert.equal(path.dirname(output), path.resolve('node_modules'));
  assert.ok(path.basename(output).startsWith('.stacker-focus-'));
  await rm(output, { recursive: true, force: true });
});
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: true, outDir: output, rollupOptions: {
    input: 'src/runtime/babylon/SceneRuntime.ts', output: { entryFileNames: 'runtime.mjs' },
  } },
});
const { SceneRuntime } = await import(pathToFileURL(path.join(output, 'runtime.mjs')).href);

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = Object.create(SceneRuntime.prototype);
  Object.assign(runtime, {
    scene, models: new Map(), meshes: new Map(), locators: new Map(), cadReferences: new Map(),
    modelGenerators: new Map(), deviceSpawnerMarkers: new Map(), lights: new Map(), syncedEntities: new Map(),
    manualRoamSpawnRuntime: { getWorldBoundsMeshes: () => [] },
    clickEventBindingRuntime: { getWorldBoundsMeshes: () => [] },
    poiEffectRuntime: { getWorldBoundsMeshes: () => [], hasEntity: () => false },
    modelArrayInstanceEntities: new Map(), modelArrayParameterVariantByEntityId: new Map(),
    skyboxRuntime: { getMesh: () => null, hasEntity: () => false },
  });
  const root = new TransformNode('stacker-root', scene);
  const body = new TransformNode('body-group', scene);
  body.parent = root;
  const box = (name: string, width: number, height: number, x: number, y: number, parent = body) => {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth: 1 }, scene);
    mesh.parent = parent;
    mesh.position.set(x, y, 0);
    return mesh;
  };
  const mast = box('lizhu1.11', 1, 10, 0, 5);
  const base = box('dibu.6', 3, 1, 0, 0.5);
  const rail = box('guidaoxia.2', 40, 0.1, 18.5, 0, root);
  const model = {
    root, contentRoot: root, meshes: [mast, base, rail], stackerCapable: true,
    entitySnapshot: { components: { modelAsset: {} } }, externalScriptRuntime: null,
    assetHandle: {}, stackerTelemetryReady: true, measurementReady: true, externalScriptStarting: false,
    telemetryBinding: { enabled: false },
  };
  runtime.models.set('stacker', model);
  return { engine, scene, runtime, root, body, mast, base, rail, model, box,
    close: () => { scene.dispose(); engine.dispose(); } };
}

test('堆垛机聚焦中心在机身，轨道加长不改变聚焦范围且完整尺寸仍包含轨道', () => {
  const f = fixture();
  try {
    const focus = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.deepEqual(focus.center, { x: 0, y: 5, z: 0 });
    assert.deepEqual(focus.sizeMeters, { x: 3, y: 10, z: 1 });
    assert.equal(focus.geometryReady, true);
    const whole = f.runtime.getEntitiesWorldBounds(['stacker']);
    assert.ok(whole.sizeMeters.x > 30);
    f.rail.scaling.x = 5;
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']), focus);
    assert.ok(f.runtime.getEntitiesWorldBounds(['stacker']).sizeMeters.x > whole.sizeMeters.x);
  } finally { f.close(); }
});

test('机身行走后聚焦当前位置，根节点和固定轨道不动', () => {
  const f = fixture();
  try {
    for (const x of [0, 12, 30]) {
      f.body.position.x = x;
      assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']).center, { x, y: 5, z: 0 });
    }
    assert.deepEqual(f.root.position.asArray(), [0, 0, 0]);
    assert.equal(f.rail.position.x, 18.5);
  } finally { f.close(); }
});

test('普通模型和多选继续使用完整世界范围', () => {
  const f = fixture();
  try {
    f.model.stackerCapable = false;
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']), f.runtime.getEntitiesWorldBounds(['stacker']));
    f.model.stackerCapable = true;
    const other = f.box('other', 2, 2, -10, 1, f.root);
    f.runtime.meshes.set('other', other);
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker', 'other']), f.runtime.getEntitiesWorldBounds(['stacker', 'other']));
  } finally { f.close(); }
});

test('未启用遥测时仍读取场景内的 devType 和 specializedMotion；固定节点后代全部排除', () => {
  const f = fixture();
  try {
    f.model.stackerCapable = false;
    f.mast.name = 'custom-mast'; f.base.name = 'custom-base';
    const fixed = new TransformNode('fixed-assembly', f.scene);
    fixed.parent = f.body;
    f.rail.parent = fixed;
    f.rail.name = 'unknown-rail-mesh';
    f.model.entitySnapshot.components.modelAsset = { dataDrivenConfig: {
      device: { devType: 'stacker' }, motion: true,
      specializedMotion: { travel: { nodes: ['body-group'] } }, fixedNodes: ['fixed-assembly'],
    } };
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']).sizeMeters, { x: 3, y: 10, z: 1 });
    assert.equal(f.model.telemetryBinding.enabled, false);
  } finally { f.close(); }
});

test('脚本原始 motion 配置包含兄弟货叉和动态新增的货叉后代', () => {
  const f = fixture();
  try {
    f.model.stackerCapable = false;
    const fork = f.box('second-stage', 2, 1, 5, 2, f.root);
    f.box('new-script-child', 2, 1, 2, 0, fork);
    f.model.externalScriptRuntime = { getDataDrivenConfigs: () => [{ device: { devType: 'stacker' },
      motion: { travel: { nodes: ['body-group'] }, fork: { frontStageTwoNodes: ['second-stage'] } },
    }] };
    const bounds = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.equal(bounds.center.x, 3.25);
    assert.equal(bounds.sizeMeters.x, 9.5);
    assert.ok(!f.model.meshes.includes(fork), '新部件未登记到导入网格快照仍应计入');
  } finally { f.close(); }
});

test('隐藏、禁用、已销毁和空辅助节点不会扩大机身范围', () => {
  const f = fixture();
  try {
    f.model.entitySnapshot.components.modelAsset = { dataDrivenConfig: {
      device: { devType: 'stacker' }, specializedMotion: { travel: { nodes: ['body-group'] } },
    } };
    f.box('hidden', 100, 100, 0, 0).isVisible = false;
    f.box('transparent', 100, 100, 0, 0).visibility = 0;
    const disabled = new TransformNode('disabled', f.scene);
    disabled.parent = f.body; disabled.setEnabled(false);
    f.box('disabled-child', 100, 100, 0, 0, disabled);
    f.box('disposed', 100, 100, 0, 0).dispose();
    const empty = new TransformNode('empty', f.scene);
    empty.parent = f.body; empty.position.x = 100;
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']).sizeMeters, { x: 3, y: 10, z: 1 });
  } finally { f.close(); }
});

test('修改高度、旋转缩放和重新创建节点后使用最新世界范围', () => {
  const f = fixture();
  try {
    f.mast.scaling.y = 2; f.mast.position.y = 10;
    f.root.position.set(8, 2, -4);
    f.root.scaling.setAll(2); f.root.rotation.y = Math.PI / 2;
    let bounds = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.ok(Vector3.Distance(Vector3.FromArray(Object.values(bounds.center)), new Vector3(8, 22, -4)) < 1e-6);
    assert.ok(Math.abs(bounds.sizeMeters.x - 2) < 1e-6);
    assert.ok(Math.abs(bounds.sizeMeters.z - 6) < 1e-6);
    f.mast.dispose();
    f.box('lizhu1.11', 1, 6, 0, 3);
    bounds = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.ok(Math.abs(bounds.center.y - 8) < 1e-6, '节点替换后不使用旧包围盒缓存');
  } finally { f.close(); }
});

test('无法识别机身或仅命中小配件时回退整机范围，明确非堆垛机声明优先于路径兜底', () => {
  const f = fixture();
  try {
    f.mast.name = 'unknown-geometry'; f.base.name = 'huocha.9';
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']), f.runtime.getEntitiesWorldBounds(['stacker']));
    f.mast.name = 'lizhu1.11'; f.base.name = 'dibu.6';
    f.model.entitySnapshot.components.modelAsset = { dataDrivenConfig: { device: { devType: 'conveyor' } } };
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker']), f.runtime.getEntitiesWorldBounds(['stacker']));
  } finally { f.close(); }
});

test('中文机身语义兼容，失效的声明可回退到有效机身，重复ID不算多选', () => {
  const f = fixture();
  try {
    f.mast.name = '左立柱'; f.base.name = '底部支架';
    f.model.entitySnapshot.components.modelAsset = { dataDrivenConfig: { device: { devType: 'stacker' },
      specializedMotion: { travel: { nodes: ['missing-body'] } },
    } };
    assert.deepEqual(f.runtime.getEntitiesFocusBounds(['stacker', 'stacker']).center, { x: 0, y: 5, z: 0 });
    assert.equal(f.runtime.getEntitiesFocusBounds([]), null);
    assert.equal(f.runtime.getEntitiesFocusBounds(['missing']), null);
  } finally { f.close(); }
});

test('加载、参数脚本初始化期间不把机身范围误报为就绪', () => {
  const f = fixture();
  try {
    f.model.assetHandle = null;
    assert.equal(f.runtime.getEntitiesFocusBounds(['stacker']).geometryReady, false);
    f.model.assetHandle = {};
    f.model.externalScriptStarting = true;
    let bounds = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.equal(bounds.geometryReady, false);
    assert.deepEqual(bounds.notReadyEntityIds, ['stacker']);
    f.model.externalScriptStarting = false; f.model.measurementReady = false;
    assert.equal(f.runtime.getEntitiesFocusBounds(['stacker']).geometryReady, false);
    f.model.measurementReady = true;
    bounds = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.equal(bounds.geometryReady, true);
    assert.deepEqual(bounds.center, { x: 0, y: 5, z: 0 });
  } finally { f.close(); }
});

test('堆垛机生成下部近景锚点和模型相对端面平视方向，普通模型不附带专用视角', () => {
  const f = fixture();
  try {
    const initial = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.ok(initial.focusView.target.y > 1.5 && initial.focusView.target.y < 2.5);
    assert.equal(initial.center.y, 5, '机身包围盒仍保留完整中心，仅相机取景使用下部锚点');
    assert.equal(initial.focusView.beta, Math.PI / 2, '镜头与目标等高，不再俯视梯子端面');
    assert.ok(Math.abs(Math.cos(initial.focusView.alpha)) < 1e-6, '正对沿行走轴的窄端面');
    assert.ok(Math.sin(initial.focusView.alpha) > 0.999999, '从局部 +Z 梯笼一端观察');
    assert.equal(initial.focusView.maxRadiusMeters, 8);
    f.root.rotation.y = Math.PI / 2;
    f.root.position.set(10, 2, 4);
    const rotated = f.runtime.getEntitiesFocusBounds(['stacker']);
    assert.ok(Math.abs(rotated.focusView.target.y - initial.focusView.target.y - 2) < 1e-6);
    assert.ok(Math.abs(Math.atan2(Math.sin(rotated.focusView.alpha - initial.focusView.alpha),
      Math.cos(rotated.focusView.alpha - initial.focusView.alpha)) + Math.PI / 2) < 1e-6);
    f.model.stackerCapable = false;
    assert.equal(f.runtime.getEntitiesFocusBounds(['stacker']).focusView, undefined);
  } finally { f.close(); }
});
