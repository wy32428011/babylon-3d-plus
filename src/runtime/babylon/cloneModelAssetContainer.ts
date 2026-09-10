import {
  AbstractMesh, AssetContainer, Camera, Light, Material, Mesh, MultiMaterial, TransformNode,
  type Animation, type Node,
} from '@babylonjs/core';

type ModelAnimationPlayback = { started: boolean; playing: boolean; loop: boolean; speed: number; from: number; to: number; additive: boolean };
const templateAnimationPlayback = new WeakMap<AssetContainer, ModelAnimationPlayback[]>();

/** 解析后停止隐藏模板的动画，复制时按 GLB 原有自动播放设置恢复独立动画组。 */
export function prepareModelAssetTemplate(source: AssetContainer): void {
  if (templateAnimationPlayback.has(source)) return;
  templateAnimationPlayback.set(source, source.animationGroups.map(group => ({ started: group.isStarted,
    playing: group.isPlaying, loop: group.loopAnimation, speed: group.speedRatio, from: group.from, to: group.to, additive: group.isAdditive })));
  for (const group of source.animationGroups) group.stop(true);
}

/**
 * 从只读解析模板创建完整工作容器。参数脚本可能直接改顶点、材质、贴图变换和动画，
 * 因此只共享内部纹理像素（Babylon 自带引用计数），其余可变对象均按实体隔离。
 */
export function cloneModelAssetContainer(source: AssetContainer): AssetContainer {
  const scene = source.scene;
  const working = new AssetContainer(scene);
  const materials = new Map<Material, Material>();
  const animations = new Map<Animation, Animation>();
  const materialTargets = new Map<unknown, unknown>();
  const ownedTextures = new Set<AssetContainer['textures'][number]>();
  const sourceRoots = [...source.transformNodes, ...source.meshes, ...source.cameras, ...source.lights]
    .filter(node => !node.parent);
  const existingMaterials = new Set([...source.materials, ...source.multiMaterials]
    .filter(material => scene.materials.includes(material) || scene.multiMaterials.includes(material as MultiMaterial)));
  const cloneAnimation = (animation: Animation): Animation => {
    let copy = animations.get(animation);
    if (!copy) { copy = animation.clone(true); animations.set(animation, copy); }
    return copy;
  };
  const cloneMaterial = (material: Material): Material => {
    const existing = materials.get(material);
    if (existing) return existing;
    // Babylon 9 的 instantiateModelsToScene(cloneMaterials=true) 会改写 MultiMaterial
    // 源对象的 subMaterials；在此显式克隆，保持模板和其它实例完全独立。
    const copy = material instanceof MultiMaterial
      ? material.clone(material.name, false) : material.clone(material.name);
    if (!copy) throw new Error(`模型材质无法克隆：${material.name}`);
    materials.set(material, copy);
    materialTargets.set(material, copy);
    if (material instanceof MultiMaterial && copy instanceof MultiMaterial) {
      copy.subMaterials = material.subMaterials.map(child => child ? cloneMaterial(child) : null);
      working.multiMaterials.push(copy);
    } else {
      working.materials.push(copy);
    }
    const sourceTextures = material.getActiveTextures();
    const clonedTextures = copy.getActiveTextures();
    for (const texture of clonedTextures) {
      if (ownedTextures.has(texture)) continue;
      ownedTextures.add(texture);
      working.textures.push(texture);
    }
    for (let i = 0; i < sourceTextures.length; i++) {
      if (clonedTextures[i]) materialTargets.set(sourceTextures[i], clonedTextures[i]);
    }
    copy.metadata = cloneModelMetadata(material.metadata);
    return copy;
  };
  try {
    const entries = source.instantiateModelsToScene(name => name, false, { doNotInstantiate: true });
    working.rootNodes.push(...entries.rootNodes);
    working.skeletons.push(...entries.skeletons);
    working.animationGroups.push(...entries.animationGroups);
    const seen = new Set<Node>();
    const claimedSources = new Set<Node>();
    const visit = (node: Node, sourceParent?: Node): void => {
      if (seen.has(node)) return;
      seen.add(node);
      const original = node instanceof Mesh && node.source
        ? node.source
        : (sourceParent?.getChildren() ?? sourceRoots).find(candidate => !claimedSources.has(candidate)
          && candidate.name === node.name && candidate.getClassName() === node.getClassName());
      if (original) {
        claimedSources.add(original);
        node.id = original.id;
      }
      node.metadata = cloneModelMetadata(node.metadata);
      node.animations = node.animations.map(cloneAnimation);
      if (node instanceof AbstractMesh) {
        working.meshes.push(node);
        if (node instanceof Mesh) {
          node.makeGeometryUnique();
          if (node.geometry) working.geometries.push(node.geometry);
          if (node.morphTargetManager) {
            const manager = node.morphTargetManager;
            working.morphTargetManagers.push(manager);
            for (let i = 0; i < manager.numTargets; i++) {
              const target = manager.getTarget(i);
              // Babylon MorphTarget.clone() 仍引用原始顶点数组；参数脚本可直接修改这些数组。
              const positions = target.getPositions(); if (positions) target.setPositions(positions.slice());
              const normals = target.getNormals(); if (normals) target.setNormals(normals.slice());
              const tangents = target.getTangents(); if (tangents) target.setTangents(tangents.slice());
              const uvs = target.getUVs(); if (uvs) target.setUVs(uvs.slice());
              const uv2s = target.getUV2s(); if (uv2s) target.setUV2s(uv2s.slice());
              const colors = target.getColors(); if (colors) target.setColors(colors.slice());
              target.animations = target.animations.map(cloneAnimation);
            }
          }
          if (node.material) node.material = cloneMaterial(node.material);
        }
      } else if (node instanceof TransformNode) working.transformNodes.push(node);
      else if (node instanceof Camera) working.cameras.push(node);
      else if (node instanceof Light) working.lights.push(node);
      for (const child of node.getChildren()) visit(child, original);
    };
    for (const root of entries.rootNodes) visit(root);
    for (const group of working.animationGroups) {
      for (const target of group.targetedAnimations) {
        target.animation = cloneAnimation(target.animation);
        target.target = materialTargets.get(target.target) ?? target.target;
      }
    }
    for (const skeleton of working.skeletons) {
      for (const bone of skeleton.bones) bone.animations = bone.animations.map(cloneAnimation);
    }
    const playback = templateAnimationPlayback.get(source) ?? [];
    for (let i = 0; i < working.animationGroups.length; i++) {
      const original = playback[i];
      if (!original?.started) continue;
      const group = working.animationGroups[i];
      group.start(original.loop, original.speed, original.from, original.to, original.additive);
      if (!original.playing) group.pause();
    }
    working.removeAllFromScene();
    return working;
  } catch (error) {
    working.dispose();
    throw error;
  } finally {
    // instantiateModelsToScene(false) 会临时把源材质加入场景；只归还本次新增项。
    for (const material of [...source.materials, ...source.multiMaterials]) {
      if (existingMaterials.has(material)) continue;
      if (material instanceof MultiMaterial) scene.removeMultiMaterial(material);
      else scene.removeMaterial(material);
    }
  }
}

/** glTF 元数据来自 JSON；保持嵌套扩展数据独立，避免脚本向模板写入实体状态。 */
function cloneModelMetadata<T>(metadata: T): T {
  return metadata == null ? metadata : structuredClone(metadata);
}

/** 估算空闲模板的几何/解码纹理内存，数量与字节双预算限制缓存残留。 */
export function estimateModelAssetContainerBytes(source: AssetContainer): number {
  let bytes = 0;
  for (const geometry of source.geometries) {
    for (const kind of geometry.getVerticesDataKinds()) {
      const data = geometry.getVerticesData(kind);
      bytes += data ? (ArrayBuffer.isView(data) ? data.byteLength : data.length * 8) : 0;
    }
    const indices = geometry.getIndices();
    bytes += indices ? (ArrayBuffer.isView(indices) ? indices.byteLength : indices.length * 8) : 0;
  }
  const textures = new Set(source.textures.map(texture => texture.getInternalTexture()).filter(Boolean));
  for (const texture of textures) {
    if (!texture) continue;
    // EXR/HDR 及浮点纹理按最保守 RGBA32F 估算；同时计入 mip 与立方体六个面。
    const pixelBytes = texture.type === 0 ? 4 : 16;
    bytes += Math.ceil(texture.width * texture.height * pixelBytes * (texture.isCube ? 6 : 1) * 4 / 3);
  }
  return bytes;
}
