import { createEntityHierarchyStateMap } from '../editor/model/entityHierarchy';
import type { SceneDocument } from '../editor/model/SceneDocument';

const DIGITAL_TWIN_ASSET_CODE_MAX_LENGTH = 128;

export type DigitalTwinAssetIndex = {
  entityIdsByAssetCode: Map<string, string[]>;
  effectiveVisibilityByEntityId: Map<string, boolean>;
};

export type DigitalTwinAssetLookupResult =
  | { status: 'invalid'; assetCode: string }
  | { status: 'not-found'; assetCode: string }
  | { status: 'ambiguous'; assetCode: string; entityIds: string[] }
  | { status: 'not-visible'; assetCode: string; entityId: string }
  | { status: 'found'; assetCode: string; entityId: string };

export type DigitalTwinGeneratedAssetCodeDiagnostic = {
  entityId: string;
  entityName: string;
  assetCode: string;
};

export type DigitalTwinDuplicateAssetCodeDiagnostic = {
  assetCode: string;
  entityIds: string[];
  entityNames: string[];
};

export type DigitalTwinAssetCodeDiagnostics = {
  generatedAssetCodes: DigitalTwinGeneratedAssetCodeDiagnostic[];
  duplicateAssetCodes: DigitalTwinDuplicateAssetCodeDiagnostic[];
};

function normalizeAssetCode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 为当前入口场景构建按资产编号查询的 O(1) 索引，并缓存父级继承后的有效显隐状态。 */
export function buildDigitalTwinAssetIndex(document: SceneDocument): DigitalTwinAssetIndex {
  const entityIdsByAssetCode = new Map<string, string[]>();
  const hierarchyStates = createEntityHierarchyStateMap(document.entityIds, document.entities);
  const effectiveVisibilityByEntityId = new Map<string, boolean>();

  for (const entityId of document.entityIds) {
    const entity = document.entities[entityId];
    if (!entity) continue;
    effectiveVisibilityByEntityId.set(entityId, hierarchyStates.get(entityId)?.visible ?? entity.visible !== false);

    const assetCode = normalizeAssetCode(entity.components.modelAsset?.assetCode);
    if (!assetCode) continue;
    const entityIds = entityIdsByAssetCode.get(assetCode);
    if (entityIds) entityIds.push(entityId);
    else entityIdsByAssetCode.set(assetCode, [entityId]);
  }

  return { entityIdsByAssetCode, effectiveVisibilityByEntityId };
}

/** 按 trim 后的完整字符串精确、区分大小写查询资产编号。 */
export function findDigitalTwinAsset(index: DigitalTwinAssetIndex, rawAssetCode: string): DigitalTwinAssetLookupResult {
  const assetCode = normalizeAssetCode(rawAssetCode);
  if (!assetCode || assetCode.length > DIGITAL_TWIN_ASSET_CODE_MAX_LENGTH) {
    return { status: 'invalid', assetCode };
  }

  const entityIds = index.entityIdsByAssetCode.get(assetCode);
  if (!entityIds?.length) return { status: 'not-found', assetCode };
  if (entityIds.length > 1) return { status: 'ambiguous', assetCode, entityIds: [...entityIds] };

  const entityId = entityIds[0];
  if (index.effectiveVisibilityByEntityId.get(entityId) === false) {
    return { status: 'not-visible', assetCode, entityId };
  }
  return { status: 'found', assetCode, entityId };
}

function createEntityShortId(entityId: string): string {
  const shortId = entityId.replace(/^entity_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return shortId || '00000000';
}

/** 默认导入编号以实体短 ID 为稳定后缀；该启发式只用于发布 warning，不作为阻断条件。 */
export function isLikelyGeneratedAssetCode(entityId: string, rawAssetCode: string): boolean {
  const assetCode = normalizeAssetCode(rawAssetCode);
  return Boolean(assetCode) && assetCode.endsWith(`-${createEntityShortId(entityId)}`);
}

/** 分析入口场景的默认自动编号和重复编号，供发布前非阻断 warning 使用。 */
export function analyzeDigitalTwinAssetCodes(document: SceneDocument): DigitalTwinAssetCodeDiagnostics {
  const index = buildDigitalTwinAssetIndex(document);
  const generatedAssetCodes: DigitalTwinGeneratedAssetCodeDiagnostic[] = [];

  for (const entityId of document.entityIds) {
    const entity = document.entities[entityId];
    const assetCode = normalizeAssetCode(entity?.components.modelAsset?.assetCode);
    if (!entity || !assetCode || !isLikelyGeneratedAssetCode(entityId, assetCode)) continue;
    generatedAssetCodes.push({ entityId, entityName: entity.name, assetCode });
  }

  const duplicateAssetCodes: DigitalTwinDuplicateAssetCodeDiagnostic[] = [];
  for (const [assetCode, entityIds] of index.entityIdsByAssetCode) {
    if (entityIds.length < 2) continue;
    duplicateAssetCodes.push({
      assetCode,
      entityIds: [...entityIds],
      entityNames: entityIds.map((entityId) => document.entities[entityId]?.name ?? entityId),
    });
  }

  return { generatedAssetCodes, duplicateAssetCodes };
}
