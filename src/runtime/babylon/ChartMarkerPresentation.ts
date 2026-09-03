import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core';
import type { ChartMarkerComponent } from '../../editor/model/components';
import type { Entity } from '../../editor/model/Entity';
import { resolveChartMarker } from '../../editor/model/chartMarker';
import { deviceTelemetryStore } from '../mqtt/deviceTelemetry';

const styles = new WeakMap<ChartMarkerComponent, Required<ChartMarkerComponent>>();
const cornersByMesh = new WeakMap<Mesh, readonly Vector3[]>();
const UPRIGHT_BASIS = Matrix.RotationX(Math.PI / 2);
const LOCAL_CORNERS = [new Vector3(-1, 0, -1), new Vector3(1, 0, -1), new Vector3(1, 0, 1), new Vector3(-1, 0, 1)];

export function getChartMarkerStyle(component: ChartMarkerComponent): Required<ChartMarkerComponent> {
  let style = styles.get(component);
  if (!style) { style = resolveChartMarker(component); styles.set(component, style); }
  return style;
}

export function getChartMarkerCorners(mesh: Mesh): readonly Vector3[] {
  return cornersByMesh.get(mesh) ?? LOCAL_CORNERS;
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

type Entry = { original: number[]; signature: string; stem?: Mesh; base?: Mesh; material?: StandardMaterial };

/** 只变换立标几何，不改写权威 Transform；Gizmo、拾取与深度遮挡共用同一平面。 */
export class ChartMarkerPresentation {
  private readonly entries = new Map<Mesh, Entry>();

  update(mesh: Mesh, component: ChartMarkerComponent, visible: boolean, polygonal = false): void {
    const style = getChartMarkerStyle(component);
    let entry = this.entries.get(mesh);
    if (!entry) {
      entry = { original: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind) ?? []), signature: '' };
      this.entries.set(mesh, entry);
      // 立标属于显示辅助内容，不应触发或抬高场景的物理阴影地面。
      mesh.metadata = { ...mesh.metadata, editorChartMarker: true };
    }
    entry.stem?.setEnabled(visible && style.appearance !== 'none');
    entry.base?.setEnabled(visible && style.appearance !== 'none');
    if (!visible) return;
    const world = mesh.computeWorldMatrix(true);
    const camera = mesh.getScene().activeCamera;
    const signature = [style.geometryBasis, style.width, style.height, style.floatHeight, style.faceCamera, style.appearance, style.indicatorSize,
      style.appearanceColor, ...world.asArray(), ...(style.faceCamera && camera ? camera.getWorldMatrix().asArray() : [])].join(',');
    if (entry.signature === signature) return;
    entry.signature = signature;
    if (Math.abs(world.determinant()) < 1e-12) return;
    const inverse = Matrix.Invert(world);
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
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
    mesh.refreshBoundingInfo();
    cornersByMesh.set(mesh, LOCAL_CORNERS.map(point => Vector3.TransformCoordinates(point, toLocal)));
    if (style.appearance === 'none') return;
    if (!entry.material) {
      entry.material = new StandardMaterial(`${mesh.name}_indicator_material`, mesh.getScene());
      entry.material.disableLighting = true;
      entry.stem = MeshBuilder.CreateCylinder(`${mesh.name}_indicator`, { height: 1, diameter: 1, tessellation: polygonal && style.appearance === 'column' ? 4 : 16 }, mesh.getScene());
      entry.base = MeshBuilder.CreateTorus(`${mesh.name}_indicator_base`, { diameter: 1, thickness: 0.06, tessellation: 32 }, mesh.getScene());
      for (const part of [entry.stem, entry.base]) {
        part.material = entry.material;
        part.isPickable = false;
        part.metadata = { editorChartMarker: true };
      }
    }
    entry.material.emissiveColor = Color3.FromHexString(style.appearanceColor);
    const anchor = Vector3.TransformCoordinates(new Vector3(0, 0, 1), geometryWorld);
    const bottom = Vector3.TransformCoordinates(new Vector3(0, 0, 1), displayWorld);
    const delta = bottom.subtract(anchor);
    const length = delta.length();
    const diameter = (style.appearance === 'column' ? 0.15 : 0.025) * style.indicatorSize;
    entry.stem!.position.copyFrom(anchor.add(bottom).scale(0.5));
    entry.stem!.scaling.set(diameter, Math.max(0.001, length), diameter);
    entry.stem!.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), length > 1e-6 ? delta.scale(1 / length) : Vector3.Up(), new Quaternion());
    entry.stem!.setEnabled(visible && length > 1e-6);
    entry.base!.position.copyFrom(anchor);
    entry.base!.scaling.setAll(style.indicatorSize * 0.5);
    entry.base!.setEnabled(visible);
  }

  remove(mesh: Mesh): void {
    const entry = this.entries.get(mesh);
    if (!entry) return;
    if (mesh.metadata) delete mesh.metadata.editorChartMarker;
    if (!mesh.isDisposed()) {
      mesh.setVerticesData(VertexBuffer.PositionKind, entry.original, true);
      mesh.refreshBoundingInfo();
    }
    entry?.stem?.dispose();
    entry?.base?.dispose();
    entry?.material?.dispose();
    this.entries.delete(mesh);
    cornersByMesh.delete(mesh);
  }
}
