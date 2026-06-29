export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';

export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
  packagePath?: string;
  metadataPath?: string;
  scriptPaths?: string[];
  displayName?: string;
  lengthUnit?: ModelSourceLengthUnit;
  unitScaleToMeters?: number;
};

export const MODEL_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-model-asset';

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
    const metadataPath = readOptionalString(payload, 'metadataPath');
    const scriptPaths = readOptionalStringArray(payload, 'scriptPaths');
    const displayName = readOptionalString(payload, 'displayName');
    const lengthUnit = readOptionalLengthUnit(payload);
    const unitScaleToMeters = readOptionalFiniteNumber(payload, 'unitScaleToMeters');

    if (packagePath) asset.packagePath = packagePath;
    if (metadataPath) asset.metadataPath = metadataPath;
    if (scriptPaths) asset.scriptPaths = scriptPaths;
    if (displayName) asset.displayName = displayName;
    if (lengthUnit) asset.lengthUnit = lengthUnit;
    if (unitScaleToMeters !== undefined) asset.unitScaleToMeters = unitScaleToMeters;

    return asset;
  } catch {
    return null;
  }
}
