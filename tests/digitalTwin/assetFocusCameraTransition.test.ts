import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

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
