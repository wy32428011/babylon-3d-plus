import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { _CommonDispose } from '@babylonjs/core/Engines/engine.common.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import glslangJsUrl from '@babylonjs/core/assets/glslang/glslang.js?url';
import glslangWasmUrl from '@babylonjs/core/assets/glslang/glslang.wasm?url';
import twgslJsUrl from '@babylonjs/core/assets/twgsl/twgsl.js?url';
import twgslWasmUrl from '@babylonjs/core/assets/twgsl/twgsl.wasm?url';

/** 此模块只在显式请求 WebGPU 后加载，WebGL 默认启动不引入新初始化工作。 */
export async function createWebGPUViewportEngine(
  canvas: HTMLCanvasElement,
  opaqueCanvas: boolean,
  signal: AbortSignal | undefined,
): Promise<WebGPUEngine> {
  signal?.throwIfAborted();
  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    stencil: true,
    premultipliedAlpha: !opaqueCanvas,
    powerPreference: 'high-performance',
    // 9.12 的原生 WGSL 初始化不加载编译器；后续 GLSL 转译也只允许已安装、随包发布的本地资源。
    glslangOptions: { jsPath: glslangJsUrl, wasmPath: glslangWasmUrl },
    twgslOptions: { jsPath: twgslJsUrl, wasmPath: twgslWasmUrl },
  });
  let initialized = false;
  try {
    // 9.12 CreateAsync 没有向外传递 initAsync rejection，必须保留候选实例并直接等待初始化。
    await engine.initAsync();
    initialized = true;
    signal?.throwIfAborted();
    engine.compatibilityMode = true;
    return engine;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const release = (action: () => void) => { try { action(); } catch (failure) { cleanupErrors.push(failure); } };
    if (initialized) release(() => engine.dispose());
    else {
      // 9.12 的 WebGPU dispose 无条件使用尚未创建的 timestampQuery。初始化失败且尚无 Scene 时，
      // 销毁本候选 device（连带其 GPU 资源），再归还构造期 DOM 监听和 AbstractEngine 登记。
      release(() => engine._device?.destroy());
      release(() => _CommonDispose(engine, canvas));
      release(() => AbstractEngine.prototype.dispose.call(engine));
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'WebGPU 初始化及候选资源释放失败。');
    throw error;
  }
}
