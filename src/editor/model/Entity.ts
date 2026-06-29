import type { EntityComponents } from './components';

export type Entity = {
  id: string;
  name: string;
  parentId: string | null;
  childrenIds: string[];
  components: EntityComponents;
};
