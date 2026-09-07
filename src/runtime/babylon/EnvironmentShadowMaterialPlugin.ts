import {
  type AbstractEngine,
  type AbstractMesh,
  CascadedShadowGenerator,
  type MaterialDefines,
  MaterialPluginBase,
  PBRMaterial,
  type Scene,
  type ShadowGenerator,
  StandardMaterial,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core';

type EnvironmentMaterial = PBRMaterial | StandardMaterial;
type ShadowState = { generator: ShadowGenerator | null; plugins: Set<EnvironmentShadowMaterialPlugin> };
const sceneStates = new WeakMap<Scene, ShadowState>();

function getState(scene: Scene): ShadowState {
  let state = sceneStates.get(scene);
  if (!state) {
    state = { generator: null, plugins: new Set() };
    sceneStates.set(scene, state);
  }
  return state;
}

/** 阴影贴图仍由 SceneShadowRuntime 独占；材质只借用，不能销毁或另建一份。 */
export function setEnvironmentShadowGenerator(scene: Scene, generator: ShadowGenerator | null): void {
  const state = getState(scene);
  if (state.generator === generator) return;
  state.generator = generator;
  for (const plugin of state.plugins) plugin.refreshShadowDefines();
}

/** 在无光照环境原色上叠加主阴影，保留纹理、透明度及原有雾效处理。 */
export class EnvironmentShadowMaterialPlugin extends MaterialPluginBase {
  private readonly state: ShadowState;
  private readonly isPbr: boolean;

  constructor(material: EnvironmentMaterial) {
    super(material, 'EnvironmentShadow', 200, {
      SHADOWS: false,
      ENVIRONMENT_SHADOW: false,
      ENVIRONMENT_SHADOW_CASCADES: 0,
      ENVIRONMENT_SHADOW_PCF: false,
      ENVIRONMENT_SHADOW_RIGHT_HANDED: false,
    }, true, false);
    this.isPbr = material instanceof PBRMaterial;
    this.state = getState(material.getScene());
    this.state.plugins.add(this);
    this.registerForExtraEvents = true;
    this.doNotSerialize = true;
    this._enable(true);
  }

  override getClassName(): string { return 'EnvironmentShadowMaterialPlugin'; }

  refreshShadowDefines(): void {
    const frozen = this._material.isFrozen;
    this._material.unfreeze();
    this.markAllDefinesAsDirty();
    if (frozen) this._material.freeze();
    // freeze() 会清除强制重绑标志，因此必须在它之后刷新材质 UBO。
    this._material.markDirty(true);
  }

  override prepareDefines(defines: MaterialDefines, scene: Scene, mesh: AbstractMesh): void {
    const generator = this.state.generator;
    const enabled = Boolean(generator && scene.shadowsEnabled && generator.getLight().shadowEnabled && mesh.receiveShadows);
    defines.ENVIRONMENT_SHADOW = enabled;
    defines.ENVIRONMENT_SHADOW_CASCADES = enabled && generator instanceof CascadedShadowGenerator ? generator.numCascades : 0;
    defines.ENVIRONMENT_SHADOW_PCF = enabled && generator!.usePercentageCloserFiltering;
    defines.ENVIRONMENT_SHADOW_RIGHT_HANDED = scene.useRightHandedSystem;
    // 只启用 Babylon 自带的阴影采样函数，不启用任何 LIGHTn 或直接光照。
    defines.SHADOWS = enabled;
    if (enabled) {
      const caps = scene.getEngine().getCaps();
      defines.SHADOWFLOAT = Boolean((caps.textureFloatRender && caps.textureFloatLinearFiltering)
        || (caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering));
    }
  }

  override getSamplers(samplers: string[]): void { samplers.push('shadowTextureEnv'); }

  override getUniforms() {
    return { externalUniforms: [
      'lightMatrixEnv', 'viewFrustumZEnv', 'frustumLengthsEnv', 'cascadeBlendFactorEnv',
      'environmentShadowView', 'environmentShadowInfo', 'environmentShadowDepth', 'environmentShadowActive',
    ] };
  }

  override hardBindForSubMesh(_buffer: UniformBuffer, scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const effect = subMesh.effect;
    const generator = this.state.generator;
    if (!effect) return;
    const active = Boolean(generator && scene.shadowsEnabled && generator.getLight().shadowEnabled
      && generator.getLight().isEnabled() && subMesh.getMesh().receiveShadows);
    effect.setFloat('environmentShadowActive', active ? 1 : 0);
    if (!active || !generator || !scene.activeCamera) return;
    // 公开绑定接口同时处理普通贴图、CSM 数组、分段距离和浮动原点。
    generator.bindShadowLight('Env', effect);
    const size = generator.getShadowMap()!.getSize().width;
    effect.setFloat4('environmentShadowInfo', generator.darkness, size, 1 / size, generator.frustumEdgeFalloff);
    const light = generator.getLight();
    const min = light.getDepthMinZ(scene.activeCamera);
    effect.setFloat2('environmentShadowDepth', min, min + light.getDepthMaxZ(scene.activeCamera));
    effect.setMatrix('environmentShadowView', scene.getViewMatrix());
  }

  override dispose(): void { this.state.plugins.delete(this); }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef ENVIRONMENT_SHADOW
uniform vec4 environmentShadowInfo;
uniform vec2 environmentShadowDepth;
uniform float environmentShadowActive;
uniform mat4 environmentShadowView;
#if ENVIRONMENT_SHADOW_CASCADES > 0
uniform mat4 lightMatrixEnv[ENVIRONMENT_SHADOW_CASCADES];
uniform float viewFrustumZEnv[ENVIRONMENT_SHADOW_CASCADES];
uniform float frustumLengthsEnv[ENVIRONMENT_SHADOW_CASCADES];
uniform float cascadeBlendFactorEnv;
uniform highp sampler2DArrayShadow shadowTextureEnv;
float environmentCascadeShadow(int layer, vec3 position) {
  vec4 projected = lightMatrixEnv[layer] * vec4(position, 1.0);
  return computeShadowWithCSMPCF5(float(layer), projected, 0.0, shadowTextureEnv,
    environmentShadowInfo.yz, environmentShadowInfo.x, environmentShadowInfo.w);
}
#else
uniform mat4 lightMatrixEnv;
#ifdef ENVIRONMENT_SHADOW_PCF
uniform highp sampler2DShadow shadowTextureEnv;
#else
uniform sampler2D shadowTextureEnv;
#endif
#endif
float environmentShadowFactor(vec3 position) {
  if (environmentShadowActive < 0.5) return 1.0;
#if ENVIRONMENT_SHADOW_CASCADES > 0
  float cameraDepth = (environmentShadowView * vec4(position, 1.0)).z;
#ifdef ENVIRONMENT_SHADOW_RIGHT_HANDED
  cameraDepth = -cameraDepth;
#endif
  for (int layer = 0; layer < ENVIRONMENT_SHADOW_CASCADES; layer++) {
    float remaining = viewFrustumZEnv[layer] - cameraDepth;
    if (remaining < 0.0) continue;
    float shade = environmentCascadeShadow(layer, position);
    if (layer < ENVIRONMENT_SHADOW_CASCADES - 1) {
      float blend = clamp(remaining / frustumLengthsEnv[layer] * cascadeBlendFactorEnv, 0.0, 1.0);
      if (blend < 1.0) shade = mix(environmentCascadeShadow(layer + 1, position), shade, blend);
    }
    return shade;
  }
  return 1.0;
#else
  vec4 projected = lightMatrixEnv * vec4(position, 1.0);
#ifdef USE_REVERSE_DEPTHBUFFER
  float depth = (-projected.z + environmentShadowDepth.x) / environmentShadowDepth.y;
#else
  float depth = (projected.z + environmentShadowDepth.x) / environmentShadowDepth.y;
#endif
#ifdef ENVIRONMENT_SHADOW_PCF
  return computeShadowWithPCF1(projected, depth, shadowTextureEnv, environmentShadowInfo.x, environmentShadowInfo.w);
#else
  return computeShadowWithPoissonSampling(projected, depth, shadowTextureEnv,
    environmentShadowInfo.z, environmentShadowInfo.x, environmentShadowInfo.w);
#endif
#endif
}
#endif`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
#ifdef ENVIRONMENT_SHADOW
${this.isPbr ? 'finalColor' : 'color'}.rgb *= environmentShadowFactor(vPositionW);
#endif`,
    };
  }
}
