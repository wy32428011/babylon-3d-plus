import type { ModelParameterConfig } from '../model/modelParameters';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import type { ModelScriptAsset, PoiEffectKind } from '../model/components';
import { findBuiltInImageAssetByReference, type BuiltInImageAsset } from '../../assets/imageAssets';
import { findSyncedImageAssetByReference } from '../../assets/syncedImageAssets';
import { normalizeModelDataDrivenConfig, type ModelDataDrivenConfig } from '../model/telemetryBinding';
import { normalizeBuiltInSlotBindingConfig, type BuiltInSlotBindingConfig } from '../model/builtInSlotBinding';
import { isPoiEffectKind } from '../model/poiEffect';

export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
export type SkyboxAssetFormat = 'hdr' | 'exr';
export type ModelAssetLibraryKind = 'model' | 'environment';

export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  assetRevision?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
  packagePath?: string;
  metadataPath?: string;
  scriptPaths?: string[];
  scriptAssets?: ModelScriptAsset[];
  parameterScriptMetadata?: unknown[];
  animationScriptMetadata?: unknown[];
  defaultAssetCode?: string;
  displayName?: string;
  lengthUnit?: ModelSourceLengthUnit;
  unitScaleToMeters?: number;
  fileSizeBytes?: number;
  parameterConfig?: ModelParameterConfig;
  dataDrivenConfig?: ModelDataDrivenConfig;
  builtInSlotBindingConfig?: BuiltInSlotBindingConfig;
  libraryKind?: ModelAssetLibraryKind;
  source?: 'project' | 'data-platform';
  availability?: 'active' | 'stale' | 'unavailable' | 'deleted';
  dataPlatformResourceId?: string;
  dataPlatformResourceType?: 'ENV_MODEL';
  dataPlatformSourceKey?: string;
  dataPlatformRevision?: string;
  dataPlatformFileRevision?: string;
  fileSha256?: string;
};

export type ProjectModelAssetEntry = AssetEntry & {
  kind: 'model';
  libraryKind: ModelAssetLibraryKind;
};

export type ProjectSkyboxAssetEntry = {
  id: string;
  name: string;
  displayName: string;
  path: string;
  sourceUrl: string;
  assetRevision: string;
  packagePath: string;
  kind: 'skybox';
  libraryKind: 'skybox';
  format: SkyboxAssetFormat;
  fileSizeBytes: number;
  source: 'project' | 'data-platform';
  availability: 'active' | 'orphaned';
  dataPlatformResourceId?: string;
  dataPlatformRevision?: string;
  fileSha256?: string;
};

export const MODEL_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-model-asset';
export const ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-environment-model-asset';
export const SKYBOX_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-skybox-asset';
export const BUILT_IN_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-built-in-asset';
export const IMAGE_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-image-asset';

/** 图片库拖拽载荷，只允许传递已登记内置图片的稳定引用和缩略图 URL。 */
export type ImageAssetDragPayload = Pick<BuiltInImageAsset, 'id' | 'name' | 'reference' | 'sourceUrl'>;

export type BuiltInAssetDragPayload =
  | { kind: 'model-generator' }
  | { kind: 'auto-patrol' }
  | { kind: 'manual-roam-spawn' }
  | { kind: 'click-event-binding' }
  | { kind: 'chart-marker' }
  | { kind: 'alarm-manager' }
  | { kind: 'poi-effect'; effectKind: PoiEffectKind }
  | { kind: 'mesh'; meshKind: 'cube' | 'sphere' | 'plane' }
  | { kind: 'locator'; locatorKind: 'box-wire' }
  | { kind: 'light'; lightKind: 'hemispheric' | 'directional' | 'point' };

type AssetEntryRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AssetEntryRecord {
  return typeof value === 'object' && value !== null;
}

const POSITIVE_DATA_PLATFORM_IDENTIFIER = /^[1-9]\d{0,63}$/;
const POSITIVE_DATA_PLATFORM_REVISION = /^[1-9]\d*$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function isPlainDataRecord(value: unknown): value is AssetEntryRecord {
  return isRecord(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function readOwnDataField(record: AssetEntryRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function hasOwnDataField(record: AssetEntryRecord, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return Boolean(descriptor && Object.hasOwn(descriptor, 'value'));
}

function readOptionalString(record: AssetEntryRecord, key: keyof AssetEntry): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalStringArray(record: AssetEntryRecord, key: keyof AssetEntry): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;

  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length === value.length ? strings : undefined;
}

function readOptionalScriptAssets(record: AssetEntryRecord): ModelScriptAsset[] | undefined {
  const value = record.scriptAssets;
  if (!Array.isArray(value)) return undefined;

  const assets = value.map((item) => {
    if (!isRecord(item)) return null;
    if (typeof item.path !== 'string' || typeof item.sourceUrl !== 'string' || typeof item.name !== 'string') return null;
    return { path: item.path, sourceUrl: item.sourceUrl, name: item.name };
  });

  return assets.every(Boolean) ? assets as ModelScriptAsset[] : undefined;
}

function readOptionalLengthUnit(record: AssetEntryRecord): ModelSourceLengthUnit | undefined {
  const value = record.lengthUnit;
  return value === 'meter' || value === 'centimeter' || value === 'millimeter' ? value : undefined;
}

function readOptionalFiniteNumber(record: AssetEntryRecord, key: keyof AssetEntry): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 读取并校验项目模型所属分库，避免旧载荷或非法载荷跨库生效。 */
function readProjectModelLibraryKind(record: AssetEntryRecord): ModelAssetLibraryKind | null {
  return record.libraryKind === 'model' || record.libraryKind === 'environment' ? record.libraryKind : null;
}

/** 编码项目模型拖拽载荷时保留分库标识，供接收端二次校验 MIME 与资产归属。 */
export function encodeModelAssetDragPayload(asset: ProjectModelAssetEntry): string {
  return JSON.stringify(asset);
}

export function encodeSkyboxAssetDragPayload(asset: ProjectSkyboxAssetEntry): string {
  return JSON.stringify(asset);
}

export function encodeBuiltInAssetDragPayload(payload: BuiltInAssetDragPayload): string {
  return JSON.stringify(payload);
}

/** 编码图片资产拖拽载荷，保持 DataTransfer 中只有必要的内置图片字段。 */
export function encodeImageAssetDragPayload(asset: ImageAssetDragPayload): string {
  return JSON.stringify({
    id: asset.id,
    name: asset.name,
    reference: asset.reference,
    sourceUrl: asset.sourceUrl,
  });
}

/** 解码项目模型拖拽载荷；缺少 libraryKind 的旧载荷会被拒绝，防止静默跨库。 */
export function decodeModelAssetDragPayload(rawPayload: string): ProjectModelAssetEntry | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isRecord(payload)) return null;
    if (payload.kind !== 'model') return null;
    const libraryKind = readProjectModelLibraryKind(payload);
    if (!libraryKind) return null;
    if (typeof payload.id !== 'string') return null;
    if (typeof payload.name !== 'string') return null;
    if (typeof payload.path !== 'string') return null;
    if (typeof payload.sourceUrl !== 'string') return null;

    const asset: ProjectModelAssetEntry = {
      id: payload.id,
      name: payload.name,
      path: payload.path,
      sourceUrl: payload.sourceUrl,
      kind: 'model',
      libraryKind,
    };

    const packagePath = readOptionalString(payload, 'packagePath');
    const assetRevision = readOptionalString(payload, 'assetRevision');
    const metadataPath = readOptionalString(payload, 'metadataPath');
    const thumbnailPath = readOptionalString(payload, 'thumbnailPath');
    const thumbnailUrl = readOptionalString(payload, 'thumbnailUrl');
    const scriptPaths = readOptionalStringArray(payload, 'scriptPaths');
    const scriptAssets = readOptionalScriptAssets(payload);
    const displayName = readOptionalString(payload, 'displayName');
    const defaultAssetCode = readOptionalString(payload, 'defaultAssetCode');
    const lengthUnit = readOptionalLengthUnit(payload);
    const unitScaleToMeters = readOptionalFiniteNumber(payload, 'unitScaleToMeters');
    const fileSizeBytes = readOptionalFiniteNumber(payload, 'fileSizeBytes');
    const parameterConfig = normalizeModelParameterConfig(payload.parameterConfig);
    const dataDrivenConfig = normalizeModelDataDrivenConfig(payload.dataDrivenConfig);
    const builtInSlotBindingConfig = normalizeBuiltInSlotBindingConfig(payload.builtInSlotBindingConfig);

    if (packagePath) asset.packagePath = packagePath;
    if (assetRevision) asset.assetRevision = assetRevision;
    if (metadataPath) asset.metadataPath = metadataPath;
    if (thumbnailPath) asset.thumbnailPath = thumbnailPath;
    if (thumbnailUrl) asset.thumbnailUrl = thumbnailUrl;
    if (scriptPaths) asset.scriptPaths = scriptPaths;
    if (scriptAssets) asset.scriptAssets = scriptAssets;
    if (Array.isArray(payload.parameterScriptMetadata)) asset.parameterScriptMetadata = payload.parameterScriptMetadata;
    if (Array.isArray(payload.animationScriptMetadata)) asset.animationScriptMetadata = payload.animationScriptMetadata;
    if (defaultAssetCode) asset.defaultAssetCode = defaultAssetCode;
    if (displayName) asset.displayName = displayName;
    if (lengthUnit) asset.lengthUnit = lengthUnit;
    if (unitScaleToMeters !== undefined) asset.unitScaleToMeters = unitScaleToMeters;
    if (fileSizeBytes !== undefined && fileSizeBytes > 0) asset.fileSizeBytes = Math.floor(fileSizeBytes);
    if (parameterConfig) asset.parameterConfig = parameterConfig;
    if (dataDrivenConfig) asset.dataDrivenConfig = dataDrivenConfig;
    if (builtInSlotBindingConfig) asset.builtInSlotBindingConfig = builtInSlotBindingConfig;
    const source = payload.source === 'project' || payload.source === 'data-platform' ? payload.source : undefined;
    const availability = payload.availability === 'active' || payload.availability === 'stale'
      || payload.availability === 'unavailable' || payload.availability === 'deleted'
        ? payload.availability
        : undefined;
    const dataPlatformResourceId = readOptionalString(payload, 'dataPlatformResourceId');
    const dataPlatformResourceType = payload.dataPlatformResourceType === 'ENV_MODEL' ? 'ENV_MODEL' : undefined;
    const dataPlatformSourceKey = readOptionalString(payload, 'dataPlatformSourceKey');
    const dataPlatformRevision = readOptionalString(payload, 'dataPlatformRevision');
    const dataPlatformFileRevision = readOptionalString(payload, 'dataPlatformFileRevision');
    const fileSha256 = readOptionalString(payload, 'fileSha256');
    if (source) asset.source = source;
    if (availability) asset.availability = availability;
    if (dataPlatformResourceId) asset.dataPlatformResourceId = dataPlatformResourceId;
    if (dataPlatformResourceType) asset.dataPlatformResourceType = dataPlatformResourceType;
    if (dataPlatformSourceKey) asset.dataPlatformSourceKey = dataPlatformSourceKey;
    if (dataPlatformRevision) asset.dataPlatformRevision = dataPlatformRevision;
    if (dataPlatformFileRevision) asset.dataPlatformFileRevision = dataPlatformFileRevision;
    if (fileSha256) asset.fileSha256 = fileSha256;

    return asset;
  } catch {
    return null;
  }
}

/** 解码项目天空盒拖拽载荷；旧本地载荷补齐 project/active，中台载荷执行严格来源校验。 */
export function decodeSkyboxAssetDragPayload(rawPayload: string): ProjectSkyboxAssetEntry | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isPlainDataRecord(payload)) return null;

    const kind = readOwnDataField(payload, 'kind');
    const libraryKind = readOwnDataField(payload, 'libraryKind');
    const id = readOwnDataField(payload, 'id');
    const name = readOwnDataField(payload, 'name');
    const displayName = readOwnDataField(payload, 'displayName');
    const assetPath = readOwnDataField(payload, 'path');
    const packagePath = readOwnDataField(payload, 'packagePath');
    const sourceUrl = readOwnDataField(payload, 'sourceUrl');
    const assetRevision = readOwnDataField(payload, 'assetRevision');
    const format = readOwnDataField(payload, 'format');
    const fileSizeBytes = readOwnDataField(payload, 'fileSizeBytes');
    const sourceValue = readOwnDataField(payload, 'source');
    const availabilityValue = readOwnDataField(payload, 'availability');
    const source = sourceValue ?? 'project';
    const availability = availabilityValue ?? 'active';

    if (hasOwnDataField(payload, 'source') && sourceValue == null) return null;
    if (hasOwnDataField(payload, 'availability') && availabilityValue == null) return null;
    if (kind !== 'skybox' || libraryKind !== 'skybox') return null;
    if (typeof id !== 'string' || !id.trim()) return null;
    if (typeof name !== 'string' || !name.trim()) return null;
    if (typeof displayName !== 'string' || !displayName.trim()) return null;
    if (typeof assetPath !== 'string' || !assetPath.trim()) return null;
    if (typeof packagePath !== 'string' || !packagePath.trim()) return null;
    if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith('editor-asset://local/')) return null;
    if (typeof assetRevision !== 'string' || !assetRevision.trim()) return null;
    if (format !== 'hdr' && format !== 'exr') return null;
    if (typeof fileSizeBytes !== 'number' || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) return null;
    if (source !== 'project' && source !== 'data-platform') return null;
    if (availability !== 'active') return null;

    const expectedExtension = format === 'hdr' ? /\.hdr$/i : /\.exr$/i;
    if (!expectedExtension.test(assetPath) || !expectedExtension.test(name)) return null;

    const asset: ProjectSkyboxAssetEntry = {
      id,
      name,
      displayName,
      path: assetPath,
      sourceUrl,
      assetRevision,
      packagePath,
      kind: 'skybox',
      libraryKind: 'skybox',
      format,
      fileSizeBytes,
      source,
      availability: 'active',
    };

    const hasDataPlatformMetadata = ['dataPlatformResourceId', 'dataPlatformRevision', 'fileSha256']
      .some((key) => hasOwnDataField(payload, key));
    if (source === 'project') {
      if (id.startsWith('data-platform-skybox:') || hasDataPlatformMetadata) return null;
      return asset;
    }

    if (!hasOwnDataField(payload, 'source') || !hasOwnDataField(payload, 'availability')) return null;
    const dataPlatformResourceId = readOwnDataField(payload, 'dataPlatformResourceId');
    const dataPlatformRevision = readOwnDataField(payload, 'dataPlatformRevision');
    const fileSha256 = readOwnDataField(payload, 'fileSha256');
    if (typeof dataPlatformResourceId !== 'string' || !POSITIVE_DATA_PLATFORM_IDENTIFIER.test(dataPlatformResourceId)) return null;
    if (typeof dataPlatformRevision !== 'string' || !POSITIVE_DATA_PLATFORM_REVISION.test(dataPlatformRevision)) return null;
    if (typeof fileSha256 !== 'string' || !LOWERCASE_SHA256.test(fileSha256)) return null;
    if (id !== `data-platform-skybox:${dataPlatformResourceId}` || assetRevision !== fileSha256) return null;

    return {
      ...asset,
      source: 'data-platform',
      dataPlatformResourceId,
      dataPlatformRevision,
      fileSha256,
    };
  } catch {
    return null;
  }
}

/** 解码图片资产拖拽载荷，并回查内置登记表，拒绝伪造引用或构建 URL。 */
export function decodeImageAssetDragPayload(rawPayload: string): ImageAssetDragPayload | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isRecord(payload)) return null;
    if (typeof payload.id !== 'string' || !payload.id.trim()) return null;
    if (typeof payload.name !== 'string' || !payload.name.trim()) return null;
    if (typeof payload.reference !== 'string' || !payload.reference.trim()) return null;
    if (typeof payload.sourceUrl !== 'string' || !payload.sourceUrl.trim()) return null;

    const normalizedReference = payload.reference.trim();
    const registeredAsset = findBuiltInImageAssetByReference(normalizedReference);
    const syncedAsset = registeredAsset ? null : findSyncedImageAssetByReference(normalizedReference);
    const matchedAsset = registeredAsset ?? syncedAsset;
    if (!matchedAsset) return null;
    if (payload.id !== matchedAsset.id || payload.name !== matchedAsset.name || payload.sourceUrl !== matchedAsset.sourceUrl) return null;

    return {
      id: matchedAsset.id,
      name: matchedAsset.name,
      reference: matchedAsset.reference,
      sourceUrl: matchedAsset.sourceUrl,
    };
  } catch {
    return null;
  }
}

export function decodeBuiltInAssetDragPayload(rawPayload: string): BuiltInAssetDragPayload | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isRecord(payload)) return null;

    if (payload.kind === 'model-generator') {
      return { kind: 'model-generator' };
    }

    if (payload.kind === 'auto-patrol') {
      return { kind: 'auto-patrol' };
    }

    if (payload.kind === 'manual-roam-spawn') {
      return { kind: 'manual-roam-spawn' };
    }

    if (payload.kind === 'click-event-binding') {
      return { kind: 'click-event-binding' };
    }

    if (payload.kind === 'alarm-manager') return { kind: 'alarm-manager' };
    if (payload.kind === 'chart-marker') return { kind: 'chart-marker' };

    if (payload.kind === 'poi-effect') {
      return isPoiEffectKind(payload.effectKind)
        ? { kind: 'poi-effect', effectKind: payload.effectKind }
        : null;
    }

    if (payload.kind === 'mesh') {
      const meshKind = payload.meshKind;
      if (meshKind !== 'cube' && meshKind !== 'sphere' && meshKind !== 'plane') return null;
      return { kind: 'mesh', meshKind };
    }

    if (payload.kind === 'locator') {
      const locatorKind = payload.locatorKind;
      if (locatorKind !== 'box-wire') return null;
      return { kind: 'locator', locatorKind };
    }

    if (payload.kind === 'light') {
      const lightKind = payload.lightKind;
      if (lightKind !== 'hemispheric' && lightKind !== 'directional' && lightKind !== 'point') return null;
      return { kind: 'light', lightKind };
    }

    return null;
  } catch {
    return null;
  }
}
