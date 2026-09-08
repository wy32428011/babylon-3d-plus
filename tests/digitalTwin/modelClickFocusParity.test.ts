import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { ArcRotateCamera, Camera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import ts from 'typescript';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
after(() => server.close());
const { focusArcRotateCameraViewOnBounds } = await server.ssrLoadModule('/src/runtime/babylon/createEngine.ts');
const { ArcRotateCameraViewController } = await server.ssrLoadModule('/src/runtime/babylon/ArcRotateCameraViewController.ts');
const { CLICK_EVENT_FOCUS_DURATION_MS, CLICK_EVENT_FOCUS_RADIUS_SCALE } = await server.ssrLoadModule('/src/editor/model/clickEventBinding.ts');

/** 从实际 UI 入口提取调用，避免测试另写一份聚焦参数而漏掉入口回归。 */
function getFocusOptions(entry: 'preview' | 'viewer', cell = false) {
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
  const bounds = { center: { x: 8, y: 6, z: -5 }, radiusMeters: 12 };
  const runtime = { getEntitiesWorldBounds: () => bounds, getLocatorCellWorldBounds: () => bounds };
  const viewport = { focusOnBounds: (_bounds: unknown, options: unknown) => { captured = options; } };
  const js = ts.transpile(`return ${expression}`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
  const result = new Function('runtime', 'viewport', 'cell', 'CLICK_EVENT_FOCUS_DURATION_MS', 'CLICK_EVENT_FOCUS_RADIUS_SCALE', js)(
    runtime, viewport, cell ? { row: 1, column: 1, layer: 1 } : undefined,
    CLICK_EVENT_FOCUS_DURATION_MS, CLICK_EVENT_FOCUS_RADIUS_SCALE,
  );
  return entry === 'preview' ? result : captured;
}

for (const entry of ['preview', 'viewer'] as const) {
  for (const orthographic of [false, true]) {
    test(`${entry} 点击高大堆垛机：${orthographic ? '正交' : '透视'}聚焦终点与编辑模式一致`, () => {
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
