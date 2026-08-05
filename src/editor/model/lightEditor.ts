import type { LightKind } from './components';

export type LightTransformTool = 'translate' | 'rotate' | 'scale';
export type LightTransformField = 'position' | 'rotation' | 'scale';
export type LightEditorMarkerKind = 'point' | 'directional';

export type LightEditorCapabilities = {
  markerKind: LightEditorMarkerKind | null;
  supportedTools: readonly LightTransformTool[];
  transformFields: readonly LightTransformField[];
};

const LIGHT_EDITOR_CAPABILITIES: Record<LightKind, LightEditorCapabilities> = {
  hemispheric: {
    markerKind: null,
    supportedTools: [],
    transformFields: ['position'],
  },
  point: {
    markerKind: 'point',
    supportedTools: ['translate'],
    transformFields: ['position'],
  },
  directional: {
    markerKind: 'directional',
    supportedTools: ['translate', 'rotate'],
    transformFields: ['position', 'rotation'],
  },
};

/** 返回灯光在编辑器中的可视标记、Gizmo 工具和 Inspector 字段能力。 */
export function getLightEditorCapabilities(lightKind: LightKind): LightEditorCapabilities {
  return LIGHT_EDITOR_CAPABILITIES[lightKind];
}

/** 灯光请求无效工具时统一回退移动，避免出现无效果的旋转或缩放 Gizmo。 */
export function resolveLightTransformTool(
  lightKind: LightKind,
  requestedTool: LightTransformTool,
): LightTransformTool {
  const supportedTools = LIGHT_EDITOR_CAPABILITIES[lightKind].supportedTools;
  return supportedTools.includes(requestedTool) ? requestedTool : 'translate';
}

/** 半球光仍复用 position 数据字段，但 Inspector 应明确表达其实际方向语义。 */
export function getLightTransformFieldLabel(
  lightKind: LightKind,
  field: LightTransformField,
): LightTransformField | 'direction' {
  return lightKind === 'hemispheric' && field === 'position' ? 'direction' : field;
}
