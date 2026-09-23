import { ArcRotateCamera, EngineStore, Vector3, Color4, type Node } from '@babylonjs/core';
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools';
import { GLTF2Export } from '@babylonjs/serializers/glTF/2.0/glTFSerializer';

/** 使用独立相机和明确的渲染列表，避免把场景环境及其他组合写入缩略图。 */
export async function captureCompositionPreview(ids: readonly string[]): Promise<{ thumbnailDataUrl: string; previewGlb?: Uint8Array }> {
  const selected = new Set(ids);
  const owner = (node: Node | null): boolean => {
    for (let current = node; current; current = current.parent) if (selected.has(current.metadata?.editorEntityId)) return true;
    return false;
  };
  const scene = EngineStore.Instances.flatMap(engine => engine.scenes).find(s => s.meshes.some(m => owner(m)));
  if (!scene) throw new Error('组合模型尚未在场景中渲染。');
  const meshes = scene.meshes.filter(mesh => owner(mesh) && mesh.getTotalVertices() > 0 && mesh.isEnabled());
  if (!meshes.length) throw new Error('组合没有可用于预览的可见几何体。');
  const represented = new Set<string>();
  for (const mesh of meshes) for (let node: Node | null = mesh; node; node = node.parent) {
    if (selected.has(node.metadata?.editorEntityId)) represented.add(node.metadata.editorEntityId);
  }
  if (ids.some(id => !represented.has(id))) throw new Error('部分成员尚无可独立导出的几何体，已跳过不完整预览');
  let min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const nodes = new Set<Node>();
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true); const bounds = mesh.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bounds.minimumWorld); max = Vector3.Maximize(max, bounds.maximumWorld);
    for (let node: Node | null = mesh; node; node = node.parent) nodes.add(node);
  }
  const camera = new ArcRotateCamera('composition-preview', -Math.PI / 3, 1.05, Math.max(2, max.subtract(min).length() * 1.3), min.add(max).scale(0.5), scene);
  camera.minZ = 0.01; camera.maxZ = Math.max(1000, camera.radius * 10);
  try {
    const thumbnailDataUrl = await CreateScreenshotUsingRenderTargetAsync(scene.getEngine(), camera, { width: 320, height: 200 }, 'image/png', 1, false, undefined, false, false, false, undefined,
      texture => { texture.renderList = meshes; texture.clearColor = new Color4(0.06,0.09,0.12,1); });
    const exported = await GLTF2Export.GLBAsync(scene, 'preview', { exportWithoutWaitingForScene: true, shouldExportNode: node => nodes.has(node), shouldExportAnimation: () => false, metadataSelector: () => undefined });
    const data = exported.files['preview.glb'];
    const previewGlb = data instanceof Blob && data.size <= 64 * 1024 * 1024 ? new Uint8Array(await data.arrayBuffer()) : undefined;
    return { thumbnailDataUrl, previewGlb };
  } finally { camera.dispose(); }
}
