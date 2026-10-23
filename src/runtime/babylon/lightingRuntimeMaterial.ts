import { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { lightingContentHash } from '../../../electron/shared/sceneLightingBakeContract.ts';

const scalarFields = ['alpha', 'alphaMode', 'transparencyMode', 'backFaceCulling', 'disableLighting', 'wireframe',
  'pointsCloud', 'pointSize', 'zOffset', 'zOffsetUnits', 'metallic', 'roughness', 'microSurface', 'specularPower',
  'useAlphaFromAlbedoTexture', 'useAlphaFromDiffuseTexture', 'useEmissiveAsIllumination', 'linkEmissiveWithDiffuse'] as const;
const colorFields = ['diffuseColor', 'albedoColor', 'emissiveColor', 'specularColor', 'ambientColor', 'reflectionColor'] as const;
const textureFields = ['albedoTexture', 'diffuseTexture', 'metallicTexture', 'microSurfaceTexture', 'bumpTexture',
  'emissiveTexture', 'ambientTexture', 'opacityTexture', 'reflectionTexture', 'refractionTexture', 'lightmapTexture'] as const;
const record = (material: Material) => material as unknown as Record<string, unknown>;

/** 只比较可被业务动作更新的公开材质值，排除插件及 shader 缓存状态。 */
export function lightingMaterialValueSignature(material: Material | null): string {
  if (!material) return 'null';
  if (material instanceof MultiMaterial) return lightingContentHash(material.subMaterials.map(lightingMaterialValueSignature));
  const value = record(material);
  return lightingContentHash([
    scalarFields.map(field => value[field]),
    colorFields.map(field => value[field] instanceof Color3 ? value[field].asArray() : null),
    textureFields.map(field => (value[field] as { uniqueId?: number } | null)?.uniqueId ?? null),
  ]);
}

/** 清除 GI 时保留经工作材质接收的实时颜色/透明度变化，已有外部原材质更新则优先保留。 */
export function restoreLightingMaterialValues(original: Material | null, working: Material | null, baseline: string): void {
  if (!original || !working || original === working || lightingMaterialValueSignature(original) !== baseline) return;
  if (original instanceof MultiMaterial && working instanceof MultiMaterial) {
    for (let index = 0; index < original.subMaterials.length; index++) {
      const target = original.subMaterials[index], source = working.subMaterials[index];
      restoreLightingMaterialValues(target, source, lightingMaterialValueSignature(target));
    }
    return;
  }
  if (!((original instanceof PBRMaterial && working instanceof PBRMaterial) || (original instanceof StandardMaterial && working instanceof StandardMaterial))) return;
  const target = record(original), source = record(working);
  for (const field of scalarFields) if (field in target && field in source) target[field] = source[field];
  for (const field of colorFields) {
    if (target[field] instanceof Color3 && source[field] instanceof Color3) target[field].copyFrom(source[field]);
  }
  for (const field of textureFields) if (field in target && field in source) target[field] = source[field];
}
