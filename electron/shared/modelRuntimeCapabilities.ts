import { hashSha256 } from './sha256.ts';

/** 新包显式声明只读共享；旧包/未知协议一律沿用独占资源。声明不是脚本安全沙箱。 */
export type ModelRuntimeCapabilities = {
  version: 1;
  geometry: 'owned' | 'shared-readonly';
  materials: 'owned' | 'shared-readonly';
  configurationSha256: string;
  scripts: Record<string, string>;
};
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = new Set(['version', 'geometry', 'materials', 'configurationSha256', 'scripts']);

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** 只保留有界自有数据，不执行能力对象的 getter；失效只关闭优化，不破坏旧场景读取。 */
export function normalizeModelRuntimeCapabilities(value: unknown): ModelRuntimeCapabilities | undefined {
  if (!plain(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !FIELDS.has(key) || !('value' in descriptors[key]))) return undefined;
  const version = descriptors.version?.value, geometry = descriptors.geometry?.value,
    materials = descriptors.materials?.value, configurationSha256 = descriptors.configurationSha256?.value,
    sourceScripts: unknown = descriptors.scripts?.value;
  if (version !== 1 || !['owned', 'shared-readonly'].includes(geometry)
    || !['owned', 'shared-readonly'].includes(materials) || typeof configurationSha256 !== 'string'
    || !HASH.test(configurationSha256) || !plain(sourceScripts)) return undefined;
  const entries = Object.getOwnPropertyDescriptors(sourceScripts);
  if (Object.keys(entries).length > 64) return undefined;
  const scripts: Record<string, string> = {};
  for (const name of Object.keys(entries).sort()) {
    const descriptor = entries[name];
    if (!('value' in descriptor) || typeof descriptor.value !== 'string' || !HASH.test(descriptor.value)
      || name.length > 255 || !/^[^\\/\u0000-\u001f]+\.ts$/i.test(name) || /\.d\.ts$/i.test(name)) return undefined;
    Object.defineProperty(scripts, name, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return { version: 1, geometry, materials, configurationSha256, scripts };
}

export function modelRuntimeCapabilitiesField(value: unknown): { runtimeCapabilities?: ModelRuntimeCapabilities } {
  const capability = normalizeModelRuntimeCapabilities(value);
  return capability ? { runtimeCapabilities: capability } : {};
}

/** 路径、实例参数值和 assetCode 不属于只读声明；配置/脚本结构改变则必须重新认证。 */
export function modelRuntimeConfigurationKey(asset: {
  lengthUnit?: unknown; unitScaleToMeters?: unknown; parameterConfig?: unknown;
  parameterScriptMetadata?: unknown; animationScriptMetadata?: unknown; dataDrivenConfig?: unknown;
  builtInSlotBindingConfig?: unknown; layerChangePlatformBindingConfig?: unknown;
}): string {
  const value = {
    lengthUnit: asset.lengthUnit ?? 'meter', unitScaleToMeters: asset.unitScaleToMeters ?? 1,
    parameterConfig: asset.parameterConfig ?? null, parameterScriptMetadata: asset.parameterScriptMetadata ?? [],
    animationScriptMetadata: asset.animationScriptMetadata ?? [], dataDrivenConfig: asset.dataDrivenConfig ?? null,
    builtInSlotBindingConfig: asset.builtInSlotBindingConfig ?? null, layerChangePlatformBindingConfig: asset.layerChangePlatformBindingConfig ?? null,
  };
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!plain(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}

export function hashModelRuntimeConfiguration(asset: Parameters<typeof modelRuntimeConfigurationKey>[0]): Promise<string> {
  return hashSha256(new TextEncoder().encode(modelRuntimeConfigurationKey(asset)));
}
