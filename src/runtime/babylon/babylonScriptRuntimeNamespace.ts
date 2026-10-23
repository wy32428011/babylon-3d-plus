/** 外置参数化模型脚本（.model.ts）运行时受控注入的 Babylon.js 命名空间。 */
import './babylonSideEffects.js';
import { Animation } from '@babylonjs/core/Animations/animation.js';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { Bone } from '@babylonjs/core/Bones/bone.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';
import { Ray } from '@babylonjs/core/Culling/ray.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { EngineStore } from '@babylonjs/core/Engines/engineStore.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { GizmoCoordinatesMode } from '@babylonjs/core/Gizmos/gizmo.js';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { SelectionOutlineLayer } from '@babylonjs/core/Layers/selectionOutlineLayer.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { RectAreaLight } from '@babylonjs/core/Lights/rectAreaLight.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { LoadAssetContainerAsync, SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { Effect } from '@babylonjs/core/Materials/effect.js';
import { GreasedLineMeshColorDistributionType, GreasedLineMeshMaterialType } from '@babylonjs/core/Materials/GreasedLine/greasedLineMaterialInterfaces.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRBaseMaterial } from '@babylonjs/core/Materials/PBR/pbrBaseMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { EnvCubeTexture } from '@babylonjs/core/Materials/Textures/envCubeTexture.js';
import { HDRFiltering } from '@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Axis } from '@babylonjs/core/Maths/math.axis.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Curve3 } from '@babylonjs/core/Maths/math.path.js';
import { Plane } from '@babylonjs/core/Maths/math.plane.js';
import { Scalar } from '@babylonjs/core/Maths/math.scalar.js';
import { Matrix, Quaternion, TmpVectors, Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateGreasedLine } from '@babylonjs/core/Meshes/Builders/greasedLineBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { Geometry } from '@babylonjs/core/Meshes/geometry.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { SerializationHelper } from '@babylonjs/core/Misc/decorators.serialization.js';
import { SmartArray } from '@babylonjs/core/Misc/smartArray.js';
import { MorphTarget } from '@babylonjs/core/Morph/morphTarget.js';
import { MorphTargetManager } from '@babylonjs/core/Morph/morphTargetManager.js';
import { Node } from '@babylonjs/core/node.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { RenderingGroup } from '@babylonjs/core/Rendering/renderingGroup.js';
import { RenderingManager } from '@babylonjs/core/Rendering/renderingManager.js';
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer.js';
import { Scene } from '@babylonjs/core/scene.js';

export const BabylonCore = Object.freeze({
  AbstractMesh,
  Animation,
  AnimationGroup,
  ArcRotateCamera,
  AssetContainer,
  Axis,
  BaseTexture,
  Bone,
  BoundingInfo,
  Camera,
  CascadedShadowGenerator,
  Color3,
  Color4,
  Constants,
  CreateBox,
  CreateGreasedLine,
  CreatePlane,
  CreateSphere,
  Curve3,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  Effect,
  Engine,
  EngineStore,
  EnvCubeTexture,
  Frustum,
  Geometry,
  GizmoCoordinatesMode,
  GizmoManager,
  GlowLayer,
  GreasedLineMeshColorDistributionType,
  GreasedLineMeshMaterialType,
  HDRFiltering,
  HemisphericLight,
  ImageProcessingConfiguration,
  InstancedMesh,
  Light,
  LinesMesh,
  LoadAssetContainerAsync,
  Material,
  MaterialDefines,
  MaterialPluginBase,
  Matrix,
  Mesh,
  MeshBuilder,
  MorphTarget,
  MorphTargetManager,
  MultiMaterial,
  Node,
  PBRBaseMaterial,
  PBRMaterial,
  ParticleSystem,
  Plane,
  PointLight,
  Quaternion,
  RawTexture,
  Ray,
  RectAreaLight,
  RenderTargetTexture,
  RenderingGroup,
  RenderingManager,
  Scalar,
  Scene,
  SceneLoader,
  SelectionOutlineLayer,
  SerializationHelper,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  ShadowGenerator,
  SmartArray,
  SpotLight,
  StandardMaterial,
  SubMesh,
  Texture,
  TmpVectors,
  TransformNode,
  UtilityLayerRenderer,
  Vector2,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
});

export type BabylonScriptRuntimeNamespace = Readonly<Record<string, unknown>>;

let completeNamespaceRequest: Promise<BabylonScriptRuntimeNamespace> | null = null;

/** 与外置脚本现有 import 解析语法保持一致，不把类型导入或无效绑定当成运行时依赖。 */
function requiresCompleteNamespace(sourceText: string): boolean {
  const imports = /^\s*import\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["'];?\s*$/gm;
  for (const match of sourceText.matchAll(imports)) {
    if (match[1]) continue;
    const importClause = match[2].trim();
    if (importClause.startsWith('* as ')) {
      if (/^[A-Za-z_$][\w$]*$/.test(importClause.slice(5).trim())) return true;
      continue;
    }
    if (match[3].includes('babylonjs-editor-tools')) continue;
    const namedImports = importClause.match(/\{([\s\S]+)\}/);
    if (!namedImports) continue;
    for (const binding of namedImports[1].split(',')) {
      const parts = binding.trim().split(/\s+as\s+/i).map(part => part.trim()).filter(Boolean);
      const importedName = parts[0];
      const localName = parts[1] ?? importedName;
      if (!/^[A-Za-z_$][\w$]*$/.test(importedName ?? '') || !/^[A-Za-z_$][\w$]*$/.test(localName ?? '')) continue;
      // 粒子自定义着色器和序列化依赖额外的场景/Engine 原型注册，保持完整入口的既有能力。
      if (importedName === 'ParticleSystem' || !Object.hasOwn(BabylonCore, importedName)) return true;
    }
  }
  return false;
}

/** 常用命名导入走轻量集合；任意命名空间和其它既有 Babylon API 保留完整兼容，失败后允许重试。 */
export async function resolveBabylonScriptRuntimeNamespace(sourceText: string): Promise<BabylonScriptRuntimeNamespace> {
  if (!requiresCompleteNamespace(sourceText)) return BabylonCore;
  completeNamespaceRequest ??= import('@babylonjs/core/index.js').catch(error => {
    completeNamespaceRequest = null;
    throw error;
  });
  return completeNamespaceRequest;
}
