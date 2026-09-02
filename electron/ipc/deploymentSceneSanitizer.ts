/** 删除部署场景中仅供编辑器资源面板使用的缩略图 URL。 */
export function removeOptionalEditorOnlyUrls(value: unknown): void {
  removeOptionalEditorOnlyUrlsAtContext(value);
}

function removeOptionalEditorOnlyUrlsAtContext(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) removeOptionalEditorOnlyUrlsAtContext(item);
    return;
  }
  if (!isPlainObject(value)) return;

  delete value.thumbnailUrl;

  for (const child of Object.values(value)) {
    removeOptionalEditorOnlyUrlsAtContext(child);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
