import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import type { AssetContainer } from '@babylonjs/core/assetContainer.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { ISceneLoaderProgressEvent } from '@babylonjs/core/Loading/sceneLoader.js';
import type { ModelAssetComponent } from '../../editor/model/components';
import { hashModelRuntimeConfiguration, normalizeModelRuntimeCapabilities, type ModelRuntimeCapabilities } from '../../../electron/shared/modelRuntimeCapabilities.ts';
import type { IGLTFLoaderData } from '@babylonjs/loaders/glTF/glTFFileLoader.js';

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
