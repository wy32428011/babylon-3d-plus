/* global window, requestAnimationFrame, document */
import assert from 'node:assert/strict';

/** 用正式 Store 和运行时安排验收夹具，不替代资产加载、材质或保存 IPC。 */
export async function installGlbEditorProbe(page) {
  await page.evaluate(async memoryDiagnostic => {
    const { useEditorStore } = await import('/src/editor/store/editorStore.ts');
    const { SceneRuntime } = await import('/src/runtime/babylon/SceneRuntime.ts');
    const original = SceneRuntime.prototype.sync;
    window.glbSmoke = { store: useEditorStore, runtime: null };
    if (memoryDiagnostic) {
      const { Geometry } = await import('/node_modules/@babylonjs/core/Meshes/geometry.js');
      const generatePoints = Geometry.prototype._generatePointsArray;
      window.glbPointCacheCalls = [];
      Geometry.prototype._generatePointsArray = function (...args) {
        if (!this._positions && this.getTotalVertices() > 10000 && window.glbPointCacheCalls.length < 8) {
          const call = { id: this.id, vertices: this.getTotalVertices(), stack: new Error().stack };
          window.glbPointCacheCalls.push(call); console.log('[glb-point-cache] ' + JSON.stringify(call));
        }
        return generatePoints.apply(this, args);
      };
    }
    SceneRuntime.prototype.sync = function (...args) {
      window.glbSmoke.runtime = this;
      return original.apply(this, args);
    };
    window.__glbScene = () => window.glbSmoke.runtime?.scene ?? null;
    useEditorStore.getState().setGridVisible(false);
  }, Boolean(process.env.GLB_PREVIEW_MEMORY_DIAGNOSTIC));
}

/** 老场景显式使用不同于新预设的照明，便于发现读取时的意外覆盖。 */
export async function createGlbFixture(page, { mode, modelPath, scenePath }) {
  return page.evaluate(async ({ mode, modelPath, scenePath }) => {
    const { createEmptySceneDocument, sanitizeSceneEnvironment, createDefaultSceneEnvironmentTransform } =
      await import('/src/editor/model/SceneDocument.ts');
    const { serializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } = await import('/electron/shared/sceneLightingConfig.ts');
    const scene = createEmptySceneDocument(`GLB 标准预览验收-${mode}`);
    const url = 'editor-asset://local/' + encodeURIComponent(modelPath);
    scene.entityIds = []; scene.entities = {}; scene.selectedEntityId = null;
    scene.mqttConfig = { ...scene.mqttConfig, enabled: false, simulatorEnabled: false };
    scene.sceneSettings.lighting = normalizeSceneLightingConfig({
      main: { enabled: true, color: '#f4e0cc', intensity: .73 },
      fill: { intensity: .19 }, environmentIntensity: .63,
      shadows: { enabled: false }, bake: { enabled: false },
      retainedExtension: { marker: 'existing-scene-must-survive' },
    });
    delete scene.sceneSettings.lighting.environment;
    scene.sceneSettings.appearance = normalizeSceneAppearanceConfig({ exposure: .9, contrast: 1.04, toneMappingEnabled: true });
    if (mode === 'model') {
      const entity = { id: 'glb-exhibition-model', name: '展会 GLB 普通模型', parentId: null, childrenIds: [], visible: true, locked: false,
        components: { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          modelAsset: { assetCode: 'GLB-EXHIBITION-AUDIT', sourcePath: modelPath, sourceUrl: url, lengthUnit: 'meter', unitScaleToMeters: 1 } } };
      scene.entityIds.push(entity.id); scene.entities[entity.id] = entity;
    } else {
      scene.sceneSettings.environment = sanitizeSceneEnvironment({ packagePath: modelPath.replace(/[\\/][^\\/]+$/, ''),
        lengthUnit: 'meter', unitScaleToMeters: 1, placementMode: 'scene-base', transform: createDefaultSceneEnvironmentTransform(),
        visible: true, opacity: 1, activeVariantUrl: url, variants: [{ name: '展会', sourcePath: modelPath, sourceUrl: url }] });
      if (!scene.sceneSettings.environment) throw new Error('环境模型验收夹具无效。');
    }
    const content = serializeScene(scene);
    if (!window.glbSmoke.store.getState().loadSceneFromContent(content, scenePath)) throw new Error('加载 GLB 验收夹具失败。');
    return { content, lighting: scene.sceneSettings.lighting, appearance: scene.sceneSettings.appearance };
  }, { mode, modelPath, scenePath });
}

export async function waitForGlbEditor(page, sandbox = false) {
  await page.waitForFunction(sandbox => {
    const probe = window.glbSmoke;
    if (!probe?.runtime || probe.runtime.getInitialLoadSnapshot().progress.loading) return false;
    const scene = probe.runtime.scene;
    const meshCount = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0).length;
    return meshCount > 2000 && (!sandbox || Boolean(scene.environmentTexture?.isReady()));
  }, sandbox, { timeout: 240_000 });
  await page.getByRole('button', { name: '取消加载并返回首页', exact: true }).waitFor({ state: 'hidden', timeout: 240_000 });
  const closeNotice = page.getByRole('button', { name: '关闭场景资源提示', exact: true });
  if (await closeNotice.isVisible()) {
    const issues = await page.evaluate(() => window.glbSmoke.store.getState().sceneResourceIssues);
    assert.equal(issues?.length ?? 0, 0, JSON.stringify(issues));
    await closeNotice.click();
  }
  await page.evaluate(async () => {
    await window.glbSmoke.runtime.scene.whenReadyAsync();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** 固定模型相对视角，再通过正式相机保存动作写入场景。 */
export async function frameAndSaveGlbCamera(page) {
  const pose = await page.evaluate(() => {
    const scene = window.__glbScene(), camera = scene.activeCamera;
    const meshes = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0
      && !mesh.name.startsWith('Editor') && !mesh.metadata?.editorHelper);
    for (const mesh of meshes) mesh.computeWorldMatrix(true);
    const meshSet = new Set(meshes);
    const bounds = scene.getWorldExtends(mesh => meshSet.has(mesh));
    const target = bounds.min.add(bounds.max).scale(.5), size = bounds.max.subtract(bounds.min);
    camera.setTarget(target, false, false, true); camera.alpha = -.98; camera.beta = 1.185; camera.radius = size.length() * .99;
    camera.minZ = .01; camera.maxZ = Math.max(1000, size.length() * 20);
    camera.inertialAlphaOffset = 0; camera.inertialBetaOffset = 0; camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = 0; camera.inertialPanningY = 0;
    // 与项目相机控制器相同，清除 Babylon 9.12 的新运动状态，避免真实 UI 输入余量覆盖固定取景。
    camera.movement.activeInput = false;
    camera.movement.resetRotationVelocity(); camera.movement.resetPanVelocity(); camera.movement.resetZoomVelocity();
    window.glbSmoke.store.getState().selectEntity(null);
    window.glbSmoke.store.getState().requestCameraPoseSave();
    return { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: { x: target.x, y: target.y, z: target.z } };
  });
  await page.waitForFunction(() => window.glbSmoke.store.getState().cameraPoseSaveRequest === null);
  await page.evaluate(async pose => {
    const camera = window.__glbScene().activeCamera;
    for (let i = 0; i < 6; i++) {
      await new Promise(requestAnimationFrame);
      if (Math.abs(camera.alpha - pose.alpha) > .0001 || Math.abs(camera.beta - pose.beta) > .0001
        || Math.abs(camera.radius - pose.radius) > .0001) throw new Error('固定取景在保存后仍有残余运动。');
    }
  }, pose);
  return pose;
}

export async function applyGlbPresetThroughUi(page, capture, check, afterFirstApply = async () => {}) {
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  const open = async () => {
    await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
    await manager.waitFor({ state: 'visible' });
    await manager.getByRole('tab', { name: '总览与烘焙', exact: true }).click();
    const summary = manager.locator('summary').filter({ hasText: /^场景照明/ });
    if (!await manager.getByRole('combobox', { name: '光照预设', exact: true }).isVisible()) await summary.click();
  };
  const close = async () => {
    await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
    await manager.waitFor({ state: 'hidden' });
  };
  const before = await page.evaluate(() => JSON.stringify(window.glbSmoke.store.getState().scene));
  await open();
  await manager.getByRole('combobox', { name: '光照预设', exact: true }).selectOption('glb-standard-preview');
  assert.equal(await page.evaluate(() => JSON.stringify(window.glbSmoke.store.getState().scene)), before, '选择预设只能暂存草稿');
  await manager.getByRole('combobox', { name: '环境照明来源', exact: true }).scrollIntoViewIfNeeded();
  await capture('preset-draft');
  const originalViewport = page.viewportSize();
  assert.ok(originalViewport, '响应式验收需要已知的原始视口尺寸');
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const environmentControl = manager.getByRole('combobox', { name: '环境照明来源', exact: true });
    await environmentControl.scrollIntoViewIfNeeded();
    const [dialogBounds, controlBounds] = await Promise.all([manager.boundingBox(), environmentControl.boundingBox()]);
    for (const [name, bounds] of [['管理器对话框', dialogBounds], ['环境照明来源', controlBounds]]) {
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1024 && bounds.y + bounds.height <= 768,
        `1024×768 下${name}必须完整位于视口内：${JSON.stringify(bounds)}`);
    }
    await capture('preset-draft-1024');
  } finally {
    await page.setViewportSize(originalViewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  // 大型环境模型的全局材质重编译可能占用首个交互帧；按真实状态与后续像素验收结算。
  { const started = Date.now(); await manager.getByRole('button', { name: '应用配置', exact: true }).click({ timeout: 180_000 });
    check('应用配置完成，操作耗时 ' + (Date.now() - started) + ' ms'); }
  await page.waitForFunction(() => window.glbSmoke.store.getState().scene.sceneSettings.lighting.environment?.source === 'sandbox');
  await waitForGlbEditor(page, true);
  await afterFirstApply();
  await close();
  const applied = await page.evaluate(() => JSON.stringify(window.glbSmoke.store.getState().scene));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(before => JSON.stringify(window.glbSmoke.store.getState().scene) === before, before);
  await waitForGlbEditor(page);
  if (process.env.GLB_PREVIEW_MEMORY_DIAGNOSTIC === '1') await capture('after-undo');
  check('实际 UI 预设只暂存草稿，应用后一次撤销恢复完整场景');
  await open();
  await manager.getByRole('combobox', { name: '光照预设', exact: true }).selectOption('glb-standard-preview');
  // 大型环境模型的全局材质重编译可能占用首个交互帧；按真实状态与后续像素验收结算。
  { const started = Date.now(); await manager.getByRole('button', { name: '应用配置', exact: true }).click({ timeout: 180_000 });
    check('应用配置完成，操作耗时 ' + (Date.now() - started) + ' ms'); }
  await page.waitForFunction(applied => JSON.stringify(window.glbSmoke.store.getState().scene) === applied, applied);
  await close();
  return manager;
}

/** 只记录计数与字节量，不读取或复制顶点数据，区分DOM、JS堆与共享缓冲放大。 */
export function inspectGlbMemory() {
  const scene = window.__glbScene(), geometries = new Set(scene.meshes.map(mesh => mesh.geometry).filter(Boolean));
  const views = new Set(), backing = new Map(), callbacks = new Map();
  let geometryBytes = 0, uniqueViewBytes = 0, uniqueRangeBytes = 0, pointCount = 0, pointCacheCount = 0;
  for (const geometry of geometries) {
    const callback = String(geometry.onGeometryUpdated ?? 'none'); callbacks.set(callback, (callbacks.get(callback) ?? 0) + 1);
    const points = geometry._positions?.length ?? geometry._positionsCache?.length ?? 0;
    pointCount += points; if (points) pointCacheCount++;
    for (const value of [geometry.getVertexBuffer('position')?.getData(), geometry.getIndices()]) {
      if (!value) continue;
      const bytes = value.byteLength ?? value.length * 8; geometryBytes += bytes;
      if (!views.has(value)) { views.add(value); uniqueViewBytes += bytes; }
      if (!ArrayBuffer.isView(value)) continue;
      const ranges = backing.get(value.buffer) ?? new Set();
      const key = Object.prototype.toString.call(value) + '/' + value.byteOffset + '/' + value.byteLength;
      if (!ranges.has(key)) { ranges.add(key); uniqueRangeBytes += value.byteLength; }
      backing.set(value.buffer, ranges);
    }
  }
  return { meshes: scene.meshes.length, geometries: geometries.size, materials: scene.materials.length,
    compiledEffects: Object.keys(scene.getEngine()._compiledEffects ?? {}).length,
    dom: { all: document.getElementsByTagName('*').length, options: document.getElementsByTagName('option').length,
      selects: document.getElementsByTagName('select').length },
    memory: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit } : null,
    geometryBytes, uniqueViewCount: views.size, uniqueViewBytes, uniqueRangeBytes,
    pointCount, pointCacheCount, pointCacheCalls: window.glbPointCacheCalls,
    environmentMeshPointCount: scene.meshes.filter(mesh => mesh.metadata?.editorEnvironmentMesh)
      .reduce((sum, mesh) => sum + (mesh._internalAbstractMeshDataInfo?._positions?.length ?? 0), 0),
    geometryCallbacks: [...callbacks].map(([source, count]) => ({ source: source.slice(0, 700), count })) };
}

/** 同一浏览器函数同时用于编辑器和发布 Viewer，避免两侧检查口径不同。 */
export async function inspectGlbScene() {
  const scene = window.__glbScene();
  if (!scene) return null;
  await scene.whenReadyAsync();
  for (let i = 0; i < 3; i++) { scene.render(); await new Promise(requestAnimationFrame); }
  const meshes = scene.meshes.filter(mesh => mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0
    && !mesh.name.startsWith('Editor') && !mesh.metadata?.editorHelper);
  const materials = [...new Set(meshes.flatMap(mesh => mesh.material?.subMaterials ?? [mesh.material]).filter(Boolean))];
  const materialValues = materials.map(material => ({ color: material.albedoColor?.asArray() ?? null, metallic: material.metallic ?? null,
    roughness: material.roughness ?? null, alpha: material.alpha, unlit: Boolean(material.unlit),
    transparencyMode: material.transparencyMode, textures: material.getActiveTextures().map(texture => ({ width: texture.getSize().width, height: texture.getSize().height, gamma: texture.gammaSpace })).sort((a, b) => a.width - b.width) }))
    .map(value => JSON.stringify(value)).sort();
  const engine = scene.getEngine(), camera = scene.activeCamera, image = scene.imageProcessingConfiguration;
  const meshSet = new Set(meshes), bounds = scene.getWorldExtends(mesh => meshSet.has(mesh));
  const boundsCenter = bounds.min.add(bounds.max).scale(.5).asArray();
  const whiteMaterial = materials.filter(material => material.albedoColor && material.alpha >= .99)
    .sort((a, b) => (b.albedoColor.r + b.albedoColor.g + b.albedoColor.b) - (a.albedoColor.r + a.albedoColor.g + a.albedoColor.b))[0] ?? null;
  const whiteMesh = meshes.find(mesh => mesh.material === whiteMaterial || mesh.material?.subMaterials?.includes(whiteMaterial));
  const whiteEffect = whiteMesh?.subMeshes?.map(sub => sub.effect ?? sub.getEffect?.()).find(Boolean);
  const materialImage = whiteMaterial?.imageProcessingConfiguration;
  const environment = scene.environmentTexture, polynomial = environment?.sphericalPolynomial;
  const reflectionDefines = effect => String(effect?.defines ?? '').split('\n')
    .filter(line => /REFLECTION|SPHERICAL|IMAGEPROCESSING|IRRADIANCE|ENVIRONMENT|RGBD/.test(line));
  const drawWrapperDiagnostics = mesh => mesh ? { name: mesh.name, className: mesh.getClassName(),
    sourceMesh: mesh.sourceMesh?.name ?? mesh._sourceMesh?.name ?? null,
    lightSources: (mesh.lightSources ?? mesh._lightSources ?? []).map(light => ({ name: light.name, id: light.id,
      intensity: light.intensity, enabled: light.isEnabled(), disposed: light.isDisposed() })),
    subMeshes: (mesh.subMeshes ?? []).map((sub, index) => {
      const wrappers = sub._drawWrappers instanceof Map ? [...sub._drawWrappers.entries()] : Object.entries(sub._drawWrappers ?? {});
      return { index, keys: Object.keys(sub).filter(key => /effect|drawWrapper/i.test(key)),
        directEffectDefines: reflectionDefines(sub.effect ?? sub.getEffect?.()),
        wrappers: wrappers.filter(([, wrapper]) => wrapper).map(([key, wrapper]) => ({ key: String(key), keys: Object.keys(wrapper),
          defines: reflectionDefines(wrapper.effect ?? wrapper._effect) })) };
    }) } : null;
  const visibilityCounts = {};
  for (const mesh of meshes) visibilityCounts[String(mesh.visibility)] = (visibilityCounts[String(mesh.visibility)] ?? 0) + 1;
  const processing = configuration => configuration ? { exposure: configuration.exposure, contrast: configuration.contrast,
    toneMappingEnabled: configuration.toneMappingEnabled, applyByPostProcess: configuration.applyByPostProcess, isEnabled: configuration.isEnabled } : null;
  const diagnostics = {
    boundsCenter,
    sceneImage: processing(image), sceneIblIntensity: scene.iblIntensity ?? null, texturesEnabled: scene.texturesEnabled,
    cameraPostProcesses: (camera._postProcesses ?? []).filter(Boolean).map(post => post.name),
    frozenMaterials: { total: materials.length, frozen: materials.filter(material => material.isFrozen).length },
    meshVisibility: visibilityCounts,
    representativeWhiteMaterial: whiteMaterial ? { name: whiteMaterial.name, color: whiteMaterial.albedoColor.asArray(),
      className: whiteMaterial.getClassName(), belongsToScene: whiteMaterial.getScene() === scene,
      materialSceneEnvironmentMatches: whiteMaterial.getScene().environmentTexture === environment,
      imageProcessingUsesScene: materialImage === image, image: processing(materialImage),
      environmentIntensity: whiteMaterial.environmentIntensity ?? null, directIntensity: whiteMaterial.directIntensity ?? null,
      specularIntensity: whiteMaterial.specularIntensity ?? null, emissiveColor: whiteMaterial.emissiveColor?.asArray() ?? null,
      reflectionTexture: whiteMaterial.reflectionTexture?.name ?? null, isFrozen: whiteMaterial.isFrozen,
      mesh: whiteMesh?.name ?? null,
      shaderDefines: reflectionDefines(whiteEffect),
      drawWrappers: drawWrapperDiagnostics(whiteMesh),
      sourceDrawWrappers: drawWrapperDiagnostics(whiteMesh?.sourceMesh ?? whiteMesh?._sourceMesh) } : null,
    environment: environment ? { gammaSpace: environment.gammaSpace,
      isRGBD: environment.isRGBD ?? environment.getInternalTexture()?.isRGBD ?? environment.getInternalTexture()?._isRGBD ?? null,
      level: environment.level, polynomial: polynomial ? { xx: polynomial.xx.asArray(), x: polynomial.x.asArray() } : null } : null,
  };
  // 读回紧接正式 draw，兼容 preserveDrawingBuffer=false 的编辑器。
  scene.render();
  const pixels = await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight());
  const histogram = Array(32).fill(0); let luminance = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const value = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
    luminance += value; histogram[Math.min(31, Math.floor(value / 8))]++;
  }
  return { ready: scene.isReady(), meshCount: meshes.length, materialCount: materials.length, materialValues,
    viewport: { width: engine.getRenderWidth(), height: engine.getRenderHeight() },
    camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.asArray() },
    environment: scene.environmentTexture ? { name: scene.environmentTexture.name, ready: scene.environmentTexture.isReady(),
      rotationY: scene.environmentTexture.rotationY, size: scene.environmentTexture.getSize(), intensity: scene.environmentIntensity } : null,
    image: { exposure: image.exposure, contrast: image.contrast, toneMappingEnabled: image.toneMappingEnabled },
    lights: scene.lights.filter(light => light.isEnabled() && light.intensity > 0).map(light => ({ name: light.name, intensity: light.intensity })),
    gpu: engine.getGlInfo(), contextLost: engine._gl.isContextLost(), diagnostics,
    pixels: { count: pixels.length / 4, meanLuminance: luminance / (pixels.length / 4), histogram } };
}

/** 仅对本次临时工程运行；对照显式反射绑定与全量 shader 刷新，不构成正式验收。 */
export async function runGlbShaderDiagnostic(page, capture) {
  const report = { status: 'DIAGNOSTIC', baseline: await page.evaluate(inspectGlbScene) };
  report.sourceMaterials = await page.evaluate(() => {
    const scene = window.__glbScene();
    const byMaterial = new Map();
    const add = (material, effect) => {
      if (!material?.albedoColor) return;
      let entry = byMaterial.get(material.uniqueId);
      if (!entry) {
        entry = { name: material.name, id: material.uniqueId, className: material.getClassName(),
          belongsToScene: material.getScene() === scene, sceneEnvironmentMatches: material.getScene().environmentTexture === scene.environmentTexture,
          actualDefines: new Set() };
        byMaterial.set(material.uniqueId, entry);
      }
      const defines = String(effect?.defines ?? '').split('\n')
        .filter(line => /REFLECTION|SPHERICAL|IMAGEPROCESSING|IRRADIANCE|ENVIRONMENT|RGBD/.test(line)).join('\n');
      if (defines) entry.actualDefines.add(defines);
    };
    for (const mesh of scene.meshes) {
      const source = mesh.sourceMesh ?? mesh._sourceMesh;
      for (const candidate of source ? [mesh, source] : [mesh]) {
        const materials = candidate.material?.subMaterials ?? [candidate.material];
        for (const material of materials) {
          add(material, material?.getEffect?.());
          for (const sub of candidate.subMeshes ?? []) {
            add(material, sub.effect ?? sub.getEffect?.());
            const wrappers = sub._drawWrappers instanceof Map ? [...sub._drawWrappers.values()] : Object.values(sub._drawWrappers ?? {});
            for (const wrapper of wrappers) add(material, wrapper?.effect ?? wrapper?._effect);
          }
        }
      }
    }
    window.__glbDiagnosticMaterials = [...new Set(scene.materials.filter(material => material.albedoColor))]
      .map(material => ({ material, reflectionTexture: material.reflectionTexture, frozen: material.isFrozen }));
    return [...byMaterial.values()].map(entry => ({ ...entry, actualDefines: [...entry.actualDefines] }));
  });
  try {
    await page.evaluate(() => {
      const scene = window.__glbScene();
      for (const { material } of window.__glbDiagnosticMaterials) {
        material.unfreeze(); material.reflectionTexture = scene.environmentTexture; material.markDirty(true);
      }
    });
    report.explicitReflection = await page.evaluate(inspectGlbScene);
    await capture('diagnostic-explicit-reflection');
    await page.evaluate(() => {
      for (const { material, reflectionTexture } of window.__glbDiagnosticMaterials) {
        material.reflectionTexture = reflectionTexture; material.markDirty(true);
      }
      window.__glbScene().markAllMaterialsAsDirty(63);
    });
    report.refreshedSceneFallback = await page.evaluate(inspectGlbScene);
    await capture('diagnostic-refreshed-fallback');
  } finally {
    await page.evaluate(() => {
      for (const { material, reflectionTexture, frozen } of window.__glbDiagnosticMaterials ?? []) {
        material.reflectionTexture = reflectionTexture; material.markDirty(true);
        if (frozen) material.freeze();
      }
      delete window.__glbDiagnosticMaterials;
    });
  }
  return report;
}

export function assertGlbStandardSnapshot(snapshot) {
  assert.ok(snapshot?.ready && snapshot.environment?.ready, '实际模型与内置环境纹理必须已加载');
  assert.ok(snapshot.meshCount > 2000 && snapshot.materialCount >= 226, JSON.stringify({ meshes: snapshot.meshCount, materials: snapshot.materialCount }));
  assert.equal(snapshot.environment.intensity, 1);
  assert.ok(Math.abs(snapshot.environment.rotationY - 5.54) < .00001);
  assert.deepEqual(snapshot.image, { exposure: 1, contrast: 1, toneMappingEnabled: false });
  assert.deepEqual(snapshot.lights, []);
  const material = snapshot.diagnostics?.representativeWhiteMaterial;
  const actualDefines = [...(material?.shaderDefines ?? []), ...[material?.drawWrappers, material?.sourceDrawWrappers]
    .flatMap(mesh => (mesh?.subMeshes ?? []).flatMap(sub => [...sub.directEffectDefines, ...sub.wrappers.flatMap(wrapper => wrapper.defines)]))];
  assert.ok(actualDefines.some(line => /^#define REFLECTION(?:\s|$)/.test(line)), '实际自身或实例源 shader 必须启用 REFLECTION');
  assert.ok(actualDefines.some(line => /^#define USESPHERICALFROMREFLECTIONMAP(?:\s|$)/.test(line)), '实际自身或实例源 shader 必须使用环境球谐漫反射');
  assert.equal(snapshot.contextLost, false);
  assert.doesNotMatch(snapshot.gpu.renderer, /swiftshader|llvmpipe|software/i, '必须使用实际硬件 WebGL');
  assert.ok(snapshot.pixels.histogram.filter(count => count > 0).length > 15, '实际帧不能为空白或只有背景');
}

export function assertGlbSnapshotPreserved(before, after) {
  assertGlbStandardSnapshot(after);
  assert.equal(after.meshCount, before.meshCount, '保存、重开或发布不能丢失网格');
  assert.equal(after.materialCount, before.materialCount, '保存、重开或发布不能丢失材质');
  assert.deepEqual(after.materialValues, before.materialValues, '保存、重开或发布不能改变原始 GLB 材质');
  for (const key of ['alpha', 'beta', 'radius']) assert.ok(Math.abs(after.camera[key] - before.camera[key]) < .0001, `相机 ${key} 必须保存`);
  after.camera.target.forEach((value, index) => assert.ok(Math.abs(value - before.camera.target[index]) < .0001, '相机 target 必须保存'));
  assert.deepEqual(after.viewport, before.viewport, '像素对照必须使用相同的实际渲染尺寸');
  assert.equal(after.pixels.count, before.pixels.count, '像素对照的读回数量必须一致');
  assert.ok(before.pixels.count > 0 && before.pixels.histogram.length === 32 && after.pixels.histogram.length === 32, '必须有完整的实际帧读回');
  const meanDifference = Math.abs(after.pixels.meanLuminance - before.pixels.meanLuminance);
  const histogramL1 = before.pixels.histogram.reduce((sum, count, index) => sum
    + Math.abs(count / before.pixels.count - after.pixels.histogram[index] / after.pixels.count), 0);
  // 同一 GPU、相机和尺寸下允许栅格化/透明边缘的微差；整体照明漂移必须导致验收失败。
  // meanLuminance 的单位是 0–255，门限 1 即一个 8 位亮度等级；直方图按像素总量归一化。
  assert.ok(Number.isFinite(meanDifference) && meanDifference <= 1,
    `保存、重开或发布后平均亮度差必须 <= 1/255：${meanDifference}；before=${before.pixels.meanLuminance}，after=${after.pixels.meanLuminance}`);
  assert.ok(Number.isFinite(histogramL1) && histogramL1 <= .02,
    `保存、重开或发布后归一化亮度直方图 L1 必须 <= 0.02：${histogramL1}`);
}
