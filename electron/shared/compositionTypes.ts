export type CompositionVector = { x: number; y: number; z: number };
export type CompositionTransform = { position: CompositionVector; rotation: CompositionVector; scale: CompositionVector };
export type CompositionInstance = {
  schemaVersion: 1;
  instanceId: string;
  libraryId: string;
  revision: string;
  resourceId?: string;
  resourceType?: 'ENV_MODEL';
  sourceKey?: string;
  packagePath?: string;
  contentSha256?: string;
};
export type CompositionResourceReference = Pick<CompositionInstance, 'schemaVersion' | 'libraryId' | 'revision' | 'resourceId' | 'sourceKey'> & { resourceType: 'ENV_MODEL'; packagePath: string };
export type CompositionNode = {
  id: string; name: string; isFolder?: boolean; visible?: boolean; locked?: boolean;
  parentId: string | null; childrenIds: string[];
  components: { transform: CompositionTransform; [key: string]: unknown };
};
export type CompositionDefinition = { schemaVersion: 1; name: string; nodes: CompositionNode[] };
export type CompositionLibraryEntry = {
  id: string; name: string; revision: string; memberCount: number; definition: CompositionDefinition;
  previousRevision?: string;
  packagePath: string; thumbnailUrl?: string; updatedAt: string; contentSha256: string;
  resourceId?: string;
  resourceType?: 'ENV_MODEL'; remoteRevision?: string; sourceKey?: string;
  syncStatus: 'local' | 'pending' | 'synced' | 'failed' | 'conflict'; syncError?: string;
};
export type CompositionLibrarySummary = Omit<CompositionLibraryEntry, 'definition'>;
export type CompositionSaveRequest = { definition: CompositionDefinition; targetId?: string; expectedRevision?: string; thumbnailDataUrl?: string; previewGlb?: Uint8Array };
export type CompositionLibraryApi = {
  importCompositionPackage: () => Promise<CompositionLibraryEntry | null>;
  exportCompositionPackage: (id: string) => Promise<boolean>;
  listCompositions: () => Promise<CompositionLibrarySummary[]>;
  loadComposition: (id: string, revision?: string) => Promise<CompositionLibraryEntry>;
  saveComposition: (request: CompositionSaveRequest) => Promise<CompositionLibraryEntry>;
  cancelCompositionSync: () => Promise<void>;
  syncCompositions: () => Promise<CompositionLibrarySummary[]>;
  restoreComposition: (id: string, expectedRevision: string) => Promise<CompositionLibraryEntry>;
};
