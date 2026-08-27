import directionArrowGlowUrl from './images/direction-arrow-glow.png';
import autoPatrolUrl from './images/auto-patrol.png';
import paiLogoUrl from './images/pai-logo.png';
import zendingUrl from './branding/zending-logo-on-light.png';
/** 方向箭头贴图的稳定逻辑引用，场景参数只保存该引用而不保存构建后的 URL。 */
export const DIRECTION_ARROW_GLOW_IMAGE_REFERENCE = 'editor-image://builtin/direction-arrow-glow';
export const AUTO_PATROL_IMAGE_REFERENCE = 'editor-image://builtin/auto-patrol';
export const PAI_LOGO_IMAGE_REFERENCE = 'editor-image://builtin/pai-logo';
export const ZENDING_LOGO_IMAGE_REFERENCE = 'editor-image://builtin/zending-logo';
/** 编辑器内置图片清单，后续新增图片必须先在这里登记才允许进入参数和拖拽流程。 */
export const BUILT_IN_IMAGE_ASSETS = [
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
export function isRegisteredEditorImageReference(value) {
    return BUILT_IN_IMAGE_ASSETS.some((asset) => asset.reference === value);
}
/** 按逻辑引用查找内置图片资产，用于 Inspector 缩略图和拖拽解码后的二次校验。 */
export function findBuiltInImageAssetByReference(reference) {
    return BUILT_IN_IMAGE_ASSETS.find((asset) => asset.reference === reference) ?? null;
}
/** 将已登记的内置图片引用解析为可展示缩略图 URL，未知引用返回空值。 */
export function resolveBuiltInImageSourceUrl(reference) {
    return findBuiltInImageAssetByReference(reference)?.sourceUrl ?? null;
}
/** 数据中台同步图片的稳定引用前缀，场景只保存前缀 + iconKey。 */
export const PLATFORM_IMAGE_REFERENCE_PREFIX = 'editor-image://platform/';
/** 数据中台图标 Key 命名规则，与后端 dt_bigscreen_icon 约束保持一致。 */
const PLATFORM_ICON_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
/** 生成数据中台同步图片的稳定逻辑引用。 */
export function createPlatformImageReference(iconKey) {
    if (!PLATFORM_ICON_KEY_PATTERN.test(iconKey)) {
        throw new Error(`数据中台图标 Key 格式不正确：${iconKey}`);
    }
    return `${PLATFORM_IMAGE_REFERENCE_PREFIX}${iconKey}`;
}
/** 判断字符串是否为合法格式的数据中台同步图片引用，不校验本地登记状态。 */
export function isPlatformImageReference(value) {
    if (!value.startsWith(PLATFORM_IMAGE_REFERENCE_PREFIX))
        return false;
    return PLATFORM_ICON_KEY_PATTERN.test(value.slice(PLATFORM_IMAGE_REFERENCE_PREFIX.length));
}
