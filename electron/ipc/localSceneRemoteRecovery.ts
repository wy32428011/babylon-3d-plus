import { requestDataPlatformJson } from './dataPlatformTransfer.js';
import { syncSceneDataPlatformModelAssets, type DataPlatformModelRecoveryResource } from './dataPlatformModelIncrementalSync.js';

type Options = {
  baseUrl: string; sharedResourcesRoot: string; resource: DataPlatformModelRecoveryResource;
  expectedRevision?: string; signal: AbortSignal; onProgress?: (message: string) => void;
  dependencies?: { synchronize?: typeof syncSceneDataPlatformModelAssets; requestJson?: typeof requestDataPlatformJson };
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 原固定版本只接受相同内容指纹，最多尝试最近五个历史文件描述，禁止静默升级。 */
export async function recoverPinnedLocalSceneModel(options: Options) {
  options.signal.throwIfAborted();
  const synchronize = options.dependencies?.synchronize ?? syncSceneDataPlatformModelAssets;
  const requestJson = options.dependencies?.requestJson ?? requestDataPlatformJson;
  const expected = options.expectedRevision && /^[a-f\d]{64}$/i.test(options.expectedRevision) ? options.expectedRevision.toLowerCase() : null;
  if (!expected) throw new Error(`模型 ${options.resource.resourceId} 缺少可验证的原版本内容指纹，请导入原模型包后重新检查。`);
  const syncOptions = { baseUrl: options.baseUrl, sharedResourcesRoot: options.sharedResourcesRoot,
    resources: [options.resource], signal: options.signal, onProgress: options.onProgress };
  let latestError: unknown;
  try {
    const [asset] = await synchronize(syncOptions);
    if (asset && (!expected || asset.assetRevision === expected)) return asset;
  } catch (error) { options.signal.throwIfAborted(); latestError = error; }
  if (!expected) throw latestError ?? new Error('当前中台没有可恢复的模型文件。');
  const endpointPath = options.resource.kind === 'combo' ? 'api/v1/combo-models/detail' : 'api/v1/models/detail';
  const response = await requestJson({ baseUrl: options.baseUrl, endpointPath, body: { id: options.resource.resourceId },
    signal: options.signal, timeoutMs: 20000, context: '查询模型历史版本' });
  if (!object(response) || response.success !== true || !object(response.data)
    || response.data.id !== options.resource.resourceId) throw new Error('模型历史详情身份不匹配。');
  const record = response.data;
  const versions = Array.isArray(record.versions) ? record.versions.filter(object).slice(-5).reverse() : [];
  const fields = ['fileName', 'fileUrl', 'metaFileName', 'metaFileUrl', 'scriptFileName', 'scriptFileUrl', 'scriptFiles', 'parseStatus'];
  const seen = new Set<string>();
  for (const version of versions) {
    options.signal.throwIfAborted();
    if (typeof version.fileUrl !== 'string' || !version.fileUrl) continue;
    const historical = { ...record };
    for (const field of fields) historical[field] = version[field] ?? null;
    const key = JSON.stringify(fields.map(field => historical[field]));
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const [asset] = await synchronize({ ...syncOptions, dependencies: { requestJson: async request => {
        if (request.endpointPath !== endpointPath) return requestJson(request);
        return { success: true, data: historical };
      } } });
      options.signal.throwIfAborted();
      if (asset?.assetRevision === expected) return asset;
    } catch (error) { options.signal.throwIfAborted(); latestError = error; }
  }
  throw new Error(`模型 ${options.resource.resourceId} 的原版本 ${expected} 未找到可校验的副本。${latestError instanceof Error ? latestError.message : ''}`);
}
