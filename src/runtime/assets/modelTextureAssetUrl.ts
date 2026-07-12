import { resolveBuiltInImageSourceUrl } from '../../assets/imageAssets';
import { resolveRelativeEditorAssetUrl, resolveRuntimeAssetUrl } from './editorAssetUrl';

const MODEL_TEXTURE_EXTENSION_PATTERN = /\.(png|jpe?g|webp)$/i;

/** 模型贴图解析所需的模型包上下文，sourceUrl 指向模型主资源，assetRevision 指向导入版本。 */
export type ModelTextureAssetUrlContext = {
  sourceUrl: string;
  assetRevision?: string | null;
};

/**
 * 将模型参数中的逻辑贴图引用解析为 Babylon 可直接读取的 URL。
 * 内置 editor-image 引用使用全局图片库 URL，不追加模型导入版本；模型包相对贴图继续跟随 assetRevision 防缓存。
 */
export function resolveModelTextureAssetUrl(
  reference: string,
  context: ModelTextureAssetUrlContext,
): string | null {
  const normalizedReference = reference.trim();
  if (!normalizedReference) return null;

  const builtInImageUrl = resolveBuiltInImageSourceUrl(normalizedReference);
  if (builtInImageUrl) return builtInImageUrl;

  const editorAssetUrl = resolveRelativeEditorAssetUrl(
    context.sourceUrl,
    normalizedReference,
    MODEL_TEXTURE_EXTENSION_PATTERN,
  );
  if (!editorAssetUrl) return null;

  return createVersionedRuntimeAssetUrl(editorAssetUrl, context.assetRevision);
}

/** 为模型包相对贴图附加导入版本，避免同路径重新导入后仍命中旧纹理缓存。 */
function createVersionedRuntimeAssetUrl(sourceUrl: string, assetRevision: string | undefined | null): string {
  const runtimeUrl = resolveRuntimeAssetUrl(sourceUrl);
  if (!assetRevision) return runtimeUrl;

  const separator = runtimeUrl.includes('?') ? '&' : '?';
  return runtimeUrl + separator + "assetRevision=" + encodeURIComponent(assetRevision);
}
