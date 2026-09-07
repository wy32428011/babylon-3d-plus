import { type Material, PBRMaterial, SerializationHelper, StandardMaterial } from '@babylonjs/core';

/** 环境显示副本共享只读纹理，避免 RawTexture.clone 丢失平铺参数和重复分配纹理。 */
export function cloneEnvironmentMaterial(source: Material, name: string): Material | null {
  if (!(source instanceof PBRMaterial || source instanceof StandardMaterial)) return source.clone(name);
  // 原生 clone 负责保留 Detail Map 等材质插件，再把只读资源恢复为共享引用。
  const material = source.clone(name);
  if (!material) return null;
  const originals = new Set(source.getActiveTextures());
  const copiedTextures = new Set(material.getActiveTextures().filter(texture => !originals.has(texture)));
  SerializationHelper.Instanciate<Material>(() => material, source);
  for (const key of ['detailMap', 'clearCoat', 'anisotropy', 'sheen', 'subSurface', 'iridescence', 'brdf', 'decalMap']) {
    const original = (source as unknown as Record<string, object>)[key];
    const copy = (material as unknown as Record<string, object>)[key];
    if (original && copy) SerializationHelper.Instanciate(() => copy, original);
  }
  const retained = new Set(material.getActiveTextures());
  for (const texture of copiedTextures) if (!retained.has(texture)) texture.dispose();
  material.name = name; material.id = name;
  source.stencil.copyTo(material.stencil);
  return material;
}
