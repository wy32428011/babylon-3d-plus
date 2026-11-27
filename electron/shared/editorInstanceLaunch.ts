export const EDITOR_NEW_INSTANCE_ARG = '--editor-new-instance';

export type EditorInstanceMode = 'primary' | 'secondary' | 'quit-for-deep-link';

export type OpenNewEditorInstanceResult = {
  ok: true;
  pid: number | null;
};

/**
 * 判定当前进程启动模式：
 * 1. 显式传入 `--editor-new-instance` 时直接以次实例启动，允许与主实例并排运行；
 * 2. 取得单实例锁时为主实例；
 * 3. 未取得单实例锁但携带 `zending3d://` 深链时，退出并交由主实例打开；
 * 4. 未取得单实例锁且无深链（例如用户再次启动应用）时，作为独立次实例启动。
 */
export function resolveEditorInstanceMode(input: {
  argv: readonly string[];
  hasSingleInstanceLock: boolean;
  hasDeepLink: boolean;
}): EditorInstanceMode {
  if (input.argv.includes(EDITOR_NEW_INSTANCE_ARG)) return 'secondary';
  if (input.hasSingleInstanceLock) return 'primary';
  if (input.hasDeepLink) return 'quit-for-deep-link';
  return 'secondary';
}

/** 仅当二次启动携带深链时才激活并聚焦主窗口，普通双开不抢夺新窗口焦点。 */
export function shouldPrimaryFocusOnSecondInstance(hasDeepLink: boolean): boolean {
  return hasDeepLink;
}

/** 生成用于启动独立编辑器新进程的命令与参数。 */
export function buildNewEditorInstanceSpawnSpec(input: {
  isPackaged: boolean;
  execPath: string;
  appPath: string;
}): { command: string; args: string[]; cwd?: string } {
  if (input.isPackaged) {
    return {
      command: input.execPath,
      args: [EDITOR_NEW_INSTANCE_ARG],
    };
  }
  return {
    command: input.execPath,
    args: [input.appPath, EDITOR_NEW_INSTANCE_ARG],
    cwd: input.appPath,
  };
}
