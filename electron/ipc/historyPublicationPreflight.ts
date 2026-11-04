import { randomUUID } from 'node:crypto';
import { requestDataPlatformJson } from './dataPlatformTransfer.js';
import { readHistoryManagementKey } from './historyAccessStore.js';
import { historyServiceEndpoint, validateHistoryServiceRequest, type HistoryServiceAction } from '../shared/historyServiceContract.js';

export type HistoryPublicationPreflight = {
  sourceContractId: string;
  sourceContractDigest: string;
  validationId: string;
  expiresAt: number;
  policyRevision: string;
  bindingRevision: string;
  projectorBuildDigest: string;
};

/** 使用已绑定项目的管理键冻结发布候选；不接受发布 targetToken 作为管理授权。 */
export async function prepareHistoryPublication(options: {
  projectId: string;
  baseUrl: string;
  settings: Record<string, unknown>;
  signal: AbortSignal;
  assertCurrent: () => Promise<void>;
}): Promise<HistoryPublicationPreflight> {
  await options.assertCurrent();
  const secret = await readHistoryManagementKey(options.baseUrl, options.projectId);
  if (!secret) throw new Error('时光回溯发布需要当前已绑定项目的历史管理访问键；发布目标票据不能代替管理授权。');
  await options.assertCurrent();
  const invoke = async (action: HistoryServiceAction, body: Record<string, unknown>): Promise<unknown> => {
    options.signal.throwIfAborted();
    await options.assertCurrent();
    const request = validateHistoryServiceRequest({ requestId: randomUUID(), projectId: options.projectId, action, body });
    const endpoint = historyServiceEndpoint(request);
    let envelope: unknown;
    try {
      envelope = await requestDataPlatformJson({ baseUrl: options.baseUrl, endpointPath: endpoint.path, body: endpoint.body,
        signal: options.signal, timeoutMs: action === 'validateConfig' ? 60_000 : 30_000,
        context: '历史发布预检', authorization: `Bearer ${secret}` });
    } catch {
      options.signal.throwIfAborted();
      throw new Error('历史发布预检无法访问已授权的历史管理服务；未发布或启用采集。');
    }
    await options.assertCurrent();
    options.signal.throwIfAborted();
    if (!object(envelope) || envelope.success !== true || envelope.code !== 'OK') {
      throw new Error('历史管理服务未接受发布预检；请检查项目授权及服务配置。');
    }
    return envelope.data;
  };

  const state = await invoke('getCaptureConfig', {});
  if (!object(state) || state.projectId !== options.projectId || !id(state.policyRevision, 64) || !id(state.bindingRevision, 64)) {
    throw new Error('历史管理服务返回了无效的项目或配置修订，不能冻结发布候选。');
  }
  const policyRevision = state.policyRevision, bindingRevision = state.bindingRevision;
  const catalog = await invoke('queryProjectorBuilds', {});
  if (!object(catalog) || !Array.isArray(catalog.items) || catalog.items.length > 32
    || !catalog.items.every(item => object(item) && typeof item.digest === 'string' && /^[a-f0-9]{64}$/u.test(item.digest)
      && item.stateSchemaVersion === '1' && item.kernelVersion === 'state-kernel/1' && item.scheduleVersion === 'input-boundary/1')) {
    throw new Error('历史服务返回了无效的已审批投影器目录，不能发布。');
  }
  const digests = catalog.items.map(item => (item as { digest: string }).digest).sort();
  if (digests.length === 0) throw new Error('服务器没有已安装并批准的兼容投影器构建，不能发布历史版本。');
  const result = await invoke('validateConfig', { settings: options.settings, policyRevision, bindingRevision });
  if (!object(result) || !id(result.validationId, 64) || !id(result.contractId, 64)
    || typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(result.digest)
    || typeof result.expiresAt !== 'number' || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()
    || !Array.isArray(result.issues) || result.issues.length > 128
    || !result.issues.every(item => object(item) && typeof item.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(item.code)
      && (item.severity === 'error' || item.severity === 'warning'))) {
    throw new Error('历史服务未返回有效的来源合同冻结结果，不能发布。');
  }
  const errors = result.issues.filter(item => item.severity === 'error').map(item => item.code as string);
  if (errors.length) throw new Error(`历史发布预检未满足条件（${[...new Set(errors)].join('、')}）；请在时光回溯设置中查看并处理。`);
  return {
    sourceContractId: result.contractId, sourceContractDigest: result.digest, validationId: result.validationId,
    expiresAt: result.expiresAt, policyRevision, bindingRevision, projectorBuildDigest: digests[0],
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
