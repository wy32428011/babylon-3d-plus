import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Node } from '@babylonjs/core/node.js';

/** A displacement in world axes, in metres, at 100% explosion. */
export interface InspectionAssemblyOffset {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Nodes have already been resolved from the model's part index by the caller. */
export interface InspectionAssemblyGroup {
  readonly id: string;
  readonly nodes: readonly TransformNode[];
  readonly fixed?: boolean;
  readonly worldOffset?: InspectionAssemblyOffset;
}

export interface InspectionAssemblyOptions {
  /** Every configured node must be this node or one of its descendants. */
  readonly root: TransformNode;
  readonly groups: readonly InspectionAssemblyGroup[];
  /** Called after positions change, so the Viewer can refresh bounds and request a redraw. */
  readonly onChange?: () => void;
}

export interface InspectionAssemblyController {
  readonly percent: number;
  setPercent(percent: number): void;
  reset(): void;
  /** Restores surviving controlled nodes and releases ownership. Safe to call repeatedly. */
  dispose(): void;
}

interface Entry {
  node: TransformNode;
  groupId: string;
  fixed: boolean;
  worldOffset: Vector3;
  baseline: Vector3;
}

// Weak keys avoid keeping a model alive. Counts allow overlapping hierarchies to be
// rejected without traversing a high-detail model for every group.
const ownedNodes = new WeakMap<Node, object>();
const ownedSubtreeCounts = new WeakMap<Node, number>();

function isFiniteVector(value: InspectionAssemblyOffset): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function assertLiveHierarchy(parents: ReadonlyMap<Node, Node | null>): void {
  for (const [node, parent] of parents) {
    if (node.isDisposed()) {
      throw new Error(`Inspection assembly node "${node.name}" has been disposed`);
    }
    if (node.parent !== parent) {
      throw new Error(`Inspection assembly hierarchy changed at "${node.name}"`);
    }
  }
}

function calculatePosition(entry: Entry, fraction: number): Vector3 {
  if (fraction === 0) return entry.baseline.clone();

  let localOffset = entry.worldOffset;
  const parent = entry.node.parent;
  if (parent) {
    const matrix = parent.computeWorldMatrix(true);
    const determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) {
      throw new Error(
        `Inspection assembly parent of "${entry.node.name}" has a singular world matrix`,
      );
    }
    const inverse = Matrix.Identity();
    matrix.invertToRef(inverse);
    localOffset = Vector3.TransformNormal(entry.worldOffset, inverse);
  }
  const result = entry.baseline.add(localOffset.scale(fraction));
  if (!isFiniteVector(result)) {
    throw new Error(`Inspection assembly position of "${entry.node.name}" is not finite`);
  }
  return result;
}

/**
 * Capture an already-confirmed static assembly pose. Until disposal, the caller
 * must keep conflicting animation stopped and give this controller exclusive
 * ownership of configured nodes' transforms and hierarchy.
 *
 * A configured ancestor owns the whole branch: descendants are not moved again,
 * even when the ancestor is fixed. A fixed descendant of an effective movable
 * ancestor is rejected because both requirements cannot be met together.
 * There is no 128-group truncation; every supplied group is validated.
 */
export function createInspectionAssemblyController(
  options: InspectionAssemblyOptions,
): InspectionAssemblyController {
  if (!options || !(options.root instanceof TransformNode) || options.root.isDisposed()) {
    throw new Error('Inspection assembly requires a live TransformNode root');
  }
  if (!Array.isArray(options.groups) || options.groups.length === 0) {
    throw new Error('Inspection assembly requires at least one group');
  }
  if (options.onChange !== undefined && typeof options.onChange !== 'function') {
    throw new Error('Inspection assembly onChange must be a function');
  }

  const entries: Entry[] = [];
  const byNode = new Map<Node, Entry>();
  const groupIds = new Set<string>();
  const parents = new Map<Node, Node | null>();

  for (const group of options.groups) {
    if (!group || typeof group.id !== 'string' || !group.id.trim()) {
      throw new Error('Inspection assembly group id must be a non-empty string');
    }
    const id = group.id.trim();
    if (groupIds.has(id)) throw new Error(`Duplicate inspection assembly group id "${id}"`);
    groupIds.add(id);
    if (group.fixed !== undefined && typeof group.fixed !== 'boolean') {
      throw new Error(`Inspection assembly group "${id}" fixed must be a boolean`);
    }
    if (!Array.isArray(group.nodes) || group.nodes.length === 0) {
      throw new Error(`Inspection assembly group "${id}" requires at least one node`);
    }
    const offset = group.worldOffset;
    if (
      (!group.fixed && offset === undefined) ||
      (offset !== undefined &&
        (offset === null || typeof offset !== 'object' || !isFiniteVector(offset)))
    ) {
      throw new Error(`Inspection assembly group "${id}" requires a finite worldOffset`);
    }

    for (const node of group.nodes) {
      if (!(node instanceof TransformNode) || node.isDisposed()) {
        throw new Error(`Inspection assembly group "${id}" requires live TransformNode entries`);
      }
      if (
        node.getScene() !== options.root.getScene() ||
        (node !== options.root && !node.isDescendantOf(options.root))
      ) {
        throw new Error(`Inspection assembly node "${node.name}" is outside the root`);
      }
      if (byNode.has(node)) {
        throw new Error(`Duplicate inspection assembly node "${node.name}"`);
      }
      if (!isFiniteVector(node.position)) {
        throw new Error(`Inspection assembly node "${node.name}" has a non-finite baseline`);
      }
      const quaternion = node.rotationQuaternion;
      if (
        !isFiniteVector(node.rotation) ||
        !isFiniteVector(node.scaling) ||
        (quaternion && (!isFiniteVector(quaternion) || !Number.isFinite(quaternion.w)))
      ) {
        throw new Error(`Inspection assembly node "${node.name}" has a non-finite transform`);
      }
      const entry: Entry = {
        node,
        groupId: id,
        fixed: group.fixed === true,
        worldOffset: offset ? new Vector3(offset.x, offset.y, offset.z) : Vector3.Zero(),
        baseline: node.position.clone(),
      };
      entries.push(entry);
      byNode.set(node, entry);
    }
  }

  const effective: Entry[] = [];
  for (const entry of entries) {
    let ancestor = entry.node.parent;
    let configuredAncestor: Entry | undefined;
    const visited = new Set<Node>([entry.node]);
    while (ancestor) {
      if (visited.has(ancestor)) throw new Error('Inspection assembly hierarchy contains a cycle');
      visited.add(ancestor);
      configuredAncestor = byNode.get(ancestor) ?? configuredAncestor;
      ancestor = ancestor.parent;
    }
    if (entry.fixed && configuredAncestor && !configuredAncestor.fixed) {
      throw new Error(
        `Fixed inspection assembly group "${entry.groupId}" has a movable configured ancestor`,
      );
    }
    if (!configuredAncestor && !entry.fixed) effective.push(entry);

    // Remember the entire original ancestry for both hierarchy checks and lock cleanup.
    for (const node of visited) parents.set(node, node.parent);
  }
  assertLiveHierarchy(parents);

  // A controller may not own a node overlapping another controller's branch.
  for (const entry of entries) {
    if ((ownedSubtreeCounts.get(entry.node) ?? 0) > 0) {
      throw new Error(`Inspection assembly node "${entry.node.name}" is already owned`);
    }
    for (let node: Node | null = entry.node; node; node = node.parent) {
      if (ownedNodes.has(node)) {
        throw new Error(`Inspection assembly node "${entry.node.name}" is already owned`);
      }
    }
  }
  for (const entry of effective) {
    // A frozen descendant would remain visually behind when its parent moves.
    for (const node of [entry.node, ...entry.node.getDescendants()]) {
      if (node instanceof TransformNode && node.isWorldMatrixFrozen) {
        throw new Error(`Inspection assembly node "${node.name}" has a frozen world matrix`);
      }
    }
    calculatePosition(entry, 1);
  }

  const owner = {};
  // Capture the ancestor list now so cleanup remains correct even after reparenting.
  const lockedPaths = entries.map(({ node }) => {
    const path: Node[] = [];
    for (let current: Node | null = node; current; current = current.parent) path.push(current);
    ownedNodes.set(node, owner);
    for (const current of path) {
      ownedSubtreeCounts.set(current, (ownedSubtreeCounts.get(current) ?? 0) + 1);
    }
    return path;
  });
  let percent = 0;
  let disposed = false;

  function apply(value: number): void {
    if (disposed) throw new Error('Inspection assembly controller has been disposed');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error('Inspection assembly percent must be finite and between 0 and 100');
    }
    assertLiveHierarchy(parents);
    const positions = effective.map((entry) => {
      if (entry.node.isWorldMatrixFrozen) {
        throw new Error(`Inspection assembly node "${entry.node.name}" has a frozen world matrix`);
      }
      return calculatePosition(entry, value / 100);
    });
    let changed = false;
    for (let index = 0; index < effective.length; index += 1) {
      const node = effective[index].node;
      if (!node.position.equals(positions[index])) {
        node.position.copyFrom(positions[index]);
        changed = true;
      }
    }
    percent = value;
    if (changed) options.onChange?.();
  }

  return {
    get percent() {
      return percent;
    },
    setPercent: apply,
    reset() {
      apply(0);
    },
    dispose() {
      if (disposed) return;
      let changed = false;
      for (const entry of effective) {
        if (!entry.node.isDisposed() && !entry.node.position.equals(entry.baseline)) {
          entry.node.position.copyFrom(entry.baseline);
          changed = true;
        }
      }
      disposed = true;
      percent = 0;
      for (const [index, entry] of entries.entries()) {
        if (ownedNodes.get(entry.node) === owner) ownedNodes.delete(entry.node);
        for (const node of lockedPaths[index]) {
          const count = (ownedSubtreeCounts.get(node) ?? 1) - 1;
          if (count > 0) ownedSubtreeCounts.set(node, count);
          else ownedSubtreeCounts.delete(node);
        }
      }
      if (changed) options.onChange?.();
    },
  };
}
