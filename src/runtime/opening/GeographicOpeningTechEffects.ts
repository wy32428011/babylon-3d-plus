import { Constants } from '@babylonjs/core/Engines/constants';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { Observer } from '@babylonjs/core/Misc/observable';
import { readOpeningBreathing, readOpeningScanPosition, type OpeningBreathingSettings } from './geographicOpeningBreathing';

export type OpeningTechSurface = {mesh:Mesh;material:StandardMaterial};
export type OpeningTechSurfaces = {
  world:OpeningTechSurface;
  regions:Record<string,OpeningTechSurface>;
};
export type GeographicOpeningTechEffects = {
  /** 调用方应将这些独立发光图层排除出原 GlowLayer，避免对 ShaderMaterial 二次解释。 */
  meshes:readonly Mesh[];
  update(elapsedSeconds:number,opacity:number,unfold:number,dynamicEnabled?:boolean):void;
  dispose():void;
};

const VERTEX_SOURCE = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
#ifdef OPENING_VERTEX_ALPHA
attribute vec4 color;
#endif
uniform mat4 worldViewProjection;
varying vec2 vUV;
varying float vVertexAlpha;
void main(void) {
  vUV = uv;
  vVertexAlpha = 1.0;
#ifdef OPENING_VERTEX_ALPHA
  vVertexAlpha = color.a;
#endif
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const FRAGMENT_SOURCE = `
precision highp float;
uniform sampler2D mapSampler;
uniform float pulseGain;
uniform float envelope;
uniform float effectStrength;
uniform float scanPosition;
uniform float scanStrength;
varying vec2 vUV;
varying float vVertexAlpha;
void main(void) {
  vec4 source = texture2D(mapSampler, vUV);
  float sourceAlpha = source.a * vVertexAlpha * envelope;
  if (sourceAlpha < 0.001) discard;
  // 省界、海岸微光和粒子的青色通道较高，深蓝陆地只接受薄扫描带。
  float edge = smoothstep(0.27, 0.68, source.g) * smoothstep(0.40, 0.90, source.b);
  // 海洋底色和背景细网格不满足蓝绿差阈值，避免整屏泛蓝。
  float land = smoothstep(0.16, 0.25, source.b - source.g) * smoothstep(0.24, 0.42, source.b);
  float distanceToScan = abs(vUV.y - scanPosition);
  float scan = 1.0 - smoothstep(0.004, 0.035, distanceToScan);
  float edgeLight = edge * (0.035 + 0.19 * pulseGain);
  float scanLight = scan * land * scanStrength;
  float alpha = sourceAlpha * effectStrength * min(0.55, edgeLight + scanLight);
  if (alpha < 0.001) discard;
  vec3 blue = mix(vec3(0.015, 0.39, 1.0), vec3(0.18, 0.78, 1.0), edge);
  gl_FragColor = vec4(blue, alpha);
}`;

const ATMOSPHERE_VERTEX_SOURCE = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform mat4 worldInverseTranspose;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main(void) {
  vWorldPosition = (world * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize((worldInverseTranspose * vec4(normal, 0.0)).xyz);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const ATMOSPHERE_FRAGMENT_SOURCE = `
precision highp float;
uniform vec3 cameraPosition;
uniform float atmosphereOpacity;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main(void) {
  vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
  float facing = abs(dot(viewDirection, normalize(vWorldNormal)));
  float rim = pow(max(0.0, 1.0 - facing), 3.5);
  float alpha = rim * min(0.25, atmosphereOpacity);
  if (alpha < 0.0001) discard;
  gl_FragColor = vec4(0.025, 0.40, 1.0, alpha);
}`;

const unit = (value:number):number => Number.isFinite(value) ? Math.max(0,Math.min(1,value)) : 0;

/**
 * 只拥有叠层 Mesh/材质，不拥有底图纹理或基础 geometry。
 * clone 共享顶点缓冲，世界展开和边缘 alpha 更新会同步到科技图层。
 */
export function createGeographicOpeningTechEffects(scene:Scene,surfaces:OpeningTechSurfaces,
  settings:OpeningBreathingSettings):GeographicOpeningTechEffects {
  const ownedMeshes:Mesh[] = [];
  const ownedMaterials:ShaderMaterial[] = [];
  const layers:Array<{source:OpeningTechSurface;mesh:Mesh;material:ShaderMaterial}> = [];
  let observer:Observer<Scene>|null = null;
  let disposed = false;
  let shaderFailure:Error|null = null;

  const dispose = ():void => {
    if (disposed) return;
    disposed = true;
    if (observer) scene.onDisposeObservable.remove(observer);
    observer = null;
    // false,false 保留共享底图材质/纹理；geometry 由 Babylon 的共享引用计数管理。
    for (const mesh of ownedMeshes) if (!mesh.isDisposed()) mesh.dispose(false,false);
    for (const material of ownedMaterials) material.dispose(false,false);
    ownedMeshes.length = ownedMaterials.length = layers.length = 0;
  };

  try {
    for (const [name,source] of [['world',surfaces.world],...Object.entries(surfaces.regions)] as Array<[string,OpeningTechSurface]>) {
      const texture = source.material.emissiveTexture ?? source.material.diffuseTexture;
      if (!texture) throw new Error(`开场科技图层 ${name} 缺少底图纹理。`);
      const vertexAlpha = source.mesh.isVerticesDataPresent(VertexBuffer.ColorKind);
      const material = new ShaderMaterial(`opening-tech-${name}-material`,scene,
        {vertexSource:VERTEX_SOURCE,fragmentSource:FRAGMENT_SOURCE},{
          attributes:vertexAlpha ? ['position','uv','color'] : ['position','uv'],
          uniforms:['worldViewProjection','pulseGain','envelope','effectStrength','scanPosition','scanStrength'],
          samplers:['mapSampler'],defines:vertexAlpha ? ['#define OPENING_VERTEX_ALPHA'] : [],
          needAlphaBlending:true,needAlphaTesting:false,
        });
      ownedMaterials.push(material);
      material.setTexture('mapSampler',texture);
      material.setFloat('pulseGain',1).setFloat('envelope',0).setFloat('effectStrength',0).setFloat('scanPosition',-.15).setFloat('scanStrength',0);
      material.alphaMode = Constants.ALPHA_ADD;
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.backFaceCulling = false;
      material.disableDepthWrite = true;
      material.depthFunction = Constants.LEQUAL;
      material.zOffset = -1;
      material.onError = (_effect,message) => { shaderFailure = new Error(`开场科技图层 ${name} shader 编译失败：${message}`); };
      const layer = source.mesh.clone(`opening-tech-${name}`,source.mesh,true,false);
      ownedMeshes.push(layer);
      // 作为基础地图的子节点，局部单位变换避免复制区域 position 后出现双重位移。
      layer.position.setAll(0);layer.rotation.setAll(0);layer.rotationQuaternion = null;layer.scaling.setAll(1);
      layer.material = material;
      layer.isPickable = false;
      layer.alwaysSelectAsActiveMesh = true;
      layer.renderingGroupId = 0;
      layer.alphaIndex = source.mesh.alphaIndex + .3;
      layer.visibility = 1;
      layer.setEnabled(false);
      layers.push({source,mesh:layer,material});
    }

    const atmosphere = MeshBuilder.CreateSphere('opening-tech-atmosphere',{diameter:2.095,segments:48},scene);
    ownedMeshes.push(atmosphere);
    atmosphere.parent = surfaces.world.mesh;
    atmosphere.isPickable = false;
    atmosphere.renderingGroupId = 0;
    atmosphere.alphaIndex = surfaces.world.mesh.alphaIndex + .2;
    // 球壳只有一个 effect，存于材质以便 onBind 直接上传相机和法线矩阵。
    const atmosphereMaterial = new ShaderMaterial('opening-tech-atmosphere-material',scene,
      {vertexSource:ATMOSPHERE_VERTEX_SOURCE,fragmentSource:ATMOSPHERE_FRAGMENT_SOURCE},{
        attributes:['position','normal'],
        uniforms:['world','worldViewProjection','worldInverseTranspose','cameraPosition','atmosphereOpacity'],
        needAlphaBlending:true,needAlphaTesting:false,
      },false);
    ownedMaterials.push(atmosphereMaterial);
    atmosphereMaterial.setFloat('atmosphereOpacity',0);
    atmosphereMaterial.alphaMode = Constants.ALPHA_ADD;
    atmosphereMaterial.transparencyMode = Material.MATERIAL_ALPHABLEND;
    atmosphereMaterial.disableDepthWrite = true;
    atmosphereMaterial.backFaceCulling = true;
    atmosphereMaterial.onError = (_effect,message) => { shaderFailure = new Error(`开场大气 shader 编译失败：${message}`); };
    const inverseWorld = Matrix.Identity();
    const normalMatrix = Matrix.Identity();
    atmosphereMaterial.onBindObservable.add(() => {
      const effect = atmosphereMaterial.getEffect();
      const camera = scene.activeCamera;
      if (!effect || !camera) return;
      // 直接写本次绑定的 effect，避免相机移动时统一变量延迟一帧；矩阵对象只创建一次。
      atmosphere.getWorldMatrix().invertToRef(inverseWorld);
      Matrix.TransposeToRef(inverseWorld,normalMatrix);
      effect.setMatrix('worldInverseTranspose',normalMatrix);
      effect.setVector3('cameraPosition',camera.globalPosition);
    });
    atmosphere.material = atmosphereMaterial;
    atmosphere.setEnabled(false);

    const update = (elapsedSeconds:number,opacity:number,unfold:number,dynamicEnabled = true):void => {
      if (disposed) return;
      const intensity = unit(settings.breathingIntensity);
      if (!dynamicEnabled || !settings.breathingEnabled || intensity === 0) {
        for (const mesh of ownedMeshes) mesh.setEnabled(false);
        return;
      }
      if (shaderFailure) throw shaderFailure;
      const gain = readOpeningBreathing(elapsedSeconds,settings,dynamicEnabled);
      const scan = readOpeningScanPosition(elapsedSeconds,settings.breathingPeriodSeconds);
      for (const layer of layers) {
        const source = layer.source;
        const alpha = !source.mesh.isDisposed() && source.mesh.isEnabled()
          ? Math.min(unit(opacity),unit(source.material.alpha)) * unit(source.mesh.visibility) : 0;
        layer.mesh.setEnabled(alpha > .001);
        if (alpha <= .001) continue;
        layer.mesh.alphaIndex = source.mesh.alphaIndex + .3;
        layer.material.setFloat('pulseGain',gain).setFloat('envelope',alpha)
          .setFloat('effectStrength',intensity).setFloat('scanPosition',scan).setFloat('scanStrength',.22);
      }
      const worldVisible = !surfaces.world.mesh.isDisposed() && surfaces.world.mesh.isEnabled();
      const worldAlpha = worldVisible ? Math.min(unit(opacity),unit(surfaces.world.material.alpha)) : 0;
      const atmosphereAlpha = worldAlpha * Math.pow(1-unit(unfold),1.7) * Math.min(.24,.2*gain) * intensity;
      atmosphere.setEnabled(atmosphereAlpha > .001);
      atmosphereMaterial.setFloat('atmosphereOpacity',atmosphereAlpha);
    };
    observer = scene.onDisposeObservable.addOnce(dispose);
    return {meshes:ownedMeshes,update,dispose};
  } catch (error) {
    dispose();
    throw error;
  }
}
