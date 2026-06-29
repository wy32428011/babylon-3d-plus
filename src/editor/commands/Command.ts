import type { SceneDocument } from '../model/SceneDocument';

export type Command = {
  label: string;
  execute: (scene: SceneDocument) => SceneDocument;
  undo: (scene: SceneDocument) => SceneDocument;
};
