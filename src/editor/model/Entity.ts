import type { CompositionInstance } from '../../../electron/shared/compositionTypes';
import type { EntityComponents } from './components';

export type Entity = {
  id: string;
  name: string;
  isFolder?: boolean;
  composition?: CompositionInstance;
  compositionNodeId?: string;
  visible?: boolean;
  locked?: boolean;
  parentId: string | null;
  childrenIds: string[];
  components: EntityComponents;
};
