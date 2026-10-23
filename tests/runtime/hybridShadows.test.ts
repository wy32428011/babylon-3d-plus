import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectionalLight, DynamicTexture, FreeCamera, Material, MeshBuilder, MorphTargetManager, MultiMaterial, NullEngine, PBRMaterial, PointLight,
  Scene, Skeleton, SpotLight, SubMesh, TransformNode, Vector3, VertexBuffer,
} from '@babylonjs/core';
import { SceneShadowRuntime } from '../../src/runtime/babylon/SceneShadowRuntime.ts';
import { HybridShadowMeshState } from '../../src/runtime/babylon/HybridShadowCache.ts';

const settings = {
  enabled: true, mode: 'hybrid' as const, quality: 'balanced' as const,
  darkness: 0, catcherEnabled: false, sunAzimuthDegrees: 56, sunElevationDegrees: 63,
  sunIntensity: 1.05, distanceMeters: 80, bias: 0.002, normalBias: 0.03,
  fillIntensity: 0.2, iblIntensityMax: 0.45,
};
const staticRole = { mobility: 'static' as const, castShadows: true, receiveShadows: true };
const dynamicRole = { ...staticRole, mobility: 'dynamic' as const };

test('候选过滤的原件仍可查询且保持标志，所有受控阴影只绘制接管批次并能恢复', () => {
  const f = fixture(), runtime = new SceneShadowRuntime(f.scene);
  const sun = new DirectionalLight('sun', new Vector3(-1, -2, 1), f.scene);
  const point = new PointLight('point', new Vector3(0, 6, 0), f.scene);
  const carrier = MeshBuilder.CreateBox('carrier', { size: 2 }, f.scene);
  carrier.material = f.material;
  const roles = new Map([...f.roles, [carrier, dynamicRole]]);
  try {
    runtime.setHybridMeshRoles(roles); runtime.applySettings(settings);
    runtime.syncLight('sun', sun); runtime.syncLight('point', point);
    f.fixed.receiveShadows = false;
    const before = { material: f.fixed.material, parent: f.fixed.parent, layerMask: f.fixed.layerMask,
      geometry: f.fixed.geometry, visible: f.fixed.isVisible, enabled: f.fixed.isEnabled() };
    runtime.setRenderSuppressedMeshes([f.fixed]);
    assert.ok(f.scene.meshes.includes(f.fixed)); assert.equal(f.fixed.receiveShadows, false);
    assert.ok(runtime.getManagedRenderTargets().size >= 2, '主光和局部光都已建立实际阴影目标');
    assert.equal((runtime as unknown as { hybridMeshState: HybridShadowMeshState }).hybridMeshState.staticMeshes.has(f.fixed), false,
      '抑制也必须使静态缓存的caster集合失效，不能继续复制旧阴影');
    for (const target of runtime.getManagedRenderTargets()) {
      if (target.renderList) { assert.ok(!target.renderList.includes(f.fixed)); assert.ok(target.renderList.includes(carrier)); }
    }
    const later = new SpotLight('later', new Vector3(0, 8, 0), Vector3.Down(), Math.PI / 3, 2, f.scene);
    runtime.syncLight('later', later);
    assert.ok(!later.getShadowGenerator()!.getShadowMap()!.renderList!.includes(f.fixed), '后创建的阴影目标同样排除原件');
    assert.deepEqual({ material: f.fixed.material, parent: f.fixed.parent, layerMask: f.fixed.layerMask,
      geometry: f.fixed.geometry, visible: f.fixed.isVisible, enabled: f.fixed.isEnabled() }, before);
    assert.equal(f.fixed.receiveShadows, false, '抑制只改变实际caster列表，不改原件受光标志');
    runtime.setRenderSuppressedMeshes([]);
    assert.ok(later.getShadowGenerator()!.getShadowMap()!.renderList!.includes(f.fixed));
    assert.equal(f.fixed.receiveShadows, true, '恢复后重新应用当前业务光照角色');
  } finally { runtime.dispose(); f.scene.dispose(); f.engine.dispose(); }
});

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera('camera', new Vector3(0, 10, -15), scene);
  camera.setTarget(Vector3.Zero());
  const floor = MeshBuilder.CreateGround('floor', { width: 30, height: 30, updatable: true }, scene);
  floor.metadata = { editorEnvironmentMesh: true };
  const fixed = MeshBuilder.CreateBox('fixed', { size: 2 }, scene);
  fixed.position.set(-3, 2, 0);
  const moving = MeshBuilder.CreateBox('moving', { size: 2 }, scene);
  moving.position.set(3, 2, 0);
  const material = new PBRMaterial('physical', scene);
  for (const mesh of [floor, fixed, moving]) mesh.material = material;
  const roles = new Map([[floor, staticRole], [fixed, staticRole], [moving, dynamicRole]]);
  return { engine, scene, floor, fixed, moving, material, roles };
}

test('静态缓存仅因静态变换、几何及可见性变化失效，动态运动不污染静态版本', () => {
  const f = fixture();
  const state = new HybridShadowMeshState();
  try {
    state.setMeshes([f.floor, f.fixed, f.moving], f.roles);
    state.refresh();
    const initial = state.revision;
    f.moving.position.x += 2;
    state.refresh();
    assert.equal(state.revision, initial);
    f.fixed.position.y += 1;
    state.refresh();
    assert.ok(state.revision > initial);
    const moved = state.revision;
    const positions = f.floor.getVerticesData(VertexBuffer.PositionKind)!;
    positions[1] = 0.5;
    f.floor.updateVerticesData(VertexBuffer.PositionKind, positions);
    state.refresh();
    assert.ok(state.revision > moved, '原地更新顶点也必须失效');
    const reshaped = state.revision;
    f.fixed.isVisible = false;
    state.refresh();
    assert.ok(state.revision > reshaped);
    const hidden = state.revision;
    f.fixed.renderingGroupId = 1; state.refresh();
    assert.ok(state.revision > hidden, '静态投射物切换原生绘制组必须更新缓存拓扑');
    assert.equal(state.staticMeshes.size, 2);
    assert.equal(state.dynamicMeshes.size, 1);
  } finally { state.dispose(); f.scene.dispose(); f.engine.dispose(); }
});

test('opaque动态贴图不影响深度缓存，真正的alpha裁剪和子材质更新仍使缓存失效', () => {
  const f = fixture(), state = new HybridShadowMeshState();
  const canvas = { width: 2, height: 2, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const texture = new DynamicTexture('dynamic-business-display', canvas, f.scene, false);
  const masked = new PBRMaterial('masked-child', f.scene);
  const multi = new MultiMaterial('sub-materials', f.scene);
  try {
    texture.hasAlpha = false; masked.albedoTexture = texture;
    multi.subMaterials = [f.material, masked];
    f.fixed.material = multi; f.fixed.releaseSubMeshes();
    new SubMesh(0, 0, f.fixed.getTotalVertices(), 0, 18, f.fixed);
    new SubMesh(1, 0, f.fixed.getTotalVertices(), 18, 18, f.fixed);
    state.setMeshes([f.floor, f.fixed, f.moving], f.roles); state.refresh();
    const opaqueRevision = state.revision;
    f.scene.render(); state.refresh();
    f.scene.render(); state.refresh();
    assert.equal(state.revision, opaqueRevision, '未参与alpha采样的DynamicTexture不能按frameId失效');
    texture.hasAlpha = true; masked.transparencyMode = Material.MATERIAL_ALPHATEST;
    state.refresh();
    assert.ok(state.revision > opaqueRevision, '子材质进入alpha-test路径必须失效');
    const alphaRevision = state.revision;
    f.scene.render(); state.refresh();
    assert.ok(state.revision > alphaRevision, '真实动态alpha保持逐帧有效');
    texture.hasAlpha = false; masked.transparencyMode = Material.MATERIAL_OPAQUE;
    state.refresh(); const restoredOpaque = state.revision;
    texture.uOffset = 0.5; f.scene.render(); state.refresh();
    assert.equal(state.revision, restoredOpaque, 'opaque路径的UV变化只影响颜色，不改变阴影形状');
    texture.hasAlpha = true; masked.transparencyMode = Material.MATERIAL_ALPHATEST;
    state.refresh(); const beforeCutoff = state.revision;
    masked.alphaCutOff = 0.3; state.refresh();
    assert.ok(state.revision > beforeCutoff, '子材质cutoff变化必须失效');
  } finally { state.dispose(); f.scene.dispose(); f.engine.dispose(); }
});

test('未知网格视为动态；混合静态/动态实例批次不能把运动实例写入静态缓存', () => {
  const f = fixture();
  const state = new HybridShadowMeshState();
  const instance = f.fixed.createInstance('instance');
  try {
    state.setMeshes([f.floor, f.fixed, f.moving, instance], f.roles);
    state.refresh();
    assert.equal(state.isStatic(f.floor), true);
    assert.equal(state.isStatic(instance), false);
    assert.equal(state.isStatic(f.fixed), false, '同一原生实例批次必须走动态路径');
  } finally { state.dispose(); f.scene.dispose(); f.engine.dispose(); }
});

test('静态父节点移动、替换几何回调和骨骼/morph 批次都有明确的缓存更新路径', () => {
  const f = fixture(), state = new HybridShadowMeshState();
  const parent = new TransformNode('parent', f.scene);
  f.fixed.parent = parent;
  try {
    state.setMeshes([f.floor, f.fixed, f.moving], f.roles);
    state.refresh();
    const initial = state.revision;
    parent.position.z = 3;
    state.refresh();
    assert.ok(state.revision > initial, '父级变化必须更新静态世界矩阵');
    const existingCallback = f.floor.geometry!.onGeometryUpdated;
    let called = 0;
    f.floor.geometry!.onGeometryUpdated = (geometry, kind) => { called++; existingCallback?.(geometry, kind); };
    state.refresh();
    const beforeEdit = state.revision;
    const positions = f.floor.getVerticesData(VertexBuffer.PositionKind)!;
    positions[1] += 1;
    f.floor.updateVerticesData(VertexBuffer.PositionKind, positions);
    state.refresh();
    assert.equal(called, 1, '保留后续注册的回调且不能递归调用旧包装');
    assert.ok(state.revision > beforeEdit);
    f.fixed.skeleton = new Skeleton('skeleton', 'skeleton', f.scene);
    f.floor.morphTargetManager = new MorphTargetManager(f.scene);
    state.setMeshes([f.floor, f.fixed, f.moving], f.roles);
    assert.equal(state.isStatic(f.fixed), false, '骨骼姿态必须逐帧渲染');
    assert.equal(state.isStatic(f.floor), false, 'morph 姿态必须逐帧渲染');
  } finally { state.dispose(); f.scene.dispose(); f.engine.dispose(); }
});

test('hybrid 的静态/动态都投射及接收，楼板是投射物且所有灯都有生成器', () => {
  const f = fixture(), runtime = new SceneShadowRuntime(f.scene);
  const sun = new DirectionalLight('sun', new Vector3(-1, -2, 1), f.scene);
  const secondSun = new DirectionalLight('secondSun', new Vector3(1, -3, 0), f.scene);
  const point = new PointLight('point', new Vector3(0, 6, 0), f.scene);
  const otherPoint = new PointLight('otherPoint', new Vector3(4, 6, 0), f.scene);
  const spot = new SpotLight('spot', new Vector3(0, 8, 0), Vector3.Down(), Math.PI / 3, 2, f.scene);
  try {
    runtime.setHybridMeshRoles(f.roles);
    runtime.applySettings(settings);
    for (const light of [sun, secondSun, point, otherPoint, spot]) runtime.syncLight(light.name, light);
    f.scene.onBeforeRenderObservable.notifyObservers(f.scene);
    for (const light of [sun, secondSun, point, otherPoint, spot]) {
      const generator = light.getShadowGenerator(f.scene.activeCamera) ?? light.getShadowGenerator();
      assert.ok(generator, light.name + ' 必须有阴影生成器');
      const casters = generator.getShadowMap()!.renderList!;
      for (const mesh of [f.floor, f.fixed, f.moving]) {
        assert.ok(casters.includes(mesh), mesh.name + ' 必须真实写入深度');
        assert.equal(mesh.receiveShadows, true);
      }
    }
    assert.ok(f.material.maxSimultaneousLights >= f.scene.lights.filter(light => light.isEnabled()).length);
    runtime.setHybridMeshRoles(f.roles, { dynamicShadows: false });
    assert.equal(point.getShadowGenerator()!.getShadowMap()!.renderList!.includes(f.moving), false);
    assert.equal(f.moving.receiveShadows, true, '关闭动态投射仍接收静态投影');
    runtime.setHybridMeshRoles(new Map([...f.roles, [f.fixed, { ...staticRole, receiveShadows: false }]]));
    assert.equal(f.fixed.receiveShadows, false);
    assert.equal(point.getShadowGenerator()!.getShadowMap()!.renderList!.includes(f.fixed), true);
    runtime.applySettings({ ...settings, enabled: false });
    assert.equal(runtime.getHybridMetrics().textureBytes, 0);
    assert.equal(f.material.maxSimultaneousLights, 5, '关闭投影不能静默削减 hybrid 的直接灯数量');
    runtime.applySettings(settings);
    runtime.removeLight('sun');
    sun.dispose();
    assert.ok(secondSun.getShadowGenerator(), '从次方向灯接管主方向灯不能误删新生成器');
    runtime.applySettings({ ...settings, quality: 'quality' });
    assert.ok(point.getShadowGenerator());
    runtime.dispose();
    assert.equal(point.getShadowGenerator(), null);
    assert.equal(secondSun.getShadowGenerator(), null);
    assert.equal(f.material.maxSimultaneousLights, 4);
    assert.equal(runtime.getHybridMetrics().textureBytes, 0);
  } finally { runtime.dispose(); f.scene.dispose(); f.engine.dispose(); }
});
