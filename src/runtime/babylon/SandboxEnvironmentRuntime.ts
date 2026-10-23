import { refreshSceneLightingMaterialDrawCaches } from './refreshDetachedInstanceSourceMaterials.ts';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { loadSkyboxTexture } from './skyboxTextureLoad';

/** 与 Sandbox 一致的预过滤环境随编辑器和 Viewer 打包，运行时不请求 CDN。 */
export const SANDBOX_ENVIRONMENT_URL = new URL('./assets/sanGiuseppeBridge.env', import.meta.url).href;
export const SANDBOX_ENVIRONMENT_LICENSE_URL = new URL('./assets/sanGiuseppeBridge.LICENSE.txt', import.meta.url).href;
export type SandboxEnvironmentReadiness = {
  phase: 'idle' | 'loading' | 'ready' | 'error'; message: string | null; sourceUrl: string | null;
};
export type SandboxEnvironmentOptions = {
  loadTexture?: (url: string, signal: AbortSignal) => Promise<CubeTexture>;
  onChanged?: (state: SandboxEnvironmentReadiness) => void;
  pushLog?: (message: string) => void;
};

/** 只拥有内置 IBL 的资源生命周期；是否绑定到场景由天空盒控制器统一决定。 */
export class SandboxEnvironmentRuntime {
  private enabled = false;
  private disposed = false;
  private rotationDegrees = 0;
  private texture: CubeTexture | null = null;
  private pending: AbortController | null = null;
  private token = 0;
  private error: string | null = null;

  constructor(private readonly scene: Scene, private readonly options: SandboxEnvironmentOptions = {}) {}

  sync(enabled: boolean, rotationDegrees: number): void {
    if (this.disposed) return;
    const changed = this.enabled !== enabled;
    this.enabled = enabled;
    this.rotationDegrees = rotationDegrees;
    if (!enabled) {
      if (!changed) return;
      this.cancel();
      this.texture?.dispose(); this.texture = null; this.error = null;
      this.notify();
      return;
    }
    if (this.texture) { this.applyRotation(); return; }
    if (!this.pending && !this.error) this.startLoad();
  }

  getTexture(): CubeTexture | null { return this.enabled ? this.texture : null; }

  getReadiness(): SandboxEnvironmentReadiness {
    return { phase: !this.enabled ? 'idle' : this.pending ? 'loading' : this.error ? 'error' : this.texture ? 'ready' : 'idle',
      message: this.error, sourceUrl: this.enabled ? SANDBOX_ENVIRONMENT_URL : null };
  }

  retry(): void {
    if (!this.disposed && this.enabled && this.error && !this.pending) this.startLoad();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.enabled = false;
    this.cancel(); this.texture?.dispose(); this.texture = null; this.error = null;
  }

  private startLoad(): void {
    const controller = new AbortController(), token = ++this.token;
    this.pending = controller; this.error = null; this.notify();
    let task: Promise<CubeTexture>;
    try {
      task = this.options.loadTexture ? this.options.loadTexture(SANDBOX_ENVIRONMENT_URL, controller.signal)
        : loadSkyboxTexture(SANDBOX_ENVIRONMENT_URL, controller.signal, {
          create: (url, onLoad, onError) => {
            const texture = new CubeTexture(url, this.scene.getEngine(), { prefiltered: true,
              forcedExtension: '.env', createPolynomials: true, onLoad, onError });
            texture.name = 'SandboxEnvironment:sanGiuseppeBridge';
            texture.metadata = { source: 'BabylonJS/Assets/environments/sanGiuseppeBridge.env',
              license: 'CC-BY-4.0', licenseUrl: SANDBOX_ENVIRONMENT_LICENSE_URL };
            return texture;
          },
        });
    } catch (error) { task = Promise.reject(error); }
    void task.then(texture => {
      // 已取消的读取仍可能完成上传；迟到资源只释放，绝不能重新绑定到场景。
      if (this.disposed || !this.enabled || controller.signal.aborted || token !== this.token) { texture.dispose(); return; }
      this.pending = null; this.texture = texture;
      this.applyRotation(); this.notify();
    }).catch(error => {
      if (this.disposed || controller.signal.aborted || token !== this.token) return;
      this.pending = null;
      this.error = `内置 Sandbox 环境加载失败：${error instanceof Error ? error.message : String(error)}`;
      this.options.pushLog?.(this.error); this.notify();
    });
  }

  private applyRotation(): void {
    const rotationY = this.rotationDegrees * Math.PI / 180;
    if (!this.texture || this.texture.rotationY === rotationY) return;
    this.texture.rotationY = rotationY;
    this.scene.markAllMaterialsAsDirty(Material.TextureDirtyFlag);
    // 首次加载由绑定阶段刷新；已有环境旋转才在这里触达离场实例源。
    if (this.scene.environmentTexture === this.texture) refreshSceneLightingMaterialDrawCaches(this.scene);
  }

  private cancel(): void { this.token++; this.pending?.abort(); this.pending = null; }
  private notify(): void { this.options.onChanged?.(this.getReadiness()); }
}
