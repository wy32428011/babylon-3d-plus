export const SKYBOX_ENVIRONMENT_VERSION = 1;
export const SKYBOX_ENVIRONMENT_RECIPE = 'babylon-9.12.0-panorama-bilinear-v2-ggx4096-rgbd-png-v1';
export const SKYBOX_ENVIRONMENT_FACE_SIZES = [256, 512, 1024] as const;
export const MAX_SKYBOX_ENVIRONMENT_BYTES = 512 * 1024 * 1024;
export const MAX_SKYBOX_ENVIRONMENT_HEADER_BYTES = 64 * 1024;
export type SkyboxEnvironmentFaceSize = typeof SKYBOX_ENVIRONMENT_FACE_SIZES[number];

/** 源字段仍描述 HDR/EXR；此对象仅描述已预过滤的运行产物，两个 SHA 不能互换。 */
export type SkyboxEnvironmentResource = {
  version: 1;
  format: 'env';
  sourceSha256: string;
  sourceRevision: string;
  recipeKey: string;
  sha256: string;
  byteLength: number;
  faceSize: SkyboxEnvironmentFaceSize;
  sourceUrl: string;
  sourcePath?: string;
  packagePath?: string;
};

export type SkyboxPreparationSource = {
  environment?: SkyboxEnvironmentResource;
  sourceAvailable?: false;
  sourcePath: string;
  sourceUrl: string;
  format: 'hdr' | 'exr';
  assetRevision?: string;
  resolution: SkyboxEnvironmentFaceSize;
};
export type SkyboxPreparationTicket = {
  token: string | null;
  sourceUrl: string;
  sourceSha256: string;
  sourceRevision: string;
  faceSize: SkyboxEnvironmentFaceSize;
  recipeKey: string;
  environment: SkyboxEnvironmentResource | null;
};
export type SkyboxPreparationStage = 'source-read' | 'decode' | 'convert' | 'prefilter' | 'encode' | 'validate' | 'commit';

const SHA256 = /^[a-f\d]{64}$/i;
const MAGIC = [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36];
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const HARMONICS = ['x', 'y', 'z', 'xx', 'yy', 'zz', 'xy', 'yz', 'zx'];
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function isSkyboxEnvironmentFaceSize(value: unknown): value is SkyboxEnvironmentFaceSize {
  return typeof value === 'number' && SKYBOX_ENVIRONMENT_FACE_SIZES.includes(value as SkyboxEnvironmentFaceSize);
}

/** 读取受控 JSON 字段，拒绝 accessor，避免资源准备/发布执行文档中携带的 getter。 */
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('天空环境资源字段必须为数据属性。');
  return descriptor.value;
}

export function normalizeSkyboxEnvironmentResource(value: unknown): SkyboxEnvironmentResource {
  const data = record(value);
  if (!data) throw new Error('天空环境产物描述无效。');
  const sourceSha256 = own(data, 'sourceSha256'), sha256 = own(data, 'sha256');
  const sourceRevision = own(data, 'sourceRevision'), recipeKey = own(data, 'recipeKey');
  const byteLength = own(data, 'byteLength'), faceSize = own(data, 'faceSize'), sourceUrl = own(data, 'sourceUrl');
  if (own(data, 'version') !== 1 || own(data, 'format') !== 'env'
    || typeof sourceSha256 !== 'string' || !SHA256.test(sourceSha256)
    || typeof sha256 !== 'string' || !SHA256.test(sha256)
    || typeof sourceRevision !== 'string' || sourceRevision.length > 256
    || recipeKey !== SKYBOX_ENVIRONMENT_RECIPE
    || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_SKYBOX_ENVIRONMENT_BYTES
    || !isSkyboxEnvironmentFaceSize(faceSize) || typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
    throw new Error('天空环境产物的版本、身份、分辨率或大小无效，请重新准备天空资源。');
  }
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw new Error('天空环境产物 URL 无效。'); }
  if (!['editor-asset:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.protocol === 'editor-asset:' && url.hostname !== 'local')
    || !/\.env$/i.test(decodeURIComponent(url.pathname))) throw new Error('天空环境产物必须引用受支持的 ENV 文件。');
  const result: SkyboxEnvironmentResource = {
    version: 1, format: 'env', sourceSha256: sourceSha256.toLowerCase(), sourceRevision,
    recipeKey, sha256: sha256.toLowerCase(), byteLength, faceSize, sourceUrl,
  };
  for (const key of ['sourcePath', 'packagePath'] as const) {
    const field = own(data, key);
    if (field !== undefined) {
      if (typeof field !== 'string' || !field.trim() || field.includes('\0')) throw new Error('天空环境产物路径无效。');
      result[key] = field;
    }
  }
  return result;
}

export function skyboxEnvironmentMatchesSource(source: { resolution: number; assetRevision?: string }, environment: SkyboxEnvironmentResource): boolean {
  const revision = source.assetRevision?.trim() ?? '';
  return source.resolution === environment.faceSize && (SHA256.test(revision)
    ? revision.toLowerCase() === environment.sourceSha256 : revision === environment.sourceRevision);
}

/** 派生字段和运输标记不是旧 GI 的物理输入；原字段及未知业务扩展仍完整参与原签名。 */
export function withoutSkyboxEnvironment(value: unknown): unknown {
  const data = record(value);
  if (!data || (!Object.hasOwn(data, 'environment') && !Object.hasOwn(data, 'sourceAvailable'))) return value;
  const { environment: _environment, sourceAvailable: _sourceAvailable, ...source } = data;
  return source;
}

export type ResolvedSceneSkyboxReference = { entityId: string | null; skybox: Record<string, unknown>; rotation: number; visible: boolean };

/** 烘焙、签名与资源准备共用实体优先/旧字段回退规则，避免把预过滤产物误当原图。 */
export function resolveSceneSkyboxReference(value: unknown): ResolvedSceneSkyboxReference | null {
  const scene = record(value), entities = record(scene?.entities) ?? {};
  const ids = Array.isArray(scene?.entityIds) ? scene.entityIds : Object.keys(entities);
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const entity = record(entities[id]), components = record(entity?.components), skybox = record(components?.skybox);
    if (!entity || !skybox) continue;
    let visible = true, current: Record<string, unknown> | null = entity;
    const visited = new Set<Record<string, unknown>>();
    while (current) {
      if (visited.has(current)) { visible = false; break; }
      visited.add(current);
      if (current.visible === false) { visible = false; break; }
      current = typeof current.parentId === 'string' ? record(entities[current.parentId]) : null;
    }
    const rotation = record(record(components?.transform)?.rotation)?.y;
    return { entityId: id, skybox, rotation: typeof rotation === 'number' && Number.isFinite(rotation) ? rotation : 0, visible };
  }
  const skybox = record(record(scene?.sceneSettings)?.skybox);
  if (!skybox) return null;
  return { entityId: null, skybox, rotation: typeof skybox.rotationDegrees === 'number' && Number.isFinite(skybox.rotationDegrees)
    ? skybox.rotationDegrees * Math.PI / 180 : 0, visible: true };
}

/** 有真实源内容身份时，路径/中台 ID/派生编码都只是运输信息，不能改变同一照明输入。 */
export function skyboxLightingIdentity(value: unknown): unknown {
  const source = record(withoutSkyboxEnvironment(value));
  if (!source) return value;
  const environment = record(record(value)?.environment);
  const hash = typeof environment?.sourceSha256 === 'string' && SHA256.test(environment.sourceSha256)
    ? environment.sourceSha256 : typeof source.assetRevision === 'string' && SHA256.test(source.assetRevision) ? source.assetRevision : null;
  if (!hash) return source;
  const { packagePath: _packagePath, sourcePath: _sourcePath, sourceUrl: _sourceUrl, assetRevision: _assetRevision,
    dataPlatformResourceId: _resourceId, intensity: _intensity, ...values } = source;
  return { ...values, sourceSha256: hash.toLowerCase() };
}

export type SkyboxEnvironmentInspection = { faceSize: SkyboxEnvironmentFaceSize; mipLevels: number; imageCount: number };

/** 校验本项目生成的 v2 PNG/RGBD ENV，先限制头和面尺寸，再允许图像解码/GPU 分配。 */
export function inspectSkyboxEnvironmentBytes(bytes: Uint8Array, expectedFaceSize?: SkyboxEnvironmentFaceSize): SkyboxEnvironmentInspection {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_SKYBOX_ENVIRONMENT_BYTES
    || MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('天空 ENV 文件头或大小无效。');
  const end = bytes.indexOf(0, MAGIC.length);
  if (end < 0 || end - MAGIC.length > MAX_SKYBOX_ENVIRONMENT_HEADER_BYTES) throw new Error('天空 ENV 头部缺失或超过限制。');
  let info: Record<string, unknown> | null;
  try { info = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(MAGIC.length, end)))); }
  catch { throw new Error('天空 ENV 头部 JSON 无效。'); }
  const width = info?.width, specular = record(info?.specular), irradiance = record(info?.irradiance);
  if (!info || info.version !== 2 || info.imageType !== 'image/png' || !isSkyboxEnvironmentFaceSize(width)
    || (expectedFaceSize !== undefined && width !== expectedFaceSize)
    || !specular || typeof specular.lodGenerationScale !== 'number' || !Number.isFinite(specular.lodGenerationScale)
    || specular.lodGenerationScale <= 0 || !irradiance
    || !HARMONICS.every(key => Array.isArray(irradiance[key]) && (irradiance[key] as unknown[]).length === 3
      && (irradiance[key] as unknown[]).every(value => typeof value === 'number' && Number.isFinite(value)))) {
    throw new Error('天空 ENV 的版本、编码、面尺寸、LOD 或球谐数据无效。');
  }
  const mipLevels = Math.log2(width) + 1;
  if (!Array.isArray(specular.mipmaps) || specular.mipmaps.length !== mipLevels * 6) throw new Error('天空 ENV 六面 Mip 数据不完整。');
  const payload = end + 1, ranges: Array<{ start: number; end: number }> = [];
  const image = (value: unknown, size: number) => {
    const entry = record(value), position = entry?.position, length = entry?.length;
    if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0
      || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 33 || length > bytes.byteLength - payload - position) {
      throw new Error('天空 ENV 图像范围越界。');
    }
    const start = payload + position;
    if (PNG.some((value, index) => bytes[start + index] !== value)
      || String.fromCharCode(...bytes.subarray(start + 12, start + 16)) !== 'IHDR') throw new Error('天空 ENV 图像不是有效 PNG。');
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
    if (view.getUint32(8) !== 13 || view.getUint32(16) !== size || view.getUint32(20) !== size
      || bytes[start + 24] !== 8 || bytes[start + 25] !== 6) throw new Error('天空 ENV PNG 尺寸或 RGBD 通道无效。');
    ranges.push({ start: position, end: position + length });
  };
  specular.mipmaps.forEach((entry, index) => image(entry, width / 2 ** Math.floor(index / 6)));
  if (irradiance.irradianceTexture !== undefined) {
    const diffuse = record(irradiance.irradianceTexture), size = diffuse?.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > width || !Array.isArray(diffuse?.faces)
      || diffuse.faces.length !== 6) throw new Error('天空 ENV 漫反射面数据无效。');
    diffuse.faces.forEach(entry => image(entry, size));
  }
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const range of ranges) { if (range.start !== cursor) throw new Error('天空 ENV 图像数据重叠或不连续。'); cursor = range.end; }
  if (cursor !== bytes.byteLength - payload) throw new Error('天空 ENV 存在未声明数据。');
  return { faceSize: width, mipLevels, imageCount: ranges.length };
}
