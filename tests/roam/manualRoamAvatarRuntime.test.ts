import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { AnimationGroup, ArcRotateCamera, AssetContainer, MeshBuilder, NullEngine, Scene, SceneLoader, Vector3 } from '@babylonjs/core';

const server = await createServer({ appType: 'custom', configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
const { ManualRoamRuntime } = await server.ssrLoadModule('/src/runtime/roam/ManualRoamRuntime.ts');
const { EditorManualRoamSpawnRuntime } = await server.ssrLoadModule('/src/runtime/babylon/EditorManualRoamSpawnRuntime.ts');
const { createManualRoamSpawnEntity } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
after(() => server.close());

const flush = () => new Promise((resolve) => setImmediate(resolve));
function createAvatar(scene: Scene, name: string, animated = false) {
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox(name, { width: 2, height: 8, depth: 1 }, scene);
  mesh.position.set(3, 8, 2);
  container.meshes.push(mesh);
  container.rootNodes.push(mesh);
  if (animated) container.animationGroups.push(new AnimationGroup('Walk', scene));
  container.removeAllFromScene();
  return { container, mesh };
}

test('漫游切换忽略过期加载，适配身高，识别动画并清理卸载后的请求', async (t) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const canvas = new EventTarget();
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  const requests: Array<{ resolve: (value: AssetContainer) => void; reject: (reason: Error) => void }> = [];
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', () => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas, avatarUrl: 'https://assets.test/one.glb', setOrbitControlsEnabled: () => {} });
  try {
    runtime.setAvatarUrl('https://assets.test/two.glb');
    const second = createAvatar(scene, 'second');
    requests[1].resolve(second.container);
    await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'static');
    second.mesh.computeWorldMatrix(true);
    const bounds = second.mesh.getBoundingInfo().boundingBox;
    assert.ok(Math.abs(bounds.minimumWorld.y) < 1e-5);
    assert.ok(Math.abs(bounds.maximumWorld.y - runtime.getSnapshot().config.capsuleHeight) < 1e-5);
    assert.ok(Math.abs(bounds.centerWorld.x) < 1e-5);
    const first = createAvatar(scene, 'first');
    requests[0].resolve(first.container);
    await flush();
    assert.equal(first.mesh.isDisposed(), true);
    assert.equal(second.mesh.isDisposed(), false);
    runtime.setAvatarUrl('https://assets.test/animated.glb');
    assert.equal(second.mesh.isDisposed(), true);
    const animated = createAvatar(scene, 'animated', true);
    requests[2].resolve(animated.container);
    await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'embedded');
    runtime.setAvatarUrl('https://assets.test/broken.glb');
    requests[3].reject(new Error('损坏模型'));
    await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'error');
    assert.match(runtime.getSnapshot().statusMessage, /损坏模型/);
    runtime.setAvatarUrl('https://assets.test/late.glb');
    runtime.dispose();
    const late = createAvatar(scene, 'late');
    requests[4].resolve(late.container);
    await flush();
    assert.equal(late.mesh.isDisposed(), true);
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('编辑态切换人物重建显示并丢弃旧模型', async (t) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const requests: Array<(value: AssetContainer) => void> = [];
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', () => new Promise((resolve) => requests.push(resolve)));
  const runtime = new EditorManualRoamSpawnRuntime(scene);
  const spawn = createManualRoamSpawnEntity({ x: 10, y: 3, z: 5 });
  spawn.components.manualRoamSpawn = { avatar: { name: 'one', sourcePath: 'one.glb', sourceUrl: 'https://assets.test/one.glb' } };
  try {
    runtime.sync(spawn, true, true, true);
    const next = structuredClone(spawn);
    next.components.manualRoamSpawn.avatar.sourceUrl = 'https://assets.test/two.glb';
    runtime.sync(next, true, true, true);
    const second = createAvatar(scene, 'second');
    requests[1](second.container);
    await flush();
    const first = createAvatar(scene, 'first');
    requests[0](first.container);
    await flush();
    assert.equal(first.mesh.isDisposed(), true);
    assert.deepEqual(runtime.getWorldBoundsMeshes(spawn.id), [second.mesh]);
    second.mesh.computeWorldMatrix(true);
    assert.ok(Math.abs(second.mesh.getBoundingInfo().boundingBox.minimumWorld.y - 3) < 1e-5);
    runtime.dispose();
    assert.equal(second.mesh.isDisposed(), true);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
  }
});
