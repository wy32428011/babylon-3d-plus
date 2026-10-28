import type { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * 共享材质仍由解析模板拥有；工作容器只借用，不把材质或纹理加入自己的 dispose 清单。
 * 登记跟随整个源 lease 生命周期，不能在某个工作实例退出时移除仍被其它实例使用的材质。
 */
export class ReadonlyMaterialOwnership {
  private readonly added = new Set<Material>();
  private disposed = false;

  constructor(private readonly scene: Scene) {}

  register(materials: ReadonlySet<Material>): void {
    if (this.disposed) throw new Error('只读材质所有权已释放。');
    const addedNow: Material[] = [];
    try {
      for (const material of materials) {
        if (material instanceof MultiMaterial
          ? this.scene.multiMaterials.includes(material) : this.scene.materials.includes(material)) continue;
        // Scene 的新增观察器可同步抛错，先记账才能连同已入场但通知失败的材质一起回滚。
        this.added.add(material);
        addedNow.push(material);
        if (material instanceof MultiMaterial) this.scene.addMultiMaterial(material);
        else this.scene.addMaterial(material);
      }
    } catch (error) {
      for (const material of addedNow.reverse()) { this.remove(material); this.added.delete(material); }
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const material of this.added) this.remove(material);
    this.added.clear();
  }

  private remove(material: Material): void {
    if (material instanceof MultiMaterial) {
      if (this.scene.multiMaterials.includes(material)) this.scene.removeMultiMaterial(material);
    } else if (this.scene.materials.includes(material)) this.scene.removeMaterial(material);
  }
}
