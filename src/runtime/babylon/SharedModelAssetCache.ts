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
