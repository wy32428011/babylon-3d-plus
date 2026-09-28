import {
  type AbstractEngine,
  type AbstractMesh,
  CascadedShadowGenerator,
  type EffectFallbacks,
  type MaterialDefines,
  MaterialPluginBase,
  Matrix,
  PBRMaterial,
  type Scene,
  type ShadowGenerator,
  StandardMaterial,
  SpotLight,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core';
import { GetFullOffsetViewProjectionToRef } from '@babylonjs/core/Materials/floatingOriginMatrixOverrides.js';

type EnvironmentMaterial = PBRMaterial | StandardMaterial;
type ShadowState = {
  generator: ShadowGenerator | null;
  localGenerators: readonly ShadowGenerator[];
  plugins: Set<EnvironmentShadowMaterialPlugin>;
};
// 与常规材质的默认灯光预算一致，避免局部灯数量无界增加片元采样器。
const LOCAL_SHADOW_SLOTS = [0, 1, 2, 3] as const;
const SHADOW_ENABLED = ['defined(ENVIRONMENT_SHADOW)', ...LOCAL_SHADOW_SLOTS.map(i => `defined(ENVIRONMENT_LOCAL_SHADOW${i})`)].join(' || ');
const sceneStates = new WeakMap<Scene, ShadowState>();

function getState(scene: Scene): ShadowState {
  let state = sceneStates.get(scene);
  if (!state) {
    state = { generator: null, localGenerators: [], plugins: new Set() };
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

export function setEnvironmentLocalShadowGenerators(scene: Scene, generators: readonly ShadowGenerator[]): void {
  const state = getState(scene);
  const selected = generators.slice(0, LOCAL_SHADOW_SLOTS.length);
  if (selected.length === state.localGenerators.length && selected.every((generator, i) => generator === state.localGenerators[i])) return;
  state.localGenerators = selected;
  for (const plugin of state.plugins) plugin.refreshShadowDefines();
}

/** 在无光照环境原色上叠加主光和局部阴影，保留纹理、透明度及原有雾效处理。 */
export class EnvironmentShadowMaterialPlugin extends MaterialPluginBase {
  private readonly state: ShadowState;
  private readonly isPbr: boolean;
  private readonly localLightMatrix = Matrix.Identity();

  constructor(material: EnvironmentMaterial) {
    super(material, 'EnvironmentShadow', 200, {
      SHADOWS: false,
      ENVIRONMENT_SHADOW: false,
      ENVIRONMENT_SHADOW_CASCADES: 0,
      ENVIRONMENT_SHADOW_PCF: false,
      ENVIRONMENT_SHADOW_RIGHT_HANDED: false,
      ...Object.fromEntries(LOCAL_SHADOW_SLOTS.flatMap(i => [
        [`ENVIRONMENT_LOCAL_SHADOW${i}`, false],
        [`ENVIRONMENT_LOCAL_SHADOW_CUBE${i}`, false],
        [`ENVIRONMENT_LOCAL_SHADOW_PCF${i}`, false],
      ])),
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
    let localEnabled = false;
    for (const i of LOCAL_SHADOW_SLOTS) {
      const local = this.state.localGenerators[i];
      const active = Boolean(local && scene.shadowsEnabled && mesh.receiveShadows && local.getLight().shadowEnabled);
      defines[`ENVIRONMENT_LOCAL_SHADOW${i}`] = active;
      defines[`ENVIRONMENT_LOCAL_SHADOW_CUBE${i}`] = active && local!.getLight().needCube();
      defines[`ENVIRONMENT_LOCAL_SHADOW_PCF${i}`] = active && local!.usePercentageCloserFiltering;
      localEnabled ||= active;
    }
    defines.SHADOWS = enabled || localEnabled;
    if (defines.SHADOWS) {
      const caps = scene.getEngine().getCaps();
      defines.SHADOWFLOAT = Boolean((caps.textureFloatRender && caps.textureFloatLinearFiltering)
        || (caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering));
    }
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('shadowTextureEnv', ...LOCAL_SHADOW_SLOTS.map(i => `shadowTextureEnvLocal${i}`));
  }

  override addFallbacks(defines: MaterialDefines, fallbacks: EffectFallbacks, currentRank: number): number {
    // 复杂源材质若超出显卡采样器预算，逐路降级局部阴影，保留主阴影与环境原材质。
    for (const i of [...LOCAL_SHADOW_SLOTS].reverse()) {
      if (defines[`ENVIRONMENT_LOCAL_SHADOW${i}`]) fallbacks.addFallback(currentRank++, `ENVIRONMENT_LOCAL_SHADOW${i}`);
    }
    return currentRank;
  }

  override getUniforms() {
    return { externalUniforms: [
      'lightMatrixEnv', 'viewFrustumZEnv', 'frustumLengthsEnv', 'cascadeBlendFactorEnv',
      'environmentShadowView', 'environmentShadowInfo', 'environmentShadowDepth', 'environmentShadowActive',
      ...LOCAL_SHADOW_SLOTS.flatMap(i => [
        `lightMatrixEnvLocal${i}`, `environmentLocalShadowActive${i}`, `environmentLocalShadowInfo${i}`,
        `environmentLocalShadowDepth${i}`, `environmentLocalShadowPosition${i}`, `environmentLocalShadowDirection${i}`,
      ]),
    ] };
  }

  override hardBindForSubMesh(_buffer: UniformBuffer, scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const effect = subMesh.effect;
    const generator = this.state.generator;
    if (!effect) return;
    this.bindLocalShadows(scene, subMesh);
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

  private bindLocalShadows(scene: Scene, subMesh: SubMesh): void {
    const effect = subMesh.effect!;
    for (const i of LOCAL_SHADOW_SLOTS) {
      const generator = this.state.localGenerators[i];
      const light = generator?.getLight();
      const map = generator?.getShadowMap();
      // 热切换编译期间可能仍在绘制旧 shader；禁止把 cube 纹理绑定给旧二维采样器。
      const compiled = effect.defines.includes(`#define ENVIRONMENT_LOCAL_SHADOW${i}\n`);
      const cube = effect.defines.includes(`#define ENVIRONMENT_LOCAL_SHADOW_CUBE${i}\n`);
      const pcf = effect.defines.includes(`#define ENVIRONMENT_LOCAL_SHADOW_PCF${i}\n`);
      const active = Boolean(compiled && generator && light && map && scene.activeCamera && scene.shadowsEnabled
        && subMesh.getMesh().receiveShadows && light.shadowEnabled && light.isEnabled() && light.intensity > 0
        && light.canAffectMesh(subMesh.getMesh()) && cube === light.needCube() && pcf === generator.usePercentageCloserFiltering);
      effect.setFloat(`environmentLocalShadowActive${i}`, active ? 1 : 0);
      if (!active || !generator || !light || !map || !scene.activeCamera) continue;
      const transformed = light.computeTransformedInformation();
      const position = transformed ? light.transformedPosition : light.position;
      const offset = scene.floatingOriginOffset;
      const min = light.getDepthMinZ(scene.activeCamera), max = light.getDepthMaxZ(scene.activeCamera);
      effect.setFloat4(`environmentLocalShadowPosition${i}`, position.x - offset.x, position.y - offset.y,
        position.z - offset.z, Math.min(light.range, max));
      if (light instanceof SpotLight) {
        const direction = transformed ? light.transformedDirection : light.direction;
        const length = direction.length() || 1;
        effect.setFloat4(`environmentLocalShadowDirection${i}`, direction.x / length, direction.y / length,
          direction.z / length, Math.cos(light.angle / 2));
      }
      const size = map.getSize().width;
      effect.setFloat4(`environmentLocalShadowInfo${i}`, generator.darkness, size, generator.blurScale / size, generator.frustumEdgeFalloff);
      effect.setFloat2(`environmentLocalShadowDepth${i}`, min, min + max);
      // 无光照材质不会绑定普通灯光 UBO，只借用阴影纹理和矩阵，避免超出普通灯槽后写入空 UBO。
      if (!cube) {
        const transform = generator.getTransformMatrix();
        const matrix = scene.floatingOriginMode
          ? GetFullOffsetViewProjectionToRef(offset, generator.viewMatrix, generator.projectionMatrix, this.localLightMatrix)
          : transform;
        effect.setMatrix(`lightMatrixEnvLocal${i}`, matrix);
      }
      const texture = generator.getShadowMapForRendering();
      if (pcf) effect.setDepthStencilTexture(`shadowTextureEnvLocal${i}`, texture);
      else effect.setTexture(`shadowTextureEnvLocal${i}`, texture);
    }
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
float environmentPrimaryShadowFactor(vec3 position) {
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
#endif
${LOCAL_SHADOW_SLOTS.map(i => `
#ifdef ENVIRONMENT_LOCAL_SHADOW${i}
uniform float environmentLocalShadowActive${i};
uniform vec4 environmentLocalShadowInfo${i};
uniform vec2 environmentLocalShadowDepth${i};
uniform vec4 environmentLocalShadowPosition${i};
uniform vec4 environmentLocalShadowDirection${i};
#ifdef ENVIRONMENT_LOCAL_SHADOW_CUBE${i}
uniform samplerCube shadowTextureEnvLocal${i};
#else
uniform mat4 lightMatrixEnvLocal${i};
#ifdef ENVIRONMENT_LOCAL_SHADOW_PCF${i}
uniform highp sampler2DShadow shadowTextureEnvLocal${i};
#else
uniform sampler2D shadowTextureEnvLocal${i};
#endif
#endif
float environmentLocalShadowFactor${i}(vec3 position) {
  if (environmentLocalShadowActive${i} < 0.5) return 1.0;
  vec3 offset = position - environmentLocalShadowPosition${i}.xyz;
  float distanceToLight = length(offset);
  if (distanceToLight < environmentLocalShadowDepth${i}.x || distanceToLight > environmentLocalShadowPosition${i}.w) return 1.0;
#ifdef ENVIRONMENT_LOCAL_SHADOW_CUBE${i}
  return computeShadowWithPoissonSamplingCube(position, environmentLocalShadowPosition${i}.xyz, shadowTextureEnvLocal${i},
    environmentLocalShadowInfo${i}.z, environmentLocalShadowInfo${i}.x, environmentLocalShadowDepth${i});
#else
  if (dot(offset / distanceToLight, environmentLocalShadowDirection${i}.xyz) < environmentLocalShadowDirection${i}.w) return 1.0;
  vec4 projected = lightMatrixEnvLocal${i} * vec4(position, 1.0);
  if (projected.w <= 0.0) return 1.0;
#ifdef USE_REVERSE_DEPTHBUFFER
  float depth = (-projected.z + environmentLocalShadowDepth${i}.x) / environmentLocalShadowDepth${i}.y;
#else
  float depth = (projected.z + environmentLocalShadowDepth${i}.x) / environmentLocalShadowDepth${i}.y;
#endif
#ifdef ENVIRONMENT_LOCAL_SHADOW_PCF${i}
  return computeShadowWithPCF1(projected, depth, shadowTextureEnvLocal${i}, environmentLocalShadowInfo${i}.x, environmentLocalShadowInfo${i}.w);
#else
  return computeShadowWithPoissonSampling(projected, depth, shadowTextureEnvLocal${i},
    environmentLocalShadowInfo${i}.z, environmentLocalShadowInfo${i}.x, environmentLocalShadowInfo${i}.w);
#endif
#endif
}
#endif`).join('\n')}
#if ${SHADOW_ENABLED}
float environmentShadowFactor(vec3 position) {
  float shade = 1.0;
#ifdef ENVIRONMENT_SHADOW
  shade = environmentPrimaryShadowFactor(position);
#endif
${LOCAL_SHADOW_SLOTS.map(i => `#ifdef ENVIRONMENT_LOCAL_SHADOW${i}
  shade = min(shade, environmentLocalShadowFactor${i}(position));
#endif`).join('\n')}
  return shade;
}
#endif`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
#if ${SHADOW_ENABLED}
${this.isPbr ? 'finalColor' : 'color'}.rgb *= environmentShadowFactor(vPositionW);
#endif`,
    };
  }
}
