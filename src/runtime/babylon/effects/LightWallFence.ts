import { Color3, Constants, Mesh, ShaderMaterial, VertexData, type Scene, type TransformNode } from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';

const VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vWallUv;
void main() {
  vWallUv = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vWallUv;
uniform vec3 wallColor;
uniform float wallOpacity;
uniform float wallIntensity;
uniform float flowPhase;
uniform float bandCount;
uniform float fadeExponent;
void main() {
  float height = clamp(vWallUv.y, 0.0, 1.0);
  float heightFade = pow(1.0 - height, fadeExponent);
  float baseGlow = exp(-height * 18.0);
  float flowBand = pow(0.5 + 0.5 * cos((height * bandCount - flowPhase) * 6.28318530718), 12.0);
  float alpha = wallOpacity * heightFade * (0.32 + 0.50 * baseGlow + 0.18 * flowBand);
  if (alpha <= 0.0) discard;
  vec3 glow = wallColor * wallIntensity * (0.9 + 0.8 * baseGlow + 0.45 * flowBand);
  gl_FragColor = vec4(glow, alpha);
}`;

/** 单 Mesh 闭合光墙；输入由 POI 组件清洗器保证为有效、不重复闭合终点的轮廓。 */
export class LightWallFence {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private phase = 0;
  private speed = 0;
  private direction = 1;

  constructor(id: string, scene: Scene, root: TransformNode, component: PoiEffectComponent) {
    const wall = component.lightWall;
    if (!wall) throw new Error(`光墙围栏缺少已校验的轮廓参数：${id}`);

    this.mesh = new Mesh(`${id}_light_wall_fence`, scene);
    this.mesh.parent = root;
    this.mesh.metadata = { editorEntityId: id, effectRole: 'light-wall-fence' };
    this.createGeometry(wall.points, wall.height);
    this.material = new ShaderMaterial(`${id}_light_wall_fence_mat`, scene, {
      vertexSource: VERTEX_SHADER,
      fragmentSource: FRAGMENT_SHADER,
    }, {
      attributes: ['position', 'uv'],
      uniforms: ['worldViewProjection', 'wallColor', 'wallOpacity', 'wallIntensity', 'flowPhase', 'bandCount', 'fadeExponent'],
      needAlphaBlending: true,
    });
    // 保留建筑深度遮挡；加法混合让闭合侧壁的叠加不依赖三角面顺序，背面同样显示。
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.mesh.material = this.material;
    this.material.setFloat('flowPhase', this.phase);
    this.update(component);
  }

  /** 外观和流速只更新 uniform/状态，保留几何、材质及当前动画相位。 */
  update(component: PoiEffectComponent): void {
    this.material.setColor3('wallColor', Color3.FromHexString(component.primaryColor));
    this.material.setFloat('wallOpacity', component.lightWall?.opacity ?? 0);
    this.material.setFloat('wallIntensity', component.intensity);
    this.speed = component.speed;
    const parameters=component.configuration?.parameters;
    const number=(key:string,fallback:number,min:number,max:number) => typeof parameters?.[key]==='number' && Number.isFinite(parameters[key]) ? Math.max(min,Math.min(max,parameters[key] as number)) : fallback;
    this.direction=parameters?.flowDirection==='reverse'?-1:1;
    this.material.setFloat('bandCount',number('bandCount',3,1,32));
    this.material.setFloat('fadeExponent',number('fadeExponent',1.5,0.1,8));
    this.mesh.position.y=number('elevation',0,-10000,10000);
  }

  /** 由 POI 的唯一帧观察者驱动；零速时保持当前帧，长期运行相位始终有界。 */
  animate(deltaSeconds: number): void {
    if (this.speed <= 0 || deltaSeconds <= 0) return;
    this.phase = (this.phase + deltaSeconds * this.speed * 0.65 * this.direction) % 1;
    this.material.setFloat('flowPhase', this.phase);
  }

  private createGeometry(points: readonly { x: number; z: number }[], height: number): void {
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      const vertex = positions.length / 3;
      positions.push(start.x, 0, start.z, end.x, 0, end.z, start.x, height, start.z, end.x, height, end.z);
      uvs.push(index / points.length, 0, (index + 1) / points.length, 0, index / points.length, 1, (index + 1) / points.length, 1);
      indices.push(vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3);
    }
    const geometry = new VertexData();
    geometry.positions = positions;
    geometry.indices = indices;
    geometry.uvs = uvs;
    geometry.applyToMesh(this.mesh);
  }
}
