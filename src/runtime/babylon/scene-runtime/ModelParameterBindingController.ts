import { executeModelParameterBindings } from '../modelParameterBindingExecution';
import { evaluateBooleanExpression, evaluateModelExpression, isVector3Value } from '../modelParameterExpression';
import { Material } from '@babylonjs/core/Materials/material.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Entity } from '../../../editor/model/Entity';
import type { ModelAssetComponent } from '../../../editor/model/components';
import type { ModelExpression, ModelParameterBinding, ModelParameterValue, ModelParameterValues } from '../../../editor/model/modelParameters';
import type { Vector3Data } from '../../../editor/model/math';
import { resolveModelTextureAssetUrl } from '../../assets/modelTextureAssetUrl';
import { isPlainRecord } from '../runtimeValueUtils';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneDocumentController } from './SceneDocumentController';
import { type ModelRuntimeEntry, type ModelParameterRuntimeTarget, type ParameterTextureAssignment, type ModelParameterBaselineValue } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly presentation: Pick<SceneMeshPresentationController, 'readColor'>;
  readonly document: Pick<SceneDocumentController, 'disposed'>;
};


/** ModelParameterBindingController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ModelParameterBindingController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly parameterTextureAssignments = new WeakMap<Material, ParameterTextureAssignment>();
  public readonly unavailableParameterTextures = new WeakSet<Texture>();
  public readonly observedParameterTextures = new WeakSet<Texture>();

  /** 将模型或环境源单位换算到米，避免污染可被 Gizmo 写回的实体根 Transform。 */
  public applyModelUnitScale(target: TransformNode, unitScaleToMeters: number): void {
    target.scaling = new Vector3(unitScaleToMeters, unitScaleToMeters, unitScaleToMeters);
  }

  /** 根据实体模型资产把声明式参数绑定应用到模型节点、网格和材质。 */
  public applyModelParameters(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;
    this.applyModelAssetParameters(modelAsset, model);
  }

  /** 应用完整模型资产快照中的默认参数，普通模型和生成模型共用同一逻辑。 */
  public applyModelAssetParameters(modelAsset: ModelAssetComponent, model: ModelRuntimeEntry): void {
    if (!modelAsset.parameterConfig || !modelAsset.parameterValues || !model.assetHandle) return;

    const signature = JSON.stringify({ config: modelAsset.parameterConfig, values: modelAsset.parameterValues });
    if (model.parameterSignature === signature) return;

    this.resetModelParameterTargets(model);

    executeModelParameterBindings(modelAsset.parameterConfig, {
      apply: binding => this.applyModelParameterBinding(binding, modelAsset.parameterValues!, modelAsset, model),
      evaluateRule: expression => this.evaluateBooleanExpression(expression, modelAsset.parameterValues!),
      report: message => Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`${modelAsset.assetCode || modelAsset.sourcePath}：${message}`]),
    });

    model.parameterSignature = signature;
  }

  /** 把实例资产编号和 meta.json 脚本参数写回 Babylon 节点 metadata，供运行时和动画识别读取。 */
  public syncModelScriptMetadata(target: TransformNode, modelAsset: ModelAssetComponent): void {
    const scripts = (modelAsset.parameterScriptMetadata ?? []).map((script) => {
      const clonedScript = this.cloneJsonValue(script);
      if (!isPlainRecord(clonedScript)) return clonedScript;

      const values = isPlainRecord(clonedScript.values) ? { ...clonedScript.values } : {};
      for (const [key, value] of Object.entries(modelAsset.parameterValues ?? {})) {
        const previousValue = isPlainRecord(values[key]) ? values[key] : {};
        values[key] = { ...previousValue, value };
      }
      clonedScript.values = values;
      return clonedScript;
    });

    const previousMetadata = target.metadata ?? {};
    const previousModelAssetMetadata = isPlainRecord(previousMetadata.modelAsset)
      ? previousMetadata.modelAsset
      : {};

    target.metadata = {
      ...previousMetadata,
      assetCode: modelAsset.assetCode,
      modelAsset: {
        ...previousModelAssetMetadata,
        assetCode: modelAsset.assetCode,
      },
      scripts,
    };
  }

  /** 克隆可序列化脚本元数据，避免运行时改动污染场景文档。 */
  public cloneJsonValue(value: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      return value;
    }
  }

  public applyModelParameterBinding(
    binding: ModelParameterBinding,
    values: ModelParameterValues,
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
  ): void {
    const value = this.evaluateModelExpression(binding.value, values);
    if (value === null) throw new Error('表达式与已保存参数值不兼容。');

    const targets = this.resolveModelParameterTargets(binding, model);
    if (!targets.length) throw new Error('新版模型中没有匹配的绑定目标。');
    for (const target of targets) {
      this.applyModelParameterValueToTarget(target, binding.property, value, modelAsset, model);
    }
  }

  public resolveModelParameterTargets(binding: ModelParameterBinding, model: ModelRuntimeEntry): ModelParameterRuntimeTarget[] {
    if (binding.target.kind === 'material') {
      const materials = new Map<string, Material>();
      for (const mesh of model.meshes) {
        if (mesh.material?.name === binding.target.name) materials.set(mesh.material.uniqueId.toString(), mesh.material);
      }
      return [...materials.values()];
    }

    if (binding.target.kind === 'mesh') {
      return model.meshes.filter((mesh) => mesh.name === binding.target.name);
    }

    return model.root.getChildTransformNodes(false).filter((node) => node.name === binding.target.name);
  }

  public getModelParameterBaselineKey(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
  ): string {
    return `${target.uniqueId}:${property}`;
  }

  public rememberModelParameterBaseline(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
    model: ModelRuntimeEntry,
  ): void {
    const key = this.getModelParameterBaselineKey(target, property);
    if (model.parameterBaseline.has(key)) return;

    if (property === 'visible') {
      if (target instanceof AbstractMesh) {
        model.parameterBaseline.set(key, target.isVisible);
        return;
      }

      if (target instanceof TransformNode) {
        model.parameterBaseline.set(key, target.isEnabled());
      }
      return;
    }

    if ((property === 'position' || property === 'rotation' || property === 'scaling') && target instanceof TransformNode) {
      const vector = target[property];
      model.parameterBaseline.set(key, { x: vector.x, y: vector.y, z: vector.z });
      return;
    }

    if ((property === 'baseColor' || property === 'emissiveColor') && target instanceof Material) {
      const color = this.readMaterialColor(target, property);
      model.parameterBaseline.set(key, color);
      return;
    }

    if (property === 'alpha' && target instanceof Material) {
      model.parameterBaseline.set(key, target.alpha);
      return;
    }

    if (property === 'baseTexture' && target instanceof Material) {
      model.parameterBaseline.set(key, this.readMaterialTexture(target));
    }
  }

  public resetModelParameterTargets(model: ModelRuntimeEntry): void {
    for (const [key, value] of model.parameterBaseline.entries()) {
      const [uniqueIdText, property] = key.split(':') as [string, ModelParameterBinding['property']];
      const target = this.findModelParameterTargetByUniqueId(model, Number(uniqueIdText));
      if (!target) continue;

      this.restoreModelParameterBaseline(target, property, value);
    }
  }

  public findModelParameterTargetByUniqueId(model: ModelRuntimeEntry, uniqueId: number): ModelParameterRuntimeTarget | null {
    for (const mesh of model.meshes) {
      if (mesh.uniqueId === uniqueId) return mesh;
      if (mesh.material?.uniqueId === uniqueId) return mesh.material;
    }

    for (const node of model.root.getChildTransformNodes(false)) {
      if (node.uniqueId === uniqueId) return node;
    }

    return null;
  }

  public restoreModelParameterBaseline(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
    value: ModelParameterBaselineValue,
  ): void {
    if (property === 'visible' && typeof value === 'boolean') {
      if (target instanceof AbstractMesh) target.isVisible = value;
      if (target instanceof TransformNode) target.setEnabled(value);
      return;
    }

    if ((property === 'position' || property === 'rotation' || property === 'scaling') && this.isVector3Value(value) && target instanceof TransformNode) {
      target[property] = new Vector3(value.x, value.y, value.z);
      return;
    }

    if ((property === 'baseColor' || property === 'emissiveColor') && typeof value === 'string' && target instanceof Material) {
      this.applyMaterialColor(target, property, value);
      return;
    }

    if (property === 'alpha' && typeof value === 'number' && target instanceof Material) {
      target.alpha = value;
      return;
    }

    if (property === 'baseTexture' && target instanceof Material) {
      this.applyMaterialTexture(target, value instanceof Texture ? value : null);
    }
  }

  public applyModelParameterValueToTarget(
    target: ModelParameterRuntimeTarget,
    property: ModelParameterBinding['property'],
    value: ModelParameterValue,
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
  ): void {
    this.rememberModelParameterBaseline(target, property, model);

    if (property === 'visible') {
      if (typeof value !== 'boolean') throw new Error('显隐绑定需要布尔值。');
      if (target instanceof AbstractMesh) target.isVisible = value;
      if (target instanceof TransformNode) target.setEnabled(value);
      return;
    }

    if (property === 'position' || property === 'rotation' || property === 'scaling') {
      if (!this.isVector3Value(value) || !(target instanceof TransformNode)) throw new Error('变换绑定需要有效的三维向量和节点。');
      target[property] = new Vector3(value.x, value.y, value.z);
      return;
    }

    if (property === 'baseColor' || property === 'emissiveColor') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value) || !(target instanceof Material)) throw new Error('颜色绑定需要有效的颜色和材质。');
      this.applyMaterialColor(target, property, value);
      return;
    }

    if (property === 'alpha') {
      if (typeof value !== 'number' || !Number.isFinite(value) || !(target instanceof Material)) throw new Error('透明度绑定需要有限数字和材质。');
      target.alpha = Math.min(1, Math.max(0, value));
      return;
    }

    if (property === 'baseTexture') {
      if (typeof value !== 'string' || !(target instanceof Material)) throw new Error('纹理绑定需要有效的纹理路径和材质。');
      const texture = this.loadOrReuseTexture(value, modelAsset, model);
      if (!texture) throw new Error('纹理路径未通过安全校验或无法读取。');
      const previousTexture = this.readMaterialTexture(target);
      if (previousTexture === texture) return;
      const previousAssignment = this.parameterTextureAssignments.get(target);
      const previous = previousAssignment?.texture === previousTexture ? previousAssignment
        : { texture: previousTexture, previous: null };
      this.observeParameterTextureDisposal(previousTexture);
      this.observeParameterTextureDisposal(texture);
      this.parameterTextureAssignments.set(target, { texture, previous });
      this.applyMaterialTexture(target, texture);
    }
  }

  public evaluateBooleanExpression(expression: ModelExpression, values: ModelParameterValues): boolean {
    return evaluateBooleanExpression(expression, values);
  }

  public evaluateModelExpression(expression: ModelExpression, values: ModelParameterValues): ModelParameterValue | null {
    return evaluateModelExpression(expression, values);
  }

  public isVector3Value(value: unknown): value is Vector3Data {
    return isVector3Value(value);
  }

  /** 判断值是否为普通对象，用于安全处理模型脚本 JSON 元数据。 */

  public applyMaterialColor(material: Material, property: 'baseColor' | 'emissiveColor', value: string): void {
    const color = this.dependencies.presentation.readColor(value);
    if (material instanceof StandardMaterial) {
      if (property === 'baseColor') material.diffuseColor = color;
      if (property === 'emissiveColor') material.emissiveColor = color;
      return;
    }

    if (material instanceof PBRMaterial) {
      if (property === 'baseColor') material.albedoColor = color;
      if (property === 'emissiveColor') material.emissiveColor = color;
    }
  }

  public readMaterialColor(material: Material, property: 'baseColor' | 'emissiveColor'): string | null {
    if (material instanceof StandardMaterial) {
      const color = property === 'baseColor' ? material.diffuseColor : material.emissiveColor;
      return color.toHexString();
    }

    if (material instanceof PBRMaterial) {
      const color = property === 'baseColor' ? material.albedoColor : material.emissiveColor;
      return color.toHexString();
    }

    return null;
  }

  public applyMaterialTexture(material: Material, texture: Texture | null): void {
    if (material instanceof StandardMaterial) {
      material.diffuseTexture = texture;
      return;
    }

    if (material instanceof PBRMaterial) {
      material.albedoTexture = texture;
    }
  }

  public readMaterialTexture(material: Material): Texture | null {
    if (material instanceof StandardMaterial) {
      return material.diffuseTexture instanceof Texture ? material.diffuseTexture : null;
    }

    if (material instanceof PBRMaterial) {
      return material.albedoTexture instanceof Texture ? material.albedoTexture : null;
    }

    return null;
  }

  /** 释放标记按对象记录，不影响相同 URL 后续重试创建的新纹理。 */
  public observeParameterTextureDisposal(texture: Texture | null): void {
    if (!texture || this.observedParameterTextures.has(texture)) return;
    this.observedParameterTextures.add(texture);
    const unavailableTextures = this.unavailableParameterTextures;
    texture.onDisposeObservable.addOnce(() => unavailableTextures.add(texture));
  }

  /** 使用共享贴图解析器加载或复用 Babylon 纹理，保证材质绑定和外置脚本参数语义一致。 */
  public loadOrReuseTexture(reference: string, modelAsset: ModelAssetComponent, model: ModelRuntimeEntry): Texture | null {
    const textureUrl = resolveModelTextureAssetUrl(reference, {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision,
    });
    if (!textureUrl) return null;

    const existing = model.textureCache.get(textureUrl);
    if (existing) return existing;

    const texture = new Texture(textureUrl, this.context.scene, undefined, undefined, undefined, undefined, message => queueMicrotask(() => {
      // 仅回退本次失败赋值：保留此前成功效果，迟到错误也不能覆盖后来的赋值。
      if (model.textureCache.get(textureUrl) === texture) model.textureCache.delete(textureUrl);
      this.unavailableParameterTextures.add(texture);
      const materials = new Set(model.meshes.map(mesh => mesh.material).filter((material): material is Material => Boolean(material)));
      for (const material of materials) {
        if (this.readMaterialTexture(material) !== texture) continue;
        const current = this.parameterTextureAssignments.get(material);
        if (current?.texture !== texture) continue;
        let previous = current.previous;
        while (previous?.texture && this.unavailableParameterTextures.has(previous.texture)) previous = previous.previous;
        this.parameterTextureAssignments.set(material, previous ?? { texture: null, previous: null });
        this.applyMaterialTexture(material, previous?.texture ?? null);
      }
      texture.dispose();
      if (!this.dependencies.document.disposed) Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`${modelAsset.assetCode || modelAsset.sourcePath}：参数纹理无法读取，已跳过该效果并保留参数值：${reference}${message ? `（${message}）` : ''}`]);
    }));
    model.textureCache.set(textureUrl, texture);
    return texture;
  }
}
