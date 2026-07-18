import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core';
import type { ModelAssetComponent } from '../../editor/model/components';

/** 共享模型实例句柄；释放实例后会同步归还共享源资源引用。 */
export type SharedModelInstantiation = {
  entries: InstantiatedEntries;
  dispose: () => void;
};

type SharedModelSourceEntry = {
  promise: Promise<AssetContainer>;
  container: AssetContainer | null;
  referenceCount: number;
  disposed: boolean;
};

/**
 * 缓存未加入场景的模型源容器，并为多个实体创建共享几何和材质的 Babylon 实例。
 * 缓存仅持有源资源，实体节点和脚本生命周期仍由 SceneRuntime 独立管理。
 */
export class SharedModelAssetCache {
  private readonly entries = new Map<string, SharedModelSourceEntry>();
  private disposed = false;

  /** 获取共享源容器并创建一个独立实体实例。 */
  async instantiate(
    key: string,
    loader: () => Promise<AssetContainer>,
    nameFunction: (sourceName: string) => string,
  ): Promise<SharedModelInstantiation> {
    if (this.disposed) {
      throw new Error('共享模型资源缓存已释放。');
    }

    const entry = this.acquireEntry(key, loader);
    try {
      const container = await entry.promise;
      if (this.disposed || entry.disposed || this.entries.get(key) !== entry) {
        throw new Error('共享模型源资源在实例创建前已失效。');
      }

      const instantiatedEntries = container.instantiateModelsToScene(
        nameFunction,
        false,
        { doNotInstantiate: false },
      );
      let instanceDisposed = false;

      return {
        entries: instantiatedEntries,
        dispose: () => {
          if (instanceDisposed) return;
          instanceDisposed = true;
          try {
            instantiatedEntries.dispose();
          } finally {
            this.releaseEntry(key, entry);
          }
        },
      };
    } catch (error) {
      this.releaseEntry(key, entry);
      throw error;
    }
  }

  /** 释放缓存入口；活动实例持有的源资源延迟到最后一次引用归还后再释放。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const entry of this.entries.values()) {
      if (entry.referenceCount === 0) {
        this.disposeSourceEntry(entry);
      }
    }
    this.entries.clear();
  }

  /** 获取或创建指定资源键的共享源条目，并增加一次活动引用。 */
  private acquireEntry(key: string, loader: () => Promise<AssetContainer>): SharedModelSourceEntry {
    const cached = this.entries.get(key);
    if (cached && !cached.disposed) {
      cached.referenceCount += 1;
      return cached;
    }

    const entry: SharedModelSourceEntry = {
      promise: Promise.resolve(null as unknown as AssetContainer),
      container: null,
      referenceCount: 1,
      disposed: false,
    };
    entry.promise = loader()
      .then((container) => {
        if (this.disposed || entry.disposed) {
          container.dispose();
          throw new Error('共享模型源资源加载完成时缓存已释放。');
        }
        entry.container = container;
        return container;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        throw error;
      });
    this.entries.set(key, entry);
    return entry;
  }

  /** 归还一次活动引用，并在最后一个实例释放后销毁共享源容器。 */
  private releaseEntry(key: string, entry: SharedModelSourceEntry): void {
    if (entry.referenceCount > 0) {
      entry.referenceCount -= 1;
    }
    if (entry.referenceCount > 0 || entry.disposed) return;

    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    this.disposeSourceEntry(entry);
  }

  /** 幂等释放单个共享源条目。 */
  private disposeSourceEntry(entry: SharedModelSourceEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.container?.dispose();
    entry.container = null;
  }
}

/** 模型共享实例的最终准入模式；shared-instance 复用源容器，owned-container 独占容器和脚本生命周期。 */
export type ModelAssetSharedInstancingMode = 'shared-instance' | 'owned-container';

/** 模型共享策略判定原因，用于 smoke 和后续接入方精确解释准入边界。 */
export type ModelAssetSharedInstancingReason =
  | 'shelf-resource'
  | 'plain-static-model'
  | 'script-assets'
  | 'parameter-config'
  | 'parameter-script-metadata'
  | 'animation-script-metadata';

/** 模型共享策略快照结果，只表达准入结论，不触碰运行时场景或外部资源。 */
export type ModelAssetSharedInstancingPolicy = {
  mode: ModelAssetSharedInstancingMode;
  reason: ModelAssetSharedInstancingReason;
};

/**
 * 基于 ModelAssetComponent 快照判定模型是否可安全进入共享实例路径。
 * Shelf 是历史验证过的特例，允许携带参数脚本继续共享；其它带脚本或参数元数据的模型必须独占容器。
 */
export function resolveModelAssetSharedInstancingPolicy(
  modelAsset: ModelAssetComponent,
): ModelAssetSharedInstancingPolicy {
  if (isShelfInstancingCandidate(modelAsset)) {
    return { mode: 'shared-instance', reason: 'shelf-resource' };
  }

  const blockingReason = findOwnedContainerReason(modelAsset);
  if (blockingReason) {
    return { mode: 'owned-container', reason: blockingReason };
  }

  return { mode: 'shared-instance', reason: 'plain-static-model' };
}

/** 判断模型策略是否允许共享实例，便于调用方不重复理解 reason 枚举。 */
export function shouldUseSharedModelInstantiation(modelAsset: ModelAssetComponent): boolean {
  return resolveModelAssetSharedInstancingPolicy(modelAsset).mode === 'shared-instance';
}

/** 找出普通模型必须独占容器的第一个动态能力字段；只读取资产组件快照。 */
function findOwnedContainerReason(modelAsset: ModelAssetComponent): ModelAssetSharedInstancingReason | null {
  if (hasArrayEntries(modelAsset.scriptAssets)) return 'script-assets';
  if (modelAsset.parameterConfig != null) return 'parameter-config';
  if (hasArrayEntries(modelAsset.parameterScriptMetadata)) return 'parameter-script-metadata';
  if (hasArrayEntries(modelAsset.animationScriptMetadata)) return 'animation-script-metadata';
  return null;
}

/** 判断快照数组字段是否真实携带条目；空数组等同于未启用该动态能力。 */
function hasArrayEntries(value: readonly unknown[] | undefined | null): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** 判断模型资产是否为允许共享几何和材质的 Shelf 模型。 */
export function isShelfInstancingCandidate(modelAsset: ModelAssetComponent): boolean {
  const resourceIdentifiers = [
    modelAsset.sourcePath,
    modelAsset.sourceUrl,
    ...(modelAsset.scriptAssets ?? []).flatMap((scriptAsset) => [
      scriptAsset.path,
      scriptAsset.sourceUrl,
      scriptAsset.name,
    ]),
  ];

  if (resourceIdentifiers.some(isShelfResourceIdentifier)) return true;

  const metadataSignature = JSON.stringify([
    modelAsset.parameterScriptMetadata ?? [],
    modelAsset.animationScriptMetadata ?? [],
  ]);
  return /"scriptFilename"\s*:\s*"shelf\.model\.ts"/i.test(metadataSignature);
}

/** 使用稳定文件名和目录名识别 Shelf 资源，避免依赖场景实体显示名称。 */
function isShelfResourceIdentifier(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').toLowerCase().split(/[?#]/, 1)[0];
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  return fileName === 'shelf.glb'
    || fileName === 'shelf.gltf'
    || fileName === 'shelf.model.ts'
    || normalized.includes('/shelf/');
}
