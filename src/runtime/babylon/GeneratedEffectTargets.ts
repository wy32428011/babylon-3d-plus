import type { AbstractMesh, TransformNode } from '@babylonjs/core';
import type { ModelGeneratorTarget } from '../../editor/model/components';
import type { EffectModelReference, EffectRuntimeTarget } from '../../editor/model/effectConfiguration';
import type { DeviceTelemetrySnapshot } from '../mqtt/deviceTelemetry';

type ModelTarget = Extract<ModelGeneratorTarget, { kind: 'model' }>;
type GeneratedTargetOwner = {
  entityId: string;
  entityName: string;
  root: TransformNode;
  loadToken: number;
  activeModelTarget?: ModelTarget | null;
  output: { kind: 'mesh' } | { kind: 'model'; model: {
    root: TransformNode; assetHandle: unknown; meshes: AbstractMesh[]; externalScriptStarting: boolean;
    readinessError?: string; externalScriptRuntime?: { getInitializationError(): string | null } | null;
  } } | { kind: 'composition' } | null;
  metadata: Record<string, unknown>;
  activeSnapshot: DeviceTelemetrySnapshot | null;
  readinessError?: string;
};

/** 直接引用实际输出模板；内置占位几何与生成器标记不具备模型库类型身份。 */
export function effectReferenceFromGeneratorTarget(target: ModelTarget): EffectModelReference {
  const asset = target.modelAsset;
  return {
    name: target.displayName,
    sourceUrl: asset.sourceUrl,
    sourcePath: asset.sourcePath,
    ...(asset.dataPlatformModel ? { identity: { ...asset.dataPlatformModel } } : {}),
    ...(asset.dataDrivenConfig?.device.devType ? { deviceType: asset.dataDrivenConfig.device.devType } : {}),
  };
}

/** 货物编号与承载设备遥测身份分开，匿名货物不会回退成承载设备编号。 */
export function describeGeneratedEffectTarget(owner: GeneratedTargetOwner): EffectRuntimeTarget | null {
  const target = owner.activeModelTarget;
  if (!target || owner.root.isDisposed()) return null;
  const model = owner.output?.kind === 'model' ? owner.output.model : null;
  const snapshot = owner.activeSnapshot;
  const containerCode = typeof owner.metadata.containerCode === 'string' ? owner.metadata.containerCode.trim() : '';
  const generatorId = typeof owner.metadata.generatorEntityId === 'string' ? owner.metadata.generatorEntityId : null;
  const hasGeometry = model?.meshes.some(mesh => !mesh.isDisposed() && mesh.getTotalVertices() > 0) ?? false;
  const ready = !!model?.assetHandle && !model.externalScriptStarting && hasGeometry;
  const visibleGeometry = model?.meshes.some(mesh => !mesh.isDisposed() && mesh.getTotalVertices() > 0 && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0) ?? false;
  const visible = owner.root.isEnabled() && (!model || model.root.isEnabled()) && (!hasGeometry || visibleGeometry);
  const error = model?.readinessError ?? model?.externalScriptRuntime?.getInitializationError() ?? owner.readinessError;
  const state = !visible ? 'hidden' : error ? 'error' : ready ? 'ready' : 'loading';
  return {
    id: owner.entityId, name: owner.entityName, origin: 'generated',
    model: effectReferenceFromGeneratorTarget(target), identity: null,
    ...(snapshot ? { carrierIdentity: { sourceId: snapshot.sourceId, deviceType: snapshot.deviceType, assetCode: snapshot.assetCode } } : {}),
    ...(containerCode ? { containerCode } : {}), generatorId, state,
    generation: owner.loadToken,
    ...(state === 'error' ? { message: error } : {}),
  };
}
