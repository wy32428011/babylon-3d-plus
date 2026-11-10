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
function getClickSource(entry: 'preview' | 'viewer') {
  let sourcePath = 'src/player/PlayerApp.tsx';
  if (entry === 'preview') {
    const panelPath = 'src/editor/panels/SceneViewPanel.tsx';
    const panelText = readFileSync(panelPath, 'utf8');
    const panel = ts.createSourceFile(panelPath, panelText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hookImport = panel.statements.find(node => ts.isImportDeclaration(node)
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(binding => binding.name.text === 'useSceneSelectionHandlers'));
    assert.ok(hookImport && ts.isImportDeclaration(hookImport) && ts.isStringLiteral(hookImport.moduleSpecifier), '预览拾取 Hook 必须由真实面板导入');
    assert.match(panelText, /const \{[^}]*handleCanvasPointerUp[^}]*\} = useSceneSelectionHandlers\(/);
    assert.match(panelText, /onPointerUp=\{handleCanvasPointerUp\}/, '实际 Canvas 必须消费此 Hook 的指针释放入口');
    sourcePath = path.resolve(path.dirname(panelPath), hookImport.moduleSpecifier.text + '.ts');
  }
  return ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function getFocusOptions(entry: 'preview' | 'viewer', cell = false, focusBounds?: unknown) {
  const source = getClickSource(entry);
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

test('堆垛机参考取景：对准下部机构、端面平视并使用8米上限，各入口一致', () => {
  const engine = new NullEngine({ renderWidth: 900, renderHeight: 540 });
  const scene = new Scene(engine);
  const bounds = { center: { x: 0, y: 6, z: 0 }, radiusMeters: 6.4,
    focusView: { target: { x: 0, y: 2.8, z: 0 }, alpha: Math.PI / 2, beta: Math.PI / 2, maxRadiusMeters: 8 } };
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
        assert.ok(camera.target.y > 2 && camera.target.y < 3, '目标应落在下部梯笼中段');
        assert.equal(camera.beta, Math.PI / 2, '正向平视梯笼端面');
        assert.ok(camera.radius === 8, '端面取景留出梯笼与底座的观察距离');
        assert.ok(Math.abs(Math.atan2(Math.sin(camera.alpha - bounds.focusView.alpha), Math.cos(camera.alpha - bounds.focusView.alpha))) < 1e-6, '保持模型正面方向，不增加水平偏转');
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

/** 执行源码分支/鼠标回调，保留漫游状态的读取时机。 */
function getClickCallback(entry: 'preview' | 'viewer', scope: Record<string, unknown>) {
  const source = getClickSource(entry);
  const matches: string[] = [];
  function visit(node: ts.Node) {
    if (entry === 'preview' && ts.isIfStatement(node)
      && node.expression.getText(source) === "resolution.kind === 'trigger-cell'") {
      matches.push(`(resolution) => { ${node.getText(source)} }`);
    }
    if (entry === 'viewer' && ts.isCallExpression(node)
      && node.expression.getText(source) === 'bindSceneModelSelectionPointer') {
      const options = node.arguments[1];
      assert.ok(options && ts.isObjectLiteralExpression(options));
      const callback = options.properties.find(property => ts.isPropertyAssignment(property)
        && property.name.getText(source) === 'onSelectionClick');
      assert.ok(callback && ts.isPropertyAssignment(callback));
      matches.push(callback.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `${entry} 应有唯一真实点击入口`);
  return new Function(...Object.keys(scope), ts.transpile(`return (${matches[0]})`, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }))(...Object.values(scope));
}

for (const target of ['model', 'cell', 'generated'] as const) {
  test(`预览 ${target} 点击在同一分支读取当前漫游状态，仅禁止聚焦`, () => {
    const entityId = target === 'generated' ? 'spawned:1' : 'model';
    const cell = { row: 2, column: 3, layer: 1 };
    const bounds = { center: { x: 1, y: 2, z: 3 }, radiusMeters: 4 };
    const highlights: unknown[] = [];
    const focuses: unknown[] = [];
    const disabled: boolean[] = [];
    let enabled = false;
    const roam = { getSnapshot: () => ({ enabled }), setEnabled: (value: boolean) => disabled.push(value) };
    const manualRoamRef: { current: typeof roam | undefined } = { current: undefined };
    const click = getClickCallback('preview', {
      manualRoamRef,
      runtimeRef: { current: {
        setLocalSlotHighlight: (id: string, value: unknown) => { if (value) highlights.push({ id, cell: value }); },
        setLocalHighlightEntityIds: (ids: string[]) => { if (ids.length) highlights.push(ids); },
        setClickHighlightTrackExclusion: () => {},
        getLocatorCellWorldBounds: () => bounds,
        getEntitiesFocusBounds: () => bounds,
      } },
      viewportRef: { current: { focusOnBounds: (value: unknown) => focuses.push(value) } },
      clickProductHighlightIdRef: { current: null },
      state: {
        scene: { entities: { model: {} } },
        setEnvironmentAdjustmentActive: () => {},
        selectEntity: (id: string | null) => { if (id) highlights.push([id]); },
        requestSceneFocusForSelection: (ids: string[]) => focuses.push(ids),
      },
      CLICK_EVENT_FOCUS_DURATION_MS, CLICK_EVENT_FOCUS_RADIUS_SCALE,
    });
    for (const state of [undefined, false, true, false, true, undefined]) {
      enabled = state ?? false;
      manualRoamRef.current = state === undefined ? undefined : roam;
      highlights.length = focuses.length = disabled.length = 0;
      click({ kind: target === 'cell' ? 'trigger-cell' : 'trigger', entityId,
        locatorEntityId: 'locator', cell, effects: ['highlight', 'focus', 'show-chart'] });
      assert.deepEqual(highlights, target === 'cell' ? [{ id: 'locator', cell }] : [[entityId]]);
      assert.deepEqual(focuses, state === true ? [] : [target === 'model' ? [entityId] : bounds],
        `enabled=${state} 时仅非漫游点击可聚焦`);
      assert.deepEqual(disabled, state === false && target !== 'model' ? [false] : [],
        '漫游中的点击不能关闭漫游');
    }
  });

  test(`Viewer ${target} 真实鼠标回调读取最新漫游状态并保留拾取结果`, () => {
    const cell = { locatorEntityId: 'locator', row: 2, column: 3, layer: 1 };
    const generatedUnit = { bindingEntityId: 'generator', highlightEntityId: 'spawned:1' };
    for (const hasRuntime of [false, true]) {
      let enabled = false;
      const calls: unknown[][] = [];
      const click = getClickCallback('viewer', {
        disposed: false, canvas: {}, pauseHistoryReplay: () => {},
        chartMarkerClickRef: { current: null },
        manualRoam: hasRuntime ? { getSnapshot: () => ({ enabled }) } : undefined,
        runtime: {
          pickChartMarkerClickAtCanvasPoint: () => null,
          pickRuntimeModelHitAtCanvasPoint: () => ({ entityId: 'model', precise: true, distance: 3 }),
          pickBuiltInSlotCellAtCanvasPoint: () => target === 'cell' ? { ...cell, hostEntityId: 'model', distance: 2 } : null,
          pickGeneratedUnitClickTargetAtCanvasPoint: () => target === 'generated' ? { hit: generatedUnit, distance: 1 } : null,
        },
        handleModelClick: (...args: unknown[]) => calls.push(args),
      });
      for (enabled of [false, true, false, true]) {
        calls.length = 0;
        click({ clientX: 10, clientY: 20 });
        assert.deepEqual(calls, [['model', target === 'cell' ? cell : null, {
          generatedUnit: target === 'generated' ? generatedUnit : null,
          focus: !hasRuntime || !enabled,
        }]]);
      }
    }
  });
}
