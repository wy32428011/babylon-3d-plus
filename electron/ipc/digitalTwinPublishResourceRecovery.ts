import type { DigitalTwinModelRecoveryResult } from '../types.js';
import { authorizeAssetFile, isAuthorizedAssetFile, isPathInsideAuthorizedAssetRoot } from './assetRegistry.js';
import { recoverPublishSceneModels } from './digitalTwinModelRecovery.js';
import { recoverPublishSkyboxReference } from './publishSkyboxRecovery.js';
import { resolvePublishModelIdentityReplacements, assertPublishResourceIdentities } from './digitalTwinPublishResourceIdentity.js';
import { applyPublishModelIdentityReplacements } from '../shared/publishResourceIdentityMigration.js';
import path from 'node:path';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';

type PublishResourceContext = { baseUrl: string; projectRoot: string; sharedResourcesRoot: string; legacyWorkspaceRoot?: string };

/** 下载及导入只使用已确认发布目标；全部成功后由 renderer 在一次撤销命令中更新引用。 */
export async function recoverPublishSceneResources(
  sceneContent: string,
  context: PublishResourceContext,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<DigitalTwinModelRecoveryResult> {
  onProgress('正在核对目标中台模型身份与已验证的迁移映射…');
  const identities = await resolvePublishModelIdentityReplacements(sceneContent, {
    ...context, workspaceRoot: context.legacyWorkspaceRoot ?? path.dirname(context.sharedResourcesRoot),
  }, signal, onProgress);
  const mappedContent = applyPublishModelIdentityReplacements(sceneContent, identities);
  await assertPublishResourceIdentities([mappedContent], context.baseUrl, signal);
  const result = await recoverPublishSceneModels(mappedContent, async () => context, signal, onProgress);
  // 组合两阶段结果，renderer 始终从原场景一次性迁移到最终可用资源。
  const replacements = [
    ...identities.replacements.map(item => {
      const next = result.replacements.find(next => next.sourceUrls.includes(item.asset.sourceUrl))?.asset;
      if (!next) return item;
      if (next.assetRevision !== item.asset.assetRevision
        || getClickEventModelResourceKey(next.sourceUrl) !== getClickEventModelResourceKey(item.asset.sourceUrl)) {
        throw new Error('身份迁移后的模型在恢复期间发生变化，请重新预检。');
      }
      return { ...item, asset: { ...next,
        dataPlatformResourceId: item.asset.dataPlatformResourceId,
        dataPlatformSourceKey: item.asset.dataPlatformSourceKey,
      } };
    }), ...result.replacements,
  ];
  const parsed = JSON.parse(mappedContent);
  const scene = parsed.scene;
  const references: Array<{ entityId: string | null; skybox: Record<string, unknown> }> = [];
  if (scene.sceneSettings?.skybox) references.push({ entityId: null, skybox: scene.sceneSettings.skybox });
  for (const [entityId, entity] of Object.entries(scene.entities ?? {})) {
    const skybox = (entity as { components?: { skybox?: Record<string, unknown> } }).components?.skybox;
    if (skybox) references.push({ entityId, skybox });
  }
  if (references.length > 64) throw new Error('一次发布最多自动恢复 64 个天空盒引用。');
  const skyboxReplacements: NonNullable<DigitalTwinModelRecoveryResult['skyboxReplacements']> = [];
  for (const reference of references) {
    signal.throwIfAborted();
    onProgress('正在检查和补全发布天空盒资源…');
    const recovered = await recoverPublishSkyboxReference({
      skybox: reference.skybox, baseUrl: context.baseUrl, sharedResourcesRoot: context.sharedResourcesRoot,
      signal, isAuthorizedLocalFile: file => isAuthorizedAssetFile(file) || isPathInsideAuthorizedAssetRoot(file),
    });
    authorizeAssetFile(recovered.sourcePath);
    if (recovered.recovered) skyboxReplacements.push({
      entityId: reference.entityId, sourceUrl: String(reference.skybox.sourceUrl ?? ''), skybox: recovered.skybox,
    });
  }
  return { replacements, ...(skyboxReplacements.length ? { skyboxReplacements } : {}) };
}
