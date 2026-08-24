import { createEntityHierarchyStateMap } from '../editor/model/entityHierarchy';
import type { SceneDocument } from '../editor/model/SceneDocument';
import { findDigitalTwinAsset, type DigitalTwinAssetIndex, type DigitalTwinAssetLookupResult } from './digitalTwinAssetCodes';

const DIGITAL_TWIN_QUERY_MAX_LENGTH = 128;
const DIGITAL_TWIN_SLOT_COORDINATE_MAX = 9999;
const SLOT_COORDINATE_PATTERN = /^(-?\d+)-(-?\d+)-(-?\d+)$/;

export type DigitalTwinSlotCoordinate = {
  row: number;
  column: number;
  layer: number;
};

export type DigitalTwinSlotLocatorRecord = {
  entityId: string;
  assetId: string;
  rowNumber: number;
  startColumn: number;
  startLayer: number;
  columns: number;
  layers: number;
  builtIn: boolean;
  hostEntityId: string | null;
};

export type DigitalTwinSlotIndex = {
  locators: DigitalTwinSlotLocatorRecord[];
  standaloneEntityIdsByAssetId: Map<string, string[]>;
  effectiveVisibilityByEntityId: Map<string, boolean>;
};

export type DigitalTwinFocusLookupResult =
  | DigitalTwinAssetLookupResult
  | { status: 'found'; assetCode: string; entityId: string; slot: DigitalTwinSlotCoordinate };

function normalizeQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoundedInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || Math.abs(parsed) > DIGITAL_TWIN_SLOT_COORDINATE_MAX) return null;
  return parsed;
}

/** 解析业务坐标「排-列-层」。排对应 rowNumber/to_z，列对应 to_x，层对应 to_y。 */
export function parseDigitalTwinSlotCoordinate(rawQuery: string): DigitalTwinSlotCoordinate | null {
  const query = normalizeQuery(rawQuery);
  const matched = SLOT_COORDINATE_PATTERN.exec(query);
  if (!matched) return null;
  const row = parseBoundedInteger(matched[1]);
  const column = parseBoundedInteger(matched[2]);
  const layer = parseBoundedInteger(matched[3]);
  if (row === null || column === null || layer === null) return null;
  return { row, column, layer };
}

function locatorCoversCoordinate(
  locator: DigitalTwinSlotLocatorRecord,
  coordinate: DigitalTwinSlotCoordinate,
): boolean {
  if (locator.rowNumber !== coordinate.row) return false;
  if (coordinate.column < locator.startColumn || coordinate.column >= locator.startColumn + locator.columns) {
    return false;
  }
  if (coordinate.layer < locator.startLayer || coordinate.layer >= locator.startLayer + locator.layers) {
    return false;
  }
  return true;
}

function isSlotVisible(index: DigitalTwinSlotIndex, locator: DigitalTwinSlotLocatorRecord): boolean {
  if (index.effectiveVisibilityByEntityId.get(locator.entityId) === false) return false;
  if (!locator.builtIn || !locator.hostEntityId) return true;
  return index.effectiveVisibilityByEntityId.get(locator.hostEntityId) !== false;
}

function resolveLocatorVisibility(
  index: DigitalTwinSlotIndex,
  assetCode: string,
  locators: DigitalTwinSlotLocatorRecord[],
  coordinate: DigitalTwinSlotCoordinate,
): DigitalTwinFocusLookupResult {
  if (locators.length > 1) {
    return { status: 'ambiguous', assetCode, entityIds: locators.map((locator) => locator.entityId) };
  }

  const locator = locators[0];
  if (!isSlotVisible(index, locator)) {
    return { status: 'not-visible', assetCode, entityId: locator.entityId };
  }
  return {
    status: 'found',
    assetCode,
    entityId: locator.entityId,
    slot: coordinate,
  };
}

/** 为当前入口场景构建货格覆盖范围索引；内置货格不进入独立 assetId 回退表。 */
export function buildDigitalTwinSlotIndex(document: SceneDocument): DigitalTwinSlotIndex {
  const hierarchyStates = createEntityHierarchyStateMap(document.entityIds, document.entities);
  const effectiveVisibilityByEntityId = new Map<string, boolean>();
  const locators: DigitalTwinSlotLocatorRecord[] = [];
  const standaloneEntityIdsByAssetId = new Map<string, string[]>();

  for (const entityId of document.entityIds) {
    const entity = document.entities[entityId];
    if (!entity) continue;
    effectiveVisibilityByEntityId.set(entityId, hierarchyStates.get(entityId)?.visible ?? entity.visible !== false);

    const locator = entity.components.locator;
    if (!locator) continue;
    const builtIn = Boolean(locator.builtInBinding);
    const record: DigitalTwinSlotLocatorRecord = {
      entityId,
      assetId: normalizeQuery(locator.assetId),
      rowNumber: locator.rowNumber,
      startColumn: locator.startColumn,
      startLayer: locator.startLayer,
      columns: locator.columns,
      layers: locator.layers,
      builtIn,
      hostEntityId: locator.builtInBinding?.hostEntityId ?? null,
    };
    locators.push(record);

    const cellCount = locator.columns * locator.layers;
    if (builtIn || cellCount !== 1 || !record.assetId) continue;
    const entityIds = standaloneEntityIdsByAssetId.get(record.assetId);
    if (entityIds) entityIds.push(entityId);
    else standaloneEntityIdsByAssetId.set(record.assetId, [entityId]);
  }

  return { locators, standaloneEntityIdsByAssetId, effectiveVisibilityByEntityId };
}

function findCoveringSlot(
  index: DigitalTwinSlotIndex,
  assetCode: string,
  coordinate: DigitalTwinSlotCoordinate,
): DigitalTwinFocusLookupResult {
  const covering = index.locators.filter((locator) => locatorCoversCoordinate(locator, coordinate));
  if (covering.length === 0) return { status: 'not-found', assetCode };
  return resolveLocatorVisibility(index, assetCode, covering, coordinate);
}

function findStandaloneSlot(
  index: DigitalTwinSlotIndex,
  assetCode: string,
): DigitalTwinFocusLookupResult {
  const entityIds = index.standaloneEntityIdsByAssetId.get(assetCode);
  if (!entityIds?.length) return { status: 'not-found', assetCode };
  const locators = entityIds
    .map((entityId) => index.locators.find((locator) => locator.entityId === entityId))
    .filter((locator): locator is DigitalTwinSlotLocatorRecord => Boolean(locator));
  if (locators.length === 0) return { status: 'not-found', assetCode };
  const locator = locators[0];
  return resolveLocatorVisibility(index, assetCode, locators, {
    row: locator.rowNumber,
    column: locator.startColumn,
    layer: locator.startLayer,
  });
}

/**
 * 发布 Viewer 搜索入口：模型资产编号优先，未命中后再查货格。
 * 货格先按「排-列-层」覆盖范围匹配，再回退到非内置单格 locator.assetId。
 */
export function findDigitalTwinFocusTarget(
  assetIndex: DigitalTwinAssetIndex,
  slotIndex: DigitalTwinSlotIndex,
  rawQuery: string,
): DigitalTwinFocusLookupResult {
  const assetLookup = findDigitalTwinAsset(assetIndex, rawQuery);
  if (assetLookup.status !== 'not-found') return assetLookup;

  const assetCode = normalizeQuery(rawQuery);
  if (!assetCode || assetCode.length > DIGITAL_TWIN_QUERY_MAX_LENGTH) {
    return { status: 'invalid', assetCode };
  }

  const coordinate = parseDigitalTwinSlotCoordinate(assetCode);
  if (coordinate) {
    const covering = findCoveringSlot(slotIndex, assetCode, coordinate);
    if (covering.status !== 'not-found') return covering;
  }

  return findStandaloneSlot(slotIndex, assetCode);
}
