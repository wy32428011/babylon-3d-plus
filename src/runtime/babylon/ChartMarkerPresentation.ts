import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3, VertexBuffer, VertexData } from '@babylonjs/core';
import type { ChartMarkerComponent } from '../../editor/model/components';
import type { Entity } from '../../editor/model/Entity';
import { resolveChartMarker } from '../../editor/model/chartMarker';
import { DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS } from '../../editor/model/dataPlatformScreen';
import { deviceTelemetryStore } from '../mqtt/deviceTelemetry';

const styles = new WeakMap<ChartMarkerComponent, Required<ChartMarkerComponent>>();
const cornersByMesh = new WeakMap<Mesh, readonly Vector3[]>();
const ringFacetsByMesh = new WeakMap<Mesh, readonly (readonly Vector3[])[]>();
const UPRIGHT_BASIS = Matrix.RotationX(Math.PI / 2);
const GROUND_BASIS = Matrix.RotationX(-Math.PI / 2);
const RING_SEGMENTS = 96;
const LOCAL_CORNERS = [new Vector3(-1, 0, -1), new Vector3(1, 0, -1), new Vector3(1, 0, 1), new Vector3(-1, 0, 1)];

export function getChartMarkerStyle(component: ChartMarkerComponent): Required<ChartMarkerComponent> {
  let style = styles.get(component);
  if (!style) { style = resolveChartMarker(component); styles.set(component, style); }
  return style;
}

export function getChartMarkerCorners(mesh: Mesh): readonly Vector3[] {
  return cornersByMesh.get(mesh) ?? LOCAL_CORNERS;
}

/** 返回局部坐标的连续侧壁分片，每片依次为左上、右上、右下、左下；矩形返回空数组。 */
export function getChartMarkerRingFacets(mesh: Mesh): readonly (readonly Vector3[])[] {
  return ringFacetsByMesh.get(mesh) ?? [];
}

/** 配置缺失、设备删除、数据过期或字段不是标量时显示编辑文本，避免残留旧设备值。 */
export function getChartMarkerText(style: Required<ChartMarkerComponent>, source: Entity | undefined, active: boolean): string {
  if (!active || style.driveMode !== 'data' || !style.dataField || !source) return style.text;
  const binding = source.components.telemetryBinding;
  const model = source.components.modelAsset;
  if (binding?.enabled === false) return style.text;
  const assetCode = binding?.assetCode || model?.assetCode;
  const deviceType = binding?.deviceType || model?.dataDrivenConfig?.device.devType;
  if (!assetCode || !deviceType) return style.text;
  const snapshot = deviceTelemetryStore.getSnapshot(assetCode, deviceType, binding?.sourceId);
  if (!snapshot || Date.now() - snapshot.receivedAt > (binding?.staleAfterMs ?? 10000)) return style.text;
  let value: unknown = snapshot.fields;
  // 字段名可含点，优先匹配完整字段，其次才按路径逐级读取自有属性。
  const path = Object.hasOwn(snapshot.fields, style.dataField) ? [style.dataField] : style.dataField.split('.');
  for (const key of path) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) return style.text;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    ? String(value).slice(0, 4096) : style.text;
}

type Entry = {
  original: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  signature: string;
  ring: boolean;
  stem?: Mesh;
  base?: Mesh;
  rims?: Mesh[];
  material?: StandardMaterial;
};

function restoreGeometry(mesh: Mesh, entry: Entry): void {
  mesh.setVerticesData(VertexBuffer.PositionKind, entry.original, true);
  mesh.setVerticesData(VertexBuffer.NormalKind, entry.normals, true);
  mesh.setVerticesData(VertexBuffer.UVKind, entry.uvs, true);
  mesh.setIndices(entry.indices);
}

function setPositionsAndNormals(mesh: Mesh, positions: number[], indices: number[]): void {
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals, true);
  mesh.refreshBoundingInfo();
}

/** 只变换立标几何，不改写权威 Transform；Gizmo、拾取与深度遮挡共用同一网格。 */
export class ChartMarkerPresentation {
  private readonly entries = new Map<Mesh, Entry>();

  update(mesh: Mesh, component: ChartMarkerComponent, visible: boolean, polygonal = false): void {
    const style = getChartMarkerStyle(component);
    let entry = this.entries.get(mesh);
    if (!entry) {
      entry = {
        original: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind) ?? []),
        normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind) ?? []),
        uvs: Array.from(mesh.getVerticesData(VertexBuffer.UVKind) ?? []),
        indices: Array.from(mesh.getIndices() ?? []), signature: '', ring: false,
      };
      this.entries.set(mesh, entry);
      // 立标属于显示辅助内容，不应触发或抬高场景的物理阴影地面。
      mesh.metadata = { ...mesh.metadata, editorChartMarker: true };
    }
    entry.stem?.setEnabled(visible && style.appearance !== 'none');
    entry.base?.setEnabled(visible && style.appearance !== 'none');
    for (const rim of entry.rims ?? []) rim.setEnabled(visible && style.panelShape === 'ring');
    if (!visible) return;
    const world = mesh.computeWorldMatrix(true);
    const camera = mesh.getScene().activeCamera;
    const ring = style.panelShape === 'ring';
    const signature = [style.geometryBasis, style.panelShape, style.ringRadius, style.width, style.height, style.floatHeight, style.faceCamera, style.appearance, style.indicatorSize,
      style.appearanceColor, ...world.asArray(), ...(!ring && style.faceCamera && camera ? camera.getWorldMatrix().asArray() : [])].join(',');
    if (entry.signature === signature) return;
    if (Math.abs(world.determinant()) < 1e-12) return;
    entry.signature = signature;
    const inverse = Matrix.Invert(world);
    if (ring) {
      this.updateRing(mesh, entry, style, world, inverse, polygonal);
      return;
    }
    if (entry.ring) {
      restoreGeometry(mesh, entry);
      for (const rim of entry.rims ?? []) rim.dispose();
      entry.rims = undefined;
      entry.ring = false;
      ringFacetsByMesh.delete(mesh);
    }
    const scale = new Vector3(), center = new Vector3();
    let rotation = new Quaternion();
    // Ground 顶点/UV 仍按原 XZ 基准绘制；立起操作仅作用于几何，不污染实体或 Gizmo 的局部轴。
    const geometryWorld = style.geometryBasis === 'upright' ? UPRIGHT_BASIS.multiply(world) : world;
    geometryWorld.decompose(scale, rotation, center);
    center.y += style.floatHeight;
    if (style.faceCamera && camera) {
      // 保持屏幕竖直方向与相机一致，俯视时也不出现退化的朝向。
      const direction = camera.globalPosition.subtract(center).normalize();
      const cameraUp = Vector3.TransformNormal(Vector3.Up(), camera.getWorldMatrix()).normalize();
      let right = Vector3.Cross(cameraUp, direction);
      if (right.lengthSquared() < 1e-8) right = Vector3.Cross(Math.abs(direction.y) > 0.99 ? Vector3.Right() : Vector3.Up(), direction);
      const up = Vector3.Cross(direction, right).normalize();
      if (direction.lengthSquared() > 0) rotation = Quaternion.FromLookDirectionLH(direction, up).multiply(Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2));
    }
    scale.x *= style.width / 320;
    scale.z *= style.height / 180;
    const displayWorld = Matrix.Compose(scale, rotation, center);
    const toLocal = displayWorld.multiply(inverse);
    const positions: number[] = [];
    for (let i = 0; i < entry.original.length; i += 3) {
      const point = Vector3.TransformCoordinates(Vector3.FromArray(entry.original, i), toLocal);
      positions.push(point.x, point.y, point.z);
    }
    setPositionsAndNormals(mesh, positions, entry.indices);
    cornersByMesh.set(mesh, LOCAL_CORNERS.map(point => Vector3.TransformCoordinates(point, toLocal)));
    if (style.appearance === 'none') return;
    const anchor = Vector3.TransformCoordinates(new Vector3(0, 0, 1), geometryWorld);
    const bottom = Vector3.TransformCoordinates(new Vector3(0, 0, 1), displayWorld);
    this.updateIndicator(mesh, entry, style, anchor, bottom, polygonal);
  }

  private ensureMaterial(mesh: Mesh, entry: Entry, style: Required<ChartMarkerComponent>): StandardMaterial {
    if (!entry.material) {
      entry.material = new StandardMaterial(`${mesh.name}_indicator_material`, mesh.getScene());
      entry.material.disableLighting = true;
    }
    entry.material.emissiveColor = Color3.FromHexString(style.appearanceColor);
    return entry.material;
  }

  private updateRing(mesh: Mesh, entry: Entry, style: Required<ChartMarkerComponent>, world: Matrix, inverse: Matrix, polygonal: boolean): void {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    const top: Vector3[] = [], bottom: Vector3[] = [];
    const localFloat = Vector3.TransformNormal(new Vector3(0, style.floatHeight, 0), inverse);
    const radius = style.ringRadius;
    // 根节点继承矩形立标的初始宽高比例，先消除此比例，米制半径才不会默认变成椭圆。
    const halfHeight = style.height / 180;
    const pointAt = (angle: number, height: number): Vector3 => {
      const point = new Vector3(-Math.sin(angle) * radius * 2 / DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS,
        height, Math.cos(angle) * radius);
      return (style.geometryBasis === 'ground' ? Vector3.TransformCoordinates(point, GROUND_BASIS) : point).add(localFloat);
    };
    for (let index = 0; index <= RING_SEGMENTS; index++) {
      // 接缝复用相同坐标但保留 U=0/1，保证闭合且纹理不会跨接缝反向插值。
      const angle = index === RING_SEGMENTS ? 0 : index / RING_SEGMENTS * Math.PI * 2;
      const upper = pointAt(angle, halfHeight), lower = pointAt(angle, -halfHeight);
      top.push(upper); bottom.push(lower);
      positions.push(...upper.asArray(), ...lower.asArray());
      uvs.push(index / RING_SEGMENTS, 1, index / RING_SEGMENTS, 0);
      if (index < RING_SEGMENTS) {
        const offset = index * 2;
        indices.push(offset, offset + 3, offset + 2, offset, offset + 1, offset + 3);
      }
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
    mesh.setIndices(indices);
    setPositionsAndNormals(mesh, positions, indices);
    const facets = top.slice(0, -1).map((point, index) => [point, top[index + 1], bottom[index + 1], bottom[index]]);
    ringFacetsByMesh.set(mesh, facets);
    cornersByMesh.set(mesh, facets[RING_SEGMENTS / 2]);
    entry.ring = true;
    const material = this.ensureMaterial(mesh, entry, style);
    entry.rims ??= [];
    for (const [index, path] of [top, bottom].entries()) {
      const rim = MeshBuilder.CreateTube(`${mesh.name}_ring_rim_${index}`, {
        path, radius: 0.012, tessellation: 8, updatable: true, instance: entry.rims[index],
      }, mesh.getScene());
      rim.parent = mesh;
      rim.material = material;
      rim.isPickable = false;
      rim.metadata = { editorChartMarker: true };
      entry.rims[index] = rim;
    }
    if (style.appearance === 'none') return;
    const geometryWorld = style.geometryBasis === 'upright' ? UPRIGHT_BASIS.multiply(world) : world;
    const anchor = Vector3.TransformCoordinates(new Vector3(0, 0, 1), geometryWorld);
    this.updateIndicator(mesh, entry, style, anchor, Vector3.TransformCoordinates(bottom[RING_SEGMENTS / 2], world), polygonal);
  }

  private updateIndicator(mesh: Mesh, entry: Entry, style: Required<ChartMarkerComponent>, anchor: Vector3, bottom: Vector3, polygonal: boolean): void {
    const material = this.ensureMaterial(mesh, entry, style);
    if (!entry.stem) {
      entry.stem = MeshBuilder.CreateCylinder(`${mesh.name}_indicator`, { height: 1, diameter: 1, tessellation: polygonal && style.appearance === 'column' ? 4 : 16 }, mesh.getScene());
      entry.base = MeshBuilder.CreateTorus(`${mesh.name}_indicator_base`, { diameter: 1, thickness: 0.06, tessellation: 32 }, mesh.getScene());
      for (const part of [entry.stem, entry.base]) {
        part.material = material;
        part.isPickable = false;
        part.metadata = { editorChartMarker: true };
      }
    }
    const delta = bottom.subtract(anchor);
    const length = delta.length();
    const diameter = (style.appearance === 'column' ? 0.15 : 0.025) * style.indicatorSize;
    entry.stem!.position.copyFrom(anchor.add(bottom).scale(0.5));
    entry.stem!.scaling.set(diameter, Math.max(0.001, length), diameter);
    entry.stem!.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), length > 1e-6 ? delta.scale(1 / length) : Vector3.Up(), new Quaternion());
    entry.stem!.setEnabled(length > 1e-6);
    entry.base!.position.copyFrom(anchor);
    entry.base!.scaling.setAll(style.indicatorSize * 0.5);
    entry.base!.setEnabled(true);
  }

  remove(mesh: Mesh): void {
    const entry = this.entries.get(mesh);
    if (!entry) return;
    if (mesh.metadata) delete mesh.metadata.editorChartMarker;
    if (!mesh.isDisposed()) {
      restoreGeometry(mesh, entry);
      mesh.refreshBoundingInfo();
    }
    entry?.stem?.dispose();
    entry?.base?.dispose();
    for (const rim of entry.rims ?? []) rim.dispose();
    entry?.material?.dispose();
    this.entries.delete(mesh);
    cornersByMesh.delete(mesh);
    ringFacetsByMesh.delete(mesh);
  }
}
