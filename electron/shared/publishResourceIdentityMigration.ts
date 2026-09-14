import type { DigitalTwinModelRecoveryResult, ProjectModelAssetEntry } from '../types.js';
import { collectPublishModelReferences } from './publishModelRecovery.js';
import { getClickEventModelResourceKey } from './clickEventModelIdentity.js';
import { normalizeDataPlatformModelIdentity } from './sceneModelUpdatePlan.js';

type Owner = Record<string, unknown>;
const hash = (value: unknown): string | null => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : null;

/** 只生成临时场景内容；严格相同内容修订的身份迁移不替换任何实例配置。 */
export function applyPublishModelIdentityReplacements(sceneContent: string, recovery: DigitalTwinModelRecoveryResult): string {
  if (!recovery.replacements.length) return sceneContent;
  const document = JSON.parse(sceneContent);
  const { models, devices } = collectPublishModelReferences(document.scene);
  const replacements = new Map<string, ProjectModelAssetEntry>();
  for (const replacement of recovery.replacements) for (const url of replacement.sourceUrls) {
    const prior = replacements.get(url);
    if (prior && (prior.sourceUrl !== replacement.asset.sourceUrl || prior.assetRevision !== replacement.asset.assetRevision)) throw new Error('同一原模型存在多个身份迁移目标。');
    replacements.set(url, replacement.asset);
  }
  const verified = new Map<string, ProjectModelAssetEntry>();
  const used = new Set<string>();
  for (const { asset, target, clickTarget } of models) {
    const url = String(asset.sourceUrl);
    const replacement = replacements.get(url);
    if (!replacement) continue;
    const oldKey = getClickEventModelResourceKey(url);
    const newKey = getClickEventModelResourceKey(replacement.sourceUrl);
    if (!oldKey || !newKey || oldKey.split(':')[2] !== newKey.split(':')[2]
      || !hash(asset.assetRevision) || hash(asset.assetRevision) !== hash(replacement.assetRevision)) {
      throw new Error('模型身份迁移必须具有相同内容修订及包内模型路径。');
    }
    const identity = targetIdentity(replacement);
    migrateOwner(asset, replacement, true);
    if (target) migrateOwner(target, replacement, false);
    asset.dataPlatformModel = identity;
    delete asset.sourceSnapshot;
    used.add(url);
    if (clickTarget) {
      const previous = verified.get(oldKey);
      if (previous && previous.sourceUrl !== replacement.sourceUrl) throw new Error('点击模型身份迁移存在多个目标。');
      verified.set(oldKey, replacement);
    }
  }
  for (const url of replacements.keys()) if (!used.has(url)) {
    const key = getClickEventModelResourceKey(url);
    if (!key || !verified.has(key) || !devices.some(device => device.sourceUrl === url)) throw new Error('身份迁移缺少已验证的原场景模型映射。');
  }
  for (const device of devices) {
    const key = getClickEventModelResourceKey(device.sourceUrl);
    const replacement = key ? verified.get(key) : undefined;
    if (!replacement) continue;
    if (device.assetRevision !== undefined && hash(device.assetRevision) !== hash(replacement.assetRevision)) {
      throw new Error('点击设备的内容修订与已验证模型不同，不能迁移身份。');
    }
    if (models.some(reference => reference.clickTarget && getClickEventModelResourceKey(reference.asset.sourceUrl) === key)) {
      throw new Error('同一点击模型仍保留未迁移的旧身份，无法确定设备目标。');
    }
    migrateOwner(device, replacement, true);
    device.dataPlatformModel = targetIdentity(replacement);
    delete device.sourceSnapshot;
  }
  return JSON.stringify(document);
}

function targetIdentity(asset: ProjectModelAssetEntry) {
  const key = getClickEventModelResourceKey(asset.sourceUrl);
  if (!key) throw new Error('迁移目标缺少稳定模型身份。');
  const [kind, resourceId, modelPath] = key.split(':');
  if (asset.dataPlatformResourceId !== resourceId) throw new Error('迁移目标资源 ID 与路径不一致。');
  return normalizeDataPlatformModelIdentity({ sourceKey: asset.dataPlatformSourceKey, kind, resourceId, modelPath })!;
}

function relativeResourcePath(file: unknown): string {
  if (typeof file !== 'string' || !file) throw new Error('原模型资源路径无效。');
  const normalized = file.replace(/\\/g, '/');
  if (normalized.split('/').some(part => part === '..' || part === '.')) throw new Error('模型资源包内路径无效。');
  const relative = /(?:^|\/)(?:Model|Combo)-[1-9]\d*(?:-[^/]+)?\/(.+)$/i.exec(normalized)?.[1];
  if (!relative) throw new Error('无法识别模型脚本包内路径。');
  return relative.toLowerCase();
}

function migrateOwner(owner: Owner, asset: ProjectModelAssetEntry, main: boolean): void {
  const fields: Owner = { path: asset.path, sourcePath: asset.path, sourceUrl: asset.sourceUrl,
    packagePath: asset.packagePath, metadataPath: asset.metadataPath, thumbnailPath: asset.thumbnailPath,
    thumbnailUrl: asset.thumbnailUrl, assetId: asset.id, assetRevision: asset.assetRevision };
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in owner) && !(main && ['sourcePath', 'sourceUrl', 'assetRevision'].includes(key))) continue;
    if (value === undefined) delete owner[key]; else owner[key] = value;
  }
  if (Array.isArray(owner.scriptAssets)) owner.scriptAssets = owner.scriptAssets.map(previous => {
    if (!previous || typeof previous !== 'object') throw new Error('原脚本引用格式无效。');
    const old = previous as Owner;
    const relative = relativeResourcePath(old.path);
    const matches = (asset.scriptAssets ?? []).filter(script => relativeResourcePath(script.path) === relative);
    if (matches.length !== 1) throw new Error('身份迁移无法唯一匹配原有脚本包内路径。');
    return { ...old, path: matches[0].path, sourceUrl: matches[0].sourceUrl };
  });
  if (Array.isArray(owner.scriptPaths)) {
    const files = [...new Set([...(asset.scriptPaths ?? []), ...(asset.scriptAssets ?? []).map(script => script.path)])];
    owner.scriptPaths = owner.scriptPaths.map(previous => {
      const relative = relativeResourcePath(previous);
      const matches = files.filter(file => relativeResourcePath(file) === relative);
      if (matches.length !== 1) throw new Error('身份迁移无法唯一匹配原有脚本路径。');
      return matches[0];
    });
  }
}
