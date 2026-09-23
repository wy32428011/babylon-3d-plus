import { Color3, Constants, Mesh, MeshBuilder, ShaderMaterial, type Scene, type TransformNode } from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';
import { isConveyorArrowEffectKind, sanitizeConveyorArrowEffect } from '../../../editor/model/conveyorArrowEffect';
import { CONVEYOR_ARROW_GLSL, CONVEYOR_ARROW_STYLE_IDS } from './ConveyorArrowShaders';

const vertexSource = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position,1.0);
}`;

const fragmentSource = `
precision highp float;
varying vec2 vUV;
uniform vec3 arrowColor;
uniform vec3 edgeColor;
uniform float arrowStyle;
uniform float arrowLength;
uniform float arrowWidth;
uniform float arrowCount;
uniform float arrowOpacity;
uniform float arrowIntensity;
uniform float flowPhase;
uniform float direction;
${CONVEYOR_ARROW_GLSL}
void main() {
  vec2 uv = vec2(direction < 0.0 ? 1.0-vUV.x : vUV.x, vUV.y);
  vec4 color = renderConveyorArrow(uv,vec2(arrowLength,arrowWidth),arrowStyle,arrowCount,flowPhase,arrowColor,edgeColor,arrowIntensity,arrowOpacity);
  if (color.a < 0.001) discard;
  gl_FragColor = color;
}`;

/** 六种直线输送箭头共用一个平面；由 POI 唯一帧观察者驱动，不生成贴图或粒子。 */
export class ConveyorArrowEffect {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private phase = 0;
  private speed = 0;
  private active = true;

  constructor(id: string, scene: Scene, root: TransformNode, component: PoiEffectComponent) {
    this.mesh = MeshBuilder.CreateGround(`${id}_conveyor_arrow`, { width: 1, height: 1 }, scene);
    this.mesh.parent = root;
    this.mesh.position.y = 0.025;
    this.mesh.metadata = { editorEntityId: id, effectRole: 'conveyor-arrow' };
    this.mesh.receiveShadows = false;
    this.material = new ShaderMaterial(`${id}_conveyor_arrow_mat`, scene, { vertexSource, fragmentSource }, {
      attributes: ['position', 'uv'],
      uniforms: ['worldViewProjection', 'arrowColor', 'edgeColor', 'arrowStyle', 'arrowLength', 'arrowWidth', 'arrowCount', 'arrowOpacity', 'arrowIntensity', 'flowPhase', 'direction'],
      needAlphaBlending: true,
    });
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.material.depthFunction = Constants.LEQUAL;
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.mesh.material = this.material;
    this.material.setFloat('flowPhase', 0);
    this.update(component);
  }

  /** 尺寸通过单平面缩放同步拾取边界；其余属性只改 uniform，保留动画相位。 */
  update(component: PoiEffectComponent): void {
    if (!isConveyorArrowEffectKind(component.effectKind)) return;
    const config = sanitizeConveyorArrowEffect(component.conveyorArrow, component.effectKind);
    this.mesh.scaling.set(config.length, 1, config.width);
    this.material.setFloat('arrowStyle', CONVEYOR_ARROW_STYLE_IDS[component.effectKind]);
    this.material.setFloat('arrowLength', config.length);
    this.material.setFloat('arrowWidth', config.width);
    this.material.setFloat('arrowCount', config.count);
    this.material.setFloat('arrowOpacity', config.opacity);
    this.material.setFloat('arrowIntensity', component.intensity);
    this.material.setFloat('direction', config.reverse ? -1 : 1);
    this.material.setColor3('arrowColor', Color3.FromHexString(component.primaryColor));
    this.material.setColor3('edgeColor', Color3.FromHexString(component.secondaryColor));
    this.speed = component.speed;
  }

  setActive(active: boolean): void {
    this.active = active;
    this.mesh.setEnabled(active);
  }

  /** 相位始终限制在一个周期内，零速、隐藏及无效帧间隔不会继续累积。 */
  tick(deltaSeconds: number): void {
    if (!this.active || this.speed <= 0 || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const rate = this.speed * 0.65;
    this.phase = (this.phase + (deltaSeconds % (1 / rate)) * rate) % 1;
    this.material.setFloat('flowPhase', this.phase);
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.material.dispose();
  }
}
