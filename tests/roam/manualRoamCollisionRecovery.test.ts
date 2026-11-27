import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import {
  ArcRotateCamera,
  AssetContainer,
  MeshBuilder,
  NullEngine,
  Scene,
  SceneLoader,
  Vector3,
} from '@babylonjs/core';
import {
  computeCollisionSubstepCount,
  DEFAULT_MAX_COLLISION_SUBSTEPS,
  findOverlappingAabbBounds,
  resolveCapsuleAabbDepenetration,
} from '../../src/runtime/roam/manualRoamCollisionRecovery.ts';
import type { ManualRoamCollisionBounds } from '../../src/runtime/roam/manualRoamCollisionBounds.ts';

const server = await createServer({
  appType: 'custom',
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
});
const { ManualRoamRuntime } = await server.ssrLoadModule('/src/runtime/roam/ManualRoamRuntime.ts');
after(() => server.close());

function installTestDomGlobals() {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', {
    value: Object.assign(new EventTarget(), { baseURI: 'https://assets.test/' }),
    configurable: true,
  });
  return () => {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  };
}

function createStaticAvatarContainer(scene: Scene): AssetContainer {
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox('test-avatar', { width: 0.4, height: 1.65, depth: 0.3 }, scene);
  container.meshes.push(mesh);
  container.rootNodes.push(mesh);
  container.removeAllFromScene();
  return container;
}

test('computeCollisionSubstepCount 对常规步长保持单步，高速或大帧间隔拆分为受限子步', () => {
  assert.equal(computeCollisionSubstepCount({ x: 0, y: 0, z: 0 }, 0.28), 1);
  assert.equal(computeCollisionSubstepCount({ x: 0.03, y: 0, z: 0 }, 0.28), 1);
  assert.equal(computeCollisionSubstepCount({ x: 0.35, y: 0, z: 0 }, 0.28), 3);
  assert.equal(
    computeCollisionSubstepCount({ x: 10, y: 0, z: 0 }, 0.28),
    DEFAULT_MAX_COLLISION_SUBSTEPS,
  );
  assert.equal(computeCollisionSubstepCount({ x: Number.NaN, y: 0, z: 0 }, 0.28), 1);
  assert.equal(computeCollisionSubstepCount({ x: 1, y: 0, z: 0 }, 0), 1);
});

test('resolveCapsuleAabbDepenetration 对贴边与站顶不误触发，陷入盒内按最短安全路径推出', () => {
  const tallBox: ManualRoamCollisionBounds = {
    id: 'tall-box',
    minimum: { x: 0, y: 0, z: 0 },
    maximum: { x: 2, y: 3, z: 4 },
  };
  const radius = 0.28;
  const height = 1.65;

  const touchingSide = resolveCapsuleAabbDepenetration({
    position: { x: 2 + radius, y: 0, z: 2 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: [tallBox],
  });
  assert.equal(touchingSide.resolved, true);
  assert.deepEqual(touchingSide.overlappingIds, []);
  assert.deepEqual(touchingSide.position, { x: 2 + radius, y: 0, z: 2 });

  const standingOnTop = resolveCapsuleAabbDepenetration({
    position: { x: 1, y: 3, z: 2 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: [tallBox],
  });
  assert.equal(standingOnTop.resolved, true);
  assert.deepEqual(standingOnTop.overlappingIds, []);

  const sideEmbedded = resolveCapsuleAabbDepenetration({
    position: { x: 2.15, y: 0, z: 2 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: [tallBox],
  });
  assert.equal(sideEmbedded.resolved, true);
  assert.deepEqual(sideEmbedded.overlappingIds, ['tall-box']);
  assert.ok(sideEmbedded.position.x >= 2 + radius + 0.019);
  assert.equal(sideEmbedded.position.y, 0);

  const deepInsideTall = resolveCapsuleAabbDepenetration({
    position: { x: 0.4, y: 0, z: 2 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: [tallBox],
  });
  assert.equal(deepInsideTall.resolved, true);
  assert.ok(deepInsideTall.position.x <= -radius - 0.019, '深陷高盒内部应从最近水平面推出，不能弹上屋顶');
  assert.equal(deepInsideTall.position.y, 0);

  const lowCurb: ManualRoamCollisionBounds = {
    id: 'low-curb',
    minimum: { x: 0, y: 0, z: 0 },
    maximum: { x: 3, y: 0.2, z: 3 },
  };
  const nearLowCurbTop = resolveCapsuleAabbDepenetration({
    position: { x: 1.5, y: 0.05, z: 1.5 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: [lowCurb],
    stepHeight: 0.22,
  });
  assert.equal(nearLowCurbTop.resolved, true);
  assert.ok(nearLowCurbTop.position.y > 0.2, '浅嵌矮台顶面应可向上抬出');

  const overheadCeiling: ManualRoamCollisionBounds = {
    id: 'ceiling',
    minimum: { x: 0, y: 2.8, z: 0 },
    maximum: { x: 4, y: 3.1, z: 4 },
  };
  const flyCeilingExit = resolveCapsuleAabbDepenetration({
    position: { x: 2, y: 1.4, z: 2 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: [overheadCeiling],
    allowVerticalExit: true,
  });
  assert.equal(flyCeilingExit.resolved, true);
  assert.ok(flyCeilingExit.position.y + height < 2.8, '飞行模式顶穿薄顶板应向下退出');

  const cornerBoxes: ManualRoamCollisionBounds[] = [
    { id: 'box-a', minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 1, y: 2, z: 1 } },
    { id: 'box-b', minimum: { x: 0.5, y: 0, z: 0.5 }, maximum: { x: 1.5, y: 2, z: 1.5 } },
  ];
  const cornerEmbedded = resolveCapsuleAabbDepenetration({
    position: { x: 0.75, y: 0, z: 0.75 },
    capsuleRadius: radius,
    capsuleHeight: height,
    bounds: cornerBoxes,
  });
  assert.equal(cornerEmbedded.resolved, true);
  assert.equal(
    findOverlappingAabbBounds(cornerEmbedded.position, radius, height, cornerBoxes).length,
    0,
  );
});

test('出生在 AABB 代理盒内时自动脱困到盒外并保持可移动', async (t) => {
  const restoreGlobals = installTestDomGlobals();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene);
  const floor = MeshBuilder.CreateGround('floor', { width: 40, height: 40, subdivisions: 2 }, scene);
  floor.position.y = 0;
  const obstacleBounds: ManualRoamCollisionBounds[] = [
    { id: 'spawn-obstacle', minimum: { x: -1, y: 0, z: -1 }, maximum: { x: 1, y: 2, z: 1 } },
  ];
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => createStaticAvatarContainer(scene));
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);

  const runtime = new ManualRoamRuntime({
    scene,
    engine,
    camera,
    canvas: new EventTarget() as unknown as HTMLCanvasElement,
    preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }),
    resolveCollisionBounds: () => obstacleBounds,
    setOrbitControlsEnabled: () => {},
  });

  try {
    runtime.setEnabled(true);
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);
    assert.equal(
      findOverlappingAabbBounds(collider.position, 0.28, 1.65, obstacleBounds).length,
      0,
      '出生点位于代理盒内部时应自动移至盒外安全区',
    );
    assert.equal(runtime.getSnapshot().grounded, true);

    const startPos = collider.position.clone();
    const awayFromBox = new Vector3(startPos.x, 0, startPos.z).normalize();
    runtime.setVirtualMovement(awayFromBox.x, awayFromBox.z);
    for (let tick = 0; tick < 15; tick += 1) scene.render();
    assert.ok(
      Vector3.Distance(collider.position, startPos) > 0.2,
      '脱困后人物应能自由移动而不被内壁锁死',
    );
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    restoreGlobals();
  }
});

test('飞行模式穿入 AABB 代理盒后切回地面模式时自动脱困并安全落地', async (t) => {
  const restoreGlobals = installTestDomGlobals();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene);
  MeshBuilder.CreateGround('floor', { width: 40, height: 40, subdivisions: 2 }, scene);
  const obstacleBounds: ManualRoamCollisionBounds[] = [
    { id: 'fly-obstacle', minimum: { x: -1, y: 0, z: -1 }, maximum: { x: 1, y: 2.5, z: 1 } },
  ];
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => createStaticAvatarContainer(scene));
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);

  const runtime = new ManualRoamRuntime({
    scene,
    engine,
    camera,
    canvas: new EventTarget() as unknown as HTMLCanvasElement,
    preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 3, y: 0, z: 0 }, yaw: 0 }),
    resolveCollisionBounds: () => obstacleBounds,
    setOrbitControlsEnabled: () => {},
  });

  try {
    runtime.setEnabled(true);
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);
    runtime.setLocomotionMode('fly');
    collider.position.set(0.2, 0.5, 0.2);

    runtime.setLocomotionMode('ground');
    assert.equal(
      findOverlappingAabbBounds(collider.position, 0.28, 1.65, obstacleBounds).length,
      0,
      '飞行切回地面时应自动推出代理盒',
    );
    for (let tick = 0; tick < 30; tick += 1) scene.render();
    assert.ok(Math.abs(collider.position.y) < 0.05);
    assert.equal(runtime.getSnapshot().grounded, true);
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    restoreGlobals();
  }
});

test('运行中动态刷新或新增的 AABB 代理盒套住人物时自动推出', async (t) => {
  const restoreGlobals = installTestDomGlobals();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene);
  MeshBuilder.CreateGround('floor', { width: 40, height: 40, subdivisions: 2 }, scene);
  let activeObstacles: ManualRoamCollisionBounds[] = [];
  let fakeNowMs = 0;
  t.mock.method(performance, 'now', () => fakeNowMs);
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => createStaticAvatarContainer(scene));
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);

  const runtime = new ManualRoamRuntime({
    scene,
    engine,
    camera,
    canvas: new EventTarget() as unknown as HTMLCanvasElement,
    preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }),
    resolveCollisionBounds: () => activeObstacles,
    setOrbitControlsEnabled: () => {},
  });

  try {
    runtime.setEnabled(true);
    scene.render();
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);

    activeObstacles = [
      { id: 'late-rack', minimum: { x: -0.9, y: 0, z: -0.9 }, maximum: { x: 0.9, y: 2, z: 0.9 } },
    ];
    fakeNowMs = 300;
    scene.render();

    assert.equal(
      findOverlappingAabbBounds(collider.position, 0.28, 1.65, activeObstacles).length,
      0,
      '代理盒延迟刷新套住静止人物时应自动脱困',
    );
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    restoreGlobals();
  }
});

test('高速移动撞向薄墙时通过距离子步防止穿墙', async (t) => {
  const restoreGlobals = installTestDomGlobals();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene);
  MeshBuilder.CreateGround('floor', { width: 40, height: 40, subdivisions: 2 }, scene);
  const thinWall = MeshBuilder.CreateBox('thin-wall', { width: 10, height: 3, depth: 0.04 }, scene);
  thinWall.position.set(0, 1.5, 0.7);
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => createStaticAvatarContainer(scene));
  t.mock.method(engine, 'getDeltaTime', () => 50);

  const runtime = new ManualRoamRuntime({
    scene,
    engine,
    camera,
    canvas: new EventTarget() as unknown as HTMLCanvasElement,
    preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }),
    setOrbitControlsEnabled: () => {},
  });

  try {
    runtime.updateConfig({ walkSpeed: 20, runSpeed: 20 });
    runtime.setEnabled(true);
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);
    runtime.setVirtualMovement(0, 1);
    for (let tick = 0; tick < 15; tick += 1) scene.render();
    assert.ok(collider.position.z < 0.68, `高速人物不应穿透薄墙，得到 z=${collider.position.z}`);
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    restoreGlobals();
  }
});

test('低台阶可平稳踏上；上方有低矮悬挑阻挡时回滚不卡入', async (t) => {
  const restoreGlobals = installTestDomGlobals();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene);
  MeshBuilder.CreateGround('floor', { width: 40, height: 40, subdivisions: 2 }, scene);
  const stepMesh = MeshBuilder.CreateBox('low-step', { width: 4, height: 0.15, depth: 4 }, scene);
  stepMesh.position.set(0, 0.075, 2.3);
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => createStaticAvatarContainer(scene));
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);

  const runtime = new ManualRoamRuntime({
    scene,
    engine,
    camera,
    canvas: new EventTarget() as unknown as HTMLCanvasElement,
    preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: -0.3 }, yaw: 0 }),
    setOrbitControlsEnabled: () => {},
  });

  try {
    runtime.setEnabled(true);
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);

    runtime.setVirtualMovement(0, 1);
    for (let tick = 0; tick < 90; tick += 1) scene.render();
    assert.ok(collider.position.z > 0.6, `应顺利走上低台阶，当前 z=${collider.position.z}`);
    assert.ok(Math.abs(collider.position.y - 0.15) < 0.04, `台阶上高度应约为 0.15m，当前 y=${collider.position.y}`);
    assert.equal(runtime.getSnapshot().grounded, true);

    runtime.setEnabled(false);
    const overhang = MeshBuilder.CreateBox('low-overhang', { width: 4, height: 1, depth: 4 }, scene);
    overhang.position.set(0, 2.2, 2.3); // 底面在 y=1.70，站在 y=0 可通过但踏上 y=0.15 会顶头
    runtime.setEnabled(true);

    runtime.setVirtualMovement(0, 1);
    for (let tick = 0; tick < 60; tick += 1) scene.render();
    assert.ok(collider.position.z < 0.3, `悬挑阻挡时不得强行挤入台阶区域，当前 z=${collider.position.z}`);
    assert.ok(collider.position.y < 0.1, `悬挑阻挡时不得强行抬升上台阶，当前 y=${collider.position.y}`);

    const blockedZ = collider.position.z;
    runtime.setVirtualMovement(0, -1);
    for (let tick = 0; tick < 30; tick += 1) scene.render();
    assert.ok(collider.position.z < blockedZ - 0.3, '被悬挑阻挡后应可自由后退，不能卡死');
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    restoreGlobals();
  }
});

test('站在平台边缘时常规贴地不会将人物硬瞬移穿进平台内部', async (t) => {
  const restoreGlobals = installTestDomGlobals();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene);
  MeshBuilder.CreateGround('floor', { width: 40, height: 40, subdivisions: 2 }, scene);
  const platform = MeshBuilder.CreateBox('platform', { width: 4, height: 0.18, depth: 4 }, scene);
  platform.position.set(0, 0.09, -1.8); // 顶面 y=0.18，边缘 z=0.20
  t.mock.method(SceneLoader, 'LoadAssetContainerAsync', async () => createStaticAvatarContainer(scene));
  t.mock.method(engine, 'getDeltaTime', () => 1000 / 60);

  const runtime = new ManualRoamRuntime({
    scene,
    engine,
    camera,
    canvas: new EventTarget() as unknown as HTMLCanvasElement,
    preloadAvatar: false,
    resolveSpawnPose: () => ({ position: { x: 0, y: 0.18, z: 0.08 }, yaw: 0 }),
    setOrbitControlsEnabled: () => {},
  });

  try {
    runtime.setEnabled(true);
    const collider = scene.getMeshByName('__manual_roam_character_collider__');
    assert.ok(collider);

    // 前进到中心刚越过平台边缘 (z ≈ 0.21)，胶囊后半部仍支在平台顶面
    runtime.setVirtualMovement(0, 1);
    for (let tick = 0; tick < 5; tick += 1) scene.render();
    assert.ok(collider.position.z > 0.2);
    assert.ok(
      collider.position.y >= 0.15,
      `胶囊边缘仍受平台支撑时不得硬瞬移进平台内部，得到 y=${collider.position.y}`,
    );

    runtime.setVirtualMovement(0, -1);
    for (let tick = 0; tick < 20; tick += 1) scene.render();
    assert.ok(collider.position.z < -0.1, '向后退回平台时不应被卡住');
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    restoreGlobals();
  }
});
