import { app } from 'electron';
import { spawn } from 'node:child_process';
import { buildNewEditorInstanceSpawnSpec, type OpenNewEditorInstanceResult } from '../shared/editorInstanceLaunch.js';
import { editorIpc } from './trustedEditorIpc.js';

/** 启动独立的编辑器子进程，用于并排打开第二个场景并跨窗口复制模型。 */
export async function launchNewEditorInstance(): Promise<OpenNewEditorInstanceResult> {
  const spec = buildNewEditorInstanceSpawnSpec({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
  });

  return await new Promise<OpenNewEditorInstanceResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: { ...process.env },
      detached: true,
      stdio: 'ignore',
    });

    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`无法启动新的编辑器窗口：${error.message}`));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ ok: true, pid: child.pid ?? null });
    });
  });
}

/** 注册多实例启动受控 IPC。 */
export function registerAppInstanceIpc(): void {
  editorIpc.handle('app:openNewEditorInstance', () => launchNewEditorInstance());
}
