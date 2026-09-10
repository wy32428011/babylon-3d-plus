import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { EnvCubeTexture } from '@babylonjs/core/Materials/Textures/envCubeTexture.js';
import type { CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap.js';

function cloneFace(face: ArrayBufferView | null): Float32Array {
  if (!(face instanceof Float32Array)) throw new Error('天空盒预解码面数据必须为 Float32。');
  return face.slice();
}

/** 使用同算法预解码的线性 Float32 面数据；GPU 上传、球谐及纹理属性仍由 Babylon 完成。 */
export class PreparedSkyboxTexture extends EnvCubeTexture {
  private readonly cubeData: CubeMapInfo;
  private readonly sourceFormat: 'exr' | 'hdr';

  constructor(url: string, engine: AbstractEngine, size: number, data: CubeMapInfo, format: 'exr' | 'hdr',
    onLoad: (() => void) | null = null, onError: ((message?: string, cause?: unknown) => void) | null = null,
    gammaSpace = false, generateHarmonics = true) {
    super(url, engine, size, false, generateHarmonics, gammaSpace, false, onLoad, onError);
    this.cubeData = data;
    this.sourceFormat = format;
  }

  protected async _getCubeMapTextureDataAsync(): Promise<CubeMapInfo> {
    if (!this.gammaSpace) return this.cubeData;
    // Babylon 的 Gamma 转换会原地写入面数据；此分支复制，避免污染缓存和其它副本。
    return { ...this.cubeData,
      right: cloneFace(this.cubeData.right), left: cloneFace(this.cubeData.left),
      up: cloneFace(this.cubeData.up), down: cloneFace(this.cubeData.down),
      front: cloneFace(this.cubeData.front), back: cloneFace(this.cubeData.back) };
  }

  protected _instantiateClone(): this {
    return new PreparedSkyboxTexture(this.url, this._getEngine()!, this._size, this.cubeData, this.sourceFormat,
      null, null, this.gammaSpace, this._generateHarmonics) as this;
  }

  getClassName(): string { return this.sourceFormat === 'exr' ? 'EXRCubeTexture' : 'HDRCubeTexture'; }

  serialize() {
    const value = super.serialize();
    if (value) value.customType = `BABYLON.${this.getClassName()}`;
    return value;
  }
}
