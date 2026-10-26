import type { Entity } from '../model/Entity';
import type { SceneDocument } from '../model/SceneDocument';

/**
 * 命令执行前后场景差异的最小记录：只保留被替换/删除的旧实体和少量顶层字段，
 * 不再整份持有执行前的文档（其实体字典随场景规模线性增长，且历史最多保留数百条）。
 * 序列化与“是否有未保存修改”依赖实体字典的键顺序，因此撤销必须精确还原键顺序。
 */
export type ScenePatch = {
  /** 命令前后都存在但对象不同的实体：保存执行前的版本。 */
  readonly changed: ReadonlyMap<string, Entity>;
  /** 命令删除的实体及其在执行前字典中的位置，按位置升序。 */
  readonly removed: readonly { readonly id: string; readonly index: number; readonly entity: Entity }[];
  /** 命令新增的实体键。 */
  readonly added: ReadonlySet<string>;
  /** 顶层字段（含 entityIds）中前后引用不同的执行前取值。 */
  readonly topLevel: Readonly<Record<string, unknown>>;
  /** 命令前后实体字典引用相同。 */
  readonly entitiesUnchanged: boolean;
};

/**
 * 计算 before 经命令得到 after 的补丁。
 * 仅当两边公共键的相对顺序一致（即命令只是原位替换、删除或追加）时才能无损还原键顺序，否则返回 null，
 * 调用方应继续保留整份旧文档。
 */
export function captureScenePatch(before: SceneDocument, after: SceneDocument): ScenePatch | null {
  const topLevel: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'entities') continue;
    const previous = (before as Record<string, unknown>)[key];
    if (previous !== (after as Record<string, unknown>)[key]) topLevel[key] = previous;
  }
  if (before.entities === after.entities) {
    return { changed: new Map(), removed: [], added: new Set(), topLevel, entitiesUnchanged: true };
  }

  const beforeKeys = Object.keys(before.entities);
  const afterKeys = Object.keys(after.entities);
  const beforeKeySet = new Set(beforeKeys);
  const afterKeySet = new Set(afterKeys);

  const removed: { id: string; index: number; entity: Entity }[] = [];
  const retainedBefore: string[] = [];
  beforeKeys.forEach((id, index) => {
    if (afterKeySet.has(id)) retainedBefore.push(id);
    else removed.push({ id, index, entity: before.entities[id] });
  });
  const added = new Set<string>();
  const retainedAfter: string[] = [];
  for (const id of afterKeys) {
    if (beforeKeySet.has(id)) retainedAfter.push(id);
    else added.add(id);
  }
  if (retainedBefore.length !== retainedAfter.length || retainedBefore.some((id, index) => id !== retainedAfter[index])) return null;

  const changed = new Map<string, Entity>();
  for (const id of retainedBefore) {
    if (before.entities[id] !== after.entities[id]) changed.set(id, before.entities[id]);
  }
  return { changed, removed, added, topLevel, entitiesUnchanged: false };
}

/** 在命令执行后的场景上还原补丁；实体字典按执行前的键顺序重建，其余实体沿用当前对象。 */
export function applyScenePatch(scene: SceneDocument, patch: ScenePatch): SceneDocument {
  let entities = scene.entities;
  if (!patch.entitiesUnchanged) {
    const keys = Object.keys(scene.entities).filter((id) => !patch.added.has(id));
    // 删除项按原位置升序回插，即可得到执行前的键顺序。
    for (const { id, index } of patch.removed) keys.splice(Math.min(index, keys.length), 0, id);
    const removedById = new Map(patch.removed.map(({ id, entity }) => [id, entity] as const));
    entities = Object.fromEntries(keys.map((id) => [id, patch.changed.get(id) ?? removedById.get(id) ?? scene.entities[id]]));
  }
  return { ...scene, ...patch.topLevel, entities } as SceneDocument;
}

/**
 * 为“执行时保存整份旧文档”的命令提供撤销逻辑：能用补丁则只保留补丁，否则保留旧文档。
 * capture 在每次 execute 得到结果后调用；undo 把最近一次捕获的变更还原到当前场景。
 */
export function createSceneUndoRecorder(): {
  capture: (before: SceneDocument, after: SceneDocument) => void;
  undo: (scene: SceneDocument) => SceneDocument;
} {
  let patch: ScenePatch | null = null;
  let previousScene: SceneDocument | null = null;
  return {
    capture: (before, after) => {
      patch = captureScenePatch(before, after);
      previousScene = patch ? null : before;
    },
    undo: (scene) => {
      if (patch) return patch.entitiesUnchanged && Object.keys(patch.topLevel).length === 0 ? scene : applyScenePatch(scene, patch);
      return previousScene ?? scene;
    },
  };
}
