import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh, Observer, Scene } from '@babylonjs/core';
import type { ModelRuntimeEntry } from './scene-runtime/sceneRuntimeTypes.ts';
import { isMobileEquipmentDeviceType } from './warehouseShadowFilters.ts';

type BlobFootprint = {
  meshCount: number;
  localCenter: Vector3;
  width: number;
  depth: number;
};

type BlobEntry = {
  mesh: Mesh;
  footprint: BlobFootprint;
};

const BLOB_TEXTURE_SIZE = 128;
const BLOB_Y_OFFSET_METERS = 0.012;
const BLOB_FOOTPRINT_PADDING = 1.18;

function sampleRadialShadowAlpha(normalizedRadius: number): number {
  if (normalizedRadius <= 0.12) return 0.52;
  if (normalizedRadius <= 0.52) {
    return 0.52 + ((normalizedRadius - 0.12) / (0.52 - 0.12)) * (0.28 - 0.52);
  }
  if (normalizedRadius <= 0.82) {
    return 0.28 + ((normalizedRadius - 0.52) / (0.82 - 0.52)) * (0.08 - 0.28);
  }
  if (normalizedRadius < 0.96) {
    return 0.08 * (1 - (normalizedRadius - 0.82) / (0.96 - 0.82));
  }
  return 0;
}

function buildRadialShadowPixels(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const half = size * 0.5;
  for (let y = 0; y < size; y++) {
    const dy = (y + 0.5 - half) / half;
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const alpha = Math.round(sampleRadialShadowAlpha(Math.hypot(dx, dy)) * 255);
      pixels[(y * size + x) * 4 + 3] = alpha;
    }
  }
  return pixels;
}

function isModelMobileEquipment(model: ModelRuntimeEntry): boolean {
  if (model.rgvCapable || model.stackerCapable) return true;
  const dataDevType = model.entitySnapshot?.components?.modelAsset?.dataDrivenConfig?.device?.devType;
  const devType = dataDevType ?? model.telemetryBinding?.deviceType;
  return isMobileEquipmentDeviceType(devType);
}

function collectVisibleMeshes(model: ModelRuntimeEntry): AbstractMesh[] {
  const result: AbstractMesh[] = [];
  for (const mesh of model.meshes) {
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible) continue;
    if ((mesh.layerMask & 0x0fffffff) === 0 || mesh.getTotalVertices() <= 0) continue;
    result.push(mesh);
  }
  return result;
}

function computeLocalFootprint(model: ModelRuntimeEntry, activeMeshes: readonly AbstractMesh[]): BlobFootprint {
  model.root.computeWorldMatrix(true);
  const invRoot = Matrix.Invert(model.root.getWorldMatrix());
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;

  for (const mesh of activeMeshes) {
    mesh.computeWorldMatrix(true);
    const boundingBox = mesh.getBoundingInfo()?.boundingBox;
    if (!boundingBox) continue;
    for (const corner of boundingBox.vectorsWorld) {
      const local = Vector3.TransformCoordinates(corner, invRoot);
      if (local.x < minX) minX = local.x;
      if (local.y < minY) minY = local.y;
      if (local.z < minZ) minZ = local.z;
      if (local.x > maxX) maxX = local.x;
      if (local.z > maxZ) maxZ = local.z;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      meshCount: activeMeshes.length,
      localCenter: new Vector3(0, 0, 0),
      width: 1.2,
      depth: 1.4,
    };
  }

  const clampSpan = (span: number) => Math.min(25, Math.max(0.45, span * BLOB_FOOTPRINT_PADDING));
  return {
    meshCount: activeMeshes.length,
    localCenter: new Vector3((minX + maxX) * 0.5, minY, (minZ + maxZ) * 0.5),
    width: clampSpan(maxX - minX),
    depth: clampSpan(maxZ - minZ),
  };
}

/**
 * 为 AGV、RGV、穿梭车、叉车、堆垛机等移动设备提供极轻量的地面底盘接触软影贴片。
 * 关闭时不保留任何网格、贴图、材质或帧监听。
 */
export class MobileBlobShadowRuntime {
  private readonly scene: Scene;
  private enabled = false;
  private disposed = false;
  private getModels: () => Iterable<ModelRuntimeEntry> = () => [];
  private texture: RawTexture | null = null;
  private material: StandardMaterial | null = null;
  private readonly entries = new Map<ModelRuntimeEntry, BlobEntry>();
  private observer: Observer<Scene> | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  sync(enabled: boolean, getModels: () => Iterable<ModelRuntimeEntry>): void {
    if (this.disposed) return;
    this.getModels = getModels;
    this.enabled = enabled;
    if (!enabled) {
      this.clearAll();
      return;
    }
    this.ensureSharedResources();
    if (!this.observer) {
      this.observer = this.scene.onBeforeRenderObservable.add(() => this.updateFrame());
    }
    this.updateFrame();
  }

  getActiveBlobCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.mesh.isEnabled() && entry.mesh.isVisible) count++;
    }
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.clearAll();
  }

  private ensureSharedResources(): void {
    if (!this.texture) {
      const texture = RawTexture.CreateRGBATexture(
        buildRadialShadowPixels(BLOB_TEXTURE_SIZE),
        BLOB_TEXTURE_SIZE,
        BLOB_TEXTURE_SIZE,
        this.scene,
        false,
        false,
        Texture.BILINEAR_SAMPLINGMODE,
      );
      texture.name = '__MobileBlobShadowTexture';
      texture.hasAlpha = true;
      texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.texture = texture;
    }
    if (!this.material) {
      const material = new StandardMaterial('__MobileBlobShadowMaterial', this.scene);
      material.diffuseTexture = this.texture;
      material.opacityTexture = this.texture;
      material.useAlphaFromDiffuseTexture = true;
      material.disableLighting = true;
      material.diffuseColor = Color3.Black();
      material.emissiveColor = Color3.Black();
      material.specularColor = Color3.Black();
      material.ambientColor = Color3.Black();
      material.backFaceCulling = false;
      material.zOffset = -2;
      material.freeze();
      this.material = material;
    }
  }

  private updateFrame(): void {
    if (this.disposed || !this.enabled || !this.material) return;
    const seen = new Set<ModelRuntimeEntry>();

    for (const model of this.getModels()) {
      if (model.root.isDisposed() || !isModelMobileEquipment(model)) continue;
      seen.add(model);

      const visible = model.root.isEnabled() ? collectVisibleMeshes(model) : [];
      let entry = this.entries.get(model);
      if (visible.length === 0) {
        if (entry) entry.mesh.isVisible = false;
        continue;
      }

      if (!entry) {
        const mesh = MeshBuilder.CreateGround('__MobileBlobShadow', { width: 1, height: 1, subdivisions: 1 }, this.scene);
        mesh.isPickable = false;
        mesh.checkCollisions = false;
        mesh.receiveShadows = false;
        mesh.material = this.material;
        mesh.metadata = { editorShadowCatcher: true, lightingDerived: true };
        entry = { mesh, footprint: computeLocalFootprint(model, visible) };
        this.entries.set(model, entry);
      } else if (entry.footprint.meshCount !== visible.length) {
        entry.footprint = computeLocalFootprint(model, visible);
      }

      const worldMatrix = model.root.computeWorldMatrix(true);
      const worldCenter = Vector3.TransformCoordinates(entry.footprint.localCenter, worldMatrix);
      const forward = Vector3.TransformNormal(Vector3.Forward(), worldMatrix);
      const yaw = Math.hypot(forward.x, forward.z) > 1e-5 ? Math.atan2(forward.x, forward.z) : 0;

      entry.mesh.isVisible = true;
      entry.mesh.position.set(worldCenter.x, worldCenter.y + BLOB_Y_OFFSET_METERS, worldCenter.z);
      entry.mesh.rotation.set(0, yaw, 0);
      entry.mesh.scaling.set(entry.footprint.width, 1, entry.footprint.depth);
    }

    for (const [model, entry] of this.entries) {
      if (seen.has(model)) continue;
      entry.mesh.dispose(false, false);
      this.entries.delete(model);
    }
  }

  private clearAll(): void {
    if (this.observer) {
      this.observer.remove();
      this.observer = null;
    }
    for (const entry of this.entries.values()) {
      entry.mesh.dispose(false, false);
    }
    this.entries.clear();
    if (this.material) {
      this.material.dispose(true, false);
      this.material = null;
    }
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
  }
}
