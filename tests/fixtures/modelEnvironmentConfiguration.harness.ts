import { ArcRotateCamera, Color3, Engine, HemisphericLight, MeshBuilder, PBRMaterial, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { TargetModelEffects } from '../../src/runtime/babylon/effects/TargetModelEffects';
import { createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect';
import type { EffectParameterValue } from '../../src/editor/model/effectConfiguration';

const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 480; document.body.append(canvas);
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
Object.assign(window, { modelEffectV2: {
  async run(materialKind: 'standard' | 'pbr') {
    const scene = new Scene(engine); scene.clearColor.set(.01, .01, .01, 1);
    const camera = new ArcRotateCamera('camera', -1.2, 1.1, 8, Vector3.Zero(), scene);
    new HemisphericLight('light', new Vector3(1, 1, -1), scene);
    const root = new TransformNode('model', scene); root.rotation.z = .25; root.position.y = 1;
    const mesh = MeshBuilder.CreateBox('body', { width: 3, height: 3, depth: 2 }, scene); mesh.parent = root;
    const material = materialKind === 'pbr' ? new PBRMaterial('body', scene) : new StandardMaterial('body', scene);
    if (material instanceof PBRMaterial) { material.albedoColor.set(.35, .2, .08); material.metallic = 0; material.roughness = 1; }
    else { material.diffuseColor.set(.35, .2, .08); material.specularColor = Color3.Black(); }
    mesh.material = material; camera.setTarget(root.position);
    const runtime = new TargetModelEffects(scene, () => root);
    const render = async () => { for (let i = 0; i < 8; i++) { scene.render(); await new Promise(requestAnimationFrame); } return new Uint8Array(await engine.readPixels(0, 0, 480, 480)); };
    const metrics = (base: Uint8Array, pixels: Uint8Array) => {
      let changed = 0, missing = 0;
      for (let i = 0; i < base.length; i += 4) {
        if (Math.max(Math.abs(base[i] - pixels[i]), Math.abs(base[i + 1] - pixels[i + 1]), Math.abs(base[i + 2] - pixels[i + 2])) > 3) changed++;
        if (Math.max(base[i], base[i + 1], base[i + 2]) > 30 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 15) missing++;
      }
      return { changed, missing };
    };
    const apply = (kind: Parameters<typeof createDefaultPoiEffectComponent>[0], parameters: Record<string, EffectParameterValue>) => {
      const c = createDefaultPoiEffectComponent(kind); c.visual!.targetEntityId = 'model'; c.visual!.progress = 1;
      c.configuration = { version: 2, parameters } as typeof c.configuration;
      runtime.sync('effect', c, true);
    };
    try {
      const baseline = await render();
      apply('height-gradient', { coordinateSpace: 'local', gradientStops: [{ position: 0, color: '#ff0000' }, { position: .5, color: '#00ff00' }, { position: 1, color: '#0000ff' }], originalMix: .2 });
      const gradient = metrics(baseline, await render());
      const gradientImage = canvas.toDataURL();
      apply('dissolve', { coordinateSpace: 'local', direction: 'reverse', progressMode: 'external', progress: .5, noiseStrength: .1, edgeWidth: .05 });
      const dissolve = metrics(baseline, await render());
      const replacement = mesh.material;
      apply('dissolve', { coordinateSpace: 'local', direction: 'reverse', progressMode: 'external', progress: 1, noiseStrength: .1, edgeWidth: .05 });
      const complete = metrics(baseline, await render()); const reused = mesh.material === replacement;
      apply('clip-section', { coordinateSpace: 'local', clipSide: 'above', progress: .4 });
      const above = metrics(baseline, await render());
      apply('clip-section', { coordinateSpace: 'local', clipSide: 'slice', sliceThickness: .2, progress: .5 });
      const slice = metrics(baseline, await render());
      apply('hologram', { wireframe: false, surfaceOpacity: .5, edgeEnabled: true, edgeColor: '#ff9900', scanLines: 20 });
      const hologram = metrics(baseline, await render());
      apply('model-scan', { delay: 1, direction: 'reverse', bandWidth: 1, duration: 2 });
      const delayedScan = metrics(baseline, await render()); runtime.tick(1); runtime.tick(1);
      const scan = metrics(baseline, await render());
      runtime.dispose(); const restored = metrics(baseline, await render());
      return { materialKind, gradient, dissolve, complete, reused, above, slice, hologram, delayedScan, scan, restored, gradientImage };
    } finally { runtime.dispose(); scene.dispose(); }
  },
  dispose: () => engine.dispose(),
} });
