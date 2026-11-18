import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { Animation, AnimationGroup, ArcRotateCamera, AssetContainer, LoadAssetContainerAsync, MeshBuilder, NullEngine, Scene, SceneLoader, Skeleton, Vector3 } from '@babylonjs/core';

const server = await createServer({ appType: 'custom', configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
const { ManualRoamRuntime } = await server.ssrLoadModule('/src/runtime/roam/ManualRoamRuntime.ts');
const { EditorManualRoamSpawnRuntime } = await server.ssrLoadModule('/src/runtime/babylon/EditorManualRoamSpawnRuntime.ts');
const { createManualRoamSpawnEntity } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { ManualRoamAvatarAnimator } = await server.ssrLoadModule('/src/runtime/roam/ManualRoamAvatarAnimator.ts');
after(() => server.close());

test('默认人物实际换向时支撑鞋朝向稳定，部分转身仍交替抬脚', async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const canvas = new EventTarget();
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', {
    value: Object.assign(new EventTarget(), { baseURI: 'https://assets.test/' }), configurable: true,
  });
  const asset = (file: string) => readFile(new URL(`../../public/manual-roam/${file}`, import.meta.url));
  const load = async (file: string) => LoadAssetContainerAsync(new Uint8Array(await asset(file)), scene, {
    pluginExtension: '.glb', pluginOptions: { gltf: { animationStartMode: 0, skipMaterials: true } },
  });
  const rad = Math.PI / 180;
  const difference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) / rad;
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas, preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }), setOrbitControlsEnabled() {} });
  try {
    // 只替换网络资源边界，保留真实输入、位移、GLB绑定、动画混合、IK与场景帧顺序。
    const avatar = await load('EQ_People_rigged_v2.glb');
    const manifest = await asset('locomotion-v2.manifest.json');
    t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatar);
    t.mock.method(globalThis, 'fetch', async () => new Response(manifest.toString()));
    const create = ManualRoamAvatarAnimator.create.bind(ManualRoamAvatarAnimator);
    t.mock.method(ManualRoamAvatarAnimator, 'create', (s, container, options) => create(s, container, {
      ...options, loadContainer: () => load('locomotion-v2.glb'),
    }));
    t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);
    const ready = new Promise<void>(resolve => {
      const off = runtime.subscribe(() => {
        if (runtime.getSnapshot().avatarAnimationMode !== 'loading') { off(); resolve(); }
      });
    });
    runtime.setEnabled(true);
    await ready;
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'shared-skeleton');
    const feet = (['left', 'right'] as const).map(side => {
      const name = side === 'left' ? 'Left' : 'Right';
      const foot = avatar.transformNodes.find(n => n.name === name + 'Foot')!;
      const toe = avatar.transformNodes.find(n => n.name === name + 'ToeBase')!;
      const localUp = Vector3.FromArray(foot.metadata.gltf.extras.manualRoamSoleUp);
      return { side, pose() {
        const world = foot.computeWorldMatrix(true);
        const up = Vector3.TransformNormal(localUp, world).normalize();
        const axis = toe.computeWorldMatrix(true).getTranslation().subtract(world.getTranslation());
        const forward = axis.subtract(up.scale(Vector3.Dot(axis, up))).normalize();
        return { yaw: Math.atan2(forward.x, forward.z), pitch: Math.asin(forward.y) };
      } };
    });
    for (const [name, turn, maxDrift] of [
      ['持续转弯', 90, 8], ['向左换向', -90, 8], ['向右换向', 90, 8], ['急反向', 180, 22],
      ['原地转身', 45, 5], ['原地转身', 90, 7], ['停步转身', 90, 8],
    ] as const) {
      runtime.setEnabled(false); runtime.setEnabled(true);
      canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType: 'mouse', button: 2, pointerId: 1 }));
      const planted = feet.map(() => ({ id: -1, yaw: 0, previousYaw: 0, samples: 0, minContact: 1, pitch: 0 }));
      // 第28帧正处于抬跟，用这一帧停步可复现单帧俯仰跳变。
      const start = name === '停步转身' ? 28 : 45;
      let drift = 0, pitchStep = 0, yawStep = 0;
      for (let tick = 0; tick < start + 75; tick++) {
        const turning = tick >= start;
        const standing = name === '原地转身' || (name === '停步转身' && turning);
        const curve = name === '持续转弯';
        const heading = turning && !curve ? turn * rad : 0;
        runtime.setVirtualMovement(standing ? 0 : Math.sin(heading), standing ? 0 : Math.cos(heading));
        const look = standing && tick === start ? turn : curve && turning && tick < start + 45 ? 2 : 0;
        if (look) canvas.dispatchEvent(Object.assign(new Event('pointermove'), { pointerType: 'mouse',
          pointerId: 1, buttons: 2, movementX: look * rad / runtime.getSnapshot().config.mouseSensitivity, movementY: 0 }));
        scene.render();
        if (tick < start - 1) continue;
        const locks = runtime.footIK.getDebugState(), contacts = runtime.skeletalAnimator.getFootContacts();
        feet.forEach(({ side, pose }, i) => {
          const foot = pose(), track = planted[i], lock = locks[side];
          if (lock.locked && lock.lockId === track.id) {
            drift = Math.max(drift, difference(foot.yaw, track.yaw)); track.samples++;
          } else track.yaw = foot.yaw;
          track.id = lock.locked ? lock.lockId : -1;
          if (turning) {
            pitchStep = Math.max(pitchStep, difference(foot.pitch, track.pitch));
            yawStep = Math.max(yawStep, difference(foot.yaw, track.previousYaw));
          }
          track.pitch = foot.pitch;
          track.previousYaw = foot.yaw;
          track.minContact = Math.min(track.minContact, contacts[side]);
        });
      }
      const label = `${name} ${turn}°`;
      assert.ok(difference(runtime.turnState.visualYaw, turn * rad) < .3, `${label}应完成实际转角`);
      assert.ok(planted.every(foot => foot.samples >= 12 && foot.minContact < .1), `${label}双脚应实际交替摆动和连续支撑`);
      assert.ok(drift < maxDrift, `${label}同一支撑脚内转动了${drift.toFixed(1)}°`);
      assert.ok(pitchStep < 8, `${label}脚掌单帧俯仰跳变${pitchStep.toFixed(1)}°`);
      assert.ok(yawStep < 8, `${label}脚掌单帧朝向跳变${yawStep.toFixed(1)}°`);
    }
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

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

test('普通蒙皮人物自动尝试共享动作，脚部增强失败不撤销已成功的动作', async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { baseURI: 'https://assets.test/' }), configurable: true });
  const avatar = createAvatar(scene, 'ordinary-skinned');
  avatar.mesh.skeleton = new Skeleton('ordinary', 'ordinary', scene);
  avatar.container.skeletons.push(avatar.mesh.skeleton);
  let created = 0, disposed = 0;
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatar.container);
  t.mock.method(ManualRoamAvatarAnimator, 'create', async () => {
    created++;
    return { sampleIdle() {}, pause() {}, setStrideWarpEnabled() {}, dispose() { disposed++; },
      getRigBinding: () => ({ joints: new Map(), automatic: true, facingYaw: Math.PI / 2, warnings: [], legLength: 1 }) };
  });
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas: new EventTarget(), avatarUrl: 'https://assets.test/ordinary.glb', setOrbitControlsEnabled() {} });
  try {
    await flush();
    assert.equal(created, 1, '无专用 profile 的蒙皮人物也必须进入自动适配');
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'auto-skeleton');
    assert.match(runtime.getSnapshot().statusMessage, /贴地/);
    assert.equal(disposed, 0, '脚部检测失败不能销毁已成功的动作');
    avatar.mesh.computeWorldMatrix(true);
    const center = avatar.mesh.getBoundingInfo().boundingBox.centerWorld;
    assert.ok(Math.hypot(center.x, center.z) < 1e-5, '自动修正朝向后人物仍应位于碰撞体中央');
    runtime.dispose();
    assert.equal(disposed, 1);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('旧人物动作晚到失败不能销毁新人物已绑定的动作', async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { baseURI: 'https://assets.test/' }), configurable: true });
  const avatars = ['old', 'new'].map(name => {
    const avatar = createAvatar(scene, name);
    avatar.mesh.skeleton = new Skeleton(name, name, scene); avatar.container.skeletons.push(avatar.mesh.skeleton); return avatar;
  });
  let loaded = 0, rejectOld!: (reason: Error) => void, newDisposed = 0;
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatars[loaded++].container);
  t.mock.method(ManualRoamAvatarAnimator, 'create', async (_scene, container) => {
    if (container === avatars[0].container) return new Promise((_resolve, reject) => { rejectOld = reject; });
    return { sampleIdle() {}, pause() {}, setStrideWarpEnabled() {}, dispose() { newDisposed++; },
      getRigBinding: () => ({ joints: new Map(), automatic: true, facingYaw: 0, warnings: [], legLength: 1 }) };
  });
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas: new EventTarget(), avatarUrl: 'https://assets.test/old.glb', setOrbitControlsEnabled() {} });
  try {
    await flush(); runtime.setAvatarUrl('https://assets.test/new.glb'); await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'auto-skeleton');
    rejectOld(new Error('旧动作下载失败')); await flush();
    assert.equal(newDisposed, 0, '过期失败不得释放当前人物动作');
    assert.equal(avatars[1].mesh.isDisposed(), false);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('普通人物适配失败保留自带动画并显示具体原因', async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { baseURI: 'https://assets.test/' }), configurable: true });
  const avatar = createAvatar(scene, 'unsupported', true);
  avatar.mesh.skeleton = new Skeleton('incomplete', 'incomplete', scene);
  avatar.container.skeletons.push(avatar.mesh.skeleton);
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatar.container);
  t.mock.method(ManualRoamAvatarAnimator, 'create', async () => { throw new Error('缺少左腿'); });
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas: new EventTarget(), avatarUrl: 'https://assets.test/incomplete.glb', setOrbitControlsEnabled() {} });
  try {
    await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'embedded');
    assert.match(runtime.getSnapshot().statusMessage, /缺少左腿/);
    assert.equal(avatar.mesh.isDisposed(), false);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

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

test('编辑态普通人物自动绑定待机，修正朝向后仍居中于指定出生点', async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { baseURI: 'https://assets.test/' }), configurable: true });
  const avatar = createAvatar(scene, 'editor-ordinary');
  avatar.mesh.skeleton = new Skeleton('ordinary', 'ordinary', scene);
  avatar.container.skeletons.push(avatar.mesh.skeleton);
  let idle = 0, paused = 0, disposed = 0;
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatar.container);
  t.mock.method(ManualRoamAvatarAnimator, 'create', async () => ({
    sampleIdle() { idle++; }, pause() { paused++; }, dispose() { disposed++; },
    getRigBinding: () => ({ joints: new Map(), automatic: true, facingYaw: Math.PI / 2, warnings: [], legLength: 1 }),
  }));
  const runtime = new EditorManualRoamSpawnRuntime(scene);
  const spawn = createManualRoamSpawnEntity({ x: 10, y: 3, z: 5 });
  spawn.components.transform.rotation.y = .7;
  spawn.components.manualRoamSpawn = { avatar: { name: 'ordinary', sourcePath: 'ordinary.glb', sourceUrl: 'https://assets.test/ordinary.glb' } };
  try {
    runtime.sync(spawn, true, true, true); await flush();
    assert.equal(idle, 1); assert.equal(paused, 1, '编辑态只采样待机，不持续播放');
    avatar.mesh.computeWorldMatrix(true);
    const bounds = avatar.mesh.getBoundingInfo().boundingBox;
    assert.ok(Math.hypot(bounds.centerWorld.x - 10, bounds.centerWorld.z - 5) < 1e-5);
    assert.ok(Math.abs(bounds.minimumWorld.y - 3) < 1e-5);
    runtime.dispose(); assert.equal(disposed, 1);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('无漫游人物需求时不加载默认资源，首次显式设置后仍按原异步生命周期加载', async (t) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  const requests: Array<(container: AssetContainer) => void> = [];
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', () => new Promise(resolve => requests.push(resolve)));
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas: new EventTarget(),
    avatarUrl: 'https://assets.test/default.glb', preloadAvatar: false, setOrbitControlsEnabled: () => {} });
  try {
    assert.equal(requests.length, 0);
    runtime.setAvatarUrl('https://assets.test/custom.glb');
    runtime.setAvatarUrl('https://assets.test/custom.glb');
    assert.equal(requests.length, 1);
    const avatar = createAvatar(scene, 'custom');
    requests[0](avatar.container);
    await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'static');
    runtime.dispose();
    assert.equal(avatar.mesh.isDisposed(), true);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('退出漫游暂停真实人物动画求值，重进恢复且反复启停不新增动画实例', async (t) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  const avatar = createAvatar(scene, 'animated-avatar');
  const group = new AnimationGroup('Idle', scene);
  const animation = new Animation('idle-yaw', 'rotation.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
  animation.setKeys([{ frame: 0, value: 0 }, { frame: 60, value: 1 }]);
  group.addTargetedAnimation(animation, avatar.mesh);
  avatar.container.animationGroups.push(group);
  avatar.container.removeAllFromScene();
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatar.container);
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas: new EventTarget(),
    avatarUrl: 'https://assets.test/animated.glb', setOrbitControlsEnabled: () => {},
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }) });
  try {
    await flush();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'embedded');
    runtime.setEnabled(true);
    scene.render();
    scene.render();
    assert.ok(avatar.mesh.rotation.y > 0, '启用漫游后 Idle 应实际改变目标的姿态');
    const [animatable] = group.animatables;
    assert.ok(animatable, 'Idle 必须有真实的动画目标');
    for (let cycle = 0; cycle < 20; cycle += 1) {
      runtime.setEnabled(false);
      const frame = group.getCurrentFrame();
      const yaw = avatar.mesh.rotation.y;
      scene.render();
      assert.ok(animatable.paused);
      assert.equal(group.getCurrentFrame(), frame, '隐藏人物时停止采样');
      assert.equal(avatar.mesh.rotation.y, yaw);
      runtime.setEnabled(true);
      scene.render();
      assert.ok(group.getCurrentFrame() > frame, '重进漫游后继续推进 Idle');
      assert.ok(avatar.mesh.rotation.y > yaw, '恢复采样必须作用到真实目标');
      assert.equal(group.animatables.length, 1);
      assert.equal(group.animatables[0], animatable, '反复启停应复用同一个动画实例');
    }
    runtime.dispose();
    assert.equal(scene.animationGroups.includes(group), false);
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('碰撞阻止位移时保持待机，恢复移动后按实际位移驱动步频', async (t) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 10, Vector3.Zero(), scene);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  const avatar = createAvatar(scene, 'collision-avatar');
  const [idle, walk] = ['Idle', 'Walk'].map(name => {
    const group = new AnimationGroup(name, scene);
    const animation = new Animation(name, 'rotation.y', 30, Animation.ANIMATIONTYPE_FLOAT);
    const baseYaw = name === 'Idle' ? -0.2 : 0.2;
    animation.setKeys([{ frame: 0, value: baseYaw }, { frame: 30, value: baseYaw + 0.1 }]);
    group.addTargetedAnimation(animation, avatar.mesh);
    avatar.container.animationGroups.push(group);
    return group;
  });
  avatar.container.removeAllFromScene();
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => avatar.container);
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);
  const runtime = new ManualRoamRuntime({ scene, engine, camera, canvas: new EventTarget(),
    avatarUrl: 'https://assets.test/collision.glb', setOrbitControlsEnabled: () => {},
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }) });
  try {
    await flush();
    runtime.setEnabled(true);
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);
    let displacementScale = 0;
    t.mock.method(collider, 'moveWithCollisions', (displacement: Vector3) => {
      collider.position.addInPlace(displacement.scale(displacementScale));
      return collider;
    });
    runtime.setVirtualMovement(0, 1);
    scene.render();
    assert.equal(runtime.getSnapshot().avatarAnimationMode, 'embedded');
    assert.equal(runtime.getSnapshot().moving, false, '输入不能替代碰撞后的实际移动');
    assert.ok(avatar.mesh.rotation.y < 0, '受阻时人物保持 Idle 姿态');
    assert.equal(walk.animatables.length, 0);

    displacementScale = 0.5;
    scene.render();
    assert.equal(runtime.getSnapshot().moving, true);
    assert.ok(idle.animatables[0].weight > 0 && walk.animatables[0].weight > 0, '起步时两种姿态应渐变');
    for (let tick = 0; tick < 11; tick++) scene.render(); // 地面过渡为 0.18 秒
    assert.ok(avatar.mesh.rotation.y > 0, '过渡后应实际应用 Walk 的姿态');
    const frame = walk.getCurrentFrame();
    const sampleSeconds = 6 / 60;
    for (let tick = 0; tick < 6; tick++) scene.render();
    const playbackRate = (walk.getCurrentFrame() - frame) / (30 * sampleSeconds);
    assert.ok(Math.abs(playbackRate - 0.5) < 0.01, `碰撞后实际步频应为半速，得到 ${playbackRate}`);

    displacementScale = 0;
    const stoppedFrame = walk.getCurrentFrame();
    scene.render();
    assert.equal(runtime.getSnapshot().moving, false);
    assert.equal(walk.getCurrentFrame(), stoppedFrame, '再次受阻时渐出的步态不能继续推进');
    for (let tick = 0; tick < 11; tick++) scene.render();
    assert.equal(walk.animatables.length, 0);
    assert.ok(avatar.mesh.rotation.y < 0, '再次受阻时应恢复 Idle 姿态');
  } finally {
    runtime.dispose(); scene.dispose(); engine.dispose();
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
