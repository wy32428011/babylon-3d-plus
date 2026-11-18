import type { DigitalTwinInspectionBinding } from '../player/digitalTwinInteractionProtocol';
import type { InspectionDetailPart } from './InspectionDetailView';

/** 按装配关系排列零件，保留同级的原始顺序。 */
export function toDetailParts(parts: DigitalTwinInspectionBinding['parts']): InspectionDetailPart[] {
  const byKey = new Map<string, DigitalTwinInspectionBinding['parts'][number]>();
  for (const part of parts) {
    if (byKey.has(part.partKey)) throw new Error(`零件标识重复：${part.partKey}。`);
    byKey.set(part.partKey, part);
  }

  const children = new Map<string | undefined, DigitalTwinInspectionBinding['parts']>();
  for (const part of parts) {
    if (part.parentPartKey !== undefined && !byKey.has(part.parentPartKey)) {
      throw new Error(`零件 ${part.partKey} 的父零件不存在。`);
    }
    const siblings = children.get(part.parentPartKey) ?? [];
    siblings.push(part);
    children.set(part.parentPartKey, siblings);
  }

  const result: InspectionDetailPart[] = [];
  const roots = children.get(undefined) ?? [];
  const pending = roots.map((part) => ({ part, depth: 0 })).reverse();
  while (pending.length) {
    const { part, depth } = pending.pop()!;
    result.push({ partKey: part.partKey, name: part.name, depth });
    const descendants = children.get(part.partKey) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      pending.push({ part: descendants[index], depth: depth + 1 });
    }
  }
  if (result.length !== parts.length) throw new Error('零件装配层级存在循环。');
  return result;
}
