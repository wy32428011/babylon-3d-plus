import type { EntityComponents } from '../../editor/model/components';

export type RuntimeModelSelectionEntity = {
  isFolder?: boolean;
  components: Partial<EntityComponents>;
};

export type RuntimeModelSelectionState = {
  visible: boolean;
  locked: boolean;
};

/** 运行态只选择真实业务模型；locked 仅限制编辑，不限制只读查看。 */
export function isRuntimeModelSelectionCandidate(
  entity: RuntimeModelSelectionEntity | null | undefined,
  state: RuntimeModelSelectionState | null | undefined,
): boolean {
  if (!entity || entity.isFolder || state?.visible === false) return false;
  return Boolean(
    entity.components.modelAsset
    || entity.components.meshRenderer
    || entity.components.modelArrayInstance
    || entity.components.modelGenerator
  );
}

