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

/**
 * 撤销历史条数上限。命令闭包会持有被替换的旧实体数据，不设上限会让长时间编辑的内存持续增长。
 * 仅限制条数，不是内存字节上限；重做栈只在撤销后由撤销栈迁移而来，总量不会超过该值。
 */
export const MAX_UNDO_HISTORY_ENTRIES = 200;

export function executeCommand(scene: SceneDocument, history: CommandHistory, command: Command): CommandResult {
  const undoStack = [...history.undoStack, command];
  // 裁剪最旧命令以释放其持有的旧数据引用；保存状态不依赖历史长度，不受影响。
  if (undoStack.length > MAX_UNDO_HISTORY_ENTRIES) undoStack.splice(0, undoStack.length - MAX_UNDO_HISTORY_ENTRIES);
  return {
    scene: command.execute(scene),
    history: { undoStack, redoStack: [] },
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
