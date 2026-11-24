import { Constants } from '@babylonjs/core/Engines/constants.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { AgvMapRoute, AgvRouteHighlightConfig } from '../../../editor/model/agvMap';
import { mapAgvPointToScene } from '../../../editor/model/agvMap.ts';
import type { AgvMapPlacement } from '../scene-runtime/sceneRuntimeTypes';
import { getAgvMapPlane } from './agvMapPlane.ts';

const ROUTE_VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUv;
void main() {
  vUv=uv;
  gl_Position=worldViewProjection*vec4(position,1.0);
}`;

const ROUTE_FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform vec3 remainingColor;
uniform float opacity;
uniform float time;
uniform float progress;
uniform float amount;
uniform float flow;
void main() {
  if(vUv.x<progress) discard;
  float wave=flow>0.5?pow(0.5+0.5*cos((vUv.x*amount-time)*6.28318530718),14.0):0.0;
  float edge=pow(max(0.0,1.0-abs(vUv.y*2.0-1.0)),0.65);
  float alpha=(0.52+wave*0.48)*edge*opacity;
  if(alpha<0.001) discard;
  gl_FragColor=vec4(remainingColor*(1.0+wave*0.55),alpha);
}`;

type ArrowEntry = { mesh: Mesh; offset: number };

export class AgvTaskRouteHighlight {
  public readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly config: AgvRouteHighlightConfig;
  private readonly path: Vector3[];
  private readonly lengths: number[];
  private readonly up: Vector3;
  private readonly surface: ShaderMaterial;
  private readonly arrowMaterials: StandardMaterial[] = [];
  private readonly arrows: ArrowEntry[] = [];
  private progress = 0;
  private elapsed = 0;
  private disposed = false;

  constructor(id: string, scene: Scene, route: AgvMapRoute, placement: AgvMapPlacement, config: AgvRouteHighlightConfig) {
    this.scene = scene;
    this.config = config;
    this.root = new TransformNode(`${id}_agvTaskRouteHighlight`, scene);
    const { transform } = placement;
    this.root.position.set(transform.position.x, transform.position.y, transform.position.z);
    this.root.rotationQuaternion = Quaternion.FromEulerAngles(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    this.root.scaling.set(transform.scale.x, transform.scale.y, transform.scale.z);
    this.root.metadata = { editorOverlay: true, agvTaskRouteHighlight: true };

    const plane = getAgvMapPlane(placement.map);
    this.up = plane.up;
    const offset = this.up.scale(0.065);
    this.path = [];
    for (const point of route.points) {
      const mapped = mapAgvPointToScene(point, placement.map);
      const vector = new Vector3(mapped.x, mapped.y, mapped.z).add(offset);
      if (!this.path.length || Vector3.DistanceSquared(this.path[this.path.length - 1], vector) > 0.000001) {
        this.path.push(vector);
      }
    }
    this.lengths = this.path.map((point, index) => {
      if (!index) return 0;
      const delta = point.subtract(this.path[index - 1]);
      delta.x *= transform.scale.x;
      delta.y *= transform.scale.y;
      delta.z *= transform.scale.z;
      return delta.length();
    });
    for (let index = 1; index < this.lengths.length; index++) this.lengths[index] += this.lengths[index - 1];

    this.surface = new ShaderMaterial(`${id}_agvRouteSurface`, scene, {
      vertexSource: ROUTE_VERTEX_SHADER,
      fragmentSource: ROUTE_FRAGMENT_SHADER,
    }, {
      attributes: ['position', 'uv'],
      uniforms: ['worldViewProjection', 'remainingColor', 'opacity', 'time', 'progress', 'amount', 'flow'],
      needAlphaBlending: true,
    });
    this.surface.backFaceCulling = false;
    this.surface.disableDepthWrite = true;
    this.surface.alphaMode = Constants.ALPHA_COMBINE;
    this.surface.setColor3('remainingColor', Color3.FromHexString(config.remainingColor));
    this.surface.setFloat('opacity', config.opacity);
    this.surface.setFloat('amount', config.amount);
    this.surface.setFloat('flow', config.style === 'path-reveal' ? 0 : 1);

    if (config.style === 'pipe-flow') this.createTube(id);
    else this.createRibbon(id);
    if (config.style === 'flow-arrows') this.createArrows(id);
    this.update(0, 0);
  }

  public update(progress: number, deltaSeconds: number): void {
    if (this.disposed) return;
    this.progress = Math.min(1, Math.max(0, progress));
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) this.elapsed += deltaSeconds;
    const totalLength = this.lengths[this.lengths.length - 1] ?? 0;
    const phase = totalLength > 0 ? (this.elapsed * this.config.speed / totalLength) % 1 : 0;
    this.surface.setFloat('progress', this.progress);
    this.surface.setFloat('time', phase * this.config.amount);
    for (const arrow of this.arrows) {
      const fraction = (arrow.offset + phase) % 1;
      const sample = this.pointOnPath(fraction);
      arrow.mesh.position.copyFrom(sample.point);
      const right = Vector3.Cross(this.up, sample.tangent).normalize();
      const up = Vector3.Cross(sample.tangent, right).normalize();
      arrow.mesh.rotationQuaternion ??= Quaternion.Identity();
      Quaternion.FromLookDirectionRHToRef(sample.tangent, up, arrow.mesh.rotationQuaternion);
      arrow.mesh.material = this.arrowMaterials[0];
      arrow.mesh.setEnabled(fraction > this.progress);
    }
  }

  public getProgress(): number {
    return this.progress;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.dispose();
    this.surface.dispose();
    for (const material of this.arrowMaterials) material.dispose();
  }

  private prepareMesh(mesh: Mesh): void {
    mesh.parent = this.root;
    mesh.isPickable = false;
    mesh.metadata = { editorOverlay: true, agvTaskRouteHighlight: true };
  }

  private createRibbon(id: string): void {
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const total = Math.max(0.000001, this.lengths[this.lengths.length - 1]);
    for (const [index, point] of this.path.entries()) {
      const tangent = this.path[Math.min(index + 1, this.path.length - 1)]
        .subtract(this.path[Math.max(0, index - 1)]);
      const side = Vector3.Cross(tangent, this.up);
      if (side.lengthSquared() < 0.000001) side.copyFrom(getAgvMapPlane({ xAxis: 'x', yAxis: 'z' }).right);
      side.normalize().scaleInPlace(this.config.width * 0.5);
      for (const sign of [-1, 1]) {
        const vertex = point.add(side.scale(sign));
        positions.push(vertex.x, vertex.y, vertex.z);
        uvs.push(this.lengths[index] / total, (sign + 1) / 2);
      }
      if (index < this.path.length - 1) {
        const vertex = index * 2;
        indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
      }
    }
    const mesh = new Mesh(`${id}_agvRouteRibbon`, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    data.applyToMesh(mesh);
    mesh.material = this.surface;
    this.prepareMesh(mesh);
  }

  private createTube(id: string): void {
    const tube = MeshBuilder.CreateTube(`${id}_agvRouteTube`, {
      path: this.path,
      radius: this.config.width * 0.5,
      tessellation: 8,
    }, this.scene);
    const uvs = tube.getVerticesData('uv');
    if (uvs) {
      const total = Math.max(0.000001, this.lengths[this.lengths.length - 1]);
      const ringSize = tube.getTotalVertices() / this.path.length;
      for (let vertex = 0; vertex < tube.getTotalVertices(); vertex++) {
        const ring = Math.min(this.path.length - 1, Math.floor(vertex / ringSize));
        uvs[vertex * 2] = this.lengths[ring] / total;
        uvs[vertex * 2 + 1] = 0.5;
      }
      tube.setVerticesData('uv', uvs);
    }
    tube.material = this.surface;
    this.prepareMesh(tube);
  }

  private createArrows(id: string): void {
    const material = new StandardMaterial(`${id}_agvRouteArrowMaterial`, this.scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.FromHexString(this.config.remainingColor);
    material.diffuseColor = Color3.Black();
    material.alpha = this.config.opacity;
    this.arrowMaterials.push(material);
    const scale = this.config.width * 2.5;
    for (let index = 0; index < this.config.amount; index++) {
      const mesh = new Mesh(`${id}_agvRouteArrow_${index}`, this.scene);
      const data = new VertexData();
      data.positions = [
        -0.6, 0, -0.5, 0, 0, 0.2, 0.6, 0, -0.5,
        0.6, 0, -0.15, 0, 0, 0.65, -0.6, 0, -0.15,
      ].map(value => value * scale);
      data.indices = [0, 1, 5, 1, 4, 5, 1, 2, 3, 1, 3, 4];
      data.applyToMesh(mesh);
      mesh.material = this.arrowMaterials[0];
      this.prepareMesh(mesh);
      this.arrows.push({ mesh, offset: index / this.config.amount });
    }
  }

  private pointOnPath(fraction: number): { point: Vector3; tangent: Vector3 } {
    const distance = Math.min(1, Math.max(0, fraction)) * this.lengths[this.lengths.length - 1];
    let low = 1;
    let high = this.lengths.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.lengths[middle] < distance) low = middle + 1;
      else high = middle;
    }
    const start = this.path[low - 1];
    const end = this.path[low];
    const segmentProgress = (distance - this.lengths[low - 1])
      / Math.max(0.000001, this.lengths[low] - this.lengths[low - 1]);
    return {
      point: Vector3.Lerp(start, end, segmentProgress),
      tangent: end.subtract(start).normalize(),
    };
  }
}
