import directionArrowGlowUrl from './images/direction-arrow-glow.png';
import autoPatrolUrl from './images/auto-patrol.png';
import paiLogoUrl from './images/pai-logo.png';
import zendingUrl from './branding/zending-logo-on-light.png';
/** 内置图片资产描述，限定图片库和拖拽载荷只暴露编辑器登记过的图片。 */
export type BuiltInImageAsset = {
  id: string;
  name: string;
  reference: string;
  sourceUrl: string;
};

/** 方向箭头贴图的稳定逻辑引用，场景参数只保存该引用而不保存构建后的 URL。 */
export const DIRECTION_ARROW_GLOW_IMAGE_REFERENCE = 'editor-image://builtin/direction-arrow-glow' as const;
export const AUTO_PATROL_IMAGE_REFERENCE = 'editor-image://builtin/auto-patrol' as const;
export const PAI_LOGO_IMAGE_REFERENCE = 'editor-image://builtin/pai-logo' as const;
export const ZENDING_LOGO_IMAGE_REFERENCE = 'editor-image://builtin/zending-logo' as const;
/** 编辑器内置图片清单，后续新增图片必须先在这里登记才允许进入参数和拖拽流程。 */
export const BUILT_IN_IMAGE_ASSETS: BuiltInImageAsset[] = [
  {
    id: 'builtin-direction-arrow-glow',
    name: '方向箭头发光贴图',
    reference: DIRECTION_ARROW_GLOW_IMAGE_REFERENCE,
    sourceUrl: directionArrowGlowUrl,
  },
  {
    id: 'builtin-auto-patrol',
    name: '自动巡检',
    reference: AUTO_PATROL_IMAGE_REFERENCE,
    sourceUrl: autoPatrolUrl,
  },
  {
    id: 'builtin-pai-logo',
    name: '排号logo',
    reference: PAI_LOGO_IMAGE_REFERENCE,
    sourceUrl: paiLogoUrl,
  },
  {
    id: 'builtin-zending-logo',
    name: '中鼎科技logo',
    reference: ZENDING_LOGO_IMAGE_REFERENCE,
    sourceUrl: zendingUrl,
  },
];

/** 判断字符串是否为已登记的 editor-image 内置图片引用。 */
export function isRegisteredEditorImageReference(value: string): value is BuiltInImageAsset['reference'] {
  return BUILT_IN_IMAGE_ASSETS.some((asset) => asset.reference === value);
}

/** 按逻辑引用查找内置图片资产，用于 Inspector 缩略图和拖拽解码后的二次校验。 */
export function findBuiltInImageAssetByReference(reference: string): BuiltInImageAsset | null {
  return BUILT_IN_IMAGE_ASSETS.find((asset) => asset.reference === reference) ?? null;
}

/** 将已登记的内置图片引用解析为可展示缩略图 URL，未知引用返回空值。 */
export function resolveBuiltInImageSourceUrl(reference: string): string | null {
  return findBuiltInImageAssetByReference(reference)?.sourceUrl ?? null;
}
