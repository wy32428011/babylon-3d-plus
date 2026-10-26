import { resolveSceneSkyboxReference } from '../../../electron/shared/sceneSkyboxContract.ts';
import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';
import { lightingMaterialOverrideFingerprint, getLightingMaterialSourceOwner } from './lightingMaterialOverrides.ts';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { RectAreaLight } from '@babylonjs/core/Lights/rectAreaLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core';
import type { LightingBakeInput, LightingBakeLightInput } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { getSceneLightingBakeSignature, lightingContentHash } from '../../../electron/shared/sceneLightingBakeContract.ts';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import { classifyEntityMobility } from '../../editor/model/lightingMobility';
import { createLightingTextureCapture, exportLightingMesh } from './lightingGeometry.ts';
import type { LightingRuntimeSource } from './lightingClassificationRuntime.ts';
import { lightingGeometrySignatureCache } from './lightingGeometrySignatureCache.ts';

export function sourceGeometryMesh(mesh: AbstractMesh): Mesh {
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  if (!(source instanceof Mesh)) throw new Error(`对象「${mesh.name}」不是支持混合光照的网格。`);
  return source;
}

export function lightingSourceVisible(source: LightingRuntimeSource): boolean {
  if (source.instance) {
    if (source.instance.batch.isLightingInstanceVisible) return source.instance.batch.isLightingInstanceVisible(source.instance.mesh, source.instance.sourceIndex);
    const owner = source.instance.batch.getLightingInstanceWorldMatrix(source.instance.mesh, source.instance.sourceIndex);
    return owner !== null && source.mesh.visibility > 0;
  }
  return !source.mesh.isDisposed() && source.mesh.isEnabled() && source.mesh.isVisible && source.mesh.visibility > 0;
}

/** 几何签名只在捕获、加载及显式 dirty 时计算；相机变化不会触发全顶点遍历。 */
export function getLightingGeometrySignature(sources: readonly LightingRuntimeSource[]): string {
  const cache = new Map<Mesh, string>();
  const staticSources = sources.filter(source => source.entry.mobility === 'static' && lightingSourceVisible(source)).sort((a, b) => a.entry.key.localeCompare(b.entry.key));
  const entries = staticSources.map(source => {
    const mesh = sourceGeometryMesh(source.mesh), world = source.getWorldMatrix();
    if (!world) throw new Error(`对象「${source.entry.name}」的世界矩阵已失效。`);
    let geometry = cache.get(mesh);
    if (!geometry) {
      geometry = lightingGeometrySignatureCache.getHash(mesh);
      cache.set(mesh, geometry);
    }
    return [source.entry.key, geometry, Array.from(world.m), source.entry.bakeIndirect, source.entry.castShadows, source.entry.receiveShadows];
  });
  return `geometry-v1-${lightingContentHash(entries)}`;
}

function isDynamicLight(document: SceneDocument, light: Light): boolean {
  const entity = document.entities[light.id] ?? document.entities[light.metadata?.entityId];
  if (!entity) return false;
  if (classifyEntityMobility(entity).mobility === 'dynamic') return true;
  const visited = new Set<string>();
  for (let id = entity.parentId; id && !visited.has(id); id = document.entities[id]?.parentId ?? null) {
    visited.add(id);
    if (document.entities[id] && classifyEntityMobility(document.entities[id]).mobility === 'dynamic') return true;
  }
  return false;
}

/** 使用当前实际灯光，包含统一管理主光；运动灯保留实时路径，不进入静态反弹。 */
export function captureLightingEnvironment(scene: Scene, document: SceneDocument): Pick<LightingBakeInput, 'lights' | 'environment'> {
  const lights: LightingBakeLightInput[] = [];
  const ambient: [number, number, number] = [0, 0, 0];
  for (const light of scene.lights) {
    if (!light.isEnabled() || light.intensity <= 0 || isDynamicLight(document, light)) continue;
    if (light instanceof HemisphericLight) {
      for (const [index, value] of [light.diffuse.r + light.groundColor.r, light.diffuse.g + light.groundColor.g, light.diffuse.b + light.groundColor.b].entries()) ambient[index] += value * light.intensity / 2;
      continue;
    }
    if (!(light instanceof DirectionalLight) && !(light instanceof PointLight) && !(light instanceof SpotLight) && !(light instanceof RectAreaLight)) throw new Error(`灯光「${light.name}」暂不支持静态间接光捕获。`);
    const parentWorld = light.parent?.computeWorldMatrix(true) ?? Matrix.IdentityReadOnly;
    light.computeWorldMatrix();
    const position = Vector3.TransformCoordinates(light.position, parentWorld);
    const direction = light instanceof DirectionalLight || light instanceof SpotLight ? Vector3.TransformNormal(light.direction, parentWorld).normalize()
      : light instanceof RectAreaLight ? Vector3.TransformNormal(Vector3.Forward(), light.getWorldMatrix()).normalize() : Vector3.Down();
    lights.push({
      kind: light instanceof DirectionalLight ? 'directional' : light instanceof SpotLight ? 'spot' : light instanceof RectAreaLight ? 'area' : 'point',
      position: [position.x, position.y, position.z], direction: [direction.x, direction.y, direction.z],
      color: [light.diffuse.r, light.diffuse.g, light.diffuse.b], intensity: light.intensity,
      // Babylon 的 MAX_VALUE/Infinity 表示无界范围；方向光和面光不使用距离范围。
      ...((light instanceof PointLight || light instanceof SpotLight) && Number.isFinite(light.range) && light.range !== Number.MAX_VALUE
        ? { range: light.range } : {}),
      falloff: light.falloffType === Light.FALLOFF_STANDARD ? 'standard' : light.falloffType === Light.FALLOFF_GLTF ? 'gltf' : 'physical',
      ...(light instanceof SpotLight ? { angle: light.angle, innerAngle: light.innerAngle, exponent: light.exponent } : {}),
      ...(light instanceof RectAreaLight ? { width: light.width, height: light.height } : {}),
    });
  }
  const resolvedSkybox = resolveSceneSkyboxReference(document);
  const skybox = resolvedSkybox?.skybox;
  // ENV 只负责运行时；烘焙始终读取真正的 HDR/EXR 源，不因换格式退化为平均辐照度。
  const useSceneEnvironment = getSceneLightingConfig(document).environment?.source !== 'sandbox';
  const intensity = Math.max(0, scene.environmentIntensity);
  if (useSceneEnvironment && resolvedSkybox?.visible && skybox?.sourceAvailable === false && intensity > 0) {
    throw new Error('当前运行包不包含天空原图，不能重新烘焙；请打开 SOURCE 工程。');
  }
  const hdrUrl = useSceneEnvironment && resolvedSkybox?.visible && typeof skybox?.sourceUrl === 'string'
    && (skybox.format === 'hdr' || skybox.format === 'exr') && skybox.sourceUrl ? skybox.sourceUrl : undefined;
  if (!hdrUrl && scene.environmentTexture) {
    const polynomial = scene.environmentTexture.sphericalPolynomial;
    if (polynomial) {
      ambient[0] += Math.max(0, (polynomial.xx.x + polynomial.yy.x + polynomial.zz.x) / 3) * intensity;
      ambient[1] += Math.max(0, (polynomial.xx.y + polynomial.yy.y + polynomial.zz.y) / 3) * intensity;
      ambient[2] += Math.max(0, (polynomial.xx.z + polynomial.yy.z + polynomial.zz.z) / 3) * intensity;
    }
  }
  return { lights, environment: hdrUrl && intensity > 0
    ? { color: ambient.map(value => value / intensity) as [number, number, number], intensity, textureUrl: hdrUrl, rotation: resolvedSkybox?.rotation ?? 0 }
    : { color: ambient, intensity: 1 } };
}

/** 快速材质指纹用于运行中的静态失效检测，不读取 GPU 像素或遍历顶点。 */
export function lightingMaterialFingerprint(mesh: AbstractMesh): string {
  return lightingMaterialOverrideFingerprint(mesh.material, getLightingMaterialSourceOwner(mesh));
}

export async function captureRuntimeLightingInput(scene: Scene, document: SceneDocument, sources: readonly LightingRuntimeSource[], jobId: string,
  signal?: AbortSignal, progress?: (message: string) => void): Promise<LightingBakeInput> {
  const staticSources = sources.filter(source => source.entry.mobility === 'static' && lightingSourceVisible(source));
  if (!staticSources.some(source => source.entry.bakeIndirect)) throw new Error('没有参与间接光烘焙的静态表面，请先检查对象分类。');
  const geometrySignature = getLightingGeometrySignature(sources), signature = getSceneLightingBakeSignature(document);
  const capture = createLightingTextureCapture(signal), meshes: LightingBakeInput['meshes'] = [];
  for (const [index, source] of staticSources.entries()) {
    signal?.throwIfAborted();
    const matrix = source.getWorldMatrix();
    if (!matrix) throw new Error(`对象「${source.entry.name}」的矩阵已失效，请重新检查分类。`);
    progress?.(`正在捕获静态对象 ${index + 1}/${staticSources.length}：${source.entry.name}`);
    meshes.push(...await exportLightingMesh(source.mesh, { key: source.entry.key, entityId: source.entry.entityId,
      nodeKey: source.entry.nodeKey, receiver: source.entry.bakeIndirect, worldMatrix: matrix }, capture));
  }
  if (getLightingGeometrySignature(sources) !== geometrySignature) throw new Error('捕获期间静态几何发生变化，请等待场景稳定后重新烘焙。');
  return { version: 1, jobId, signature, geometrySignature, sceneName: document.name,
    settings: getSceneLightingConfig(document).bake, meshes, ...captureLightingEnvironment(scene, document) };
}
