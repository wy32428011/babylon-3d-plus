import { Constants, RawTexture, type Scene, Texture } from '@babylonjs/core';
import ltcDataUrl from '../../assets/lighting/areaLightsLTC.bin?url&inline';

let decoded: [Uint16Array, Uint16Array] | null = null;

/** 随 Viewer 打包 LTC 数据，避免矩形面光运行时依赖 Babylon 公网 CDN。 */
export function ensureLocalAreaLightTextures(scene: Scene): void {
  if (scene._ltcTextures) return;
  if (!decoded) {
    const encoded = atob(ltcDataUrl.slice(ltcDataUrl.indexOf(',') + 1));
    if (encoded.length !== 64 * 64 * 8 * 2) throw new Error('矩形面光 LTC 数据长度异常');
    const bytes = Uint8Array.from(encoded, (value) => value.charCodeAt(0));
    const input = new DataView(bytes.buffer);
    decoded = [new Uint16Array(64 * 64 * 4), new Uint16Array(64 * 64 * 4)];
    for (let pixel = 0; pixel < 64 * 64; pixel++) {
      for (let channel = 0; channel < 4; channel++) {
        decoded[0][pixel * 4 + channel] = input.getUint16((pixel * 8 + channel) * 2, true);
        decoded[1][pixel * 4 + channel] = input.getUint16((pixel * 8 + channel + 4) * 2, true);
      }
    }
  }
  const textures = decoded.map((data) => {
    const texture = RawTexture.CreateRGBATexture(data, 64, 64, scene.getEngine(), false, false,
      Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, 0, false, true);
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return texture;
  });
  scene._ltcTextures = { LTC1: textures[0], LTC2: textures[1] };
  scene.onDisposeObservable.addOnce(() => {
    for (const texture of textures) texture.dispose();
  });
}
