/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict';
import { migrateSceneLightingDocument } from '../../dist-electron/shared/sceneLightingConfig.js';
import { assertLightingFactoryResumeEvidence, prepareLightingFactorySceneForPerformance } from './lightingFactoryGiPerformance.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function waitForFactoryReady(page) {
  await page.waitForFunction(() => {
    const { runtime, store } = window.lightingSmoke;
    if (!runtime || runtime.getInitialLoadSnapshot().progress.loading) return false;
    const loadError = runtime.getInitialLoadSnapshot().error;
    if (loadError) throw new Error('真实工厂模型载入失败：' + loadError);
    if (window.lightingSmoke.preparation?.isScenePreparationActive()) return false;
    const env = runtime.environment.environmentRuntime.getSnapshot();
    if (env.phase === 'error') throw new Error('真实工厂环境载入失败：' + env.message);
    const settings = store.getState().scene.sceneSettings.environment;
    const expectsEnvironment = Boolean(settings?.packagePath && settings.visible !== false);
    return (!expectsEnvironment || (env.phase === 'ready' && !env.error && runtime.environment.environmentRuntime.getLightingSurfaces().length > 0))
      && runtime.scene.isReady();
  }, null, { timeout: 600_000 });
}

/** 仅在失效诊断时读取；不在性能采样窗口中额外遍历场景。 */
async function cacheDiagnostics(page) {
  return page.evaluate(async () => {
    const runtime = window.lightingSmoke.runtime;
    const capture = () => [...runtime.environment.shadowRuntime.hybridCaches.entries()].map(([generator, cache]) => ({
      light: generator.getLight().name, cacheRevision: cache.revision, stateRevision: cache.state.revision,
      metrics: { ...cache.metrics }, faces: [...cache.faces].map(([index, face]) => ({ index, signature: face.signature })),
      signatures: [...cache.state.signatures].map(([mesh, signature]) => ({ id: mesh.uniqueId, name: mesh.name, signature })),
      dynamicTextures: [...cache.state.staticMeshes].flatMap(mesh => {
        const materials = mesh.material?.subMaterials ?? [mesh.material];
        return materials.filter(Boolean).flatMap(material => {
          const texture = material.getAlphaTestTexture?.();
          return texture?.getClassName() === 'DynamicTexture' ? [{ mesh: mesh.name, id: mesh.uniqueId, material: material.name,
            alphaTesting: material.needAlphaTestingForMesh?.(mesh) ?? material.needAlphaTesting?.(),
            alphaBlending: material.needAlphaBlendingForMesh?.(mesh), texture: texture.name, textureReady: texture.isReady(),
            geometryVersion: cache.state.geometries.get(mesh.geometry)?.version }] : [];
        });
      }),
    }));
    const before = capture();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = capture();
    return after.map((entry, index) => {
      const previous = new Map((before[index]?.signatures ?? []).map(item => [item.id, item]));
      const changed = entry.signatures.filter(item => previous.get(item.id)?.signature !== item.signature);
      return { ...entry, signatures: undefined, previousRevision: before[index]?.stateRevision,
        changedCount: changed.length, changedMeshes: changed.slice(0, 12).map(item => {
          const old = previous.get(item.id)?.signature.split(',') ?? [], current = item.signature.split(',');
          return { id: item.id, name: item.name, changes: current.flatMap((value, field) => value === old[field] ? [] : [{ field, before: old[field], after: value }]) };
        }) };
    });
  });
}

async function readGpuProcessMemory(application) {
  const pids = await application.evaluate(({ app }) => app.getAppMetrics().filter(p => p.type === 'GPU').map(p => p.pid));
  assert.ok(pids.length && pids.every(Number.isSafeInteger), '需要本次 Electron 的 GPU 进程 PID');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -match '^pid_(?:${pids.join('|')})_' } | Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted | ConvertTo-Json -Compress`;
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 60_000 });
  const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  const counters = Array.isArray(value) ? value : [value];
  assert.ok(counters.length, 'Windows 必须返回本次 GPU 进程的真实内存计数');
  return { pids, counters, dedicatedBytes: counters.reduce((n, c) => n + Number(c.DedicatedUsage), 0),
    sharedBytes: counters.reduce((n, c) => n + Number(c.SharedUsage), 0),
    committedBytes: counters.reduce((n, c) => n + Number(c.TotalCommitted), 0) };
}

/** 原工程只读；临时副本保留实际模型/几何和视角，隔离外部服务后做 A/B/B/A 对照。 */
export async function runLightingFactoryPerformance({ application, page, sourceScenePath, projectRoot, output, profile = false, measureGi, resumeScenePath = process.env.LIGHTING_FACTORY_GI_RESUME_SCENE || null }) {
  const originalBytes = await readFile(sourceScenePath);
  const sourceHash = createHash('sha256').update(originalBytes).digest('hex');
  const originalContent = JSON.parse(originalBytes.toString('utf8'));
  const resumePath = resumeScenePath ? path.resolve(resumeScenePath) : null;
  let loadedContent = originalContent, resumeEvidence = null, resumeBytes = null, resumeSource = null;
  if (resumePath) {
    assert.equal(typeof measureGi, 'function', '恢复已有GI只能使用GI专项性能验收');
    resumeBytes = await readFile(resumePath); loadedContent = JSON.parse(resumeBytes.toString('utf8'));
    const resumeProjectRoot = path.dirname(path.dirname(resumePath)), proofPath = path.join(resumeProjectRoot, 'replay-report.json');
    const proofBytes = await readFile(proofPath); resumeEvidence = JSON.parse(proofBytes.toString('utf8'));
    assertLightingFactoryResumeEvidence(resumeEvidence, loadedContent.scene?.sceneSettings?.lighting?.result, sourceHash);
    assert.equal(path.resolve(resumeEvidence.bakedScenePath), resumePath, '恢复场景必须是重放报告实际产出的文件');
    assert.deepEqual([...loadedContent.scene.entityIds].sort(), [...originalContent.scene.entityIds].sort(), '恢复GI不能增删原工厂实体');
    resumeSource = { scenePath: resumePath, projectRoot: resumeProjectRoot,
      sceneSha256: createHash('sha256').update(resumeBytes).digest('hex'), proofPath, proofSha256: createHash('sha256').update(proofBytes).digest('hex'),
      inputSignature: resumeEvidence.inputSignature, geometrySignature: resumeEvidence.geometrySignature,
      expectedStaticMeshCount: resumeEvidence.expectedStaticMeshCount, expectedReceiverCount: resumeEvidence.expectedReceiverCount,
      expectedTriangleCount: resumeEvidence.expectedTriangleCount,
      sourceFiles: {
        original: { path: resumeEvidence.originalSourceScenePath ?? sourceScenePath,
          sha256Before: resumeEvidence.originalSourceSceneSha256Before ?? resumeEvidence.sourceSceneSha256Before,
          sha256After: resumeEvidence.originalSourceSceneSha256After ?? resumeEvidence.sourceSceneSha256After },
        captured: { path: resumeEvidence.sourceScenePath, sha256Before: resumeEvidence.sourceSceneSha256Before, sha256After: resumeEvidence.sourceSceneSha256After },
      },
      physicalSignatures: { captured: resumeEvidence.sceneSignature, compiledCaptured: resumeEvidence.compiledSignature,
        original: resumeEvidence.originalSceneSignature, compiledOriginal: resumeEvidence.originalCompiledSignature } };
  } else {
    loadedContent.scene = migrateSceneLightingDocument(loadedContent.scene); loadedContent.version = 6;
  }
  const content = prepareLightingFactorySceneForPerformance(loadedContent, { resume: Boolean(resumePath) });
  const sourceProjectRoot = path.dirname(path.dirname(sourceScenePath));
  const result = { sourceScenePath, sourceSha256: sourceHash, sourceEntityCount: originalContent.scene.entityIds.length, ...(resumeSource ? { resumeSource } : {}),
    scope: measureGi ? '实际完整工厂、固定视角；隔离外部遥测/HTTP，仅放行固定版本解码器。GI由正式engine全输入生成或经完整重放证据恢复，必须等待Runtime实际绑定后比较探针算法；Windows GPU内存是整个进程。' : '实际工厂模型、固定视角；停用外部遥测并阻断远程业务大屏/HTTP，保留屏幕占位；仅放行Babylon固定版本解码依赖，全部模型就绪后才采样。GI关闭，仅比较实时与混合静态阴影缓存。Windows GPU进程内存包含该进程全部资源。', samples: [], externalRequestsBlocked: [], decoderRequestsAllowed: [] };
  const externalHttp = /^https?:\/\//;
  const isolateExternalRequest = async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue();
    // 实际工厂含 Draco 压缩 glTF；解码器是固定版本技术依赖，不能将加载失败的占位模型用于对照。
    if (url.origin === 'https://cdn.babylonjs.com'
      && /^\/v9\.12\.0\/(?:draco_wasm_wrapper_gltf\.js|draco_decoder_gltf\.(?:wasm|js))$/.test(url.pathname)) {
      result.decoderRequestsAllowed.push(url.origin + url.pathname);
      return route.continue();
    }
    // 外部大屏仍保留在场景中，但不允许其服务响应或脚本活动污染四段采样。
    result.externalRequestsBlocked.push({ method: route.request().method(), url: url.origin + url.pathname,
      resourceType: route.request().resourceType() });
    await route.abort('blockedbyclient');
  };
  await page.route(externalHttp, isolateExternalRequest);
  const sceneCopyPath = resumePath ?? path.join(projectRoot, 'Scenes', 'factory-readonly-copy.scene.json');
  result.sceneCopyPath = sceneCopyPath;
  if (!resumePath) await writeFile(sceneCopyPath, JSON.stringify(content), 'utf8');
  const authorizedRoots = [...new Set([sourceProjectRoot, ...(resumeSource ? [resumeSource.projectRoot] : [])])];
  await application.evaluate((_electron, roots) => {
    for (const root of roots) globalThis.lightingSmokeMain.registry.authorizeAssetRoot(root);
  }, authorizedRoots);
  await page.evaluate(({ content, scenePath }) => {
    const store = window.lightingSmoke.store;
    store.getState().stopRuntimePreview();
    if (!store.getState().loadSceneFromContent(content, scenePath)) throw new Error('实际工厂场景无法读取');
  }, { content: JSON.stringify(content), scenePath: sceneCopyPath });
  console.log(`[lighting-factory] 正在加载实际 ${result.sourceEntityCount} 实体和完整环境，等待真实材质就绪`);
  await waitForFactoryReady(page);
  await page.getByRole('button', { name: '取消加载并返回首页', exact: true }).waitFor({ state: 'hidden', timeout: 600_000 });
  const closeNotice = page.getByRole('button', { name: '关闭场景资源提示', exact: true });
  if (await closeNotice.isVisible()) {
    result.resourceNotice = await page.getByRole('complementary', { name: '场景资源状态', exact: true }).innerText();
    await closeNotice.click();
  }
  result.loaded = await page.evaluate(() => {
    const { runtime } = window.lightingSmoke;
    const scene = runtime.scene;
    return { initialLoad: runtime.getInitialLoadSnapshot(), environment: runtime.environment.environmentRuntime.getSnapshot(),
      environmentSurfaceCount: runtime.environment.environmentRuntime.getLightingSurfaces().length,
      classification: runtime.getLightingClassification().reduce((a, e) => {
      a[e.mobility]++; return a;
    }, { static: 0, dynamic: 0 }), meshCount: scene.meshes.length, materialCount: scene.materials.length,
    webgl: scene.getEngine().getGlInfo(), viewport: [scene.getEngine().getRenderWidth(), scene.getEngine().getRenderHeight()] };
  });
  assert.equal(result.loaded.initialLoad.error, null, '工厂资产加载失败时不得把替代几何当作真实完整样本');
  console.log(`[lighting-factory] 实际 ${result.sourceEntityCount} 实体已加载，${result.loaded.meshCount} 渲染网格`);
  const nativeWindow = await application.browserWindow(page);
  const originalOnTop = await nativeWindow.evaluate(window => window.isAlwaysOnTop());
  const readWindowState = () => nativeWindow.evaluate(window => ({ visible: window.isVisible(), minimized: window.isMinimized(),
    focused: window.isFocused(), webContentsFocused: window.webContents.isFocused(),
    backgroundThrottling: window.webContents.getBackgroundThrottling() }));
  const focusWindow = async () => {
    await nativeWindow.evaluate(window => {
      if (window.isMinimized()) window.restore();
      window.show(); window.setAlwaysOnTop(true); window.focus(); window.webContents.focus();
    });
    await page.bringToFront();
    return readWindowState();
  };
  if (measureGi) {
    try {
      return await measureGi({ application, page, result, output, focusWindow, readWindowState,
        readGpuMemory: () => readGpuProcessMemory(application), waitForReady: () => waitForFactoryReady(page), resumeScenePath: resumePath, resumeEvidence });
    } finally {
      try {
        result.sourceUnchanged = createHash('sha256').update(await readFile(sourceScenePath)).digest('hex') === sourceHash;
        if (resumeSource) result.resumeSourceUnchanged = createHash('sha256').update(await readFile(resumePath)).digest('hex') === resumeSource.sceneSha256;
        await writeFile(path.join(output, 'factory-gi-performance.json'), JSON.stringify(result, null, 2));
        assert.equal(result.sourceUnchanged, true, '原始工厂场景必须保持逐字节不变');
        if (resumeSource) assert.equal(result.resumeSourceUnchanged, true, '恢复场景必须保持逐字节不变');
      } finally {
        await nativeWindow.evaluate((window, onTop) => window.setAlwaysOnTop(onTop), originalOnTop);
        await page.unroute(externalHttp, isolateExternalRequest);
      }
    }
  }
  if (profile) {
    const { runLightingFactoryProfile } = await import('./lightingFactoryProfile.mjs');
    try {
      return await runLightingFactoryProfile({ application, page, result, output, focusWindow, readWindowState,
        readGpuMemory: () => readGpuProcessMemory(application), waitForReady: () => waitForFactoryReady(page) });
    } finally {
      await nativeWindow.evaluate((window, onTop) => window.setAlwaysOnTop(onTop), originalOnTop);
      await page.unroute(externalHttp, isolateExternalRequest);
    }
  }
  for (const [index, mode] of ['uncached', 'cached', 'cached', 'uncached'].entries()) {
    let nativeBefore = await focusWindow();
    await page.evaluate(async mode => {
      const { runtime, store } = window.lightingSmoke;
      const scene = store.getState().scene;
      store.setState({ scene: { ...scene, sceneSettings: { ...scene.sceneSettings, lighting: { ...scene.sceneSettings.lighting,
        bake: { ...scene.sceneSettings.lighting.bake, cacheStaticShadows: mode === 'cached' } } } } });
      runtime.syncDocument(store.getState().scene);
      // 同一正式照明路径只切换静态深度缓存，保持材质与动态阴影一致。
      await runtime.environment.environmentRuntime.setLightingMode('scene');
    }, mode);
    await waitForFactoryReady(page);
    nativeBefore = await focusWindow();
    await page.evaluate(() => new Promise(resolve => {
      const scene = window.lightingSmoke.runtime.scene;
      let frames = 0; const observer = scene.onAfterRenderObservable.add(() => {
        if (++frames >= 60) { scene.onAfterRenderObservable.remove(observer); resolve(); }
      });
    }));
    const sample = await page.evaluate(() => new Promise(resolve => {
      const runtime = window.lightingSmoke.runtime, scene = runtime.scene;
      const times = []; let previous = performance.now();
      const before = runtime.getHybridLightingMetrics();
      const cameraState = () => {
        const camera = scene.activeCamera;
        return { id: camera.uniqueId, position: camera.position.asArray(), target: camera.target?.asArray(),
          alpha: camera.alpha, beta: camera.beta, radius: camera.radius, minZ: camera.minZ, maxZ: camera.maxZ,
          view: Array.from(camera.getViewMatrix().m), projection: Array.from(camera.getProjectionMatrix().m),
          viewport: [scene.getEngine().getRenderWidth(), scene.getEngine().getRenderHeight()] };
      };
      const cameraBefore = cameraState(), signature = JSON.stringify(cameraBefore);
      const conditions = { hiddenFrames: 0, unfocusedFrames: 0, preparingFrames: 0, cameraChangedFrames: 0 };
      const preparationBefore = window.lightingSmoke.preparation.getScenePreparationSnapshot();
      const observer = scene.onAfterRenderObservable.add(() => {
        const now = performance.now(); times.push(now - previous); previous = now;
        if (document.hidden || document.visibilityState !== 'visible') conditions.hiddenFrames++;
        if (!document.hasFocus()) conditions.unfocusedFrames++;
        if (window.lightingSmoke.preparation.isScenePreparationActive()) conditions.preparingFrames++;
        if (JSON.stringify(cameraState()) !== signature) conditions.cameraChangedFrames++;
        // 条件已破坏时立即保留无效样本，避免后台 1Hz 继续等待数分钟并冒充可比结果。
        if (times.length < 240 && Object.values(conditions).every(value => value === 0)) return;
        scene.onAfterRenderObservable.remove(observer);
        const sorted = [...times].sort((a, b) => a - b);
        const textures = scene.getEngine().getLoadedTexturesCache().map(t => ({ width: t.width, height: t.height,
          depth: t.depth, type: t.type, format: t.format, mipmaps: t.generateMipMaps, samples: t.samples }));
        const environmentMaterials = runtime.environment.environmentRuntime.getLightingSurfaces().map(surface => ({ key: surface.key,
          unlit: surface.mesh.material?.unlit, disableLighting: surface.mesh.material?.disableLighting,
          emissive: surface.mesh.material?.emissiveColor?.asArray() }));
        resolve({ frames: times.length, meanMs: times.reduce((a, b) => a + b, 0) / times.length,
          medianMs: sorted[Math.floor(times.length / 2)], p95Ms: sorted[Math.floor(times.length * 0.95)],
          cacheBefore: before, cacheAfter: runtime.getHybridLightingMetrics(), textures,
          initialLoad: runtime.getInitialLoadSnapshot(), environmentLightingMode: runtime.environment.environmentRuntime.lightingMode, environmentMaterials,
          conditions, cameraBefore, cameraAfter: cameraState(), preparationBefore,
          preparationAfter: window.lightingSmoke.preparation.getScenePreparationSnapshot(),
          scheduling: { renderEvenInBackground: scene.getEngine().renderEvenInBackground,
            windowIsBackground: scene.getEngine()._windowIsBackground, maxFPS: scene.getEngine().maxFPS,
            customFrameRequester: Boolean(scene.getEngine().customAnimationFrameRequester) } });
      });
    }));
    sample.mode = mode; sample.index = index;
    sample.nativeWindowBefore = nativeBefore;
    sample.nativeWindowAfter = await readWindowState();
    // 计时结束后记录名义分组与实际提交列表，区分隐藏载体和真正参与投影的组。
    sample.shadowGroups = await page.evaluate(() => [...window.lightingSmoke.runtime.environment.shadowRuntime.hybridCaches.entries()]
      .map(([generator, cache]) => {
        const nominal = new Map();
        for (const mesh of generator.getShadowMap().renderList ?? []) {
          const group = nominal.get(mesh.renderingGroupId) ?? { id: mesh.renderingGroupId, meshCount: 0, examples: [] };
          group.meshCount++;
          if (group.examples.length < 3) group.examples.push(mesh.name);
          nominal.set(group.id, group);
        }
        return { light: generator.getLight().name, nominal: [...nominal.values()],
          dispatched: cache.activeGroups.map(group => ({ id: group.id,
            staticSubMeshes: group.statics.map(list => list.length), dynamicSubMeshes: group.dynamics.map(list => list.length),
            examples: [...new Set(group.original.flatMap(list => list.data.slice(0, list.length)
              .map(subMesh => subMesh.getEffectiveMesh().name)))].slice(0, 3) })) };
      }));
    result.samples.push(sample);
    if (mode === 'cached' && sample.cacheAfter.staticRenders !== sample.cacheBefore.staticRenders) {
      sample.cacheDiagnostics = await cacheDiagnostics(page);
    }
    await page.screenshot({ path: path.join(output, `factory-${index}-${mode}.png`) });
    await writeFile(path.join(output, 'factory-performance.json'), JSON.stringify(result, null, 2));
    assert.equal(sample.initialLoad.error, null, '各段采样必须保持完整实际资产');
    assert.equal(sample.environmentLightingMode, 'scene');
    assert.deepEqual(sample.conditions, { hiddenFrames: 0, unfocusedFrames: 0, preparingFrames: 0, cameraChangedFrames: 0 },
      '性能采样必须全程处于真实前台、准备结束且固定相机条件');
    assert.equal(sample.frames, 240, '只有完整有效的240帧才能进入性能对照');
    assert.ok(sample.nativeWindowBefore.visible && !sample.nativeWindowBefore.minimized && sample.nativeWindowBefore.focused
      && sample.nativeWindowBefore.webContentsFocused && sample.nativeWindowAfter.visible && !sample.nativeWindowAfter.minimized
      && sample.nativeWindowAfter.focused && sample.nativeWindowAfter.webContentsFocused, '采样窗口必须保持前台');
    if (index > 0) assert.deepEqual(sample.cameraBefore, result.samples[0].cameraBefore, '四段必须使用相同相机和投影');
    if (index > 0) assert.deepEqual(sample.environmentMaterials, result.samples[0].environmentMaterials, '对照必须保持相同环境材质受光与自发光');
    if (index === 0 || index === 2) sample.gpuProcessMemory = await readGpuProcessMemory(application);
    await writeFile(path.join(output, 'factory-performance.json'), JSON.stringify(result, null, 2));
    if (mode === 'cached') {
      assert.equal(sample.cacheAfter.staticRenders, sample.cacheBefore.staticRenders, '固定工厂画面不得重新绘制静态阴影');
      assert.ok(sample.cacheAfter.cacheHits > sample.cacheBefore.cacheHits, '实际工厂必须命中静态缓存');
      assert.equal(sample.cacheAfter.validationErrors.length, 0);
    }
    await writeFile(path.join(output, 'factory-performance.json'), JSON.stringify(result, null, 2));
    console.log(`[lighting-factory] ${index + 1}/4 ${mode}: mean ${sample.meanMs.toFixed(2)} ms, p95 ${sample.p95Ms.toFixed(2)} ms`);
  }
  result.sourceUnchanged = createHash('sha256').update(await readFile(sourceScenePath)).digest('hex') === sourceHash;
  assert.equal(result.sourceUnchanged, true, '原始工厂场景必须保持逐字节不变');
  result.status = 'PASS';
  await writeFile(path.join(output, 'factory-performance.json'), JSON.stringify(result, null, 2));
  await nativeWindow.evaluate((window, onTop) => window.setAlwaysOnTop(onTop), originalOnTop);
  await page.unroute(externalHttp, isolateExternalRequest);
  return result;
}
