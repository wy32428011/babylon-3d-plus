import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { AbstractEngine, AbstractMesh, BaseTexture, Mesh, Scene, StandardMaterial, SubMesh, UniformBuffer } from '@babylonjs/core';

export type BakedLightingBinding = { texture?: BaseTexture; rgbmRange?: number; probes?: readonly number[]; enabled: boolean };
export const LIGHTING_UV_ATTRIBUTE = 'lightingBakeUV';

/** 只替换环境漫反射分量；直接光仍由原生光照/阴影处理，镜面反射与自发光保持原路径。 */
export class BakedLightingMaterialPlugin extends MaterialPluginBase {
  private readonly binding: (mesh: AbstractMesh) => BakedLightingBinding;

  constructor(material: PBRMaterial | StandardMaterial, binding: (mesh: AbstractMesh) => BakedLightingBinding) {
    super(material, 'BakedIndirectLighting', 180, { BAKED_INDIRECT: true, BAKED_INDIRECT_MAP: false }, true, false);
    this.binding = binding;
    this.registerForExtraEvents = true; this.doNotSerialize = true; this._enable(true);
  }
  override getClassName(): string { return 'BakedLightingMaterialPlugin'; }
  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    defines.BAKED_INDIRECT = true;
    defines.BAKED_INDIRECT_MAP = Boolean(this.binding(mesh).texture && mesh.isVerticesDataPresent(LIGHTING_UV_ATTRIBUTE));
  }
  override getAttributes(attributes: string[], _scene: Scene, mesh: Mesh): void {
    if (mesh.isVerticesDataPresent(LIGHTING_UV_ATTRIBUTE)) attributes.push(LIGHTING_UV_ATTRIBUTE);
  }
  override getSamplers(samplers: string[]): void { samplers.push('lightingBakeSampler'); }
  override getUniforms() { return { externalUniforms: ['lightingBakeActive', 'lightingBakeRange', 'lightingProbePX', 'lightingProbeNX', 'lightingProbePY', 'lightingProbeNY', 'lightingProbePZ', 'lightingProbeNZ'] }; }
  override hardBindForSubMesh(_buffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const effect = subMesh.effect;
    if (!effect) return;
    const binding = this.binding(subMesh.getMesh());
    const usesMap = effect.defines.includes('#define BAKED_INDIRECT_MAP');
    const usableMap = usesMap && binding.texture?.isReady() && subMesh.getMesh().isVerticesDataPresent(LIGHTING_UV_ATTRIBUTE);
    const usableProbes = !usesMap && Boolean(binding.probes && binding.probes.length >= 18);
    // 异步模型/贴图加载或 shader 热切换尚未准备好时保留源材质，不能把环境漫反射误清零。
    effect.setFloat('lightingBakeActive', binding.enabled && Boolean(usableMap || usableProbes) ? 1 : 0);
    effect.setFloat('lightingBakeRange', binding.rgbmRange ?? 1);
    if (binding.texture) effect.setTexture('lightingBakeSampler', binding.texture);
    const coefficients = binding.probes;
    for (const [i, axis] of ['PX', 'NX', 'PY', 'NY', 'PZ', 'NZ'].entries()) {
      effect.setFloat3(`lightingProbe${axis}`, coefficients?.[i * 3] ?? 0, coefficients?.[i * 3 + 1] ?? 0, coefficients?.[i * 3 + 2] ?? 0);
    }
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: '#ifdef BAKED_INDIRECT_MAP\nattribute vec2 lightingBakeUV;\nvarying vec2 vLightingBakeUV;\n#endif',
      CUSTOM_VERTEX_MAIN_BEGIN: '#ifdef BAKED_INDIRECT_MAP\nvLightingBakeUV = lightingBakeUV;\n#endif',
    };
    if (shaderType !== 'fragment') return null;
    const definitions = `
uniform float lightingBakeActive;
uniform float lightingBakeRange;
uniform vec3 lightingProbePX, lightingProbeNX, lightingProbePY, lightingProbeNY, lightingProbePZ, lightingProbeNZ;
#ifdef BAKED_INDIRECT_MAP
uniform sampler2D lightingBakeSampler;
varying vec2 vLightingBakeUV;
#endif
vec3 readBakedIrradiance(vec3 normalDirection) {
#ifdef BAKED_INDIRECT_MAP
  vec4 sampleValue = texture2D(lightingBakeSampler, vLightingBakeUV);
  return sampleValue.rgb * sampleValue.a * lightingBakeRange;
#else
  vec3 n = normalize(normalDirection);
  return n.x*n.x*(n.x>=0.0 ? lightingProbePX : lightingProbeNX)
    + n.y*n.y*(n.y>=0.0 ? lightingProbePY : lightingProbeNY)
    + n.z*n.z*(n.z>=0.0 ? lightingProbePZ : lightingProbeNZ);
#endif
}`;
    // 基类构造时已收集注入点，不能依赖 super() 之后才赋值的派生字段。
    // PBR 能量、清漆与透射项沿用原生 finalIrradiance 顺序；烘焙值已含灯光强度，
    // 不再整体乘环境强度，只保留仍由环境贴图采样的透射项自己的强度。
    if (this._material instanceof PBRMaterial) return {
      CUSTOM_FRAGMENT_DEFINITIONS: definitions,
      // PBR 的高光也读取 light.diffuse 作为辐亮度，不能靠将灯的 diffuse 置黑来保留高光。
      '!info\\.diffuse\\s*=\\s*computeHemisphericDiffuseLighting\\([^;]+\\);': `
$0
if (lightingBakeActive > 0.5) { info.diffuse = vec3(0.0); }
`,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifndef UNLIT
if (lightingBakeActive > 0.5) {
  vec3 bakedDiffuse = readBakedIrradiance(normalW);
#ifndef LEGACY_SPECULAR_ENERGY_CONSERVATION
#if defined(METALLICWORKFLOW) || defined(SPECULAR_GLOSSINESS_ENERGY_CONSERVATION)
  vec3 bakedSpecularEnergy = vec3(baseSpecularEnvironmentReflectance);
#if defined(ENVIRONMENTBRDF) && defined(MS_BRDF_ENERGY_CONSERVATION)
  bakedSpecularEnergy *= baseSpecularEnergyConservationFactor;
#endif
  bakedDiffuse *= clamp(vec3(1.0) - bakedSpecularEnergy, 0.0, 1.0);
#endif
#endif
#ifdef CLEARCOAT
  bakedDiffuse *= clearcoatOut.conservationFactor;
#ifdef CLEARCOAT_TINT
  bakedDiffuse *= clearcoatOut.absorption;
#endif
#endif
#ifndef SS_APPLY_ALBEDO_AFTER_SUBSURFACE
  bakedDiffuse *= surfaceAlbedo.rgb;
#endif
#if defined(SS_REFRACTION) && !defined(LEGACY_SPECULAR_ENERGY_CONSERVATION)
  bakedDiffuse *= subSurfaceOut.refractionOpacity;
#endif
#ifdef SS_TRANSLUCENCY
  bakedDiffuse *= 1.0 - subSurfaceOut.translucencyIntensity;
  bakedDiffuse += subSurfaceOut.refractionIrradiance * vLightingIntensity.z;
#endif
#ifdef SS_APPLY_ALBEDO_AFTER_SUBSURFACE
  bakedDiffuse *= surfaceAlbedo.rgb;
#endif
  bakedDiffuse *= aoOut.ambientOcclusionColor;
#ifdef REFLECTION
  finalIrradiance = bakedDiffuse;
#else
  finalDiffuse += bakedDiffuse;
#endif
}
#endif`,
    };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: definitions,
      '!info\\s*=\\s*computeHemisphericLighting\\([^;]+\\);': `
$0
if (lightingBakeActive > 0.5) { info.diffuse = vec3(0.0); }
`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
if (lightingBakeActive > 0.5) {
  color.rgb += readBakedIrradiance(normalW) * diffuseColor * baseColor.rgb * baseAmbientColor;
}`,
    };
  }
}
