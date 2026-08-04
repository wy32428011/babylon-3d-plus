import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DigitalTwinPublishCancelRequest,
  DigitalTwinPublishContext,
  DigitalTwinPublishProgress,
  DigitalTwinPublishRequest,
  DigitalTwinPublishResult,
} from '../types.js';
import { getDigitalTwinPublishContext, getLocalDigitalTwinPublishContext, publishDigitalTwin } from './digitalTwinPublishService.js';

const CONTEXT_CHANNEL = 'digital-twin-publish:getContext';
const START_CHANNEL = 'digital-twin-publish:start';
const CANCEL_CHANNEL = 'digital-twin-publish:cancel';
const PROGRESS_CHANNEL = 'digital-twin-publish:progress';

type ActivePublishTask = {
  requestId: string;
  sender: WebContents;
  controller: AbortController;
};

const activeTasks = new Map<number, ActivePublishTask>();
const activeTaskPromises = new Set<Promise<unknown>>();
const cleanupBoundSenderIds = new Set<number>();
let registered = false;
let shuttingDown = false;

/** 注册数字孪生发布上下文、启动、取消和进度 IPC。 */
export function registerDigitalTwinPublishIpc(): void {
  if (registered) return;
  registered = true;
  shuttingDown = false;
  ipcMain.handle(CONTEXT_CHANNEL, handleGetContext);
  ipcMain.handle(START_CHANNEL, handleStartPublish);
  ipcMain.handle(CANCEL_CHANNEL, handleCancelPublish);
}

export async function disposeAllDigitalTwinPublishTasks(): Promise<void> {
  shuttingDown = true;
  for (const task of activeTasks.values()) task.controller.abort();
  await Promise.allSettled([...activeTaskPromises]);
  activeTasks.clear();
  activeTaskPromises.clear();
  cleanupBoundSenderIds.clear();
  ipcMain.removeHandler(CONTEXT_CHANNEL);
  ipcMain.removeHandler(START_CHANNEL);
  ipcMain.removeHandler(CANCEL_CHANNEL);
  registered = false;
}

function isDigitalTwinPublishActive(): boolean {
  return activeTasks.size > 0;
}

async function handleGetContext(event: IpcMainInvokeEvent): Promise<DigitalTwinPublishContext> {
  const { sender } = assertTrustedSender(event);
  const publishActive = activeTasks.has(sender.id) || isDigitalTwinPublishActive();
  if (publishActive) return getLocalDigitalTwinPublishContext(true);
  return getDigitalTwinPublishContext();
}

async function handleStartPublish(
  event: IpcMainInvokeEvent,
  request: DigitalTwinPublishRequest,
): Promise<DigitalTwinPublishResult> {
  const { sender } = assertTrustedSender(event);
  if (shuttingDown) throw new Error('应用正在退出，无法开始数字孪生发布。');
  bindSenderCleanup(sender);
  if (activeTasks.has(sender.id)) throw new Error('当前窗口已有数字孪生发布任务正在执行。');
  if (isDigitalTwinPublishActive()) throw new Error('已有其他窗口正在发布数字孪生工程。');

  const requestId = validateRequestId(request?.requestId);
  const task: ActivePublishTask = { requestId, sender, controller: new AbortController() };
  activeTasks.set(sender.id, task);
  const completion = publishDigitalTwin(request, task.controller.signal, (progress) => sendProgress(task, progress));
  activeTaskPromises.add(completion);
  try {
    return await completion;
  } finally {
    activeTaskPromises.delete(completion);
    if (activeTasks.get(sender.id) === task) activeTasks.delete(sender.id);
  }
}

function handleCancelPublish(event: IpcMainInvokeEvent, request: DigitalTwinPublishCancelRequest): boolean {
  const { sender } = assertTrustedSender(event);
  const requestId = validateRequestId(request?.requestId);
  const active = activeTasks.get(sender.id);
  if (!active || active.requestId !== requestId) return false;
  active.controller.abort();
  return true;
}

function sendProgress(task: ActivePublishTask, progress: DigitalTwinPublishProgress): void {
  if (task.sender.isDestroyed() || activeTasks.get(task.sender.id) !== task) return;
  task.sender.send(PROGRESS_CHANNEL, progress);
}

function bindSenderCleanup(sender: WebContents): void {
  if (cleanupBoundSenderIds.has(sender.id)) return;
  cleanupBoundSenderIds.add(sender.id);
  sender.once('destroyed', () => {
    activeTasks.get(sender.id)?.controller.abort();
    // 活动记录由发布 Promise 的 finally 移除，避免取消清理完成前启动第二个发布。
    cleanupBoundSenderIds.delete(sender.id);
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent): { sender: WebContents } {
  const sender = event.sender;
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  if (!ownerWindow || ownerWindow.isDestroyed() || sender.isDestroyed()) throw new Error('数字孪生发布 sender 无效。');
  if (!event.senderFrame || event.senderFrame !== sender.mainFrame) throw new Error('数字孪生发布只能由主 frame 发起。');
  if (!isAllowedRendererUrl(sender.getURL())) throw new Error('数字孪生发布来自未授权的 renderer URL。');
  return { sender };
}

function isAllowedRendererUrl(rendererUrl: string): boolean {
  try {
    const url = new URL(rendererUrl);
    url.hash = '';
    url.search = '';
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      const allowed = new URL(devServerUrl);
      allowed.hash = '';
      allowed.search = '';
      return url.origin === allowed.origin && url.pathname === allowed.pathname;
    }
    return url.href === pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;
  } catch {
    return false;
  }
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) {
    throw new Error('数字孪生发布 requestId 无效。');
  }
  return value;
}
