import { normalizeEntityLightingSettings,
  type EntityLightingSettings, type LightingClassificationEntry } from '../../../electron/shared/sceneLightingBakeContract';
import { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig,
  type SceneLightingConfig, type SceneAppearanceConfig } from '../../../electron/shared/sceneLightingConfig';
import { normalizeSceneLightingPolicy } from '../../../electron/shared/sceneLightingPolicy';
import type { SceneDocument } from '../model/SceneDocument';
import { isEntityEffectivelyLocked } from '../model/entityHierarchy';

export type LightingManagerTab = 'overview' | 'rules' | 'objects' | 'resources';
export type LightingManagerFocus = { entityIds: string[]; nodeKey?: string };
export type LightingManagementDraft = {
  /** 草稿只可提交到产生它的同一场景与文档版本，避免覆盖后台资源更新。 */
  baseScene: SceneDocument;
  sceneSessionId: string;
  lighting?: SceneLightingConfig;
  appearance?: SceneAppearanceConfig;
  /** 仅列出本次编辑的例外；null 表示恢复该对象全部规则继承。 */
  entityLighting?: Record<string, EntityLightingSettings | null>;
};
export type LightingManagementResult = { ok: boolean; message?: string };
type PreparedDraft = LightingManagementResult & { scene?: SceneDocument };

/** 整个草稿先验证、后生成文档，拒绝项不能产生部分配置更新。 */
export function prepareLightingManagementDraft(
  scene: SceneDocument,
  sceneSessionId: string,
  draft: LightingManagementDraft,
  classification: readonly LightingClassificationEntry[],
): PreparedDraft {
  if (draft.sceneSessionId !== sceneSessionId) return { ok: false, message: '场景会话已变化，请重新打开光照与烘焙管理器。' };
  if (draft.baseScene !== scene) return { ok: false, message: '场景已更新，请重新载入当前设置后再应用草稿。' };
  const settings = { ...scene.sceneSettings };
  try {
    if (draft.lighting !== undefined) {
      // 结果仅由烘焙提交/清除专用动作管理，普通配置草稿不能伪造或替换资产。
      if (JSON.stringify(draft.lighting.result ?? null) !== JSON.stringify(settings.lighting.result ?? null)) {
        return { ok: false, message: '烘焙结果已变化或不能由配置草稿修改，请重新载入。' };
      }
      const rawPolicy = draft.lighting.policy;
      const policy = normalizeSceneLightingPolicy(rawPolicy);
      if (rawPolicy && (!policy || rawPolicy.rules.length !== policy.rules.length
        || rawPolicy.rules.some((rule, index) => (rule.nodeRules?.length ?? 0) !== (policy.rules[index]?.nodeRules?.length ?? 0)))) {
        return { ok: false, message: '存在未完成或无效的分类规则，请检查资源和部件目标后再应用。' };
      }
      settings.lighting = normalizeSceneLightingConfig(draft.lighting);
      const empty = !policy || (policy.rules.length === 0 && Object.keys(policy.defaults).length === 0);
      if (empty && !scene.sceneSettings.lighting.policy) delete settings.lighting.policy;
    }
    if (draft.appearance !== undefined) settings.appearance = normalizeSceneAppearanceConfig(draft.appearance);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '光照或显示效果配置无效。' };
  }
  let entities = scene.entities;
  for (const [id, raw] of Object.entries(draft.entityLighting ?? {})) {
    if (!Object.hasOwn(scene.entities, id) || scene.entities[id].isFolder) return { ok: false, message: '部分对象已不存在，请重新载入草稿。' };
    const entity = scene.entities[id];
    const next = raw === null ? undefined : normalizeEntityLightingSettings(raw);
    if (JSON.stringify(next) === JSON.stringify(entity.components.lighting)) continue;
    if (isEntityEffectivelyLocked(scene.entities, entity)) return { ok: false, message: '选中对象或其父级已锁定，未应用任何配置。' };
    if (next) {
      for (const [nodeKey, override] of Object.entries(next.nodeOverrides)) {
        const before = entity.components.lighting?.nodeOverrides?.[nodeKey];
        const requestedStatic = override.mobility === 'static' && !override.inheritPolicy?.includes('mobility');
        const previouslyStatic = before?.mobility === 'static' && !before.inheritPolicy?.includes('mobility');
        // 历史冲突由运行时钳制；恢复继承和修改阴影不等于再次请求静态。
        if (!requestedStatic || previouslyStatic) continue;
        if (classification.some(entry => entry.entityId === id && entry.nodeKey === nodeKey && entry.parentDynamic)) {
          return { ok: false, message: '动态祖先会带动选中部件，不能将该部件设置为静态。' };
        }
      }
    }
    if (entities === scene.entities) entities = { ...entities };
    const components = { ...entity.components };
    if (next) components.lighting = next;
    else delete components.lighting;
    entities[id] = { ...entity, components };
  }
  const sameSettings = JSON.stringify(settings) === JSON.stringify(scene.sceneSettings);
  return { ok: true, scene: sameSettings && entities === scene.entities ? scene : {
    ...scene, sceneSettings: sameSettings ? scene.sceneSettings : settings, entities,
  } };
}

export type LightingManagerPreflightState = {
  phase: 'idle' | 'checking' | 'ready' | 'blocked' | 'error';
  signature?: string;
  report?: import('../../../electron/shared/sceneLightingBakePreflight').LightingBakePreflight;
  message?: string;
};
export type LightingDraftPreview = {
  baseScene: SceneDocument; sceneSessionId: string; lighting: SceneLightingConfig; appearance: SceneAppearanceConfig; suppressIndirect: boolean;
};
