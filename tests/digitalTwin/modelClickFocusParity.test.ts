import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { ArcRotateCamera, Camera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import ts from 'typescript';
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 预编译相机模块图，避免按需 SSR 启动延迟掩盖聚焦断言。
const output = await mkdtemp(path.resolve('node_modules/.focus-parity-'));
after(async () => {
  assert.equal(path.dirname(output), path.resolve('node_modules'));
  assert.ok(path.basename(output).startsWith('.focus-parity-'));
  await rm(output, { recursive: true, force: true });
});
await build({ configFile: false, logLevel: 'error', build: { ssr: true, outDir: output,
  rollupOptions: { input: {
    engine: 'src/runtime/babylon/createEngine.ts',
    controller: 'src/runtime/babylon/ArcRotateCameraViewController.ts',
    click: 'src/editor/model/clickEventBinding.ts',
  }, output: { entryFileNames: '[name].mjs' } },
} });
const [{ focusArcRotateCameraViewOnBounds }, { ArcRotateCameraViewController },
  { CLICK_EVENT_FOCUS_DURATION_MS, CLICK_EVENT_FOCUS_RADIUS_SCALE }] = await Promise.all(
  ['engine', 'controller', 'click'].map(name => import(pathToFileURL(path.join(output, name + '.mjs')).href)),
);

/** 从实际 UI 入口提取调用，避免测试另写一份聚焦参数而漏掉入口回归。 */
function getFocusOptions(entry: 'preview' | 'viewer', cell = false, focusBounds?: unknown) {
  const path = entry === 'preview' ? 'src/editor/panels/SceneViewPanel.tsx' : 'src/player/PlayerApp.tsx';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: string | undefined;
  function visit(node: ts.Node) {
    if (entry === 'preview' && ts.isCallExpression(node)
      && node.expression.getText(source) === 'state.requestSceneFocusForSelection'
      && node.arguments[0]?.getText(source) === '[resolution.entityId]') {
      expression = `(${node.arguments[1].getText(source)})`;
    }
    if (entry === 'viewer' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'focusTarget') {
      expression = `(${node.initializer.getText(source)})('stacker', cell)`;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `${entry} 聚焦入口应存在`);
  let captured: unknown;
  const bounds = focusBounds ?? { center: { x: 8, y: 6, z: -5 }, radiusMeters: 12 };
  const runtime = { getEntitiesFocusBounds: () => bounds, getLocatorCellWorldBounds: () => bounds };
  const viewport = { focusOnBounds: (received: unknown, options: unknown) => {
    if (focusBounds) assert.equal(received, focusBounds, 'Viewer 必须把专用取景信息一并传给相机');
    captured = options;
  } };
  const js = ts.transpile(`return ${expression}`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
  const result = new Function('runtime', 'viewport', 'cell', 'CLICK_EVENT_FOCUS_DURATION_MS', 'CLICK_EVENT_FOCUS_RADIUS_SCALE', js)(
    runtime, viewport, cell ? { row: 1, column: 1, layer: 1 } : undefined,
    CLICK_EVENT_FOCUS_DURATION_MS, CLICK_EVENT_FOCUS_RADIUS_SCALE,
  );
  return entry === 'preview' ? result : captured;
}

for (const entry of ['preview', 'viewer'] as const) {
  for (const orthographic of [false, true]) {
    test(`${entry} 未识别机身的模型：${orthographic ? '正交' : '透视'}聚焦终点与编辑模式一致`, () => {
      const engine = new NullEngine({ renderWidth: 800, renderHeight: 600 });
      const scene = new Scene(engine);
      let now = 0;
      const cameras = [0, 1].map((index) => new ArcRotateCamera(`camera-${index}`, 0.5, 1, 80, Vector3.Zero(), scene));
      const controllers = cameras.map((camera) => new ArcRotateCameraViewController(camera, engine, scene, {
        now: () => now, prefersReducedMotion: () => false,
      }));
      try {
        if (orthographic) cameras.forEach((camera) => { camera.mode = Camera.ORTHOGRAPHIC_CAMERA; });
        const bounds = { center: { x: 8, y: 6, z: -5 }, radiusMeters: 12 };
        focusArcRotateCameraViewOnBounds(controllers[0], cameras[0], engine, bounds);
        const options = getFocusOptions(entry);
        assert.equal(options.animate, true);
        assert.equal(options.durationMs, CLICK_EVENT_FOCUS_DURATION_MS);
        focusArcRotateCameraViewOnBounds(controllers[1], cameras[1], engine, bounds, options);
        scene.activeCamera = cameras[1];
        now = CLICK_EVENT_FOCUS_DURATION_MS;
        scene.render();
        assert.ok(Math.abs(cameras[1].radius - cameras[0].radius) < 1e-6,
          `运行聚焦距离 ${cameras[1].radius}m 应等于编辑聚焦距离 ${cameras[0].radius}m`);
        assert.ok(Math.abs(cameras[1].beta - cameras[0].beta) < 1e-6);
        assert.equal(cameras[1].alpha, cameras[0].alpha);
        assert.deepEqual(cameras[1].target.asArray(), cameras[0].target.asArray());
      } finally {
        controllers.forEach((controller) => controller.dispose());
        scene.dispose();
        engine.dispose();
      }
    });
  }
}

test('发布 Viewer 的货格点击继续保留单格取景方向和距离倍率', () => {
  const options = getFocusOptions('viewer', true);
  assert.equal(options.useModelFocusAngle, false);
  assert.equal(options.radiusScale, CLICK_EVENT_FOCUS_RADIUS_SCALE);
});

test('堆垛机参考取景：对准下部机构、接近平视并使用5米上限，各入口一致', () => {
  const engine = new NullEngine({ renderWidth: 900, renderHeight: 540 });
  const scene = new Scene(engine);
  const bounds = { center: { x: 0, y: 6, z: 0 }, radiusMeters: 6.4,
    focusView: { target: { x: 0, y: 1.2, z: 0 }, alpha: -Math.PI * 100 / 180, beta: Math.PI * 85 / 180, maxRadiusMeters: 5 } };
  let expected: number[] | undefined;
  try {
    for (const entry of ['editor', 'preview', 'viewer'] as const) {
      const camera = new ArcRotateCamera(entry, 2, 0.3, 80, Vector3.Zero(), scene);
      let now = 0;
      const controller = new ArcRotateCameraViewController(camera, engine, scene, { now: () => now, prefersReducedMotion: () => false });
      try {
        const options = entry === 'editor' ? undefined : getFocusOptions(entry, false, bounds);
        focusArcRotateCameraViewOnBounds(controller, camera, engine, bounds, options);
        now = CLICK_EVENT_FOCUS_DURATION_MS;
        scene.activeCamera = camera; scene.render();
        assert.ok(camera.target.y > 0.5 && camera.target.y < 2, '目标应下移到载货台和底座上方');
        assert.ok(camera.beta > Math.PI * 0.44 && camera.beta < Math.PI / 2, '采用小俯角，避免45度俯视');
        assert.ok(camera.radius === 5, '高机身的下部取景使用5米上限');
        assert.ok(Math.abs(Math.atan2(Math.sin(camera.alpha - bounds.focusView.alpha), Math.cos(camera.alpha - bounds.focusView.alpha))) < 1e-6, '从模型侧面轻微斜看');
        const pose = [...camera.target.asArray(), camera.alpha, camera.beta, camera.radius];
        if (expected) {
          for (let i = 0; i < pose.length; i++) {
            const delta = pose[i] - expected[i];
            assert.ok(Math.abs(i === 3 ? Math.atan2(Math.sin(delta), Math.cos(delta)) : delta) < 1e-6);
          }
        } else expected = pose;
      } finally { controller.dispose(); }
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test('正交和显式保留方向的聚焦不应用堆垛机透视角度，显式距离上限继续生效', () => {
  const engine = new NullEngine({ renderWidth: 800, renderHeight: 600 });
  const scene = new Scene(engine);
  const bounds = { center: { x: 0, y: 6, z: 0 }, radiusMeters: 7,
    focusView: { target: { x: 0, y: 1.2, z: 0 }, alpha: -1.8, beta: 1.48, maxRadiusMeters: 5 } };
  try {
    for (const mode of ['orthographic', 'preserve', 'perspective'] as const) {
      const camera = new ArcRotateCamera(mode, 0.5, 1, 50, Vector3.Zero(), scene);
      const controller = new ArcRotateCameraViewController(camera, engine, scene);
      try {
        if (mode === 'orthographic') controller.setCameraProjection('orthographic');
        focusArcRotateCameraViewOnBounds(controller, camera, engine, bounds, {
          animate: false, maxRadiusMeters: 2.6, ...(mode === 'preserve' ? { useModelFocusAngle: false } : {}),
        });
        assert.ok(camera.radius <= 2.6);
        if (mode !== 'perspective') {
          assert.equal(camera.alpha, 0.5); assert.equal(camera.beta, 1);
          assert.deepEqual(camera.target.asArray(), [0, 6, 0]);
        } else assert.deepEqual(camera.target.asArray(), [0, 1.2, 0]);
      } finally { controller.dispose(); }
    }
  } finally { scene.dispose(); engine.dispose(); }
});
