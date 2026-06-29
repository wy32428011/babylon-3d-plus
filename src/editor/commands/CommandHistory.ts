import type { SceneDocument } from '../model/SceneDocument';
import type { Command } from './Command';

export type CommandHistory = {
  undoStack: Command[];
  redoStack: Command[];
};

export type CommandResult = {
  scene: SceneDocument;
  history: CommandHistory;
};

export function createCommandHistory(): CommandHistory {
  return { undoStack: [], redoStack: [] };
}

export function executeCommand(scene: SceneDocument, history: CommandHistory, command: Command): CommandResult {
  return {
    scene: command.execute(scene),
    history: { undoStack: [...history.undoStack, command], redoStack: [] },
  };
}

export function undoCommand(scene: SceneDocument, history: CommandHistory): CommandResult {
  const command = history.undoStack.at(-1);
  if (!command) return { scene, history };

  return {
    scene: command.undo(scene),
    history: {
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [command, ...history.redoStack],
    },
  };
}

export function redoCommand(scene: SceneDocument, history: CommandHistory): CommandResult {
  const command = history.redoStack[0];
  if (!command) return { scene, history };

  return {
    scene: command.execute(scene),
    history: {
      undoStack: [...history.undoStack, command],
      redoStack: history.redoStack.slice(1),
    },
  };
}
