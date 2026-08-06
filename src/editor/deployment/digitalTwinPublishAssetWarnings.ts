import type { DigitalTwinAssetCodeDiagnostics } from '../../shared/digitalTwinAssetCodes';

export type DigitalTwinPublishAssetWarningView = {
  requiresConfirmation: boolean;
  generatedCount: number;
  duplicateCount: number;
  detailLines: string[];
  truncatedCount: number;
};

const DUPLICATE_ENTITY_NAME_PREVIEW_LIMIT = 5;

function formatDuplicateAssetCodeLine(
  item: DigitalTwinAssetCodeDiagnostics['duplicateAssetCodes'][number],
): string {
  const previewNames = item.entityNames.slice(0, DUPLICATE_ENTITY_NAME_PREVIEW_LIMIT);
  const omittedNameCount = Math.max(0, item.entityNames.length - previewNames.length);
  const entitySummary = omittedNameCount > 0
    ? `${previewNames.join('、')} 等 ${item.entityNames.length} 个实体`
    : previewNames.join('、');
  return `重复编号：${item.assetCode}（${entitySummary}）`;
}

/** 把资产编号诊断压缩成发布 Dialog 可展示的有界 warning，避免大场景渲染无界列表。 */
export function createDigitalTwinPublishAssetWarningView(
  diagnostics: DigitalTwinAssetCodeDiagnostics,
  detailLimit = 8,
): DigitalTwinPublishAssetWarningView {
  const safeLimit = Number.isFinite(detailLimit) ? Math.max(0, Math.floor(detailLimit)) : 0;
  const detailLines: string[] = [];

  for (const item of diagnostics.generatedAssetCodes) {
    if (detailLines.length >= safeLimit) break;
    detailLines.push(`默认编号：${item.entityName}（${item.assetCode}）`);
  }
  for (const item of diagnostics.duplicateAssetCodes) {
    if (detailLines.length >= safeLimit) break;
    detailLines.push(formatDuplicateAssetCodeLine(item));
  }

  const totalWarningCount = diagnostics.generatedAssetCodes.length + diagnostics.duplicateAssetCodes.length;
  return {
    requiresConfirmation: totalWarningCount > 0,
    generatedCount: diagnostics.generatedAssetCodes.length,
    duplicateCount: diagnostics.duplicateAssetCodes.length,
    detailLines,
    truncatedCount: Math.max(0, totalWarningCount - detailLines.length),
  };
}
