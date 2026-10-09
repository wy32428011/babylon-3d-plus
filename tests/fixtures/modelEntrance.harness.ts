import { Color3, DynamicTexture, Engine, FreeCamera, HemisphericLight, MeshBuilder, PBRMaterial, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { ModelEntranceRuntime } from '../../src/runtime/babylon/ModelEntranceRuntime';
import { normalizeSceneModelEntranceSettings, type SceneModelEntranceSettings } from '../../src/editor/model/sceneModelEntrance';

const effects = ['fade', 'scan', 'dissolve', 'hologram', 'particles', 'assembly', 'radial', 'stagger'] as const;
const canvas = document.createElement('canvas');
canvas.width = 640; canvas.height = 480;
document.body.style.cssText = 'margin:0;background:#14202a;color:white;font:16px sans-serif';
const controls = document.createElement('div'); controls.style.cssText = 'padding:12px;display:flex;gap:10px;align-items:center';
const select = document.createElement('select');
for (const effect of effects) { const option = document.createElement('option'); option.value = effect; option.textContent = effect; select.append(option); }
const play = document.createElement('button'); play.textContent = '播放入场';
const cancel = document.createElement('button'); cancel.textContent = '取消并恢复';
const verify = document.createElement('button'); verify.textContent = '验证八效果与两种材质';
const results = document.createElement('pre'); results.id = 'entrance-results';
const status = document.createElement('output');
controls.append(select, play, cancel, verify, status); document.body.append(controls, canvas, results);
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
let active: { scene: Scene; runtime: ModelEntranceRuntime } | null = null;
let automatic = false;

function createCase(materialKind: 'standard' | 'pbr') {
  active?.runtime.dispose(); active?.scene.dispose();
  const scene = new Scene(engine); scene.clearColor.set(.015, .025, .035, 1);
  const camera = new FreeCamera('camera', new Vector3(6, 5, -9), scene); camera.setTarget(new Vector3(0, 1, 0));
  new HemisphericLight('light', new Vector3(0, 1, -1), scene);
  const texture = new DynamicTexture('checker', 64, scene, false);
  const context = texture.getContext(); context.fillStyle = '#d0a15d'; context.fillRect(0, 0, 64, 64);
  context.fillStyle = '#427b9c'; context.fillRect(0, 0, 32, 32); context.fillRect(32, 32, 32, 32); texture.update();
  const material = materialKind === 'pbr' ? new PBRMaterial('pbr', scene) : new StandardMaterial('standard', scene);
  if (material instanceof PBRMaterial) { material.albedoTexture = texture; material.metallic = 0; material.roughness = 1; }
  else { material.diffuseTexture = texture; material.specularColor = Color3.Black(); }
  const targets = [-2, 0, 2].map((x, index) => {
    const node = new TransformNode(`device-${index}`, scene); node.position.x = x;
    for (let part = 0; part < 2; part++) {
      const mesh = MeshBuilder.CreateBox(`part-${index}-${part}`, { width: 1.4, height: .8, depth: 1.2 }, scene);
      mesh.position.y = .5 + part; mesh.parent = node; mesh.material = material;
    }
    return { id: node.name, node };
  });
  const runtime = new ModelEntranceRuntime(scene); active = { scene, runtime };
  return { scene, runtime, targets, material };
}

async function pixels(scene: Scene) {
  // PBR 构造会异步解码默认 BRDF，即使本样例没有反射贴图也要等其完成后再销毁场景。
  const started = performance.now();
  while (scene.environmentBRDFTexture && !scene.environmentBRDFTexture.isReady()) {
    if (performance.now() - started > 10_000) throw new Error('默认 BRDF 纹理未完成解码。');
    scene.render(); await new Promise(requestAnimationFrame);
  }
  // 固定动画时间，仅等待真实 WebGL 材质准备和渲染。
  for (let frame = 0; frame < 10; frame++) { scene.render(); await new Promise(requestAnimationFrame); }
  return new Uint8Array(await engine.readPixels(0, 0, 640, 480));
}
function changedPixels(base: Uint8Array, current: Uint8Array) {
  let changed = 0;
  for (let index = 0; index < base.length; index += 4) {
    if (Math.max(Math.abs(base[index] - current[index]), Math.abs(base[index + 1] - current[index + 1]), Math.abs(base[index + 2] - current[index + 2])) > 3) changed++;
  }
  return changed;
}
const api = {
  effects,
  snapshot: () => active?.runtime.getSnapshot(),
  async run(effect: typeof effects[number], materialKind: 'standard' | 'pbr') {
    automatic = false;
    // 首次展示场景也会创建 BRDF；切换样例前等待其异步资源，不能在解码中销毁它。
    if (active) await pixels(active.scene);
    const { scene, runtime, targets, material } = createCase(materialKind);
    const baseline = await pixels(scene);
    const settings = normalizeSceneModelEntranceSettings({ enabled: true, effect, durationSeconds: 2, delaySeconds: 0, staggerSeconds: .12 });
    await runtime.prepare(settings, targets); runtime.start(); runtime.tick(1, true);
    const midpoint = changedPixels(baseline, await pixels(scene)); const midpointImage = canvas.toDataURL();
    const beforePause = runtime.getSnapshot(); runtime.tick(10, false); const paused = runtime.getSnapshot();
    runtime.tick(10, true);
    const completed = changedPixels(baseline, await pixels(scene)); const completedImage = canvas.toDataURL();
    const completion = runtime.getSnapshot();
    const materialsRestored = targets.every(target => target.node.getChildMeshes().every(mesh => mesh.material === material));
    await runtime.prepare(settings, targets); runtime.start(); runtime.tick(.3, true); runtime.cancel();
    const cancelled = changedPixels(baseline, await pixels(scene));
    return { effect, materialKind, midpoint, completed, cancelled, beforePause, paused, completion, materialsRestored, midpointImage, completedImage };
  },
  async play(settings?: Partial<SceneModelEntranceSettings>) {
    const { runtime, targets } = createCase('pbr');
    await runtime.prepare(normalizeSceneModelEntranceSettings({ enabled: true, effect: select.value, durationSeconds: 3, ...settings }), targets);
    runtime.start(); automatic = true;
  },
  cancel() { active?.runtime.cancel(); },
  dispose() { automatic = false; active?.runtime.dispose(); active?.scene.dispose(); active = null; engine.dispose(); },
};
play.onclick = () => api.play(); cancel.onclick = () => api.cancel();
verify.onclick = async () => {
  verify.disabled = true; play.disabled = true; cancel.disabled = true;
  const rows: unknown[] = [];
  try {
    for (const effect of effects) for (const materialKind of ['standard','pbr'] as const) {
      results.textContent = '验证中：' + effect + '/' + materialKind;
      const { midpointImage, completedImage, ...row } = await api.run(effect, materialKind);
      rows.push(row);
    }
    results.textContent = JSON.stringify({ results:rows },null,2);
    results.dataset.state = 'complete';
  } catch(error) {
    results.textContent = String(error); results.dataset.state = 'error';
  } finally { verify.disabled = false; play.disabled = false; cancel.disabled = false; }
};
createCase('pbr');
engine.runRenderLoop(() => {
  if (!active) return;
  if (automatic) active.runtime.tick(engine.getDeltaTime() / 1000, !document.hidden);
  active.scene.render(); status.value = JSON.stringify(active.runtime.getSnapshot());
});
Object.assign(window, { modelEntranceHarness: api });
