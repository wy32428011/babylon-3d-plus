import React from 'react';
import { createRoot } from 'react-dom/client';
import { SceneOpeningAnimationPanel } from '../../src/editor/panels/SceneOpeningAnimationPanel';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { ProjectPanel } from '../../src/editor/panels/ProjectPanel';
import { getScenePreparationSnapshot } from '../../src/editor/loading/scenePreparationProgress';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { createOpeningPackageBinding, validateOpeningPackageDefinition } from '../../src/shared/opening/openingPackage';
import '../../src/styles/global.css';

const mapBytes = await (await fetch('/__opening_pkg__/assets/map.svg')).arrayBuffer();
const mapHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', mapBytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const definition = validateOpeningPackageDefinition({
  manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'test.brand-campus', version: '1.0.0', name: '品牌与园区', renderer: 'timeline',
    assets: [{ id: 'map', path: 'assets/map.svg', type: 'image', size: mapBytes.byteLength, sha256: mapHash }] },
  schema: { type: 'object', properties: { title: { type: 'string', title: '公司标题', format: 'multiline' }, show: { type: 'boolean', title: '显示标识' },
    count: { type: 'number', title: '计数参数', minimum: 0, maximum: 100 }, tint: { type: 'string', format: 'color', title: '品牌色' },
    map: { type: 'string', format: 'asset', title: '园区底图' } } },
  uiSchema: { groups: [{ title: '品牌配置', fields: ['title', 'show', 'count', 'tint', 'map'] }] },
  defaults: { title: '智慧园区', show: true, count: 10, tint: '#55d9ff', map: 'map' },
  timeline: { stages: [
    { id: 'brand', label: '品牌亮相', durationSeconds: 2, titleKey: 'title', backgroundKey: 'map', routes: [] },
    { id: 'campus', label: '园区飞线', durationSeconds: 4, title: '连接每一个现场', backgroundAssetId: 'map', routes: [
      { id: 'route-one', name: '一号仓库', from: { x: .2, y: .65 }, to: { x: .72, y: .32 } },
    ] },
    { id: 'handoff', label: '进入场景', durationSeconds: 2, title: '进入数字孪生', routes: [] },
  ] },
});
const original = createOpeningPackageBinding(definition, new URL('/__opening_pkg__/manifest.json', location.href).href, 'b'.repeat(64));
const upgradeDefinition = structuredClone(definition); upgradeDefinition.manifest.version = '1.1.0';
const upgrade = createOpeningPackageBinding(upgradeDefinition, original.manifestUrl, 'c'.repeat(64));
const otherDefinition = structuredClone(definition); otherDefinition.manifest.id = 'test.other'; otherDefinition.manifest.name = '另一套开场';
otherDefinition.timeline.stages = otherDefinition.timeline.stages.slice(0, 2);
const other = createOpeningPackageBinding(otherDefinition, original.manifestUrl, 'd'.repeat(64));
const tallBytes = await (await fetch('/__opening_pkg__/assets/ref-6.svg')).arrayBuffer();
const tallHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', tallBytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const referenceDefinition = validateOpeningPackageDefinition({
  manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'test.reference', version: '1.0.0', name: '参考整图 UV', renderer: 'reference-huishan',
    assets: Array.from({ length: 10 }, (_, index) => ({ id: `asset-${index + 1}`, path: `assets/ref-${index + 1}.svg`, type: 'image',
      size: index === 5 ? tallBytes.byteLength : mapBytes.byteLength, sha256: index === 5 ? tallHash : mapHash })) },
  schema: { type: 'object', properties: {} }, uiSchema: { groups: [] }, defaults: {},
  timeline: { stages: Array.from({ length: 9 }, (_, index) => ({ id: `reference-${index}`, label: `参考阶段 ${index + 1}`, durationSeconds: 2,
    backgroundAssetId: index === 5 ? 'asset-6' : 'asset-2', ...(index === 5 ? { routes: structuredClone(definition.timeline.stages[1].routes) } : {}) })) },
});
const reference = createOpeningPackageBinding(referenceDefinition, original.manifestUrl, '9'.repeat(64));
const packages = [original, upgrade, other, reference];
let deferImport = false;
let releaseImport: (() => void) | null = null;
Object.assign(window, { editorApi: {
  listProjectAssets: async () => ({ projectRoot: null, assets: [], skyboxes: [], localAssets: [], localSkyboxes: [] }),
  listCompositions: async () => [],
  listOpeningPackages: async () => ({ projectRoot: 'fixture', packages: structuredClone(packages), warnings: [] }),
  importOpeningPackage: async () => {
    if (deferImport) await new Promise<void>(resolve => { releaseImport = resolve; });
    return { projectRoot: 'fixture', canceled: false, package: structuredClone(original), packages: structuredClone(packages), warnings: [] };
  },
  exportOpeningPackage: async () => ({ canceled: false, filePath: 'fixture.dtopening' }),
  importOpeningAsset: async () => ({ canceled: false, assetUrl: new URL('/__opening_pkg__/assets/map.svg?replacement=1', location.href).href, size: mapBytes.byteLength, sha256: mapHash, filePath: 'fixture.svg' }),
} });
function reopen(content: string) { useEditorStore.getState().loadSceneFromContent(content, '开场包验收.scene.json'); }
function createScene(name = '场景 A') {
  const scene = createEmptySceneDocument(name); scene.sceneSettings.shadows.enabled = false;
  const mesh = createMeshEntity('cube', { x: 0, y: 1, z: 0 }); mesh.components.transform.scale = { x: 6, y: 2, z: 4 };
  scene.entities[mesh.id] = mesh; scene.entityIds.push(mesh.id); reopen(serializeScene(scene));
}
createScene();
createRoot(document.getElementById('root')!).render(<main style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 470px', height: '100vh' }}>
  <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) 90px', minHeight: 0 }}><SceneViewPanel /><ProjectPanel /></div>
  <aside className="panel inspector-panel" style={{ overflow: 'auto', padding: 18 }}><h2>开场包配置</h2><SceneOpeningAnimationPanel /></aside>
</main>);
Object.assign(window, { openingPackageHarness: {
  store: useEditorStore, original, packages, createScene, reopen, preparation: getScenePreparationSnapshot,
  save: () => serializeScene(useEditorStore.getState().scene),
  defer: () => { deferImport = true; }, release: () => { releaseImport?.(); deferImport = false; },
} });
