import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import {
  DEFAULT_LIGHTING_BAKE_SETTINGS,
  getSceneLightingBakeSignature,
  getSceneLightingBakeError,
  lightingContentHash,
  normalizeEntityLightingSettings,
  normalizeSceneLightingBakeSettings,
  validateSceneLightingBakeSnapshot,
} from '../../electron/shared/sceneLightingBakeContract.ts';

test('基础烘焙参数保持稳定默认值，配置迁移由统一光照合同负责', () => {
  assert.deepEqual(normalizeSceneLightingBakeSettings(null), DEFAULT_LIGHTING_BAKE_SETTINGS);
  assert.equal(normalizeSceneLightingBakeSettings({ atlasSize: 0 }).atlasSize, 2048);
  assert.equal(normalizeSceneLightingBakeSettings({ quality: 'high' }).quality, 'high');
});

test('摘要采用 JSON 的 undefined 语义，并保持数组顺序、空项及 typed array 等价', () => {
  const value = { optional: undefined, nested: { absent: undefined, value: 2 }, values: [undefined, null, 3] };
  assert.equal(lightingContentHash(value), lightingContentHash(JSON.parse(JSON.stringify(value))));
  assert.equal(lightingContentHash({ optional: undefined }), lightingContentHash({}));
  assert.equal(lightingContentHash([undefined]), lightingContentHash([null]));
  assert.equal(lightingContentHash(new Array(2)), lightingContentHash([null, null]));
  assert.notEqual(lightingContentHash([undefined]), lightingContentHash([]));
  assert.notEqual(lightingContentHash({ optional: null }), lightingContentHash({}));
  assert.equal(lightingContentHash(new Float32Array([0.125, 0.5])), lightingContentHash([0.125, 0.5]));
  assert.notEqual(lightingContentHash([1, 2]), lightingContentHash([2, 1]));
});

test('实际 SceneSerializer 保存重开不会因删除生成器留下的 undefined 误判 GI 过期', async () => {
  // 运行真实序列化模块；只将非代码图片导入映射为 URL，避免依赖浏览器或写入构建产物。
  const project = new URL('../../', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@babylonjs/') && specifier.split('/').length > 2 && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith(project) && !specifier.endsWith('.ts')) {
        const candidate = new URL(specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : `${specifier}.ts`, context.parentURL);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(project) && /\.(png|jpg|jpeg|svg|webp|glb)(\?.*)?$/i.test(url)) {
        return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
      }
      if (url.startsWith(project) && url.endsWith('.ts') && !url.includes('/node_modules/')) {
        return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText };
      }
      return next(url, context);
    },
  });
  try {
    const { createEmptySceneDocument, createMeshEntity } = await import('../../src/editor/model/SceneDocument.ts');
    const { serializeScene, deserializeScene } = await import('../../src/editor/project/SceneSerializer.ts');
    const { createDefaultTelemetryBinding } = await import('../../src/editor/model/telemetryBinding.ts');
    const scene = createEmptySceneDocument('光照签名往返回归');
    const entity = createMeshEntity('cube');
    entity.components.telemetryBinding = { ...createDefaultTelemetryBinding('rgv'), cargoGeneratorId: undefined };
    scene.entityIds = [entity.id]; scene.entities = { [entity.id]: entity };
    scene.sceneSettings.lighting = normalizeSceneLightingConfig(undefined);
    const signature = getSceneLightingBakeSignature(scene);
    scene.sceneSettings.lighting.result = validateSceneLightingBakeSnapshot({
      version: 1, signature, createdAt: '2026-10-20T00:00:00Z', engineVersion: '5.2',
      assets: [
        { id: 'g', kind: 'geometry', url: 'Assets/LightingBakes/job/g.json', byteLength: 100 },
        { id: 'l', kind: 'lightmap', url: 'Assets/LightingBakes/job/l.png', byteLength: 100 },
        { id: 'p', kind: 'probes', url: 'Assets/LightingBakes/job/p.json', byteLength: 100 },
      ],
      surfaces: [{ key: `${entity.id}/mesh`, entityId: entity.id, nodeKey: 'mesh', geometryAssetId: 'g', lightmapAssetId: 'l' }],
      probeAssetId: 'p',
      statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 16384, durationMs: 1000 },
    });
    assert.equal(Object.hasOwn(entity.components.telemetryBinding, 'cargoGeneratorId'), true);
    assert.equal(getSceneLightingBakeError(scene), null);
    const encoded = serializeScene(scene);
    const persisted = JSON.parse(encoded).scene;
    const reopened = deserializeScene(encoded);
    assert.equal(Object.hasOwn(persisted.entities[entity.id].components.telemetryBinding, 'cargoGeneratorId'), false);
    assert.equal(Object.hasOwn(reopened.entities[entity.id].components.telemetryBinding!, 'cargoGeneratorId'), false);
    assert.equal(getSceneLightingBakeSignature(persisted), signature, '发布读取的原始 JSON 必须保持签名');
    assert.equal(getSceneLightingBakeSignature(reopened), signature, '编辑器规范化重开必须保持签名');
    assert.equal(getSceneLightingBakeError(persisted), null);
    assert.equal(getSceneLightingBakeError(reopened), null);
    reopened.entities[entity.id].components.transform.position.x += 1;
    assert.notEqual(getSceneLightingBakeSignature(reopened), signature);
    assert.match(getSceneLightingBakeError(reopened)!, /已过期/);
    reopened.entities[entity.id].components.transform.position.x -= 1;
    reopened.entities[entity.id].components.meshRenderer!.materialColor = '#ff0000';
    assert.notEqual(getSceneLightingBakeSignature(reopened), signature);
    assert.match(getSceneLightingBakeError(reopened)!, /已过期/);
  } finally { hooks.deregister(); }
});

test('实体及子节点配置规范化，动态节点默认不参与静态间接光', () => {
  const value = normalizeEntityLightingSettings({
    mobility: 'dynamic',
    nodeOverrides: { 'model/rail[0]': { mobility: 'static', receiveShadows: false } },
  });
  assert.equal(value.mobility, 'dynamic');
  assert.equal(value.bakeIndirect, true, '参与设置保留，实际参与由有效静态身份共同决定');
  assert.equal(value.nodeOverrides['model/rail[0]']?.mobility, 'static');
  assert.equal(value.nodeOverrides['model/rail[0]']?.receiveShadows, false);
});

function document() {
  return {
    entityIds: ['wall', 'car', 'lamp'],
    entities: {
      wall: { id: 'wall', components: { transform: { position: { x: 0, y: 0, z: 0 } }, meshRenderer: { meshKind: 'cube' }, lighting: { mobility: 'static' } } },
      car: { id: 'car', components: { transform: { position: { x: 0, y: 0, z: 0 } }, meshRenderer: { meshKind: 'cube' }, lighting: { mobility: 'dynamic' } } },
      lamp: { id: 'lamp', components: { light: { lightKind: 'point', intensity: 1 }, transform: { position: { x: 1, y: 3, z: 1 } } } },
    },
    sceneSettings: { shadows: { mode: 'hybrid', sunAzimuthDegrees: 45 }, lightingBake: DEFAULT_LIGHTING_BAKE_SETTINGS },
  };
}

test('相机和动态实体的位置不使光照烘焙过期，静态几何与灯光改变使其过期', () => {
  const scene = document();
  const original = getSceneLightingBakeSignature(scene);
  scene.entities.car.components.transform.position.x = 12;
  assert.equal(getSceneLightingBakeSignature(scene), original);
  scene.entities.wall.components.transform.position.x = 4;
  assert.notEqual(getSceneLightingBakeSignature(scene), original);
  scene.entities.wall.components.transform.position.x = 0;
  scene.entities.lamp.components.light.intensity = 2;
  assert.notEqual(getSceneLightingBakeSignature(scene), original);
});

test('快照校验拒绝断开的几何和光照资产引用及非有限统计', () => {
  const base = {
    version: 1, signature: 'lighting-v1-test', createdAt: '2026-10-20T00:00:00Z', engineVersion: '5.2',
    assets: [
      { id: 'g', kind: 'geometry', url: 'Assets/LightingBakes/job/g.json', byteLength: 100 },
      { id: 'l', kind: 'lightmap', url: 'Assets/LightingBakes/job/l.png', byteLength: 100 },
      { id: 'p', kind: 'probes', url: 'Assets/LightingBakes/job/p.json', byteLength: 100 },
    ],
    surfaces: [{ key: 'wall/mesh', entityId: 'wall', nodeKey: 'mesh', geometryAssetId: 'g', lightmapAssetId: 'l' }],
    probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 16384, durationMs: 1000 },
  };
  assert.equal(validateSceneLightingBakeSnapshot(base)?.surfaces.length, 1);
  assert.equal(validateSceneLightingBakeSnapshot({ ...base, assets: base.assets.slice(0, 1) }), null);
  assert.equal(validateSceneLightingBakeSnapshot({ ...base, statistics: { ...base.statistics, textureBytes: Infinity } }), null);
  assert.equal(validateSceneLightingBakeSnapshot({ ...base, surfaces: [...base.surfaces, ...base.surfaces] }), null);
});
