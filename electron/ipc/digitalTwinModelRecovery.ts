import { promises as fs } from 'node:fs';
import type { DigitalTwinModelRecoveryResult } from '../types.js';
import { collectPublishModelReferences, planPublishModelRecovery } from '../shared/publishModelRecovery.js';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';
import { authorizeAssetFile, decodeAssetUrl, isAuthorizedAssetFile, isPathInsideAuthorizedAssetRoot } from './assetRegistry.js';
import { isPathInsideOrEqual } from './deploymentExportFileSystem.js';
import { recoverDataPlatformModelAssets } from './dataPlatformModelIncrementalSync.js';

/** 所有网络地址和缓存目录只取主进程配置；场景只能提供稳定模型 ID。 */
export async function recoverPublishSceneModels(
  sceneContent: string,
  resolveContext: () => Promise<{ baseUrl: string; sharedResourcesRoot: string }>,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<DigitalTwinModelRecoveryResult> {
  onProgress('正在检查场景模型和点击事件绑定…');
  const { plan, scene } = await inspectPublishSceneModels(sceneContent, signal);
  if (!plan.length) return { replacements: [] };
  if (plan.length > 256) throw new Error('一次发布最多自动恢复 256 种模型，请先同步模型资源库。');
  const context = await resolveContext();
  signal.throwIfAborted();
  // 下载会替换当前共享包；同步更新该包的其它实例，独立工程快照不受影响。
  const references = collectPublishModelReferences(scene);
  for (const item of plan) {
    const key = item.kind + ':' + item.resourceId + ':';
    for (const asset of [...references.models.map((reference) => reference.asset), ...references.devices]) {
      if (!getClickEventModelResourceKey(asset.sourceUrl)?.startsWith(key)) continue;
      const sourceUrl = String(asset.sourceUrl);
      if (isPathInsideOrEqual(context.sharedResourcesRoot, decodeAssetUrl(sourceUrl)) && !item.sourceUrls.includes(sourceUrl)) {
        item.sourceUrls.push(sourceUrl);
      }
    }
  }
  const assets = await recoverDataPlatformModelAssets({ ...context, resources: plan, signal, onProgress });
  signal.throwIfAborted();
  return {
    replacements: plan.map((item) => {
      const key = `${item.kind}:${item.resourceId}:`;
      const asset = assets.find((candidate) => getClickEventModelResourceKey(candidate.sourceUrl)?.startsWith(key));
      if (!asset) throw new Error(`数据中台模型「${item.displayName}」恢复后未返回有效模型，已停止发布。`);
      for (const file of [asset.path, asset.thumbnailPath, ...(asset.scriptAssets ?? []).map((script) => script.path)]) {
        if (file) authorizeAssetFile(file);
      }
      return { sourceUrls: item.sourceUrls, asset };
    }),
  };
}

async function inspectPublishSceneModels(sceneContent: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof sceneContent !== 'string' || Buffer.byteLength(sceneContent, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('发布前模型恢复的场景内容无效或超过 64 MiB。');
  }
  const parsed = JSON.parse(sceneContent) as { version?: number; scene?: unknown };
  if (![1, 2, 3, 4, 5].includes(parsed.version ?? 0) || !parsed.scene) throw new Error('发布前模型恢复的场景格式无效。');
  const plan = await planPublishModelRecovery(parsed.scene, async (asset) => {
    signal.throwIfAborted();
    const files = [asset, ...(Array.isArray(asset.scriptAssets) ? asset.scriptAssets : [])];
    for (const file of files) {
      const sourcePath = typeof file?.sourceUrl === 'string' ? decodeAssetUrl(file.sourceUrl) : null;
      if (!sourcePath || (!isAuthorizedAssetFile(sourcePath) && !isPathInsideAuthorizedAssetRoot(sourcePath))) return false;
      try {
        const info = await fs.lstat(sourcePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return false;
      }
    }
    return true;
  });
  return { plan, scene: parsed.scene };
}

/** 主发布入口也必须检查，防止绕过 renderer 预处理发布无点击目标的包。 */
export async function assertPublishSceneModelsReady(sceneContent: string, signal: AbortSignal): Promise<void> {
  const { plan } = await inspectPublishSceneModels(sceneContent, signal);
  if (plan.length) throw new Error('场景仍有缺失模型或无目标的点击绑定，请先完成发布前模型恢复，再重新发布：' + plan.map((item) => item.displayName).join('、'));
}
