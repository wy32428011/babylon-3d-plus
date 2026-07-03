import type { EntityComponents } from './components';

export type Entity = {
  id: string;
  name: string;
  isFolder?: boolean;
  visible?: boolean;
  locked?: boolean;
  parentId: string | null;
  childrenIds: string[];
  components: EntityComponents;
};
