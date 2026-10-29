import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import type { GPUParticleSystem } from '@babylonjs/core/Particles/gpuParticleSystem.js';
import type { Scene } from '@babylonjs/core/scene.js';

type GpuParticleConstructor = typeof GPUParticleSystem;
export type RuntimeParticleSystem = ParticleSystem | GPUParticleSystem;
export type GpuParticleRuntimeSnapshot = {
  requested: boolean;
  backend: 'cpu' | 'webgl2-transform-feedback' | 'webgpu-compute';
  ready: boolean;
  reason: 'not-requested' | 'preparing' | 'unsupported' | 'module-load-failed' | null;
  activeGpuSystems: number;
  activeCpuSystems: number;
};
type State = GpuParticleRuntimeSnapshot & { constructor: GpuParticleConstructor | null; pending: Promise<void> | null };
const states = new WeakMap<Scene, State>();

/** 仅在显式选择 GPU 粒子的视口准备期加载；默认场景不承担 GPU 粒子模块和预热开销。 */
export async function prepareGpuParticleRuntime(scene: Scene, requested: boolean): Promise<void> {
  if (!requested || scene.isDisposed) return;
  const existing = states.get(scene);
  if (existing) { if (existing.pending) await existing.pending; return; }
  const caps = scene.getEngine().getCaps();
  const backend = caps.supportComputeShaders ? 'webgpu-compute' : caps.supportTransformFeedbacks ? 'webgl2-transform-feedback' : 'cpu';
  const state: State = { requested: true, backend, ready: false, reason: 'preparing',
    activeGpuSystems: 0, activeCpuSystems: 0, constructor: null, pending: null };
  states.set(scene, state);
  if (backend === 'cpu') { state.reason = 'unsupported'; return; }
  const pending = (async () => {
    try {
      const [module] = await Promise.all([
        import('@babylonjs/core/Particles/gpuParticleSystem.js'),
        backend === 'webgpu-compute'
          ? Promise.all([
            import('@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader.js'),
            import('@babylonjs/core/Particles/computeShaderParticleSystem.js'),
          ])
          : import('@babylonjs/core/Particles/webgl2ParticleSystem.js'),
      ]);
      if (scene.isDisposed) return;
      state.constructor = module.GPUParticleSystem;
      state.ready = true; state.reason = null;
    } catch (error) {
      state.backend = 'cpu'; state.reason = 'module-load-failed';
      console.warn('[Babylon] GPU 粒子模块准备失败，保留 CPU 粒子。', error);
    } finally { state.pending = null; }
  })();
  state.pending = pending;
  await pending;
}

/** 只接管框架定义的基础 Box 发射器，不转换用户脚本的自定义更新或已有粒子状态。 */
export function createRuntimeParticleSystem(name: string, capacity: number, scene: Scene): RuntimeParticleSystem {
  const state = states.get(scene);
  if (!state?.ready || !state.constructor) {
    const system = new ParticleSystem(name, capacity, scene);
    if (state) {
      state.activeCpuSystems++;
      system.onDisposeObservable.addOnce(() => { state.activeCpuSystems--; });
    }
    return system;
  }
  const system = new state.constructor(name, { capacity, emitRateControl: true }, scene);
  state.activeGpuSystems++;
  system.onDisposeObservable.addOnce(() => { state.activeGpuSystems--; });
  return system;
}

export function getGpuParticleRuntimeSnapshot(scene: Scene): GpuParticleRuntimeSnapshot | null {
  const state = states.get(scene);
  if (!state) return null;
  return { requested: state.requested, backend: state.backend, ready: state.ready, reason: state.reason,
    activeGpuSystems: state.activeGpuSystems, activeCpuSystems: state.activeCpuSystems };
}
