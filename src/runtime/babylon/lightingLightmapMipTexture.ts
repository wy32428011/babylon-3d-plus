import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import '@babylonjs/core/Engines/Extensions/engine.rawTexture.js';
import type { ThinEngine } from '@babylonjs/core/Engines/thinEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { DecodedLightingLightmapMips } from '../../../electron/shared/sceneLightingLightmapMips.ts';

export type LightingLightmapMipTextureOptions = {
  maxTextureBytes: number;
  signal?: AbortSignal;
  /** 恢复失败保持纹理未就绪，由上层诊断，不能偷偷退成只有base的贴图。 */
  onRestoreError?: (error: Error) => void;
};

/**
 * 已验证容器的有限 mip 上传适配。Babylon 9.12 WebGL 的 updateMipLevel 实际覆盖 level0，
 * 因而隔离使用实际支持 lod 的内部上传口；显式rebuild回调重放全部CPU级，不让SDK生成mip。
 */
export function createLightingLightmapMipTexture(scene: Scene, decoded: DecodedLightingLightmapMips,
  options: LightingLightmapMipTextureOptions): Texture {
  options.signal?.throwIfAborted();
  const candidate = scene.getEngine() as ThinEngine;
  if (candidate.webGLVersion !== 2 || !candidate._gl || typeof candidate._uploadDataToTextureDirectly !== 'function') {
    throw new Error('有限光照 mip 需要已验证的 WebGL2 上传后端。');
  }
  const gl = candidate._gl;
  const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!precision || precision.precision < 23) throw new Error('有限光照 mip 需要至少23位fragment highp精度。');
  if (!Number.isSafeInteger(options.maxTextureBytes) || options.maxTextureBytes < decoded.totalTextureBytes
    || decoded.levelCount < 2 || decoded.levelCount > 5 || decoded.levelCount !== decoded.levels.length) {
    throw new Error('有限光照 mip 层级或全链 RGBA 预算无效。');
  }
  let total = 0;
  decoded.levels.forEach((level, index) => {
    if (level.width !== Math.max(1, decoded.width >> index) || level.height !== Math.max(1, decoded.height >> index)
      || level.rgba.byteLength !== level.width * level.height * 4) throw new Error('有限光照 mip 解码后数据不一致。');
    total += level.rgba.byteLength;
  });
  if (total !== decoded.totalTextureBytes || decoded.width > candidate.getCaps().maxTextureSize
    || decoded.height > candidate.getCaps().maxTextureSize) throw new Error('有限光照 mip 尺寸/全链总量超限。');

  // 闭包只保留解析器的各级视图；它们共享一个已验证容器，不额外复制整条CPU链。
  let retained: DecodedLightingLightmapMips | undefined = decoded;
  let disposed = false;
  const upload = (internal: InternalTexture) => {
    if (disposed || !retained) throw new Error('有限光照 mip 资源已释放。');
    options.signal?.throwIfAborted();
    internal.isReady = false;
    internal.generateMipMaps = false;
    internal.useMipMaps = true;
    internal.mipLevelCount = retained.levelCount;
    internal.invertY = false; // 容器已经是Blender底行在前，不能再翻转。
    candidate._bindTextureDirectly(gl.TEXTURE_2D, internal, true, true);
    const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    const previousPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    const previousColorSpace = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number;
    try {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      retained.levels.forEach((level, lod) => candidate._uploadDataToTextureDirectly(internal, level.rgba, 0, lod));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, retained.levelCount - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, 0);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, retained.levelCount - 1);
      const anisotropic = candidate.getCaps().textureAnisotropicFilterExtension;
      if (anisotropic) gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, 1);
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
      // 通过引擎自己的绑定口恢复缓存一致性，避免裸gl.bindTexture留下伪缓存。
      candidate._bindTextureDirectly(gl.TEXTURE_2D, null, true, true);
    }
    candidate.updateTextureSamplingMode(Texture.TRILINEAR_SAMPLINGMODE, internal, false);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('有限光照 mip GPU 上传失败。');
    internal.isReady = true;
  };

  let texture: RawTexture | undefined;
  try {
    texture = new RawTexture(null, decoded.width, decoded.height, Constants.TEXTUREFORMAT_RGBA, scene,
      false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, false);
    texture.name = 'lighting-lightmap-mips';
    texture.gammaSpace = false;
    texture.hasAlpha = false;
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 1;
    const internal = texture.getInternalTexture();
    if (!internal) throw new Error('有限光照 mip 无法创建纹理。');
    upload(internal);
    internal.onRebuildCallback = target => {
      let proxy: InternalTexture | undefined;
      try {
        if (disposed || !retained) throw new Error('有限光照 mip 恢复时资源已经释放。');
        // 创建时generateMipMaps=false；不能先生成错误链、再在下个frame补传。
        proxy = candidate.createRawTexture(null, retained.width, retained.height, Constants.TEXTUREFORMAT_RGBA,
          false, false, Texture.BILINEAR_SAMPLINGMODE, null, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, false);
        upload(proxy);
        return { proxy, isReady: true, isAsync: false };
      } catch (cause) {
        proxy?.dispose(); target.isReady = false;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        options.onRestoreError?.(error);
        throw error;
      }
    };
    // 成功后由Texture统一拥有CPU视图及rebuild回调；dispose/切结果后不留观察器或容器引用。
    texture.onDisposeObservable.addOnce(() => {
      disposed = true; retained = undefined; internal.onRebuildCallback = null; internal._bufferView = null;
    });
    options.signal?.throwIfAborted();
    return texture;
  } catch (error) {
    disposed = true; retained = undefined; texture?.dispose();
    throw error;
  }
}
