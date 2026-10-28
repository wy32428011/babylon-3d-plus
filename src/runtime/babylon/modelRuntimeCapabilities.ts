import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import type { AssetContainer } from '@babylonjs/core/assetContainer.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ISceneLoaderProgressEvent } from '@babylonjs/core/Loading/sceneLoader.js';
import type { ModelAssetComponent } from '../../editor/model/components';
import { hashModelRuntimeConfiguration, normalizeModelRuntimeCapabilities, type ModelRuntimeCapabilities } from '../../../electron/shared/modelRuntimeCapabilities.ts';
import type { IGLTFLoaderData } from '@babylonjs/loaders/glTF/glTFFileLoader.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';

const declarations = new WeakMap<AssetContainer, ModelRuntimeCapabilities>();

/** 声明必须来自实际加载的 glTF，而非仅来自可编辑的场景快照；不增加一次 GLB 下载或解析。 */
export async function loadCapabilityModelTemplate(rootUrl: string, fileName: string, scene: Scene,
  onProgress?: (event: ISceneLoaderProgressEvent) => void): Promise<AssetContainer> {
  let declaration: ModelRuntimeCapabilities | undefined;
  const container = await LoadAssetContainerAsync(fileName, scene, { rootUrl, onProgress,
    pluginOptions: { gltf: { onParsed: (data: IGLTFLoaderData) => {
      const json = data.json as { asset?: { extras?: { runtimeCapabilities?: unknown } } };
      declaration = normalizeModelRuntimeCapabilities(json.asset?.extras?.runtimeCapabilities);
    } } },
  });
  if (declaration) declarations.set(container, declaration);
  return container;
}

/** 只读共享先确认实际源、配置和完整脚本集合；脚本内容在执行 factory 之前再次核摘要。 */
export async function verifyModelTemplateCapabilities(source: AssetContainer, asset: ModelAssetComponent): Promise<ModelRuntimeCapabilities | undefined> {
  const requested = normalizeModelRuntimeCapabilities(asset.runtimeCapabilities);
  const actual = declarations.get(source);
  if (!requested || !actual || !(asset.sourceSnapshot?.contentSha256 || asset.assetRevision)
    || JSON.stringify(requested) !== JSON.stringify(actual)) return undefined;
  const scripts = asset.scriptAssets ?? [];
  const names = scripts.map(script => script.name);
  if (new Set(names).size !== names.length || names.length !== Object.keys(actual.scripts).length
    || names.some(name => !Object.hasOwn(actual.scripts, name))) return undefined;
  if (await hashModelRuntimeConfiguration(asset) !== actual.configurationSha256) return undefined;
  // 原生实例、骨骼、Morph 与内嵌 thinInstance 可在复制时引入新的可变数据，首版保持独占。
  if (source.skeletons.length || source.morphTargetManagers.length
    || source.meshes.some(mesh => mesh.isAnInstance || mesh.skeleton || mesh.morphTargetManager || mesh.hasThinInstances)) return undefined;
  return actual;
}

/**
 * 只在源声明与配置验证后收集可共享材质。首版不接纳脚本或动画，避免无法追踪的公开属性写入。
 * 声明式材质目标（含尚未命中的条件规则）从一开始独占，不能等 GI/入场保存恢复引用后再拆分。
 */
export function collectReadonlyModelMaterials(
  source: AssetContainer,
  asset: ModelAssetComponent,
  capability: ModelRuntimeCapabilities | undefined,
): ReadonlySet<Material> {
  const shared = new Set<Material>();
  if (capability?.materials !== 'shared-readonly' || Object.keys(capability.scripts).length
    || asset.scriptAssets?.length || asset.parameterScriptMetadata?.length || asset.animationScriptMetadata?.length
    || source.animationGroups.length) return shared;
  const hasAnimations = (target: unknown): boolean => Boolean((target as { animations?: { length?: number } }).animations?.length);
  // 连节点动画也保守回退：公开动画属性路径可指向 material/texture 的嵌套字段。
  if ([...source.meshes, ...source.transformNodes, ...source.cameras, ...source.lights, ...source.textures].some(hasAnimations)) return shared;

  const materials = new Set<Material>();
  const collect = (material: Material | null): void => {
    if (!material || materials.has(material)) return;
    materials.add(material);
    if (material instanceof MultiMaterial) for (const child of material.subMaterials) collect(child);
  };
  // 只纳入工作模型实际引用的材质；模板内未使用的材质不能制造“已共享”的空覆盖。
  for (const mesh of source.meshes) collect(mesh.material);
  for (const material of materials) {
    if (hasAnimations(material) || material.getActiveTextures().some(texture => hasAnimations(texture) || texture.isRenderTarget)) return shared;
  }

  const writableNames = new Set<string>();
  const config = asset.parameterConfig;
  for (const binding of config?.bindings ?? []) if (binding.target.kind === 'material') writableNames.add(binding.target.name);
  for (const rule of config?.rules ?? []) {
    for (const binding of rule.set) if (binding.target.kind === 'material') writableNames.add(binding.target.name);
  }
  const owned = new Set<Material>();
  const markOwned = (material: Material): void => {
    if (owned.has(material)) return;
    owned.add(material);
    if (material instanceof MultiMaterial) for (const child of material.subMaterials) if (child) markOwned(child);
  };
  const sourceOwnedMaterials = new Set<Material>([...source.materials, ...source.multiMaterials]);
  for (const material of materials) {
    // 借用的每一层必须确由模板持有；未登记的子材质不能靠工作容器释放兜底。
    if (writableNames.has(material.name) || material.getScene() !== source.scene || !sourceOwnedMaterials.has(material)
      || !(material instanceof MultiMaterial || material instanceof PBRMaterial || material instanceof StandardMaterial)) markOwned(material);
  }
  const visited = new Map<Material, boolean>();
  const canShare = (material: Material): boolean => {
    const cached = visited.get(material);
    if (cached !== undefined) return cached;
    // 先登记 false，循环 MultiMaterial 保守独占；父容器引用可写子材质时也必须独占。
    visited.set(material, false);
    if (owned.has(material)) return false;
    const eligible = !(material instanceof MultiMaterial)
      || material.subMaterials.every(child => !child || canShare(child));
    if (eligible) { visited.set(material, true); shared.add(material); }
    return eligible;
  };
  for (const material of materials) canShare(material);
  return shared;
}
