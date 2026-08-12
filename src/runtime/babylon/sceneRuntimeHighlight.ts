/** 合并编辑器选区、Viewer 本地选区和外部临时描边，调用方输入保持只读。 */
export function mergeSceneRuntimeHighlightEntityIds(
  ...highlightSources: readonly ReadonlySet<string>[]
): Set<string> {
  const merged = new Set<string>();
  for (const source of highlightSources) {
    for (const entityId of source) merged.add(entityId);
  }
  return merged;
}
