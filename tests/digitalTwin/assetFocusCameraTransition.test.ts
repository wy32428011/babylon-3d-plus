import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';
import { DIGITAL_TWIN_CAMERA_CONTROL_STANDARD } from '../../src/runtime/babylon/cameraControlStandard.ts';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@babylonjs/core'] },
});
const { ArcRotateCameraViewController } = await viteServer.ssrLoadModule(
  '/src/runtime/babylon/ArcRotateCameraViewController.ts',
) as typeof import('../../src/runtime/babylon/ArcRotateCameraViewController.ts');
after(async () => {
  await viteServer.close();
});

function fixture() {
  const engine = new NullEngine({ renderWidth: 800, renderHeight: 600 });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0.5, 1, 20, Vector3.Zero(), scene);
  scene.activeCamera = camera;
  let nowMs = 0;
  let suspendCount = 0;
  let resumeCount = 0;
  const controller = new ArcRotateCameraViewController(camera, engine, scene, {
    now: () => nowMs,
    prefersReducedMotion: () => false,
    suspendCameraControl: () => { suspendCount += 1; },
    resumeCameraControl: () => { resumeCount += 1; },
  });
  return {
    engine,
    scene,
    camera,
    controller,
    setNow: (value: number) => { nowMs = value; },
    counts: () => ({ suspendCount, resumeCount }),
    dispose: () => {
      controller.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

/** 断言 ArcRotateCamera 的镜头前向量确实穿过指定观察中心。 */
function assertCameraLooksAtTarget(camera: ArcRotateCamera, target: Vector3): void {
  camera.getViewMatrix(true);
  const directionToTarget = target.subtract(camera.position);
  const distance = directionToTarget.length();
  assert.ok(distance > 1e-6, '相机不能与观察目标重合');

  const forward = camera.getForwardRay().direction.normalize();
  const expectedForward = directionToTarget.scale(1 / distance);
  assert.ok(
    Vector3.Dot(forward, expectedForward) >= 1 - 1e-6,
    '相机镜头必须朝向模型中心',
  );
}

/** 断言相机相对 Target 的仰角为 45°。 */
function assertCameraAtFortyFiveDegreeElevation(camera: ArcRotateCamera, target: Vector3): void {
  camera.getViewMatrix(true);
  const offset = camera.position.subtract(target);
  const horizontalDistance = Math.hypot(offset.x, offset.z);
  assert.ok(
    Math.abs(Math.atan2(offset.y, horizontalDistance) - Math.PI / 4) <= 1e-6,
    '聚焦相机必须位于模型斜上方 45°',
  );
}

test('单次相机调用可覆盖 450ms 时长并在完成后通知和恢复控件', () => {
  const f = fixture();
  let completed = 0;
  try {
    f.controller.applyCameraPose({
      alpha: 0.5,
      beta: 1,
      radius: 5,
      target: { x: 10, y: 2, z: -4 },
    }, {
      animate: true,
      durationMs: 450,
      onCompleted: () => { completed += 1; },
    });

    assert.equal(f.controller.getNavigationMode(), 'transition');
    assert.deepEqual(f.counts(), { suspendCount: 1, resumeCount: 0 });

    f.setNow(225);
    f.scene.render();
    assert.ok(f.camera.radius < 20 && f.camera.radius > 5);

    f.setNow(450);
    f.scene.render();
    assert.equal(f.controller.getNavigationMode(), 'orbit');
    assert.equal(completed, 1);
    assert.deepEqual(f.counts(), { suspendCount: 1, resumeCount: 1 });
    assert.equal(f.camera.radius, 5);
    assert.deepEqual(f.camera.getTarget().asArray(), [10, 2, -4]);
  } finally {
    f.dispose();
  }
});

test('新 transition 会以 replaced 原因取消旧 transition 且不会失衡相机控件', () => {
  const f = fixture();
  const cancelled: string[] = [];
  try {
    f.controller.applyCameraPose({ alpha: 0.5, beta: 1, radius: 8, target: { x: 1, y: 0, z: 0 } }, {
      animate: true,
      durationMs: 450,
      onCancelled: (reason) => cancelled.push(reason),
    });
    f.controller.applyCameraPose({ alpha: 0.5, beta: 1, radius: 6, target: { x: 2, y: 0, z: 0 } }, {
      animate: true,
      durationMs: 450,
    });

    assert.deepEqual(cancelled, ['replaced']);
    assert.deepEqual(f.counts(), { suspendCount: 2, resumeCount: 1 });

    f.setNow(450);
    f.scene.render();
    assert.deepEqual(f.counts(), { suspendCount: 2, resumeCount: 2 });
  } finally {
    f.dispose();
  }
});

test('人工输入可显式取消 transition 并收到 manual-input 原因', () => {
  const f = fixture();
  const cancelled: string[] = [];
  let completed = 0;
  try {
    f.controller.applyCameraPose({ alpha: 0.5, beta: 1, radius: 7, target: { x: 3, y: 0, z: 0 } }, {
      animate: true,
      durationMs: 450,
      onCompleted: () => { completed += 1; },
      onCancelled: (reason) => cancelled.push(reason),
    });

    assert.equal(f.controller.cancelTransition('manual-input'), true);
    assert.equal(f.controller.cancelTransition('manual-input'), false);
    assert.equal(completed, 0);
    assert.deepEqual(cancelled, ['manual-input']);
    assert.deepEqual(f.counts(), { suspendCount: 1, resumeCount: 1 });
    assert.equal(f.controller.getNavigationMode(), 'orbit');
  } finally {
    f.dispose();
  }
});

test('聚焦以最新模型中心为 Target，链条机改大后相机位于斜上方 45° 且距离不超过 3m', async () => {
  const { focusArcRotateCameraOnBounds } = await viteServer.ssrLoadModule(
    '/src/runtime/babylon/createEngine.ts',
  ) as typeof import('../../src/runtime/babylon/createEngine.ts');
  const {
    defaultBetaRadians,
    minCameraHeightMeters,
    maxRadiusMeters,
    preferredRadiusMeters,
  } = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus;

  const engine = new NullEngine({ renderWidth: 800, renderHeight: 600 });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', Math.PI / 4, Math.PI * 0.62, 10, Vector3.Zero(), scene);
  const originalAlpha = camera.alpha;
  try {
    focusArcRotateCameraOnBounds(camera, engine, {
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 0.5,
    });
    camera.getViewMatrix(true);
    assert.equal(camera.alpha, originalAlpha, '聚焦应保留当前水平观察方向');
    assert.equal(camera.beta, defaultBetaRadians, '常规模型聚焦应使用斜上方 45° 视角');
    assert.equal(camera.radius, preferredRadiusMeters, '常规模型聚焦距离应为 2m');
    assert.deepEqual(camera.getTarget().asArray(), [0, 0, 0], '聚焦 Target 应落在当前模型中心');
    assertCameraAtFortyFiveDegreeElevation(camera, Vector3.Zero());
    assert.ok(
      camera.position.y >= minCameraHeightMeters - 1e-9,
      `聚焦地面模型后相机高度 ${camera.position.y.toFixed(4)} 不得低于 ${minCameraHeightMeters}`,
    );
    assert.ok(camera.radius <= maxRadiusMeters + 1e-9, '聚焦半径不得超过 3m 上限');

    focusArcRotateCameraOnBounds(camera, engine, {
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 3,
    });
    camera.getViewMatrix(true);
    assert.equal(camera.radius, maxRadiusMeters, '大模型聚焦距离不得突破 3m');
    assert.ok(Vector3.Distance(camera.position, camera.getTarget()) <= maxRadiusMeters + 1e-6);

    // 真实链条机改为约 20m × 5.3m × 10.2m 后，包围球半径约为 11.54m；
    // 同时改变中心可防止实现仍对准改参前的旧包围盒。
    const resizedChainBounds = {
      center: { x: 8, y: 2.632455, z: -5 },
      radiusMeters: 11.53405,
    };
    focusArcRotateCameraOnBounds(camera, engine, resizedChainBounds);
    camera.getViewMatrix(true);
    assert.deepEqual(
      camera.getTarget().asArray(),
      [resizedChainBounds.center.x, resizedChainBounds.center.y, resizedChainBounds.center.z],
      '链条机改参后应聚焦新的包围盒中心',
    );
    assert.equal(camera.alpha, originalAlpha, '链条机改参聚焦后仍应保留水平观察方向');
    assert.equal(camera.beta, defaultBetaRadians, '链条机改参聚焦后必须使用斜上方 45° 视角');
    assert.ok(camera.position.y > resizedChainBounds.center.y, '链条机改参聚焦后相机应位于 Target 上方');
    assert.equal(camera.radius, maxRadiusMeters, '放大的链条机聚焦距离也不得超过 3m');
    assert.ok(
      Vector3.Distance(camera.position, camera.getTarget()) <= maxRadiusMeters + 1e-6,
      '相机位置到链条机中心点的实际距离不得超过 3m',
    );
    assertCameraLooksAtTarget(
      camera,
      new Vector3(resizedChainBounds.center.x, resizedChainBounds.center.y, resizedChainBounds.center.z),
    );
    assertCameraAtFortyFiveDegreeElevation(
      camera,
      new Vector3(resizedChainBounds.center.x, resizedChainBounds.center.y, resizedChainBounds.center.z),
    );

    focusArcRotateCameraOnBounds(camera, engine, {
      center: { x: 0, y: -5, z: 0 },
      radiusMeters: 0.5,
    });
    camera.getViewMatrix(true);
    assert.equal(camera.radius, maxRadiusMeters, '地下目标也必须遵守 3m 最大距离');
    focusArcRotateCameraOnBounds(camera, engine, {
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 5000,
    });
    camera.getViewMatrix(true);
    assert.equal(camera.radius, maxRadiusMeters, '超大模型聚焦距离仍不得超过 3m');
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('标准视角锁定后聚焦会切回轨道模式并使用斜上方 45° 位置', async () => {
  const { focusArcRotateCameraViewOnBounds } = await viteServer.ssrLoadModule(
    '/src/runtime/babylon/createEngine.ts',
  ) as typeof import('../../src/runtime/babylon/createEngine.ts');
  const f = fixture();
  try {
    f.scene.activeCamera = f.camera;
    f.controller.setCameraOrientation('top', { animate: false });
    assert.equal(f.controller.getNavigationMode(), 'standard');
    assert.equal(f.camera.lowerBetaLimit, f.camera.upperBetaLimit, '俯视模式应锁定 beta');

    focusArcRotateCameraViewOnBounds(f.controller, f.camera, f.engine, {
      center: { x: 8, y: 2, z: -5 },
      radiusMeters: 0.5,
    });
    assert.equal(f.controller.getNavigationMode(), 'orbit', '省略选项的场景聚焦应同步解除标准视角锁');
    f.scene.render();

    assert.equal(f.controller.getNavigationMode(), 'orbit', '场景聚焦后应解除标准视角锁');
    assert.equal(f.camera.beta, DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus.defaultBetaRadians);
    assert.deepEqual(f.camera.getTarget().asArray(), [8, 2, -5]);
    assert.equal(f.camera.radius, DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus.preferredRadiusMeters);
    assertCameraAtFortyFiveDegreeElevation(f.camera, f.camera.target);
  } finally {
    f.dispose();
  }
});

test('环境同步聚焦保留标准视角锁和当前观察方向', async () => {
  const { focusArcRotateCameraViewOnBounds } = await viteServer.ssrLoadModule(
    '/src/runtime/babylon/createEngine.ts',
  ) as typeof import('../../src/runtime/babylon/createEngine.ts');
  const f = fixture();
  try {
    f.scene.activeCamera = f.camera;
    f.controller.setCameraOrientation('front', { animate: false });
    const originalBeta = f.camera.beta;

    focusArcRotateCameraViewOnBounds(f.controller, f.camera, f.engine, {
      center: { x: 0, y: 2_800, z: 0 },
      radiusMeters: 3_700,
    }, {
      animate: false,
      maxRadiusMeters: Number.POSITIVE_INFINITY,
      useModelFocusAngle: false,
    });
    f.camera.getViewMatrix(true);

    assert.equal(f.controller.getNavigationMode(), 'standard');
    assert.equal(f.camera.beta, originalBeta, '环境聚焦不得覆盖当前观察方向');
    assert.deepEqual(f.camera.getTarget().asArray(), [0, 2_800, 0]);
    assert.ok(f.camera.radius > 5_000, '环境聚焦应保留完整取景距离');
  } finally {
    f.dispose();
  }
});

test('发布态同步聚焦立即从模型斜上方 45° 直视模型，距离不超过 3m', async () => {
  const { focusArcRotateCameraViewOnBounds } = await viteServer.ssrLoadModule(
    '/src/runtime/babylon/createEngine.ts',
  ) as typeof import('../../src/runtime/babylon/createEngine.ts');
  const f = fixture();
  const bounds = {
    center: { x: 8, y: 2.632455, z: -5 },
    radiusMeters: 11.53405,
  };
  const target = new Vector3(bounds.center.x, bounds.center.y, bounds.center.z);

  try {
    // 发布 Viewer 的 focusAsset 使用同一 viewport，必须同步进入模型聚焦位姿。
    focusArcRotateCameraViewOnBounds(f.controller, f.camera, f.engine, bounds, {
      animate: false,
    });
    f.camera.getViewMatrix(true);

    assert.equal(f.controller.getNavigationMode(), 'orbit');
    assert.deepEqual(f.camera.getTarget().asArray(), target.asArray());
    assert.equal(
      f.camera.beta,
      DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus.defaultBetaRadians,
      '发布后聚焦必须使用模型斜上方 45° 视角',
    );
    assert.ok(f.camera.position.y > target.y);
    assert.ok(
      Vector3.Distance(f.camera.position, target)
        <= DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.focus.maxRadiusMeters + 1e-6,
      '发布后模型聚焦距离不得超过 3m',
    );
    assertCameraLooksAtTarget(f.camera, target);
    assertCameraAtFortyFiveDegreeElevation(f.camera, target);
  } finally {
    f.dispose();
  }
});

test('非动画调用同步完成且不暂停相机控件', () => {
  const f = fixture();
  let completed = 0;
  try {
    f.controller.applyCameraPose({ alpha: 0.8, beta: 1.1, radius: 9, target: { x: 4, y: 5, z: 6 } }, {
      animate: false,
      durationMs: 450,
      onCompleted: () => { completed += 1; },
    });
    assert.equal(completed, 1);
    assert.deepEqual(f.counts(), { suspendCount: 0, resumeCount: 0 });
    assert.deepEqual(f.camera.getTarget().asArray(), [4, 5, 6]);
  } finally {
    f.dispose();
  }
});
