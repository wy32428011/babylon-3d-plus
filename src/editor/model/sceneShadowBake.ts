import type { SceneDocument } from './SceneDocument';
import {
  getSceneShadowBakeErrorContract,
  getSceneShadowBakeSignatureContract,
  isStaticShadowEntityContract,
} from '../../../electron/shared/sceneShadowBakeContract';

export { sanitizeSceneShadowBake, SCENE_SHADOW_BAKE_MAX_PIXELS, SCENE_SHADOW_BAKE_MAX_DATA_URL_LENGTH, type SceneShadowBakeSnapshot } from '../../../electron/shared/sceneShadowBakeContract';

export function getSceneShadowBakeSignature(document: SceneDocument): string {
  return getSceneShadowBakeSignatureContract(document);
}

export function isStaticShadowEntity(document: SceneDocument, entityId: string): boolean {
  return isStaticShadowEntityContract(document, entityId);
}

export function getSceneShadowBakeError(document: SceneDocument): string | null {
  return getSceneShadowBakeErrorContract(document);
}
