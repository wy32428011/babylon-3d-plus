import { isPlatformImageReference, isRegisteredEditorImageReference } from '../../assets/imageAssets';

const SAFE_TEXTURE_EXTENSION_PATTERN = /[.](png|jpe?g|webp)$/i;
const WINDOWS_SEPARATOR = String.fromCharCode(92);
const LOCAL_EDITOR_ASSET_PREFIX = 'editor-asset://local/';

/** 纹理引用校验结果，区分内置 editor-image、数据中台同步图片与模型包相对路径三类来源。 */
export type TextureReferenceKind = 'builtin-image' | 'platform-image' | 'model-package-relative';

/** 规范化纹理扩展名白名单，保持旧配置可传 allowedExtensions 的能力。 */
function normalizeAllowedTextureExtensions(allowedExtensions?: string[]): string[] {
  return allowedExtensions?.length ? allowedExtensions : ['.png', '.jpg', '.jpeg', '.webp'];
}

/** 判断路径是否带任意协议或绝对路径前缀，防止纹理参数逃逸到外部来源。 */
function hasForbiddenTexturePrefix(value: string): boolean {
  return /^[a-z]+:/i.test(value) || value.startsWith('/') || value.startsWith(WINDOWS_SEPARATOR);
}

/** 判断是否为原模型包内的相对图片路径，拒绝任意协议、绝对路径、反斜杠和目录回退。 */
export function isModelPackageRelativeTexturePath(value: string, allowedExtensions?: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('..') || trimmed.includes(WINDOWS_SEPARATOR) || hasForbiddenTexturePrefix(trimmed)) return false;

  const extensions = normalizeAllowedTextureExtensions(allowedExtensions);
  if (!extensions.some((extension) => trimmed.toLowerCase().endsWith(extension.toLowerCase()))) return false;

  return SAFE_TEXTURE_EXTENSION_PATTERN.test(trimmed);
}

/** 判断是否为便携源工程中的数据中台贴图引用（editor-asset 相对 Assets/Images 路径）。 */
function isPortableImageAssetTextureUrl(value: string, allowedExtensions?: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith(LOCAL_EDITOR_ASSET_PREFIX)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(trimmed).pathname.slice(1));
  } catch {
    return false;
  }
  const normalized = decoded.replace(/\\/g, '/');
  if (!/^assets\/images\//i.test(normalized)) return false;
  const extensions = normalizeAllowedTextureExtensions(allowedExtensions);
  return extensions.some((extension) => normalized.toLowerCase().endsWith(extension.toLowerCase()))
    && SAFE_TEXTURE_EXTENSION_PATTERN.test(normalized);
}

/** 判断纹理参数是否为允许保存的引用：内置图片、数据中台同步图片、便携图片 URL 或模型包相对图片路径。 */
export function isAllowedTextureReference(value: string, allowedExtensions?: string[]): boolean {
  const trimmed = value.trim();
  return isRegisteredEditorImageReference(trimmed)
    || isPlatformImageReference(trimmed)
    || isPortableImageAssetTextureUrl(trimmed, allowedExtensions)
    || isModelPackageRelativeTexturePath(trimmed, allowedExtensions);
}

/** 返回纹理引用类型，供界面按来源展示缩略图或普通文本提示。 */
export function getTextureReferenceKind(value: string, allowedExtensions?: string[]): TextureReferenceKind | null {
  const trimmed = value.trim();
  if (isRegisteredEditorImageReference(trimmed)) return 'builtin-image';
  if (isPlatformImageReference(trimmed)) return 'platform-image';
  if (isModelPackageRelativeTexturePath(trimmed, allowedExtensions)) return 'model-package-relative';
  return null;
}
