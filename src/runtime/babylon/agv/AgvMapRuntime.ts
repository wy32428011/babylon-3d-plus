import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { AgvMapComponent } from '../../../editor/model/components';
import { getAgvMapDefinition } from '../../../editor/model/agvMapLibrary.ts';
import { mapAgvPointToScene, resolveAgvMapTrackPoints, type AgvMapDefinition, type AgvMapPoint } from '../../../editor/model/agvMap.ts';
import { getAgvMapPlane } from './agvMapPlane.ts';

const TRACK_COLOR = Color3.FromHexString('#20d9ff');
const NODE_COLOR = '#ffb020';
const MAP_HEIGHT_OFFSET_METERS = 0.035;
const MAX_LINE_BATCH_POINTS = 32_000;

/** AGV 地图只持有运行时几何；地图选择、映射与比例尺的权威数据仍在 SceneDocument。 */
export class AgvMapRuntime {
  public readonly root: TransformNode;
  private component: AgvMapComponent | null = null;
  private nodeMaterial: StandardMaterial | null = null;

  constructor(scene: Scene, entityId: string) {
    this.root = new TransformNode(`${entityId}_agvMapRoot`, scene);
  }

  public sync(component: AgvMapComponent, visible: boolean): void {
    const map = getAgvMapDefinition(component);
    this.root.setEnabled(visible && component.showTrajectories && Boolean(map));
    const previous = this.component;
    if (previous && getAgvMapDefinition(previous) === map
      && previous.showTrajectories === component.showTrajectories
      && previous.xAxis === component.xAxis && previous.yAxis === component.yAxis
      && previous.scale === component.scale) return;
    this.component = component;
    this.clearGeometry();
    if (!map || !component.showTrajectories) return;

    const scene = this.root.getScene();
    this.nodeMaterial = new StandardMaterial(`${map.id}_businessNodeMaterial`, scene);
    this.nodeMaterial.disableLighting = true;
    this.nodeMaterial.emissiveColor = Color3.FromHexString(NODE_COLOR);
    if (map === component.importedMap) {
      this.buildImportedMap(map, component, this.nodeMaterial);
      return;
    }
    for (const track of map.tracks) {
      const points = resolveAgvMapTrackPoints(map, track).map(point => {
        const position = mapAgvPointToScene(point, component);
        return new Vector3(position.x, position.y + MAP_HEIGHT_OFFSET_METERS, position.z);
      });
      if (points.length < 2) continue;
      const line = MeshBuilder.CreateLines(`${map.id}_${track.id}_track`, { points }, scene);
      line.parent = this.root;
      line.color = TRACK_COLOR;
      line.isPickable = false;
      line.metadata = { editorOverlay: true, agvMapTrackId: track.id };
    }

    for (const node of map.nodes) {
      const position = mapAgvPointToScene(node, component);
      const marker = MeshBuilder.CreateSphere(`${map.id}_${node.id}_businessNode`, { diameter: 0.28, segments: 2 }, scene);
      marker.parent = this.root;
      marker.position.set(position.x, position.y + MAP_HEIGHT_OFFSET_METERS * 2, position.z);
      marker.material = this.nodeMaterial;
      marker.isPickable = false;
      marker.metadata = { editorOverlay: true, agvBusinessNodeId: node.id };
    }
  }

  /** 批量绘制实图路线和点位，避免为数千个图元分别提交绘制。 */
  private buildImportedMap(map: AgvMapDefinition, component: AgvMapComponent, material: StandardMaterial): void {
    const scene = this.root.getScene();
    const { up } = getAgvMapPlane(component);
    const trackOffset = up.scale(MAP_HEIGHT_OFFSET_METERS * component.scale);
    const nodeOffset = trackOffset.scale(2);
    const toVector = (point: AgvMapPoint, offset: Vector3) => {
      const { x, y, z } = mapAgvPointToScene(point, component);
      return new Vector3(x + offset.x, y + offset.y, z + offset.z);
    };
    const nodesById = new Map(map.nodes.map(node => [node.id, node]));
    let lines: Vector3[][] = [];
    let pointCount = 0;
    let batch = 0;
    const drawLines = () => {
      if (lines.length === 0) return;
      const mesh = MeshBuilder.CreateLineSystem(`${map.id}_tracks_${batch++}`, { lines }, scene);
      mesh.parent = this.root;
      mesh.color = TRACK_COLOR;
      mesh.isPickable = false;
      mesh.metadata = { editorOverlay: true };
      lines = [];
      pointCount = 0;
    };
    for (const track of map.tracks) {
      const from = nodesById.get(track.fromNodeId);
      const to = nodesById.get(track.toNodeId);
      const points = track.points ?? (from && to ? [from, to] : []);
      if (points.length < 2) continue;
      if (pointCount + points.length > MAX_LINE_BATCH_POINTS) drawLines();
      lines.push(points.map(point => toVector(point, trackOffset)));
      pointCount += points.length;
    }
    drawLines();

    const markers = MeshBuilder.CreateSphere(`${map.id}_businessNodes`, { diameter: 0.28, segments: 2 }, scene);
    const matrices = new Float32Array(map.nodes.length * 16);
    for (const [index, node] of map.nodes.entries()) {
      const { x, y, z } = toVector(node, nodeOffset);
      const offset = index * 16;
      matrices[offset] = matrices[offset + 5] = matrices[offset + 10] = matrices[offset + 15] = 1;
      matrices[offset + 12] = x;
      matrices[offset + 13] = y;
      matrices[offset + 14] = z;
    }
    markers.parent = this.root;
    markers.material = material;
    markers.isPickable = false;
    markers.metadata = { editorOverlay: true };
    markers.thinInstanceSetBuffer('matrix', matrices, 16, true);
  }

  private clearGeometry(): void {
    for (const mesh of this.root.getChildMeshes(false) as Mesh[]) mesh.dispose(false, true);
    this.nodeMaterial?.dispose();
    this.nodeMaterial = null;
  }

  public dispose(): void {
    this.component = null;
    this.clearGeometry();
    this.root.dispose();
  }
}
