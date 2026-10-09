import { type BaseTexture, type Material, PBRMaterial, SerializationHelper, StandardMaterial } from '@babylonjs/core';
import { cloneMaterialWithSharedTexturePixels } from './cloneMaterialWithSharedTexturePixels.ts';
import { withNewMaterialDirtyGuard } from './withNewMaterialDirtyGuard.ts';

/** 环境显示副本共享只读纹理，避免 RawTexture.clone 丢失平铺参数和重复分配纹理。 */
export function cloneEnvironmentMaterial(source: Material, name: string): Material | null {
  return withNewMaterialDirtyGuard(source.getScene(), () => {
    if (!(source instanceof PBRMaterial || source instanceof StandardMaterial)) return cloneMaterialWithSharedTexturePixels(source, name);
    // 显示副本只读共享纹理；避免临时 RGBD 副本被释放后异步解码仍访问其场景。
    const originals = new Set(source.getActiveTextures());
    // 默认 BRDF 不在 getActiveTextures 中，但 PBR 原生序列化也会克隆它。
    if (source instanceof PBRMaterial && source.environmentBRDFTexture) originals.add(source.environmentBRDFTexture);
    const replacements: { texture: BaseTexture; descriptor: PropertyDescriptor | undefined }[] = [];
    let material: Material | null;
    try {
      for (const texture of originals) {
        const descriptor = Object.getOwnPropertyDescriptor(texture, 'clone');
        if ((!descriptor && !Object.isExtensible(texture)) || (descriptor && (!('value' in descriptor) || (!descriptor.configurable && !descriptor.writable)))) {
          throw new Error(`环境材质“${source.name}”的纹理“${texture.name}”无法安全共享。`);
        }
        Object.defineProperty(texture, 'clone', descriptor ? { ...descriptor, value: () => texture } : { value: () => texture, configurable: true, writable: true });
        replacements.push({ texture, descriptor });
      }
      material = cloneMaterialWithSharedTexturePixels(source, name);
    } finally {
      for (const { texture, descriptor } of replacements.reverse()) {
        if (descriptor) Object.defineProperty(texture, 'clone', descriptor);
        else Reflect.deleteProperty(texture, 'clone');
      }
    }
    if (!material) return null;
    const copiedTextures = new Set(material.getActiveTextures().filter(texture => !originals.has(texture)));
    try {
      SerializationHelper.Instanciate<Material>(() => material, source);
      // Babylon 的 PBR clone 未序列化自定义 BRDF；显示副本必须显式保留该只读引用。
      if (source instanceof PBRMaterial && material instanceof PBRMaterial) material.environmentBRDFTexture = source.environmentBRDFTexture;
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
    } catch (error) {
      material.dispose(false, false);
      for (const texture of copiedTextures) texture.dispose();
      throw error;
    }
  });
}
