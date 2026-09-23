import type { CompositionDefinition } from './compositionTypes.js';
export function validateComposition(value: unknown): asserts value is CompositionDefinition {
  const v = value as CompositionDefinition;
  if (!v || v.schemaVersion !== 1 || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100
    || !Array.isArray(v.nodes) || v.nodes.length > 4096) throw new Error('组合格式或成员数量无效。');
  const nodes = new Map(v.nodes.map(n => [n.id, n]));
  if (nodes.size !== v.nodes.length) throw new Error('组合层级存在重复节点。');
  let count = 0;
  for (const n of v.nodes) {
    if (typeof n.id !== 'string' || !n.id || n.id.length > 256 || typeof n.name !== 'string' || n.name.length > 256 || !n.components) throw new Error('组合节点无效。');
    const t = n.components.transform;
    if (!t || ![t.position,t.rotation,t.scale].every(v => v && [v.x,v.y,v.z].every(Number.isFinite)) || [t.scale.x,t.scale.y,t.scale.z].some(v => Math.abs(v)<1e-6)) throw new Error('组合变换无效。');
    const keys = Object.keys(n.components);
    if (keys.some(k => !['transform','modelAsset','meshRenderer','modelArrayInstance','locator'].includes(k)) || (n.isFolder && keys.some(k => k !== 'transform'))) throw new Error('组合包含不支持的场景组件。');
    if (!Array.isArray(n.childrenIds) || new Set(n.childrenIds).size !== n.childrenIds.length) throw new Error('组合层级无效。');
    if (!n.isFolder && !n.components.modelAsset && !n.components.meshRenderer && !(n.components.locator as { builtInBinding?: unknown })?.builtInBinding) throw new Error(`组合成员“${n.name}”不是可复用模型。`);
    if (!n.isFolder && (n.components.modelAsset || n.components.meshRenderer)) count++;
    if (n.parentId !== null && (!nodes.get(n.parentId)?.isFolder || !nodes.get(n.parentId)?.childrenIds.includes(n.id))) throw new Error('组合层级父节点无效。');
    for (const id of n.childrenIds) if (!n.isFolder || nodes.get(id)?.parentId !== n.id) throw new Error('组合层级子节点无效。');
    const seen = new Set([n.id]); let p = n.parentId;
    while (p) { if (seen.has(p) || seen.size > 64) throw new Error('组合层级循环或超过 64 层。'); seen.add(p); p = nodes.get(p)?.parentId ?? null; }
  }
  if (count < 2) throw new Error('组合至少需要两个有效模型。');
}

