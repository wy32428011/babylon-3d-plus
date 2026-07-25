import type { Entity } from './Entity';

export type EntityHierarchyState = {
  visible: boolean;
  locked: boolean;
};

/** 返回选区中没有已选祖先的最高层实体，保持输入顺序并移除重复项。 */
export function getTopLevelHierarchyEntityIds(
  entities: Record<string, Entity>,
  entityIds: readonly string[],
): string[] {
  const uniqueIds = [...new Set(entityIds)].filter((entityId) => Boolean(entities[entityId]));
  const selectedIdSet = new Set(uniqueIds);
  const hasSelectedAncestorByEntityId = new Map<string, boolean>();

  function hasSelectedAncestor(entityId: string): boolean {
    const cached = hasSelectedAncestorByEntityId.get(entityId);
    if (cached !== undefined) return cached;

    const path: string[] = [];
    const pathIdSet = new Set<string>();
    let currentId: string | null = entityId;
    let result = false;

    while (currentId && !pathIdSet.has(currentId)) {
      const currentCached = hasSelectedAncestorByEntityId.get(currentId);
      if (currentCached !== undefined) {
        result = currentCached;
        break;
      }

      path.push(currentId);
      pathIdSet.add(currentId);
      const parentId: string | null = entities[currentId]?.parentId ?? null;
      if (!parentId) break;
      if (selectedIdSet.has(parentId)) {
        result = true;
        break;
      }
      currentId = parentId;
    }

    for (const pathEntityId of path) hasSelectedAncestorByEntityId.set(pathEntityId, result);
    return result;
  }

  return uniqueIds.filter((entityId) => !hasSelectedAncestor(entityId));
}

/** 判断 ancestorId 是否位于 entityId 的父级链上。 */
export function isEntityAncestorOf(
  entities: Record<string, Entity>,
  ancestorId: string,
  entityId: string,
): boolean {
  const visited = new Set<string>([entityId]);
  let parentId = entities[entityId]?.parentId ?? null;

  while (parentId) {
    if (parentId === ancestorId) return true;
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    parentId = entities[parentId]?.parentId ?? null;
  }

  return false;
}

/** 以深度优先顺序返回实体子树，默认包含根实体；异常循环会被 visited 截断。 */
export function collectEntitySubtreeIds(
  entities: Record<string, Entity>,
  rootEntityId: string,
  includeRoot = true,
): string[] {
  if (!entities[rootEntityId]) return [];

  const result: string[] = [];
  const visited = new Set<string>();
  const stack = [rootEntityId];

  while (stack.length > 0) {
    const entityId = stack.pop();
    if (!entityId || visited.has(entityId)) continue;
    const entity = entities[entityId];
    if (!entity) continue;

    visited.add(entityId);
    if (includeRoot || entityId !== rootEntityId) result.push(entityId);

    if (!entity.isFolder) continue;
    for (let index = entity.childrenIds.length - 1; index >= 0; index -= 1) {
      stack.push(entity.childrenIds[index]);
    }
  }

  return result;
}

/** 任意祖先锁定都会使实体不可编辑。 */
export function isEntityEffectivelyLocked(
  entities: Record<string, Entity>,
  entity: Entity | null | undefined,
): boolean {
  if (!entity) return false;

  const visited = new Set<string>();
  let current: Entity | null | undefined = entity;
  while (current && !visited.has(current.id)) {
    if (current.locked === true) return true;
    visited.add(current.id);
    current = current.parentId ? entities[current.parentId] : null;
  }

  return false;
}

/** 实体自身和全部祖先均可见时，实体才在运行时可见。 */
export function isEntityEffectivelyVisible(
  entities: Record<string, Entity>,
  entity: Entity | null | undefined,
): boolean {
  if (!entity) return false;

  const visited = new Set<string>();
  let current: Entity | null | undefined = entity;
  while (current && !visited.has(current.id)) {
    if (current.visible === false) return false;
    visited.add(current.id);
    current = current.parentId ? entities[current.parentId] : null;
  }

  return true;
}

/**
 * 一次性计算全场景的继承显隐/锁定状态。
 * 每个实体及父级链只会解析一次，供大场景运行时同步复用。
 */
export function createEntityHierarchyStateMap(
  entityIds: readonly string[],
  entities: Record<string, Entity>,
): Map<string, EntityHierarchyState> {
  const stateByEntityId = new Map<string, EntityHierarchyState>();

  for (const entityId of entityIds) {
    if (!entities[entityId] || stateByEntityId.has(entityId)) continue;

    const chain: Entity[] = [];
    const chainIdSet = new Set<string>();
    let current: Entity | null | undefined = entities[entityId];

    while (current && !stateByEntityId.has(current.id) && !chainIdSet.has(current.id)) {
      chain.push(current);
      chainIdSet.add(current.id);
      current = current.parentId ? entities[current.parentId] : null;
    }

    let inheritedState = current ? stateByEntityId.get(current.id) : undefined;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const chainEntity = chain[index];
      inheritedState = {
        visible: (inheritedState?.visible ?? true) && chainEntity.visible !== false,
        locked: (inheritedState?.locked ?? false) || chainEntity.locked === true,
      };
      stateByEntityId.set(chainEntity.id, inheritedState);
    }
  }

  return stateByEntityId;
}
