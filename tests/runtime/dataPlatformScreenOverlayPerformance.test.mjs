import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';
import * as babylon from '@babylonjs/core';
const { FreeCamera, Matrix, MeshBuilder, NullEngine, Scene, Vector3 } = babylon;
const require = createRequire(import.meta.url);
const source = await readFile(process.env.OVERLAY_PERF_SOURCE ?? new URL('../../src/runtime/babylon/DataPlatformScreenOverlay.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const exports = {};
new vm.Script(`(function(require,exports){${compiled}\n})`).runInThisContext()((id) => {
  if (id === '@babylonjs/core') return babylon;
  if (id === 'react' || id === 'react/jsx-runtime') return require(id);
  // 本测试只走旧大屏平面路径；三维立标遮挡由已有真实浏览器集成测试覆盖。
  if (id === './chartMarkerVisibility') return { getVisibleChartMarkerPolygons: () => new Map() };
  if (id === '../../shared/chartMarkerEmbed') return { CHART_MARKER_REFRESH_EVENT: 'chart-marker-refresh' };
  return {};
}, exports);
const { DataPlatformScreenOverlay, createCssProjectiveMatrix } = exports;

/** 仅替代 DOM 与 React 挂载；被测更新仍由真实组件注册的 Babylon Observable 驱动。 */
function mountOverlay(items, scene) {
  const counts = { rectReads: 0, styleWrites: 0, allocatingMathCalls: 0 };
  const rectangle = { left: 12, top: 20, width: 800, height: 600 };
  const rootRectangle = { left: 4, top: 8, width: 800, height: 600 };
  class Element {
    children = [];
    dataset = {};
    listeners = new Map();
    style = new Proxy({}, { set(target, key, value) {
      counts.styleWrites++;
      target[key] = key === 'backgroundColor' && /^#[0-9a-f]{6}$/i.test(value)
        ? `rgb(${[1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16)).join(', ')})` : value;
      return true;
    } });
    append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    getBoundingClientRect() { counts.rectReads++; return this.rectangle; }
  }
  const canvas = new Element(); canvas.rectangle = rectangle;
  const root = new Element(); root.rectangle = rootRectangle;
  const windowStub = new Element();
  const previous = { window: globalThis.window, document: globalThis.document, React: globalThis.React };
  globalThis.window = windowStub;
  globalThis.document = { createElement: () => new Element() };
  globalThis.React = React;
  const effects = [];
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = internals.H;
  internals.H = { useRef: current => ({ current }), useEffect: callback => effects.push(callback) };
  let view;
  try { view = DataPlatformScreenOverlay({ scene, canvas, runtime: { getDataPlatformScreenOverlayItems: () => items } }); }
  finally { internals.H = dispatcher; }
  view.props.ref.current = root;
  const cleanups = effects.map(effect => effect());
  return {
    counts, rectangle, rootRectangle, root,
    hosts: () => root.children.map(clip => clip.children[0]),
    frame() {
      scene.updateTransformMatrix(true);
      counts.rectReads = counts.styleWrites = counts.allocatingMathCalls = 0;
      const methods = [[Vector3, 'Lerp'], [Vector3, 'TransformCoordinates'], [Vector3, 'Project'], [Matrix, 'Identity']];
      const originals = methods.map(([owner, key]) => owner[key]);
      methods.forEach(([owner, key], index) => {
        owner[key] = function (...args) { counts.allocatingMathCalls++; return originals[index].apply(this, args); };
      });
      try { scene.onBeforeCameraRenderObservable.notifyObservers(scene.activeCamera); }
      finally { methods.forEach(([owner, key], index) => { owner[key] = originals[index]; }); }
      return { ...counts };
    },
    dispose() {
      for (const cleanup of cleanups.reverse()) cleanup?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
}

function expectedTransform(mesh, scene, canvasRect, rootRect, width, height) {
  const engine = scene.getEngine();
  const viewport = scene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => {
    const world = Vector3.TransformCoordinates(new Vector3(x, 0, z), mesh.computeWorldMatrix(true));
    const point = Vector3.Project(world, Matrix.Identity(), scene.getTransformMatrix(), viewport);
    return { x: canvasRect.left - rootRect.left + point.x / engine.getRenderWidth() * canvasRect.width,
      y: canvasRect.top - rootRect.top + point.y / engine.getRenderHeight() * canvasRect.height };
  });
  return createCssProjectiveMatrix(width, height, points);
}

test('大屏真实帧更新复用投影环境，静止帧不重复写样式，并保留运动、尺寸和清理语义', () => {
  const engine = new NullEngine({ renderWidth: 800, renderHeight: 600 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 5, -9), scene);
  camera.setTarget(Vector3.Zero()); camera.minZ = 0.1; scene.updateTransformMatrix(true);
  const items = Array.from({ length: 120 }, (_, index) => {
    const mesh = MeshBuilder.CreateGround('screen-' + index, { width: 2, height: 2 }, scene);
    mesh.position.x = (index % 5 - 2) * 0.3;
    return { entityId: mesh.name, mesh, name: mesh.name,
      markerStyle: { contentType: 'screen', panelShape: 'plane', width: 320, height: 180,
        backgroundColor: '#102030', appearanceColor: '#506070' } };
  });
  const fixture = mountOverlay(items, scene);
  try {
    fixture.frame();
    const stable = fixture.frame();
    assert.equal(fixture.hosts().length, 120, '不裁减或限制标签数量');
    const host = fixture.hosts()[0];
    assert.equal(host.style.transform, expectedTransform(items[0].mesh, scene, fixture.rectangle, fixture.rootRectangle, 1920, 1080));
    console.log(JSON.stringify({ overlayFrame: '120 unchanged screens', ...stable }));
    if (process.env.OVERLAY_PERF_BASELINE !== '1') {
      assert.equal(stable.rectReads, 2, '同一更新只读取画布和叠加根节点各一次');
      assert.equal(stable.styleWrites, 0, '未变化帧不重写样式');
      assert.equal(stable.allocatingMathCalls, 0, '投影不再逐角调用创建 Vector3/Matrix 的数学 API');
    }
    const beforeMove = host.style.transform;
    items[0].mesh.position.x += 0.6;
    fixture.frame();
    assert.notEqual(host.style.transform, beforeMove, '相机静止时对象运动仍逐帧投影');
    assert.equal(host.style.transform, expectedTransform(items[0].mesh, scene, fixture.rectangle, fixture.rootRectangle, 1920, 1080));
    const beforeCamera = host.style.transform;
    camera.position.x += 0.8; camera.setTarget(Vector3.Zero()); fixture.frame();
    assert.notEqual(host.style.transform, beforeCamera, '相机移动仍逐帧投影');
    fixture.rectangle.width = 640; fixture.rectangle.left += 6; fixture.rootRectangle.top += 4;
    items[0].markerStyle.width = 400; items[0].markerStyle.backgroundColor = '#ff0088'; fixture.frame();
    assert.equal(host.style.width, '2400px');
    assert.equal(host.style.backgroundColor, 'rgb(255, 0, 136)');
    assert.equal(host.style.transform, expectedTransform(items[0].mesh, scene, fixture.rectangle, fixture.rootRectangle, 2400, 1080));
    host.style.backgroundColor = '#000000'; fixture.frame();
    assert.equal(host.style.backgroundColor, 'rgb(255, 0, 136)', '外部样式修改仍在下一帧按配置纠正');
    items[0].mesh.position.z = -200; fixture.frame();
    assert.equal(host.style.display, 'none', '相机后方仍隐藏');
    items[0].mesh.position.z = 0; fixture.frame(); assert.equal(host.style.display, 'block');
    items.splice(0, 120); fixture.frame(); assert.equal(fixture.hosts().length, 0, '删除实体释放全部叠加节点');
    fixture.dispose();
    assert.equal(scene.onBeforeCameraRenderObservable.observers.filter(observer => !observer._willBeUnregistered).length, 0);
  } finally {
    if (globalThis.window) fixture.dispose();
    scene.dispose(); engine.dispose();
  }
});
