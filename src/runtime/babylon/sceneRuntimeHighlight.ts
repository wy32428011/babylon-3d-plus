/** 合并编辑器选区和 Viewer 外部描边，保持输入集合不变且按首次出现顺序去重。 */
export function mergeSceneRuntimeHighlightEntityIds(
  selectedEntityIds: ReadonlySet<string>,
  externalHighlightedEntityIds: ReadonlySet<string>,
): Set<string> {
  return new Set([...selectedEntityIds, ...externalHighlightedEntityIds]);
}
