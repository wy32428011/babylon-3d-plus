const EDITOR_ASSET_URL_PREFIX = 'editor-asset://local/';
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const RESOURCE_ID_PATTERN = /^[1-9]\d{0,63}$/;
const INVALID_MODEL_PATH_CHARS = '#:?\\';

function hasInvalidModelPathChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127 || INVALID_MODEL_PATH_CHARS.includes(value[i])) return true;
  }
  return false;
}

export type CompositionOriginDataPlatformModel = {
  sourceKey: string;
  kind: 'model' | 'combo';
  resourceId: string;
  modelPath: string;
};

/**
 * 组合固定包成员保留的原始模型类型标识：
 * - 不包含本机绝对路径，可安全写入组合清单、场景文档和 DIST 发布包；
 * - 供点击事件匹配、发布恢复与部署导出对齐设备类型，且不改变普通模型同步对组合固定包的隔离边界。
 */
export type CompositionOriginModelIdentity = {
  dataPlatformModel?: CompositionOriginDataPlatformModel;
  resourceKey?: string;
  localPathSha256?: string;
};

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INIT: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const utf8Encoder = new TextEncoder();

/** 纯 JS 同步 SHA-256（FIPS 180-4），供 Node 与浏览器运行态共享规范路径摘要。 */
export function sha256Utf8Hex(input: string): string {
  const bytes = utf8Encoder.encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const buffer = new Uint8Array(paddedLen);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let [h0, h1, h2, h3, h4, h5, h6, h7] = SHA256_INIT;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOriginDataPlatformModel(value: unknown): CompositionOriginDataPlatformModel | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.sourceKey !== 'string' || !LOWERCASE_SHA256.test(value.sourceKey)) return null;
  if (value.kind !== 'model' && value.kind !== 'combo') return null;
  if (typeof value.resourceId !== 'string' || !RESOURCE_ID_PATTERN.test(value.resourceId)) return null;
  if (typeof value.modelPath !== 'string' || !/\.(glb|gltf)$/i.test(value.modelPath)
    || hasInvalidModelPathChars(value.modelPath) || value.modelPath.startsWith('/')
    || value.modelPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return {
    sourceKey: value.sourceKey,
    kind: value.kind,
    resourceId: value.resourceId,
    modelPath: value.modelPath,
  };
}

export function normalizeClickEventModelResourceKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(model|combo):([1-9]\d{0,63}):(.+\.(?:glb|gltf))$/i.exec(value.trim());
  if (!match) return null;
  const relPath = match[3];
  if (hasInvalidModelPathChars(relPath) || relPath.startsWith('/')
    || relPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return `${match[1].toLowerCase()}:${match[2]}:${relPath.toLowerCase()}`;
}

function formatDataPlatformResourceKey(identity: CompositionOriginDataPlatformModel): string {
  return `${identity.kind}:${identity.resourceId}:${identity.modelPath.toLowerCase()}`;
}

function decodeAuthorizedAssetPath(sourceUrl: unknown): string | null {
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith(EDITOR_ASSET_URL_PREFIX)) return null;
  let modelPath: string;
  try {
    modelPath = decodeURIComponent(sourceUrl.slice(EDITOR_ASSET_URL_PREFIX.length).split(/[?#]/, 1)[0]).replace(/\\/g, '/').trim();
  } catch {
    return null;
  }
  if (!modelPath || modelPath.split('/').some((part) => part === '.' || part === '..')) return null;
  return modelPath;
}

/**
 * 点击绑定针对设备类型，同一中台模型的共享库、工程快照和发布包共用资源 ID。
 * 包名允许重命名、SOURCE 冲突后缀和部署哈希；包内路径仍须一致，避免误绑同包其他模型。
 * 普通本地模型没有稳定资源 ID，继续由调用方按完整 URL（或组合打包时记录的路径摘要）匹配。
 */
export function getClickEventModelResourceKey(sourceUrl: unknown): string | null {
  const modelPath = decodeAuthorizedAssetPath(sourceUrl);
  if (!modelPath) return null;
  const match = /(?:^|\/)(model|combo)-([1-9]\d{0,63})(?:-[^/]+)?\/(.+\.(?:glb|gltf))$/i.exec(modelPath);
  return match ? `${match[1].toLowerCase()}:${match[2]}:${match[3].toLowerCase()}` : null;
}

/** 本地模型 URL 的规范路径 SHA-256；仅接受受控 editor-asset://local/ 路径，避免泄露本机路径。 */
export function getLocalModelPathSha256(sourceUrl: unknown): string | null {
  const modelPath = decodeAuthorizedAssetPath(sourceUrl);
  if (!modelPath) return null;
  return sha256Utf8Hex(modelPath.toLowerCase());
}

/** 校验并规范化组合固定包成员的原始模型类型标识。 */
export function normalizeCompositionOriginModelIdentity(value: unknown): CompositionOriginModelIdentity | null {
  if (!isPlainObject(value)) return null;
  let dataPlatformModel: CompositionOriginDataPlatformModel | undefined;
  if (value.dataPlatformModel !== undefined) {
    const normalized = normalizeOriginDataPlatformModel(value.dataPlatformModel);
    if (!normalized) return null;
    dataPlatformModel = normalized;
  }
  let resourceKey: string | undefined;
  if (value.resourceKey !== undefined) {
    const normalized = normalizeClickEventModelResourceKey(value.resourceKey);
    if (!normalized) return null;
    resourceKey = normalized;
  }
  let localPathSha256: string | undefined;
  if (value.localPathSha256 !== undefined) {
    if (typeof value.localPathSha256 !== 'string' || !LOWERCASE_SHA256.test(value.localPathSha256)) return null;
    localPathSha256 = value.localPathSha256;
  }
  if (dataPlatformModel && resourceKey && formatDataPlatformResourceKey(dataPlatformModel) !== resourceKey) {
    return null;
  }
  if (!dataPlatformModel && !resourceKey && !localPathSha256) return null;
  return {
    ...(dataPlatformModel ? { dataPlatformModel } : {}),
    ...(resourceKey ? { resourceKey } : {}),
    ...(localPathSha256 ? { localPathSha256 } : {}),
  };
}

/** 从打包前或组合清单中的 modelAsset 提取稳定的原始模型类型标识（兼容已有组合清单及嵌套再组合）。 */
export function resolveCompositionOriginModelIdentity(asset: unknown): CompositionOriginModelIdentity | null {
  if (!isPlainObject(asset)) return null;
  const snapshot = isPlainObject(asset.sourceSnapshot) ? asset.sourceSnapshot : null;
  const existing = normalizeCompositionOriginModelIdentity(asset.compositionOriginModel)
    ?? normalizeCompositionOriginModelIdentity(snapshot?.originModel);
  const dataPlatformModel = normalizeOriginDataPlatformModel(asset.dataPlatformModel)
    ?? existing?.dataPlatformModel;
  const resourceKey = dataPlatformModel
    ? formatDataPlatformResourceKey(dataPlatformModel)
    : getClickEventModelResourceKey(asset.sourceUrl) ?? existing?.resourceKey ?? null;
  if (dataPlatformModel || resourceKey) {
    return {
      ...(dataPlatformModel ? { dataPlatformModel } : {}),
      ...(resourceKey ? { resourceKey } : {}),
    };
  }
  if (existing?.localPathSha256) {
    return { localPathSha256: existing.localPathSha256 };
  }
  const decodedPath = decodeAuthorizedAssetPath(asset.sourceUrl);
  if (decodedPath && !/(?:^|\/)assets\/compositions\//i.test(decodedPath)) {
    return { localPathSha256: sha256Utf8Hex(decodedPath.toLowerCase()) };
  }
  return null;
}

/** 读取模型资产或点击绑定槽位用于点击匹配的有效中台资源键（兼容组合固定包成员）。 */
export function getClickEventModelEffectiveResourceKey(asset: unknown): string | null {
  if (!isPlainObject(asset)) return null;
  const direct = getClickEventModelResourceKey(asset.sourceUrl);
  if (direct) return direct;
  const directIdentity = normalizeOriginDataPlatformModel(asset.dataPlatformModel);
  if (directIdentity) return formatDataPlatformResourceKey(directIdentity);
  const directResourceKey = normalizeClickEventModelResourceKey(asset.resourceKey);
  if (directResourceKey) return directResourceKey;
  const snapshot = isPlainObject(asset.sourceSnapshot) ? asset.sourceSnapshot : null;
  const origin = normalizeCompositionOriginModelIdentity(snapshot?.originModel);
  if (origin?.dataPlatformModel) return formatDataPlatformResourceKey(origin.dataPlatformModel);
  return origin?.resourceKey ?? null;
}

type ClickEventComparableIdentity = {
  sourceUrl: string | null;
  dataPlatformModel: CompositionOriginDataPlatformModel | null;
  resourceKey: string | null;
  localPathSha256: string | null;
};

function readClickEventComparableIdentity(asset: unknown, isDeviceType: boolean): ClickEventComparableIdentity {
  if (!isPlainObject(asset)) {
    return { sourceUrl: null, dataPlatformModel: null, resourceKey: null, localPathSha256: null };
  }
  const sourceUrl = typeof asset.sourceUrl === 'string' && asset.sourceUrl ? asset.sourceUrl : null;
  const snapshot = !isDeviceType && isPlainObject(asset.sourceSnapshot) ? asset.sourceSnapshot : null;
  const origin = snapshot ? normalizeCompositionOriginModelIdentity(snapshot.originModel) : null;
  const dataPlatformModel = normalizeOriginDataPlatformModel(asset.dataPlatformModel) ?? origin?.dataPlatformModel ?? null;
  const explicitResourceKey = isDeviceType ? normalizeClickEventModelResourceKey(asset.resourceKey) : null;
  const resourceKey = getClickEventModelResourceKey(sourceUrl)
    ?? (dataPlatformModel ? formatDataPlatformResourceKey(dataPlatformModel) : null)
    ?? explicitResourceKey
    ?? origin?.resourceKey
    ?? null;
  const explicitLocalSha = isDeviceType && typeof asset.localPathSha256 === 'string' && LOWERCASE_SHA256.test(asset.localPathSha256)
    ? asset.localPathSha256
    : null;
  const localPathSha256 = resourceKey === null
    ? (isDeviceType ? (explicitLocalSha ?? getLocalModelPathSha256(sourceUrl)) : (origin?.localPathSha256 ?? getLocalModelPathSha256(sourceUrl)))
    : null;
  return { sourceUrl, dataPlatformModel, resourceKey, localPathSha256 };
}

/**
 * 判断场景模型资产与点击事件绑定的设备类型是否指向同一设备模型：
 * 1) 双方均有中台来源键且不同 → 拒绝跨中台误匹配；
 * 2) 精确 sourceUrl 一致 → 命中；
 * 3) 中台资源键（含组合固定包保留的 originModel）一致 → 命中；
 * 4) 非中台本地模型通过组合固定包保留的规范路径 SHA-256 对齐 → 命中。
 */
export function matchesClickEventModelIdentity(modelAsset: unknown, deviceType: unknown): boolean {
  const model = readClickEventComparableIdentity(modelAsset, false);
  const device = readClickEventComparableIdentity(deviceType, true);
  if (model.dataPlatformModel?.sourceKey && device.dataPlatformModel?.sourceKey
    && model.dataPlatformModel.sourceKey !== device.dataPlatformModel.sourceKey) {
    return false;
  }
  if (model.sourceUrl && device.sourceUrl && model.sourceUrl === device.sourceUrl) return true;
  if (model.resourceKey !== null && device.resourceKey !== null && model.resourceKey === device.resourceKey) return true;
  if (model.resourceKey === null && device.resourceKey === null
    && model.localPathSha256 !== null && model.localPathSha256 === device.localPathSha256) {
    return true;
  }
  return false;
}
