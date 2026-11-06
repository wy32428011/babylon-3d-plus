import type { TransformNode } from '@babylonjs/core';
import { ExternalModelScriptRuntime } from '../../runtime/babylon/ExternalModelScriptRuntime';
import type { ModelAssetComponent } from '../model/components';
import { normalizeModelParameterConfig } from '../model/modelParameters';
import type { AuthoringSession, BinaryAsset, ParameterValue } from './types';
import { originalParameterDefinitions, safeAssetPath, validateSessionAssets } from './io';
import { sha256, trustedTemplate } from './templates';

export function assetDataUri(asset: BinaryAsset): string {
  let binary = '';
  for (let offset = 0; offset < asset.bytes.length; offset += 0x8000) binary += String.fromCharCode(...asset.bytes.subarray(offset, offset + 0x8000));
  return `data:${asset.mediaType};base64,${btoa(binary)}`;
}

/** 纹理参数按源 GLB 所在目录解析，而非按 scripts/meta 所在目录。 */
export function findTextureAsset(session: AuthoringSession, reference: string): BinaryAsset {
  const model = session.project.source && session.assets.get(session.project.source.modelAssetId);
  if (!model) throw new Error('源模型资产缺失。');
  const path = safeAssetPath(reference);
  const directory = model.path.slice(0, model.path.lastIndexOf('/') + 1);
  const asset = [...session.assets.values()].find(item => item.path === directory + path);
  if (!asset || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType)) throw new Error(`纹理参数引用的图片缺失：${reference}`);
  return asset;
}

export async function createLegacyPreview(root: TransformNode, session: AuthoringSession): Promise<{
  update(values: Record<string, ParameterValue>): void;
  dispose(): void;
  getError(): string | null;
} | null> {
  const text = await trustedTemplate(session.project, session.assets);
  if (!text) return null;
  await validateSessionAssets(session);
  const source = session.project.source!;
  const scriptName = source.scripts[0].fileName;
  const urls: string[] = [];
  const originalMetadata = root.metadata;
  const values = Object.fromEntries(session.project.parameters.map(parameter => [parameter.key, parameter.value]));
  const fields = originalParameterDefinitions(source.originalMeta);
  const textureKeys = new Set(fields.filter(field => field.type === 'texture').map(field => String(field.key)));
  const textureUrls = new Map<string, string>();
  const resolveValues = (input: Record<string, ParameterValue>): Record<string, ParameterValue> => Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (!textureKeys.has(key) || typeof value !== 'string' || !value) return [key, value];
    let uri = textureUrls.get(value);
    if (!uri) { uri = assetDataUri(findTextureAsset(session, value)); textureUrls.set(value, uri); }
    return [key, uri];
  }));
  const resolvedValues = resolveValues(values);
  const blobUrl = (bytes: Uint8Array, type: string): string => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type }));
    urls.push(url); return url;
  };
  const scriptUrl = blobUrl(new TextEncoder().encode(text), 'text/plain');
  const model = session.assets.get(source.modelAssetId)!;
  const modelUrl = blobUrl(model.bytes, model.mediaType);
  const parameterConfig = normalizeModelParameterConfig({ schema: 'babylon-editor.model-parameters', version: 1, bindings: [], parameters: session.project.parameters.map(parameter => ({
    ...fields.find(field => field.key === parameter.key), ...parameter,
    // 已在此处解析图片为 data URI，避免 Blob 模型地址再次参与相对路径解析。
    type: textureKeys.has(parameter.key) ? 'string' : parameter.type,
  })) });
  if (!parameterConfig) { urls.forEach(url => URL.revokeObjectURL(url)); throw new Error('原模型参数定义不能被正式宿主接受。'); }
  const asset: ModelAssetComponent = {
    assetCode: source.id, sourcePath: model.path, sourceUrl: modelUrl, lengthUnit: source.unit, unitScaleToMeters: source.unitScale,
    scriptAssets: [{ name: scriptName, path: source.scripts[0].path, sourceUrl: scriptUrl }], parameterConfig,
    parameterValues: resolvedValues,
    parameterScriptMetadata: Array.isArray(source.originalMeta.parameterScripts) ? structuredClone(source.originalMeta.parameterScripts) : [],
    animationScriptMetadata: [{ scriptFilename: scriptName, className: 'ParametricModelRuntimeComponent' }],
  };
  const runtime = new ExternalModelScriptRuntime(root, asset, { expectedScriptHashes: { [scriptName]: await sha256(new TextEncoder().encode(text)) } });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    runtime.dispose();
    root.metadata = originalMetadata;
    urls.forEach(url => URL.revokeObjectURL(url));
  };
  const syncValues = (input: Record<string, ParameterValue>): Record<string, ParameterValue> => {
    const resolved = resolveValues(input);
    const scripts = Array.isArray(root.metadata?.scripts) ? root.metadata.scripts.filter((script: any) => !script.__authoringLegacy) : [];
    root.metadata = { ...(root.metadata ?? {}), scripts: [{ ...resolved, className: 'ParametricModelParamsComponent', scriptFilename: scriptName, values: resolved, __authoringLegacy: true }, ...scripts] };
    return resolved;
  };
  try {
    root.metadata = { ...(root.metadata ?? {}), scripts: [...(asset.parameterScriptMetadata ?? []), ...(asset.animationScriptMetadata ?? [])] };
    runtime.updateParameterValues(syncValues(values));
    await runtime.start();
    runtime.update();
    const error = runtime.getInitializationError();
    if (error) throw new Error(error);
    return {
      update(nextValues) {
        if (disposed) return;
        runtime.updateParameterValues(syncValues(nextValues));
        runtime.update();
      },
      dispose,
      getError: () => {
        const diagnostic = Object.entries(root.metadata ?? {}).find(([key, value]) => /parametric.*(?:error|diagnostic)/i.test(key) && value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string');
        return diagnostic ? String((diagnostic[1] as { message: string }).message) : runtime.getInitializationError();
      },
    };
  } catch (error) { dispose(); throw error; }
}
