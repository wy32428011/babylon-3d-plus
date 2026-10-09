import { Engine, Scene, FreeCamera, Vector3 } from '@babylonjs/core';
import { SceneSkyboxRuntime } from '../../src/runtime/babylon/SceneSkyboxRuntime';

const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
const camera = new FreeCamera('mosaic-camera', Vector3.Zero(), scene);
camera.maxZ = 20000;
camera.fov = 0.7;
const logs: string[] = [];
const runtime = new SceneSkyboxRuntime(scene, message => logs.push(message));
engine.runRenderLoop(() => scene.render());
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function settle() {
  const deadline = performance.now() + 120000;
  while (runtime.getReadiness().phase !== 'ready' || !scene.isReady(true)) {
    if (runtime.getReadiness().phase === 'error') throw Error(runtime.getReadiness().message!);
    if (performance.now() > deadline) throw Error('等待首帧超时：' + logs.join(' | '));
    await pause(30);
  }
  const frame = scene.getFrameId();
  while (scene.getFrameId() < frame + 6) {
    if (performance.now() > deadline) throw Error('等待稳定帧超时');
    await pause(16);
  }
}
Object.assign(window, { skyboxMosaic: {
  async load(kind: 'compact' | 'gradient') {
    runtime.sync({ entityId: 'mosaic', visible: true, pickable: false, selected: false,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      skybox: { sourceUrl: new URL('/' + kind + '.hdr', location.href).href, sourcePath: kind + '.hdr', packagePath: '',
        format: 'hdr', rotationDegrees: 0, intensity: 1, resolution: 512 } });
    await settle();
    const texture = scene.environmentTexture!;
    const caps = engine.getCaps();
    return { engine: engine.getGlInfo(), samplingMode: texture.samplingMode, textureSize: texture.getSize(),
      caps: { textureFloatLinearFiltering: caps.textureFloatLinearFiltering, textureHalfFloatLinearFiltering: caps.textureHalfFloatLinearFiltering },
      lodGenerationScale: texture.lodGenerationScale, lodGenerationOffset: texture.lodGenerationOffset,
      readiness: runtime.getReadiness(), diagnostics: runtime.getLoadDiagnostics() };
  },
  async capture(yaw: number, elevation = 0.35, fov = 0.7) {
    camera.fov = fov;
    camera.setTarget(new Vector3(Math.sin(yaw), elevation, Math.cos(yaw)));
    await settle();
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    let jumps = 0, samples = 0, maximumJump = 0, totalVariation = 0;
    // 正常8bit渐变允许单级量化；连续大于2级的像素跳变用于暴露最近邻台阶。
    for (let y = canvas.height / 2 - 8; y < canvas.height / 2 + 8; y++) {
      for (let x = 1; x < canvas.width; x++) for (let c = 0; c < 3; c++) {
        const offset = (y * canvas.width + x) * 4 + c;
        const delta = Math.abs(pixels[offset] - pixels[offset - 4]);
        if (delta > 2) jumps++;
        maximumJump = Math.max(maximumJump, delta); totalVariation += delta; samples++;
      }
    }
    const cube = await scene.environmentTexture!.readPixels(0);
    if (!(cube instanceof Float32Array)) throw Error('预期浮点立方体读回');
    let plateaus = 0, edges = 0;
    for (let y = 192; y < 320; y++) for (let x = 1; x < 512; x++) {
      const offset = (y * 512 + x) * 4;
      if (cube[offset] === cube[offset - 4] && cube[offset + 1] === cube[offset - 3] && cube[offset + 2] === cube[offset - 2]) plateaus++;
      edges++;
    }
    return { largeJumpFraction: jumps / samples, maximumJump, totalVariation, cubePlateauFraction: plateaus / edges };
  },
  dispose() { engine.stopRenderLoop(); runtime.dispose(); scene.dispose(); engine.dispose(); },
} });
