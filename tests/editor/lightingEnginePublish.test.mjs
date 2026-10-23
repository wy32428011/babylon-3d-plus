import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const project = new URL('../../', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/LightingBakeEngineDialog')) return { url: 'test:engine-dialog', shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const extension of ['.ts', '.tsx']) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:engine-dialog') return { format: 'module', shortCircuit: true, source: 'export function LightingBakeEngineDialog() { return null; }' };
    if (url.startsWith(project) && /\.tsx?$/.test(url) && !url.includes('/node_modules/')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText };
    }
    return next(url, context);
  },
});
after(() => hooks.deregister());
const { getLightingBakePublishRequirement, LightingBakePublishEngineCheck } = await import('../../src/editor/deployment/LightingBakePublishEngineCheck.tsx');
const { getSceneLightingBakeSignature } = await import('../../electron/shared/sceneLightingBakeContract.ts');
const { normalizeSceneLightingConfig } = await import('../../electron/shared/sceneLightingConfig.ts');

function sceneWithPendingBake() {
  return { entities: {}, entityIds: [], sceneSettings: { environment: { visible: true }, lighting: normalizeSceneLightingConfig(undefined) } };
}

test('需要生成或刷新光照的场景提供引擎检查，而没有静态表面或关闭烘焙时无需 Blender', () => {
  const scene = sceneWithPendingBake();
  assert.match(getLightingBakePublishRequirement(scene), /烘焙/);
  assert.equal(getLightingBakePublishRequirement({ ...scene, sceneSettings: { ...scene.sceneSettings, environment: undefined } }), null);
  scene.sceneSettings.lighting.bake.enabled = false;
  assert.equal(getLightingBakePublishRequirement(scene), null);
});

test('已有当前有效烘焙时不误要求 Blender，过期结果仍进入检查', () => {
  const scene = sceneWithPendingBake();
  scene.sceneSettings.lighting.result = {
    version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-23T00:00:00Z', engineVersion: '5.2',
    assets: [
      { id: 'g', kind: 'geometry', url: 'Assets/LightingBakes/job/g.json', byteLength: 100 },
      { id: 'l', kind: 'lightmap', url: 'Assets/LightingBakes/job/l.png', byteLength: 100 },
      { id: 'p', kind: 'probes', url: 'Assets/LightingBakes/job/p.json', byteLength: 100 },
    ],
    surfaces: [{ key: '$environment/mesh', entityId: '$environment', nodeKey: 'mesh', geometryAssetId: 'g', lightmapAssetId: 'l' }],
    probeAssetId: 'p', statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 16384, durationMs: 1000 },
  };
  assert.equal(getLightingBakePublishRequirement(scene), null);
  scene.sceneSettings.lighting.main.intensity += 1;
  assert.match(getLightingBakePublishRequirement(scene), /过期/);
});

test('其他场景或同步后的 Blender 失败也提供配置入口，普通发布错误不会误触发', () => {
  const scene = { entities: {}, sceneSettings: {} };
  assert.equal(getLightingBakePublishRequirement(scene, '资源同步失败'), null);
  assert.match(getLightingBakePublishRequirement(scene, 'Error invoking remote method lighting-bake:start: 未找到可用 Blender。'), /Blender/);
  const markup = renderToStaticMarkup(createElement(LightingBakePublishEngineCheck, { open: true, scene, error: '未找到可用 Blender。' }));
  assert.match(markup, /aria-label="发布检查"/);
  assert.match(markup, /配置 Blender…/);
  assert.match(markup, /重新检查引擎/);
});

test('普通和已烘焙发布不增加引擎检查 UI，关闭时不渲染', () => {
  assert.equal(renderToStaticMarkup(createElement(LightingBakePublishEngineCheck, { open: true, scene: { entities: {}, sceneSettings: {} } })), '');
  assert.equal(renderToStaticMarkup(createElement(LightingBakePublishEngineCheck, { open: false, scene: sceneWithPendingBake() })), '');
});

test('部署和中台发布共享配置补救入口，配置不重置发布表单或自动提交', async () => {
  for (const file of ['DeploymentExportDialog.tsx', 'DigitalTwinPublishDialog.tsx']) {
    const source = await readFile(new URL(`../../src/editor/deployment/${file}`, import.meta.url), 'utf8');
    assert.match(source, /<LightingBakePublishEngineCheck/);
    assert.match(source, /scene=\{scene\}/);
    assert.match(source, /error=\{state\.error\}/);
  }
  const source = await readFile(new URL('../../src/editor/deployment/LightingBakePublishEngineCheck.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /controller\.(start|reset)|requestLightingBake|publishDigitalTwin/);
  assert.match(source, /onSaved=\{handleSaved\}/);
});
