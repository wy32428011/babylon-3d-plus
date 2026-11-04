import { editorIpc as ipcMain } from './trustedEditorIpc.js';
import { getCurrentDataPlatformBinding } from './dataPlatformBindingStore.js';
import { readDataPlatformConfig, isDataPlatformProjectClosing } from './dataPlatformIpc.js';
import { DataPlatformHttpError, requestDataPlatformJson } from './dataPlatformTransfer.js';
import {
  historyServiceEndpoint,
  validateHistoryAccessUpdate,
  validateHistoryProjectId,
  validateHistoryServiceRequest,
  type HistoryServiceResult,
} from '../shared/historyServiceContract.js';
import { getHistoryAccessStatus, historyManagementOrigin, readHistoryManagementKey, updateHistoryAccess } from './historyAccessStore.js';

type RequestContext = { projectId: string; baseUrl: string; origin: string; projectRoot: string; key: string };
type ActiveRequest = { controller: AbortController; contextKey: string };
let registered = false;
const active = new Map<string, ActiveRequest>();

const PUBLIC_ERRORS: Readonly<Record<string, string>> = {
  HISTORY_AUTH_REQUIRED: '请先配置当前项目的历史管理访问键。',
  HISTORY_ACCESS_REQUIRED: '请先配置当前项目的历史管理访问键。',
  HISTORY_AUTH_FAILED: '历史管理访问键无效，请重新配置。',
  HISTORY_ACCESS_DENIED: '当前凭据没有此项目的历史管理权限。',
  HISTORY_FORBIDDEN: '当前凭据没有此操作的权限。',
  HISTORY_NOT_CONFIGURED: '历史服务的安全或存储配置尚未就绪。',
  HISTORY_REVISION_CONFLICT: '来源或有效配置已被修改，请刷新后重新预检。',
  HISTORY_IDEMPOTENCY_CONFLICT: '请求标识已用于不同操作，请核对原任务。',
  HISTORY_SOURCE_NOT_FOUND: '当前项目中找不到该历史来源。',
  HISTORY_SOURCE_DISABLED: '该历史来源已禁用。',
  HISTORY_SOURCE_IN_USE: '该来源仍有有效或历史引用，不能删除。',
  HISTORY_SOURCE_NOT_READY: '该来源尚未具备完整回放条件，请查看预检结果。',
  HISTORY_PROJECTION_NOT_READY: '历史状态投影尚未就绪，原有效配置保持不变。',
  HISTORY_PREFLIGHT_REQUIRED: '预检结果缺失或已失效，请重新预检。',
  HISTORY_VALIDATION_EXPIRED: '预检已过期，请重新预检。',
  HISTORY_CONFIG_INVALID: '来源配置有误，请检查必填字段、参数和映射。',
  HISTORY_INVALID_CONFIG: '来源配置有误，请检查必填字段、参数和映射。',
  HISTORY_CREDENTIAL_NOT_READY: '服务端凭据保护尚未配置，不能保存或使用密钥。',
  HISTORY_VERSION_MISMATCH: '发布版本与有效历史绑定不匹配，请核对后重新应用。',
  HISTORY_BUDGET_EXCEEDED: '本次操作超过历史服务允许的资源预算。',
  HISTORY_CONTEXT_CHANGED: '项目或平台已切换，已丢弃旧请求结果；远端操作请按原请求标识查询。',
  HISTORY_CANCELED: '请求已取消；这不表示远端已提交的操作已回滚。',
  HISTORY_TIMEOUT: '历史请求超时，请沿用原请求标识查询或重试，不要重复启用采集。',
  HISTORY_CREDENTIAL_UPDATE_REQUIRED: '已有来源的凭据请在独立轮换操作中更新，不随来源草稿保存。',
  HISTORY_CREDENTIAL_UNAVAILABLE: '来源凭据已撤销或服务器加密能力不可用。',
  HISTORY_ACCESS_REVOKED: '此项目的历史访问授权已撤销。',
  HISTORY_ACCESS_REVISION_CONFLICT: '访问凭据已被其他操作更改，请刷新后重新确认。',
  HISTORY_SOURCE_REVOKED: '该来源的连接访问已撤销。',
  HISTORY_SOURCE_CHANGED: '来源修订或生命周期已改变，请刷新后重新预检。',
  HISTORY_SOURCE_RETIRED: '该来源已停止新绑定，不能继续保存为有效草稿。',
  HISTORY_INVALID_REQUEST: '请求字段不符合历史服务合同，请检查连接、映射和必填项。',
  HISTORY_LEGACY_BOUNDARY_UNPROTECTED: '旧 HTTP 来源的通用取数旁路尚未受保护，不能导入历史域。',
  HISTORY_VALIDATION_NOT_READY: '预检尚未满足生效条件，请先处理阻塞项。',
  HISTORY_VALIDATION_MISMATCH: '来源、版本或策略与预检不一致，请重新预检。',
  HISTORY_TARGET_NOT_APPROVED: '此来源目标未获服务器出站授权。',
  HISTORY_READONLY_PATH_NOT_APPROVED: '此只读接口的方法或路径未获服务器授权。',
  HISTORY_RESPONSE_LIMIT: '来源响应超过服务器的字节预算。',
  HISTORY_PAGE_LIMIT: '来源分页超过预算，未将不完整结果当作完整历史。',
  HISTORY_UPSTREAM_REVISION_CHANGED: '上游快照修订在读取期间改变，请重新准备一致窗口。',
  HISTORY_EVENT_ORDER_INVALID: '上游事件顺序或身份不符合连续回放合同。',
  HISTORY_OPERATION_TIMEOUT: '后台操作超时，请按原请求标识确认状态。',
  HISTORY_BUSY: '历史服务当前已达并发上限，请稍后按原标识重试。',
  HISTORY_RETENTION_CONFIRMATION_REQUIRED: '缩短留存需要单独确认影响，未改变当前保留策略。',
  HISTORY_NOT_ACTIVE: '当前项目尚无已激活的采集绑定。',
  HISTORY_CAPTURE_STATE_CONFLICT: '采集状态已变化，请刷新后操作。',
  HISTORY_PROJECTION_NOT_CONNECTED: '持续采集与完整业务投影尚未接入，不能启用。',
  HISTORY_PUBLICATION_NOT_CONNECTED: '发布版本校验与资源留存尚未接入，不能启用。',
  HISTORY_PROJECTOR_ABI_UNAPPROVED: '服务器尚未批准与当前状态内核兼容的投影器 ABI。',
  HISTORY_PROJECTOR_NOT_APPROVED: '当前服务器没有批准该投影器构建。',
  HISTORY_PROJECTOR_BUILD_MISMATCH: '已安装的投影器文件与批准摘要不一致。',
  HISTORY_SERVICE_UNAVAILABLE: '历史服务不可用，请检查平台地址、服务部署和网络。',
};

function failure(code: unknown, fallback = 'HISTORY_SERVICE_UNAVAILABLE'): HistoryServiceResult {
  const safeCode = typeof code === 'string' && Object.prototype.hasOwnProperty.call(PUBLIC_ERRORS, code) ? code : fallback;
  return { success: false, code: safeCode, message: PUBLIC_ERRORS[safeCode] ?? '历史服务请求失败，请刷新状态后重试。' };
}

async function contextFor(rawProjectId: unknown): Promise<RequestContext> {
  const projectId = validateHistoryProjectId(rawProjectId);
  if (isDataPlatformProjectClosing()) throw new Error('项目正在关闭，不能发起历史服务操作。');
  const binding = getCurrentDataPlatformBinding();
  if (!binding || binding.metadata.projectId !== projectId) throw new Error('历史服务操作仅允许用于当前已绑定项目。');
  const config = await readDataPlatformConfig();
  if (!config.baseUrl) throw new Error('请先配置数据中台地址。');
  const origin = historyManagementOrigin(config.baseUrl);
  if (historyManagementOrigin(binding.metadata.baseUrl) !== origin) throw new Error('平台地址与当前项目绑定不一致，请重新绑定项目。');
  const context = { projectId, baseUrl: config.baseUrl, origin, projectRoot: binding.projectRoot, key: JSON.stringify([origin, projectId, binding.projectRoot]) };
  if (!await isCurrent(context)) throw new Error('项目或平台已切换，请重新打开时光回溯设置。');
  return context;
}

async function isCurrent(context: RequestContext): Promise<boolean> {
  if (isDataPlatformProjectClosing()) return false;
  const config = await readDataPlatformConfig();
  const current = getCurrentDataPlatformBinding();
  if (isDataPlatformProjectClosing() || !current || current.projectRoot !== context.projectRoot || current.metadata.projectId !== context.projectId) return false;
  try { return historyManagementOrigin(config.baseUrl) === context.origin && historyManagementOrigin(current.metadata.baseUrl) === context.origin; }
  catch { return false; }
}

function abortContext(contextKey: string): void {
  for (const request of active.values()) if (request.contextKey === contextKey) request.controller.abort();
}

/** 历史控制面仅暴露固定平台动作；凭据不返回 renderer，也不写入场景。 */
export function registerHistoryIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('history:context', () => {
    if (isDataPlatformProjectClosing()) return null;
    const binding = getCurrentDataPlatformBinding();
    if (!binding) return null;
    let platformOrigin: string | null = null;
    try { platformOrigin = historyManagementOrigin(binding.metadata.baseUrl); } catch { /* 无安全传输时只提供离线项目身份。 */ }
    return { projectId: binding.metadata.projectId, projectName: binding.metadata.projectName, platformOrigin, latestVersionId: binding.metadata.latestVersionId };
  });
  ipcMain.handle('history:access-status', async (_event, projectId: unknown) => {
    const context = await contextFor(projectId);
    const result = await getHistoryAccessStatus(context.baseUrl, context.projectId);
    if (!await isCurrent(context)) throw new Error('项目或平台已切换，请重新读取凭据状态。');
    return result;
  });
  ipcMain.handle('history:access-update', async (_event, input: unknown) => {
    const request = validateHistoryAccessUpdate(input);
    const context = await contextFor(request.projectId);
    abortContext(context.key);
    const result = await updateHistoryAccess(context.baseUrl, request);
    if (!await isCurrent(context)) throw new Error('当前项目已切换；凭据只保存到原项目，不会用于新项目。');
    return result;
  });
  ipcMain.handle('history:invoke', async (event, input: unknown): Promise<HistoryServiceResult> => {
    const request = validateHistoryServiceRequest(input);
    const prefix = `${event.sender.id}:`;
    const key = prefix + request.requestId;
    if (active.has(key)) throw new Error('此历史请求仍在执行，请等待结果或取消后沿用相同请求标识。');
    if (active.size >= 32 || [...active.keys()].filter((item) => item.startsWith(prefix)).length >= 8) throw new Error('历史服务请求并发超过上限。');
    const controller = new AbortController();
    const record: ActiveRequest = { controller, contextKey: '' };
    // 在首次异步读取前登记，避免弹窗关闭的取消先于请求登记而失效。
    active.set(key, record);
    const cancel = () => controller.abort();
    if (event.sender.isDestroyed()) cancel();
    else event.sender.once('destroyed', cancel);
    let context: RequestContext | null = null;
    try {
      context = await contextFor(request.projectId);
      record.contextKey = context.key;
      if (controller.signal.aborted) return failure('HISTORY_CANCELED');
      const secret = await readHistoryManagementKey(context.baseUrl, context.projectId);
      if (!secret && request.action !== 'capabilities') return failure('HISTORY_AUTH_REQUIRED');
      if (controller.signal.aborted) return failure('HISTORY_CANCELED');
      if (!await isCurrent(context)) return failure('HISTORY_CONTEXT_CHANGED');
      const { path, body } = historyServiceEndpoint(request);
      const result = await requestDataPlatformJson({
        baseUrl: context.baseUrl, endpointPath: path, body, signal: controller.signal,
        timeoutMs: request.action === 'probeSource' || request.action === 'validateConfig' ? 60_000 : 30_000,
        context: '历史服务', ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      });
      if (controller.signal.aborted) return failure('HISTORY_CANCELED');
      if (!await isCurrent(context)) return failure('HISTORY_CONTEXT_CHANGED');
      if (!result || typeof result !== 'object' || Array.isArray(result)) return failure('HISTORY_SERVICE_UNAVAILABLE');
      const envelope = result as Record<string, unknown>;
      if (envelope.success !== true || envelope.code !== 'OK') return failure(envelope.code);
      return { success: true, data: envelope.data };
    } catch (error) {
      if (controller.signal.aborted) return failure('HISTORY_CANCELED');
      if (!context) return { success: false, code: 'HISTORY_CONTEXT_UNAVAILABLE', message: '请在已绑定项目中使用历史管理，并确认平台地址一致、使用 HTTPS（本机允许 HTTP）。' };
      if (error instanceof DataPlatformHttpError) {
        if (error.httpStatus === 401 || error.httpStatus === 403) return failure('HISTORY_ACCESS_DENIED');
        return failure(error.businessCode);
      }
      if (error instanceof Error && error.message.includes('超时')) return failure('HISTORY_TIMEOUT');
      // 远端 URL、正文、系统路径和底层认证错误不穿透 IPC。
      return failure('HISTORY_SERVICE_UNAVAILABLE');
    } finally {
      active.delete(key);
      if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', cancel);
    }
  });
  ipcMain.handle('history:cancel', (event, requestId: unknown): boolean => {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) return false;
    const request = active.get(`${event.sender.id}:${requestId}`);
    request?.controller.abort();
    return Boolean(request);
  });
}
