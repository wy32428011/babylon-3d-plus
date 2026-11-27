import { refreshSceneLightingMaterialDrawCaches } from './refreshDetachedInstanceSourceMaterials.ts';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { loadSkyboxTexture } from './skyboxTextureLoad';

import type { BuiltinEnvironmentPresetId } from '../../../electron/shared/sceneLightingConfig.ts';

/** 与 Sandbox 一致的预过滤环境及仓储内置环境随编辑器和 Viewer 打包，运行时不请求 CDN。 */
export const SANDBOX_ENVIRONMENT_URL = new URL('./assets/sanGiuseppeBridge.env', import.meta.url).href;
export const SANDBOX_ENVIRONMENT_LICENSE_URL = new URL('./assets/sanGiuseppeBridge.LICENSE.txt', import.meta.url).href;
export const WAREHOUSE_BRIGHT_ENVIRONMENT_URL = new URL('./assets/warehouseBright.env', import.meta.url).href;
export const WAREHOUSE_DARK_ENVIRONMENT_URL = new URL('./assets/warehouseDark.env', import.meta.url).href;

export function resolveBuiltinEnvironmentUrl(preset: BuiltinEnvironmentPresetId = 'sandbox'): string {
  if (preset === 'warehouse-bright') return WAREHOUSE_BRIGHT_ENVIRONMENT_URL;
  if (preset === 'warehouse-dark') return WAREHOUSE_DARK_ENVIRONMENT_URL;
  return SANDBOX_ENVIRONMENT_URL;
}
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
  private preset: BuiltinEnvironmentPresetId = 'sandbox';
  private texture: CubeTexture | null = null;
  private pending: AbortController | null = null;
  private token = 0;
  private error: string | null = null;

  constructor(private readonly scene: Scene, private readonly options: SandboxEnvironmentOptions = {}) {}

  sync(enabled: boolean, rotationDegrees: number, preset: BuiltinEnvironmentPresetId = 'sandbox'): void {
    if (this.disposed) return;
    const changed = this.enabled !== enabled;
    const presetChanged = this.preset !== preset;
    this.enabled = enabled;
    this.rotationDegrees = rotationDegrees;
    this.preset = preset;
    if (!enabled) {
      if (!changed) return;
      this.cancel();
      this.texture?.dispose(); this.texture = null; this.error = null;
      this.notify();
      return;
    }
    if (presetChanged) {
      this.cancel();
      this.texture?.dispose(); this.texture = null; this.error = null;
      this.startLoad();
      return;
    }
    if (this.texture) { this.applyRotation(); return; }
    if (!this.pending && !this.error) this.startLoad();
  }

  getTexture(): CubeTexture | null { return this.enabled ? this.texture : null; }

  getReadiness(): SandboxEnvironmentReadiness {
    return { phase: !this.enabled ? 'idle' : this.pending ? 'loading' : this.error ? 'error' : this.texture ? 'ready' : 'idle',
      message: this.error, sourceUrl: this.enabled ? resolveBuiltinEnvironmentUrl(this.preset) : null };
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
    const targetPreset = this.preset;
    const targetUrl = resolveBuiltinEnvironmentUrl(targetPreset);
    this.pending = controller; this.error = null; this.notify();
    let task: Promise<CubeTexture>;
    try {
      task = this.options.loadTexture ? this.options.loadTexture(targetUrl, controller.signal)
        : loadSkyboxTexture(targetUrl, controller.signal, {
          create: (url, onLoad, onError) => {
            const texture = new CubeTexture(url, this.scene.getEngine(), { prefiltered: true,
              forcedExtension: '.env', createPolynomials: true, onLoad, onError });
            texture.name = `SandboxEnvironment:${targetPreset}`;
            texture.metadata = targetPreset === 'sandbox'
              ? { source: 'BabylonJS/Assets/environments/sanGiuseppeBridge.env',
                license: 'CC-BY-4.0', licenseUrl: SANDBOX_ENVIRONMENT_LICENSE_URL }
              : { source: `builtin:${targetPreset}`, license: 'CC0-1.0' };
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
