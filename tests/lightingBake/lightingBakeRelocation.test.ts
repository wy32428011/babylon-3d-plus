import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { getSceneLightingConfig, migrateSceneLightingDocument } from '../../electron/shared/sceneLightingConfig.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
      const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
      if (!existsSync(target) && existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { captureSceneLightingBakeRelocation, restoreSceneLightingBakeAfterMappedRewrite } = await import('../../electron/shared/sceneLightingBakeRelocation.ts');
hooks.deregister();
const url = (value: string) => 'editor-asset://local/' + encodeURIComponent(value);

function fixture() {
  const scene: any = { entities: {
    fixed: { id: 'fixed', parentId: null, components: { transform: { position: { x: 1, y: 0, z: 0 } },
      modelAsset: { sourcePath: 'C:/old/Assets/Models/pump/model.glb', sourceUrl: url('C:/old/Assets/Models/pump/model.glb'), assetRevision: 'r1', parameterValues: { count: 3 } } } },
  }, sceneSettings: { shadows: { mode: 'hybrid', sunIntensity: 1 }, lightingBake: { enabled: true } } };
  const canonical = migrateSceneLightingDocument(scene);
  canonical.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(canonical), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'test',
    assets: [{ id: 'g', kind: 'geometry', url: url('C:/old/Assets/LightingBakes/job/mesh.json'), byteLength: 10, sha256: 'a'.repeat(64) },
      { id: 'l', kind: 'lightmap', url: url('C:/old/Assets/LightingBakes/job/map.png'), byteLength: 20, sha256: 'b'.repeat(64) },
      { id: 'p', kind: 'probes', url: url('C:/old/Assets/LightingBakes/job/probes.json'), byteLength: 30, sha256: 'c'.repeat(64) }],
    surfaces: [{ key: 'fixed/root', entityId: 'fixed', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 20, durationMs: 100 } };
  return canonical;
}
function move(value: unknown): any {
  if (typeof value === 'string') return value.replace('C:/old/', 'D:/new/').replace(encodeURIComponent('C:/old/'), encodeURIComponent('D:/new/'));
  if (Array.isArray(value)) return value.map(move);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, move(child)]));
  return value;
}
test('canonical结果按新位置迁移，纯外观变化不触发GI重签失败', () => {
  const source = migrateSceneLightingDocument(fixture()), target = move(source);
  target.sceneSettings.appearance.exposure = 2;
  const restore = captureSceneLightingBakeRelocation(source);
  assert.ok(restore);
  assert.equal(restore(target), true);
  assert.equal(target.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(target));
  assert.equal(Object.hasOwn(target.sceneSettings, 'lightingBakeResult'), false);
});
test('旧v1结果缺少实际填充输入戳，不能通过搬迁或发布把它重签成v2有效结果', () => {
  const source = fixture(); source.sceneSettings.lighting.result.signature = 'lighting-v1-unproven';
  const target = move(migrateSceneLightingDocument(source)), saved = JSON.stringify(target);
  assert.equal(captureSceneLightingBakeRelocation(source), null);
  assert.equal(restoreSceneLightingBakeAfterMappedRewrite(source, target, new Map()), false);
  assert.equal(getSceneLightingConfig(target).result?.signature, 'lighting-v1-unproven');
  assert.equal(JSON.stringify(target), saved);
});
test('纯工程位置变化同时保留三类独立资产及有效签名', () => {
  const source = fixture(), restore = captureSceneLightingBakeRelocation(source), target = move(source);
  assert.ok(restore);
  assert.equal(restore(target), true);
  assert.equal(target.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(target));
  assert.equal(target.sceneSettings.lighting.result.assets.length, 3);
});
test('过期结果不重新签名，静态参数、资源修订、光照、资产内容改变都拒绝迁移', () => {
  const stale = fixture(); stale.entities.fixed.components.transform.position.x++;
  assert.equal(captureSceneLightingBakeRelocation(stale), null);
  for (const mutate of [
    (scene: any) => { scene.entities.fixed.components.modelAsset.parameterValues.count++; },
    (scene: any) => { scene.entities.fixed.components.modelAsset.assetRevision = 'r2'; },
    (scene: any) => { scene.sceneSettings.lighting.main.intensity = 2; },
    (scene: any) => { scene.sceneSettings.lighting.result.assets[0].sha256 = 'd'.repeat(64); },
    (scene: any) => { scene.sceneSettings.lighting.result.surfaces[0].nodeKey = 'other'; },
  ]) {
    const source = fixture(), restore = captureSceneLightingBakeRelocation(source)!, target = move(source);
    mutate(target);
    const before = target.sceneSettings.lighting.result.signature;
    assert.equal(restore(target), false);
    assert.equal(target.sceneSettings.lighting.result.signature, before);
  }
});
test('普通参数文本不作为路径归一化，复制静态实体后旧结果失效', () => {
  const source = fixture(); source.entities.fixed.components.modelAsset.parameterValues.note = 'C:/old/Assets/Models/pump/model.glb';
  source.sceneSettings.lighting.result.signature = getSceneLightingBakeSignature(source);
  assert.equal(captureSceneLightingBakeRelocation(source)!(move(source)), false);
  const copy = structuredClone(source); copy.entities.copy = structuredClone(copy.entities.fixed); copy.entities.copy.id = 'copy';
  assert.equal(captureSceneLightingBakeRelocation(source)!(copy), false);
});
test('部署改名仅接受实际清单中的映射，不能用重写掩盖几何变更', () => {
  const source = fixture();
  source.entities.fixed.components.modelAsset.thumbnailUrl = url('C:/old/Assets/Models/pump/thumb.png');
  source.sceneSettings.lighting.result.signature = getSceneLightingBakeSignature(source);
  const mapping = new Map<string, string>();
  mapping.set(source.entities.fixed.components.modelAsset.sourcePath, url('project/assets/models/pump-hash/model.glb'));
  mapping.set(source.entities.fixed.components.modelAsset.sourceUrl, url('project/assets/models/pump-hash/model.glb'));
  for (const asset of source.sceneSettings.lighting.result.assets) mapping.set(asset.url, url('project/assets/lighting-bakes/job-hash/' + asset.id));
  const rewrite = (value: any): any => typeof value === 'string' ? mapping.get(value) ?? value
    : Array.isArray(value) ? value.map(rewrite)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)])) : value;
  const deployed = rewrite(source);
  delete deployed.entities.fixed.components.modelAsset.thumbnailUrl;
  assert.equal(restoreSceneLightingBakeAfterMappedRewrite(source, deployed, mapping), true);
  assert.equal(deployed.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(deployed));
  const changed = rewrite(source); changed.entities.fixed.components.transform.position.x++;
  assert.equal(restoreSceneLightingBakeAfterMappedRewrite(source, changed, mapping), false);
});
test('固定组合仅搬迁来源定位信息时保持等价，内容摘要改变仍拒绝', () => {
  const source = fixture();
  source.entities.fixed.components.modelAsset.sourceSnapshot = {
    composition: true, contentSha256: 'f'.repeat(64), compositionResource: { sourceKey: 'old-host', packagePath: 'C:/old/Assets/Compositions/42/7' },
  };
  source.sceneSettings.lighting.result.signature = getSceneLightingBakeSignature(source);
  const target = move(source);
  target.entities.fixed.components.modelAsset.sourceSnapshot.compositionResource.sourceKey = 'new-host';
  assert.equal(captureSceneLightingBakeRelocation(source)!(target), true);
  const changed = move(source);
  changed.entities.fixed.components.modelAsset.sourceSnapshot.contentSha256 = 'e'.repeat(64);
  assert.equal(captureSceneLightingBakeRelocation(source)!(changed), false);
});
