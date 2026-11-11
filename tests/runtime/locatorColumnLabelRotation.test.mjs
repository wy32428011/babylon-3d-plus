import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const projectRoot = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(projectRoot.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(projectRoot.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return {
      format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';',
    };
    if (url.startsWith(projectRoot.href) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { createLocatorEntity } = await import('../../src/editor/model/SceneDocument.ts');
hooks.deregister();

function labelWorldPosition(label) {
  label.mesh.computeWorldMatrix(true);
  return label.mesh.getWorldMatrix().getTranslation();
}

test('内置货格顶部列号随宿主旋转，原地更新步距后仍使用旋转后的定位锚点', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -10), scene);
  const previousOffscreenCanvas = globalThis.OffscreenCanvas;
  const originalCreateCanvas = engine.createCanvas.bind(engine);
  globalThis.OffscreenCanvas = class {};
  engine.createCanvas = (width, height) => ({
    width,
    height,
    getContext: () => ({ fillText() {} }),
    remove() {},
  });
  const runtime = new SceneRuntime(scene);
  t.after(() => {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
    engine.createCanvas = originalCreateCanvas;
    if (previousOffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousOffscreenCanvas;
  });

  const entity = createLocatorEntity();
  entity.components.locator.columns = 2;
  const entry = runtime.locators.createLocator(entity.id, entity.components.locator, { columnStepX: 2, layerStepY: 1 });
  assert.equal(entry.columnLabels.length, 2);

  const host = new TransformNode('rotated-rack', scene);
  host.position.set(10, 0, 20);
  entry.root.parent = host;
  entry.root.position.set(1, 0, 3);

  const firstBefore = labelWorldPosition(entry.columnLabels[0]);
  const secondBefore = labelWorldPosition(entry.columnLabels[1]);
  assert.ok(Math.abs(secondBefore.x - firstBefore.x - 2) < 1e-6);

  host.rotation.y = Math.PI;
  const firstAfter = labelWorldPosition(entry.columnLabels[0]);
  const secondAfter = labelWorldPosition(entry.columnLabels[1]);
  assert.ok(Math.abs(secondAfter.x - firstAfter.x + 2) < 1e-6, 'Y 轴旋转 180° 后列号偏移必须反向');
  assert.ok(Math.abs(secondAfter.z - firstAfter.z) < 1e-6);

  runtime.locators.syncLocatorColumnLabelsInPlace(entity.components.locator, { columnStepX: 3, layerStepY: 1 }, entry.columnLabels);
  const firstUpdated = labelWorldPosition(entry.columnLabels[0]);
  const secondUpdated = labelWorldPosition(entry.columnLabels[1]);
  assert.ok(Math.abs(secondUpdated.x - firstUpdated.x + 3) < 1e-6, '更新列步距时必须更新定位锚点而非 billboard 自身偏移');
});
