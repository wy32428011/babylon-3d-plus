import type { Entity } from '../model/Entity';

export type HierarchyRow = {
  entity: Entity;
  depth: number;
};

type TraversalEntry = {
  entityId: string;
  depth: number;
  ancestorMatches: boolean;
};

/** 判断实体名称是否命中当前搜索关键字。 */
function matchesSearch(entity: Entity, query: string): boolean {
  return entity.name.toLocaleLowerCase().includes(query);
}

/** 按 childrenIds 顺序压入子项，使用逆序 stack 保持最终 DFS 展示顺序。 */
function pushChildren(
  stack: TraversalEntry[],
  entity: Entity,
  depth: number,
  ancestorMatches: boolean,
): void {
  if (!entity.isFolder) return;
  for (let index = entity.childrenIds.length - 1; index >= 0; index -= 1) {
    stack.push({ entityId: entity.childrenIds[index], depth, ancestorMatches });
  }
}

/**
 * 将场景实体整理为任意深度的 Hierarchy 行。
 * 无搜索时遵循折叠状态；搜索时展示命中项的祖先路径，文件夹自身命中则展示完整子树。
 */
export function buildHierarchyRows(
  entityIds: readonly string[],
  entities: Record<string, Entity>,
  searchText: string,
  collapsedFolderIds: ReadonlySet<string>,
): HierarchyRow[] {
  const query = searchText.trim().toLocaleLowerCase();
  const rootIds = entityIds.filter((entityId) => entities[entityId]?.parentId === null);
  const rows: HierarchyRow[] = [];
  const visited = new Set<string>();

  if (!query) {
    const stack: TraversalEntry[] = [];
    for (let index = rootIds.length - 1; index >= 0; index -= 1) {
      stack.push({ entityId: rootIds[index], depth: 0, ancestorMatches: false });
    }

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current.entityId)) continue;
      const entity = entities[current.entityId];
      if (!entity) continue;

      visited.add(entity.id);
      rows.push({ entity, depth: current.depth });
      if (!entity.isFolder || collapsedFolderIds.has(entity.id)) continue;
      pushChildren(stack, entity, current.depth + 1, false);
    }

    return rows;
  }

  const traversalOrder: string[] = [];
  const traversalStack = [...rootIds].reverse();
  while (traversalStack.length > 0) {
    const entityId = traversalStack.pop();
    if (!entityId || visited.has(entityId)) continue;
    const entity = entities[entityId];
    if (!entity) continue;

    visited.add(entityId);
    traversalOrder.push(entityId);
    if (!entity.isFolder) continue;
    for (let index = entity.childrenIds.length - 1; index >= 0; index -= 1) {
      traversalStack.push(entity.childrenIds[index]);
    }
  }

  const selfMatches = new Set<string>();
  const subtreeMatches = new Map<string, boolean>();
  for (const entityId of traversalOrder) {
    const entity = entities[entityId];
    if (entity && matchesSearch(entity, query)) selfMatches.add(entityId);
  }
  for (let index = traversalOrder.length - 1; index >= 0; index -= 1) {
    const entityId = traversalOrder[index];
    const entity = entities[entityId];
    if (!entity) continue;
    const childMatches = entity.isFolder === true
      && entity.childrenIds.some((childId) => subtreeMatches.get(childId) === true);
    subtreeMatches.set(entityId, selfMatches.has(entityId) || childMatches);
  }

  visited.clear();
  const stack: TraversalEntry[] = [];
  for (let index = rootIds.length - 1; index >= 0; index -= 1) {
    stack.push({ entityId: rootIds[index], depth: 0, ancestorMatches: false });
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current.entityId)) continue;
    const entity = entities[current.entityId];
    if (!entity) continue;

    const currentMatches = selfMatches.has(entity.id);
    const includeWholeSubtree = current.ancestorMatches || currentMatches;
    if (!includeWholeSubtree && subtreeMatches.get(entity.id) !== true) continue;

    visited.add(entity.id);
    rows.push({ entity, depth: current.depth });
    pushChildren(stack, entity, current.depth + 1, includeWholeSubtree);
  }

  return rows;
}

