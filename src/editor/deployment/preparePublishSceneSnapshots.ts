import { ArcRotateCamera, Engine, Scene, Vector3 } from '@babylonjs/core';
import { getRequiredEnvironmentResourceIds } from '../../../electron/shared/sceneEnvironmentReferences';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { waitForSceneRenderReady } from '../../runtime/babylon/sceneRenderReadiness';
import { applyAvailableSceneModelUpdates } from '../assets/applySceneModelUpdates';
import { loadEnvironmentFromAsset } from '../assets/environmentAssets';
import { countExpectedSceneBatchedEntities } from '../loading/scenePreparationProgress';
import type { SceneDocument } from '../model/SceneDocument';
import { getSceneShadowBakeError } from '../model/sceneShadowBake';
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
import { waitForPublishCondition } from './publishOrchestration';
import { preparePublishResources } from './preparePublishResources';

/** SOURCE 的非入口场景只在隔离副本中更新，不切换编辑器 Store，也不覆盖磁盘场景。 */
export async function preparePublishSceneSnapshot(sceneContent: string, assertCurrent: () => void, pushLog: (message: string) => void): Promise<string> {
  assertCurrent();
  const scene = deserializeScene(sceneContent);
  const resources = await preparePublishResources(sceneContent, assertCurrent);
  assertCurrent();
  if (!resources.configured || !resources.sourceKey || !resources.modelReplacements) throw new Error('其他场景模型同步未返回完整结果。');
  const issues = (resources.issues ?? []).map(issue => issue.message);
  const environment = scene.sceneSettings.environment;
  let nextEnvironment = environment;
  const resourceId = getRequiredEnvironmentResourceIds(scene)?.[0];
  if (environment && (resourceId || environment.source === 'data-platform')) {
    const asset = resources.environmentAssets.find(candidate => candidate.dataPlatformSourceKey === resources.sourceKey
      && (!resourceId || candidate.dataPlatformResourceId === resourceId));
    if (!asset) throw new Error('其他场景的中台环境模型同步失败，原场景文件已保留。');
    nextEnvironment = await loadEnvironmentFromAsset(asset, environment);
    if (!nextEnvironment) throw new Error('其他场景的新版环境配置无效。');
  }
  assertCurrent();
  const updated = applyAvailableSceneModelUpdates(scene, resources.modelReplacements, resources.sourceKey, nextEnvironment);
  for (const warning of new Set([...(resources.warnings ?? []), ...(updated.warnings ?? [])])) {
    pushLog(`模型参数同步提示：${warning}`);
  }
  issues.push(...updated.issues.map(issue => issue.message));
  if (issues.length) throw new Error(issues.join('\n'));
  const readyScene = await renderPublishSceneSnapshot(updated.scene, assertCurrent, pushLog);
  return serializeScene(readyScene);
}

async function renderPublishSceneSnapshot(document: SceneDocument, assertCurrent: () => void, pushLog: (message: string) => void): Promise<SceneDocument> {
  const canvas = window.document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: false, stencil: true });
  const scene = new Scene(engine);
  const controller = new AbortController();
  let runtime: SceneRuntime | undefined;
  let monitorFailure: unknown;
  let renderFailure: unknown;
  const startedAt = performance.now();
  const check = () => {
    assertCurrent();
    if (monitorFailure) throw monitorFailure;
    if (renderFailure) throw renderFailure;
    if (performance.now() - startedAt > 600_000) throw new Error('其他场景的渲染或烘焙准备超时。');
  };
  const monitor = window.setInterval(() => {
    try { check(); } catch (error) { monitorFailure = error; controller.abort(); }
  }, 100);
  try {
    new ArcRotateCamera('publish-snapshot-camera', -Math.PI / 2, Math.PI / 3, 100, Vector3.Zero(), scene);
    let environmentReady = !document.sceneSettings.environment?.visible;
    runtime = new SceneRuntime(scene, pushLog, undefined, snapshot => {
      environmentReady = snapshot.phase === 'ready' || snapshot.phase === 'idle';
    });
    runtime.sync(document, []);
    runtime.syncEnvironment(document.sceneSettings.environment);
    engine.runRenderLoop(() => {
      if (renderFailure || controller.signal.aborted) return;
      try { scene.render(); } catch (error) { renderFailure = error; controller.abort(); }
    });
    const modelIds = document.entityIds.filter(id => document.entities[id]?.components.modelAsset && !document.entities[id]?.components.modelArrayInstance);
    const expectedBatches = countExpectedSceneBatchedEntities(document.entityIds, document.entities);
    let stableSamples = 0;
    await waitForPublishCondition({ assertCurrent: check, ready: () => {
      const snapshot = runtime!.getInitialLoadSnapshot();
      if (snapshot.error) throw new Error(snapshot.error);
      const ready = !snapshot.progress.loading && environmentReady && modelIds.every(id => runtime!.isModelReady(id))
        && runtime!.getPerformanceMetrics().modelArrayBatchEntityCount >= expectedBatches;
      stableSamples = ready ? stableSamples + 1 : 0;
      return stableSamples >= 2;
    } });
    await waitForSceneRenderReady(scene, controller.signal);
    check();
    if (!getSceneShadowBakeError(document)) return document;
    const bake = await runtime.bakeStaticShadows(document, controller.signal, pushLog);
    check();
    const updated = { ...document, sceneSettings: { ...document.sceneSettings, shadows: { ...document.sceneSettings.shadows, bake } } };
    const error = getSceneShadowBakeError(updated);
    if (error) throw new Error(error);
    return updated;
  } catch (error) {
    throw monitorFailure ?? renderFailure ?? error;
  } finally {
    window.clearInterval(monitor);
    controller.abort();
    engine.stopRenderLoop();
    try { runtime?.dispose(); } finally {
      try { scene.dispose(); } finally {
        engine.dispose();
        canvas.remove();
      }
    }
  }
}
