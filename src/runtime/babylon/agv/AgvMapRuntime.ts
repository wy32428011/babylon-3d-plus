import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { AgvMapComponent } from '../../../editor/model/components';
import { getBuiltInAgvMap } from '../../../editor/model/agvMapLibrary.ts';
import { mapAgvPointToScene, resolveAgvMapTrackPoints } from '../../../editor/model/agvMap.ts';

const TRACK_COLOR = Color3.FromHexString('#20d9ff');
const NODE_COLOR = '#ffb020';
const MAP_HEIGHT_OFFSET_METERS = 0.035;

/** AGV 地图只持有运行时几何；地图选择、映射与比例尺的权威数据仍在 SceneDocument。 */
export class AgvMapRuntime {
  public readonly root: TransformNode;
  private signature = '';
  private nodeMaterial: StandardMaterial | null = null;

  constructor(scene: Scene, entityId: string) {
    this.root = new TransformNode(`${entityId}_agvMapRoot`, scene);
  }

  public sync(component: AgvMapComponent, visible: boolean): void {
    const map = getBuiltInAgvMap(component.mapId);
    const signature = JSON.stringify(component);
    this.root.setEnabled(visible && component.showTrajectories && Boolean(map));
    if (signature === this.signature) return;
    this.signature = signature;
    this.clearGeometry();
    if (!map || !component.showTrajectories) return;

    const scene = this.root.getScene();
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

    this.nodeMaterial = new StandardMaterial(`${map.id}_businessNodeMaterial`, scene);
    this.nodeMaterial.disableLighting = true;
    this.nodeMaterial.emissiveColor = Color3.FromHexString(NODE_COLOR);
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

  private clearGeometry(): void {
    for (const mesh of this.root.getChildMeshes(false) as Mesh[]) mesh.dispose(false, true);
    this.nodeMaterial?.dispose();
    this.nodeMaterial = null;
  }

  public dispose(): void {
    this.signature = '';
    this.clearGeometry();
    this.root.dispose();
  }
}
