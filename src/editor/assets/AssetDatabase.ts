import type { ModelParameterConfig } from '../model/modelParameters';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import type { ModelScriptAsset } from '../model/components';

export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';

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
  parameterConfig?: ModelParameterConfig;
};

export const MODEL_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-model-asset';
export const ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-environment-model-asset';
export const BUILT_IN_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-built-in-asset';

export type BuiltInAssetDragPayload =
  | { kind: 'mesh'; meshKind: 'cube' | 'sphere' | 'plane' }
  | { kind: 'locator'; locatorKind: 'box-wire' }
  | { kind: 'light'; lightKind: 'hemispheric' | 'directional' | 'point' };

type AssetEntryRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AssetEntryRecord {
  return typeof value === 'object' && value !== null;
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

export function encodeModelAssetDragPayload(asset: AssetEntry): string {
  return JSON.stringify(asset);
}

export function encodeBuiltInAssetDragPayload(payload: BuiltInAssetDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeModelAssetDragPayload(rawPayload: string): AssetEntry | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isRecord(payload)) return null;
    if (payload.kind !== 'model') return null;
    if (typeof payload.id !== 'string') return null;
    if (typeof payload.name !== 'string') return null;
    if (typeof payload.path !== 'string') return null;
    if (typeof payload.sourceUrl !== 'string') return null;

    const asset: AssetEntry = {
      id: payload.id,
      name: payload.name,
      path: payload.path,
      sourceUrl: payload.sourceUrl,
      kind: 'model',
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
    const parameterConfig = normalizeModelParameterConfig(payload.parameterConfig);

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
    if (parameterConfig) asset.parameterConfig = parameterConfig;

    return asset;
  } catch {
    return null;
  }
}

export function decodeBuiltInAssetDragPayload(rawPayload: string): BuiltInAssetDragPayload | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isRecord(payload)) return null;

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
