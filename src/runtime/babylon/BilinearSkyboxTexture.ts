import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture.js';
import { EXRCubeTexture } from '@babylonjs/core/Materials/Textures/exrCubeTexture.js';
import { RGBE_ReadHeader, RGBE_ReadPixels } from '@babylonjs/core/Misc/HighDynamicRange/hdr.js';
import { GetExrHeader } from '@babylonjs/core/Materials/Textures/Loaders/EXR/exrLoader.header.js';
import { ReadExrDataAsync } from '@babylonjs/core/Materials/Textures/Loaders/exrTextureLoader.js';
import { convertSkyboxPanoramaToCubemap } from './skyboxPanoramaSampling.ts';
import { validateSkyboxSourceDimensions } from './skyboxDecodedValidation.ts';

/** Worker 不支持的格式沿用 Babylon 解码，转换和反射克隆仍采用平滑采样。 */
export class BilinearHDRCubeTexture extends HDRCubeTexture {
  protected async _getCubeMapTextureDataAsync(buffer: ArrayBuffer, size: number) {
    const bytes = new Uint8Array(buffer);
    const header = RGBE_ReadHeader(bytes);
    validateSkyboxSourceDimensions(header.width, header.height);
    return convertSkyboxPanoramaToCubemap(RGBE_ReadPixels(bytes, header), header.width, header.height, size, true);
  }

  protected _instantiateClone(): this {
    return new BilinearHDRCubeTexture(this.url, this.getScene() || this._getEngine()!, this._size,
      this._noMipmap, this._generateHarmonics, this.gammaSpace) as this;
  }
}

export class BilinearEXRCubeTexture extends EXRCubeTexture {
  protected async _getCubeMapTextureDataAsync(buffer: ArrayBuffer, size: number) {
    const header = GetExrHeader(new DataView(buffer), { value: 0 });
    validateSkyboxSourceDimensions(header.dataWindow.xMax - header.dataWindow.xMin + 1,
      header.dataWindow.yMax - header.dataWindow.yMin + 1);
    const decoded = await ReadExrDataAsync(buffer);
    if (!decoded.data) throw new Error('EXR 数据无法解码。');
    return convertSkyboxPanoramaToCubemap(decoded.data, decoded.width, decoded.height, size, false);
  }

  protected _instantiateClone(): this {
    return new BilinearEXRCubeTexture(this.url, this.getScene() || this._getEngine()!, this._size,
      this._noMipmap, this._generateHarmonics, this.gammaSpace) as this;
  }
}
