import React from 'react';
import { createRoot } from 'react-dom/client';
import { EngineStore } from '@babylonjs/core/Engines/engineStore';
import { SceneViewPanel } from '../../src/editor/panels/SceneViewPanel';
import { SceneOpeningAnimationPanel } from '../../src/editor/panels/SceneOpeningAnimationPanel';
import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument';
import { serializeScene } from '../../src/editor/project/SceneSerializer';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createOpeningPackageBinding } from '../../src/shared/opening/openingPackage';
import { createLocalEditorAssetUrl, installDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl';
import '../../src/styles/global.css';

const definition = await (await fetch('/__prismatic__/definition.json')).json();
const binding = createOpeningPackageBinding(definition, new URL('/__prismatic__/manifest.json', location.href).href, 'f'.repeat(64));
const warehouseUrl = createLocalEditorAssetUrl('fixture/warehouse.glb'), towerUrl = createLocalEditorAssetUrl('fixture/tower.glb');
installDeploymentAssetManifest({ [warehouseUrl]: new URL('/__prismatic__/warehouse.glb', location.href).href,
  [towerUrl]: new URL('/__prismatic__/tower.glb', location.href).href });
let imported = false;
Object.assign(window, { editorApi: {
  listProjectAssets: async () => ({ projectRoot: null, assets: [], skyboxes: [], localAssets: [], localSkyboxes: [] }),
  listCompositions: async () => [],
  listOpeningPackages: async () => ({ projectRoot: 'fixture', packages: imported ? [structuredClone(binding)] : [], warnings: [] }),
  importOpeningPackage: async () => { imported = true; return { projectRoot: 'fixture', canceled: false, package: structuredClone(binding), packages: [structuredClone(binding)], warnings: [] }; },
} });
const scene = createEmptySceneDocument('棱镜创生 · 环境模型验收'); scene.sceneSettings.shadows.enabled = false;
scene.sceneSettings.environment = {
  packagePath: 'fixture', lengthUnit: 'meter', unitScaleToMeters: 1, placementMode: 'scene-base',
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  visible: true, opacity: 1, activeVariantUrl: warehouseUrl,
  variants: [{ name: '仓库', sourcePath: 'fixture/warehouse.glb', sourceUrl: warehouseUrl },
    { name: '塔楼', sourcePath: 'fixture/tower.glb', sourceUrl: towerUrl }], displayName: '仓储环境夹具',
};
const reopen = (content: string) => useEditorStore.getState().loadSceneFromContent(content, 'prismatic.scene.json');
reopen(serializeScene(scene));
createRoot(document.getElementById('root')!).render(<main style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 400px', height: '100vh' }}>
  <SceneViewPanel />
  <aside className="panel inspector-panel" style={{ overflow: 'auto', padding: 16 }}><SceneOpeningAnimationPanel /></aside>
</main>);
const businessScene = () => EngineStore.Instances.flatMap(engine => engine.scenes).find(s => s.meshes.some(m => m.metadata?.editorEnvironmentMesh));
let probeFrames = 0, stopProbe = () => {};
Object.assign(window, { prismaticHarness: {
  save: () => serializeScene(useEditorStore.getState().scene), reopen,
  environmentReady: () => useEditorStore.getState().environmentRuntimeSnapshot.phase === 'ready'
    && !!businessScene()?.meshes.some(mesh => mesh.metadata?.editorEnvironmentMesh && mesh.isEnabled()),
  startProbe() {
    stopProbe(); const business = businessScene()!;
    const camera = business.activeCamera as import('@babylonjs/core').ArcRotateCamera;
    const observer = business.onBeforeRenderObservable.add(() => { probeFrames++; camera.alpha += .001; });
    stopProbe = () => business.onBeforeRenderObservable.remove(observer);
  },
  state() {
    const business = businessScene()!;
    return { frames: probeFrames, alpha: (business.activeCamera as import('@babylonjs/core').ArcRotateCamera).alpha,
      models: business.meshes.filter(mesh => mesh.metadata?.editorEnvironmentMesh).map(mesh => ({ name: mesh.name,
        material: mesh.material?.uniqueId, world: mesh.getWorldMatrix().asArray(), visible: mesh.isVisible, enabled: mesh.isEnabled() })),
      engines: EngineStore.Instances.length };
  },
  switchEnvironment(kind: 'tower' | 'missing') {
    const current = structuredClone(useEditorStore.getState().scene);
    if (kind === 'missing') current.sceneSettings.environment = null;
    else current.sceneSettings.environment!.activeVariantUrl = towerUrl;
    reopen(serializeScene(current));
  },
  dispose: () => stopProbe(),
} });
