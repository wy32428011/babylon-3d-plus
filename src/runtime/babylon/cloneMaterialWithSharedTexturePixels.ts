import { type Material, RawTexture, SerializationHelper, type Texture } from '@babylonjs/core';

const safeRawTextureCloneMethods = new WeakSet<object>();

function cloneRawTextureMethod(this: RawTexture): Texture {
  return cloneRawTexture(this);
}
safeRawTextureCloneMethods.add(cloneRawTextureMethod);

/** 保留可变 RawTexture 包装，只共享 Babylon 引用计数管理的像素资源。 */
function cloneRawTexture(source: RawTexture): Texture {
  const internal = source.getInternalTexture();
  if (!internal) return RawTexture.prototype.clone.call(source);
  let copy: RawTexture | undefined;
  try {
    // Babylon 9.12 的 RawTexture.clone 会分配原尺寸纹理后覆盖引用，并遗漏 UV 属性。
    // 构造真正的 RawTexture 保留 update 等 API；1x1 占位立即释放，再接管共享像素。
    copy = new RawTexture(null, 1, 1, source.format, source.getScene() ?? internal.getEngine(),
      internal.generateMipMaps, source._invertY, source.samplingMode, internal.type,
      internal._creationFlags, source._useSRGBBuffer);
    copy.releaseInternalTexture();
    copy._texture = internal;
    internal.incrementReferences();
    SerializationHelper.Clone(() => copy!, source);
    copy.clone = cloneRawTextureMethod;
    return copy;
  } catch (error) {
    copy?.dispose();
    throw error;
  }
}

/** 沿用原生材质及插件克隆，仅在本次同步调用内修正 RawTexture 的克隆。 */
export function cloneMaterialWithSharedTexturePixels(source: Material, name: string): Material | null {
  const replacements: { texture: RawTexture; descriptor: PropertyDescriptor | undefined }[] = [];
  const createdTextures: Texture[] = [];
  let succeeded = false;
  try {
    for (const texture of new Set(source.getActiveTextures())) {
      if (!(texture instanceof RawTexture)) continue;
      // 自定义纹理克隆有自己的契约；嵌套调用只接管原生或本 helper 安装的方法。
      if (texture.clone !== RawTexture.prototype.clone && !safeRawTextureCloneMethods.has(texture.clone)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(texture, 'clone');
      if ((!descriptor && !Object.isExtensible(texture))
        || (descriptor && (!('value' in descriptor) || (!descriptor.configurable && !descriptor.writable)))) {
        throw new Error(`材质“${source.name}”的 RawTexture“${texture.name}”无法安全克隆：clone 方法不可修改。`);
      }
      const clone = function (this: RawTexture): Texture {
        const copy = cloneRawTexture(this);
        createdTextures.push(copy);
        return copy;
      };
      safeRawTextureCloneMethods.add(clone);
      Object.defineProperty(texture, 'clone', descriptor
        ? { ...descriptor, value: clone }
        : { value: clone, configurable: true, writable: true });
      replacements.push({ texture, descriptor });
    }
    const material = source.clone(name);
    succeeded = material !== null;
    return material;
  } finally {
    // 重入时恢复外层 descriptor；各调用只释放自己创建的纹理，避免清掉内层成功结果。
    for (const { texture, descriptor } of replacements.reverse()) {
      if (descriptor) Object.defineProperty(texture, 'clone', descriptor);
      else Reflect.deleteProperty(texture, 'clone');
    }
    if (!succeeded) for (const texture of createdTextures) texture.dispose();
  }
}
