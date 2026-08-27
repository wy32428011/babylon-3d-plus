import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

import type { SceneEnvironmentSettings } from '../../src/editor/model/SceneDocument.ts';

const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
globalWithWindow.window ??= {};

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});

const {
  createEmptySceneDocument,
} = await viteServer.ssrLoadModule('/src/editor/model/SceneDocument.ts') as typeof import('../../src/editor/model/SceneDocument.ts');
const {
  resolveEnvironmentRuntimeSettings,
} = await viteServer.ssrLoadModule('/src/editor/model/environmentRuntime.ts') as typeof import('../../src/editor/model/environmentRuntime.ts');
const {
  serializeScene,
} = await viteServer.ssrLoadModule('/src/editor/project/SceneSerializer.ts') as typeof import('../../src/editor/project/SceneSerializer.ts');
const {
  useEditorStore,
} = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');

after(async () => {
  await viteServer.close();
});

function createEnvironment(
  sourceKey: string,
  resourceId: string,
  revision: string,
  packagePath: string,
): SceneEnvironmentSettings {
  const sourcePath = `${packagePath}\\model.glb`;
  const sourceUrl = `editor-asset://local/${encodeURIComponent(sourcePath)}?assetRevision=${revision}`;
  return {
    packagePath,
    lengthUnit: 'centimeter',
    unitScaleToMeters: 0.01,
    displayName: '园区环境',
    fileSizeBytes: 1024,
    source: 'data-platform',
    resourceType: 'ENV_MODEL',
    dataPlatformResourceId: resourceId,
    dataPlatformSourceKey: sourceKey,
    dataPlatformRevision: revision,
    displayNameSnapshot: '园区环境',
    placementMode: 'scene-base',
    transform: {
      position: { x: 3, y: 4, z: 5 },
      rotation: { x: 0.1, y: 0.2, z: 0.3 },
      scale: 1.5,
    },
    visible: true,
    opacity: 0.8,
    activeVariantUrl: sourceUrl,
    variants: [{ name: '默认预设', sourcePath, sourceUrl }],
  };
}

function withVariants(
  environment: SceneEnvironmentSettings,
  names: string[],
  activeIndex = 0,
): SceneEnvironmentSettings {
  const variants = names.map((name) => {
    const sourcePath = `${environment.packagePath}\\${name}.glb`;
    return {
      name,
      sourcePath,
      sourceUrl: `editor-asset://local/${encodeURIComponent(sourcePath)}?assetRevision=${environment.dataPlatformRevision}`,
    };
  });
  return {
    ...environment,
    activeVariantUrl: variants[activeIndex]?.sourceUrl ?? environment.activeVariantUrl,
    variants,
  };
}

function installRuntimeOverride(
  oldEnvironment: SceneEnvironmentSettings,
  refreshedEnvironment: SceneEnvironmentSettings,
): void {
  const scene = createEmptySceneDocument('环境运行时覆盖');
  scene.sceneSettings.environment = oldEnvironment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'runtime-override-test'), true);

  const requestId = useEditorStore.getState().requestEnvironmentApply(oldEnvironment, {
    persistSceneChange: false,
    runtimeEnvironment: refreshedEnvironment,
  });
  assert.ok(requestId);
  useEditorStore.getState().completeEnvironmentApply(requestId, {
    environment: refreshedEnvironment,
    snapshot: {
      phase: 'ready',
      requestId,
      sourceUrl: refreshedEnvironment.activeVariantUrl,
      message: null,
      bounds: null,
      statistics: null,
    },
  });
}

test('运行时刷新完成后持续使用新缓存来源并保留场景显示设置', () => {
  const resourceId = '2088100088037199873';
  const oldEnvironment = createEnvironment(
    'a'.repeat(64),
    resourceId,
    '7645194092844337573',
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const refreshedEnvironment = {
    ...createEnvironment(
      'b'.repeat(64),
      resourceId,
      '7645194092844337573',
      'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
    ),
    lengthUnit: 'meter' as const,
    unitScaleToMeters: 1,
    transform: {
      position: { x: 100, y: 100, z: 100 },
      rotation: { x: 1, y: 1, z: 1 },
      scale: 2,
    },
  };
  installRuntimeOverride(oldEnvironment, refreshedEnvironment);

  const refreshedState = useEditorStore.getState();
  assert.deepEqual(refreshedState.scene.sceneSettings.environment, oldEnvironment);
  assert.deepEqual(refreshedState.environmentRuntimeOverride, refreshedEnvironment);

  refreshedState.updateEnvironmentDisplay({ visible: false, opacity: 0.35 }, '更新环境显示');
  const displayedState = useEditorStore.getState();
  const runtimeEnvironment = resolveEnvironmentRuntimeSettings(
    displayedState.scene.sceneSettings.environment,
    displayedState.environmentRuntimeOverride,
  );
  assert.ok(runtimeEnvironment);
  assert.equal(runtimeEnvironment.packagePath, refreshedEnvironment.packagePath);
  assert.equal(runtimeEnvironment.activeVariantUrl, refreshedEnvironment.activeVariantUrl);
  assert.equal(runtimeEnvironment.dataPlatformSourceKey, refreshedEnvironment.dataPlatformSourceKey);
  assert.deepEqual(runtimeEnvironment.variants, refreshedEnvironment.variants);
  assert.equal(runtimeEnvironment.lengthUnit, oldEnvironment.lengthUnit);
  assert.equal(runtimeEnvironment.unitScaleToMeters, oldEnvironment.unitScaleToMeters);
  assert.deepEqual(runtimeEnvironment.transform, oldEnvironment.transform);
  assert.equal(runtimeEnvironment.visible, false);
  assert.equal(runtimeEnvironment.opacity, 0.35);

  useEditorStore.getState().newScene();
  assert.equal(useEditorStore.getState().environmentRuntimeOverride, null);
});

test('场景首次打开时延迟加载旧共享缓存环境直到资源重关联完成', () => {
  const sourceKey = 'a'.repeat(64);
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const environment = createEnvironment(
    sourceKey,
    resourceId,
    revision,
    `D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${sourceKey}\\${resourceId}\\2092171410874761217`,
  );
  const scene = createEmptySceneDocument('环境启动重关联');
  scene.sceneSettings.environment = environment;

  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'startup-relink-test'), true);
  const loadedState = useEditorStore.getState();
  const sceneSessionId = loadedState.sceneSessionId;

  assert.equal(loadedState.environmentStartupRelinkSessionId, sceneSessionId);
  assert.equal(
    resolveEnvironmentRuntimeSettings(
      loadedState.scene.sceneSettings.environment,
      loadedState.environmentRuntimeOverride,
      { deferManagedCacheLoad: true },
    ),
    null,
  );

  useEditorStore.getState().newScene();
  assert.equal(useEditorStore.getState().environmentStartupRelinkSessionId, null);
});

test('旧场景异步环境刷新不能向新场景提交加载请求', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = createEnvironment(
    'a'.repeat(64),
    resourceId,
    revision,
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const refreshedEnvironment = createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );
  const scene = createEmptySceneDocument('旧场景异步刷新');
  scene.sceneSettings.environment = oldEnvironment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'stale-refresh-test'), true);
  const staleSceneSessionId = useEditorStore.getState().sceneSessionId;

  useEditorStore.getState().newScene();
  const currentSceneId = useEditorStore.getState().scene.id;
  const requestId = useEditorStore.getState().requestEnvironmentApply(oldEnvironment, {
    persistSceneChange: false,
    runtimeEnvironment: refreshedEnvironment,
    expectedSceneSessionId: staleSceneSessionId,
  });

  assert.equal(requestId, null);
  assert.equal(useEditorStore.getState().scene.id, currentSceneId);
  assert.equal(useEditorStore.getState().scene.sceneSettings.environment, null);
  assert.equal(useEditorStore.getState().environmentApplyRequest, null);
});

test('同场景旧异步刷新不能覆盖用户新发起的环境加载', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = createEnvironment(
    'a'.repeat(64),
    resourceId,
    revision,
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const refreshedEnvironment = createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );
  const userEnvironment = createEnvironment(
    'c'.repeat(64),
    '2088100088037199999',
    revision,
    'D:\\current-workspace\\SharedResources\\Assets\\Environments\\user-selected',
  );
  const scene = createEmptySceneDocument('同场景环境刷新竞态');
  scene.sceneSettings.environment = oldEnvironment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'same-scene-refresh-race-test'), true);
  const sceneSessionId = useEditorStore.getState().sceneSessionId;

  const userRequestId = useEditorStore.getState().requestEnvironmentApply(userEnvironment, {
    runtimeEnvironment: userEnvironment,
    expectedSceneSessionId: sceneSessionId,
  });
  assert.ok(userRequestId);

  const staleRefreshRequestId = useEditorStore.getState().requestEnvironmentApply(oldEnvironment, {
    persistSceneChange: false,
    runtimeEnvironment: refreshedEnvironment,
    expectedSceneSessionId: sceneSessionId,
    expectedEnvironmentState: {
      environment: oldEnvironment,
      applyRequestId: null,
    },
  });

  assert.equal(staleRefreshRequestId, null);
  assert.equal(useEditorStore.getState().environmentApplyRequest?.id, userRequestId);

  useEditorStore.getState().completeEnvironmentApply(userRequestId, {
    environment: userEnvironment,
    snapshot: {
      phase: 'ready',
      requestId: userRequestId,
      sourceUrl: userEnvironment.activeVariantUrl,
      message: null,
      bounds: null,
      statistics: null,
    },
  });
  const completedRefreshRequestId = useEditorStore.getState().requestEnvironmentApply(oldEnvironment, {
    persistSceneChange: false,
    runtimeEnvironment: refreshedEnvironment,
    expectedSceneSessionId: sceneSessionId,
    expectedEnvironmentState: {
      environment: oldEnvironment,
      applyRequestId: null,
    },
  });

  assert.equal(completedRefreshRequestId, null);
  assert.deepEqual(useEditorStore.getState().scene.sceneSettings.environment, userEnvironment);
});

test('启动重关联加载失败后仍阻止旧机器缓存路径', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldSourceKey = 'a'.repeat(64);
  const refreshedSourceKey = 'b'.repeat(64);
  const oldEnvironment = createEnvironment(
    oldSourceKey,
    resourceId,
    revision,
    `D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${oldSourceKey}\\${resourceId}\\${revision}`,
  );
  const refreshedEnvironment = createEnvironment(
    refreshedSourceKey,
    resourceId,
    revision,
    `D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${refreshedSourceKey}\\${resourceId}\\${revision}`,
  );
  const scene = createEmptySceneDocument('启动重关联失败');
  scene.sceneSettings.environment = oldEnvironment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'startup-relink-failure-test'), true);
  const sceneSessionId = useEditorStore.getState().sceneSessionId;
  const requestId = useEditorStore.getState().requestEnvironmentApply(oldEnvironment, {
    persistSceneChange: false,
    runtimeEnvironment: refreshedEnvironment,
    expectedSceneSessionId: sceneSessionId,
  });
  assert.ok(requestId);
  assert.equal(useEditorStore.getState().environmentStartupRelinkSessionId, sceneSessionId);

  useEditorStore.getState().failEnvironmentApply(requestId, '当前缓存损坏');

  const failedState = useEditorStore.getState();
  assert.equal(failedState.environmentStartupRelinkSessionId, sceneSessionId);
  assert.equal(
    resolveEnvironmentRuntimeSettings(
      failedState.scene.sceneSettings.environment,
      failedState.environmentRuntimeOverride,
      { deferManagedCacheLoad: failedState.environmentStartupRelinkSessionId === sceneSessionId },
    ),
    null,
  );
});

test('启动重关联期间拒绝无当前缓存覆盖的旧路径重载', () => {
  const sourceKey = 'a'.repeat(64);
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = createEnvironment(
    sourceKey,
    resourceId,
    revision,
    `D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${sourceKey}\\${resourceId}\\${revision}`,
  );
  const scene = createEmptySceneDocument('启动重关联交互守卫');
  scene.sceneSettings.environment = oldEnvironment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'startup-relink-guard-test'), true);
  const sceneSessionId = useEditorStore.getState().sceneSessionId;

  const requestId = useEditorStore.getState().requestEnvironmentApply(
    { ...oldEnvironment, lengthUnit: 'meter', unitScaleToMeters: 1 },
    { expectedSceneSessionId: sceneSessionId },
  );

  assert.equal(requestId, null);
  assert.equal(useEditorStore.getState().environmentApplyRequest, null);
  assert.equal(useEditorStore.getState().environmentStartupRelinkSessionId, sceneSessionId);
});

test('启动重关联期间主动重选环境成功后撤销不会恢复旧机器缓存', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldSourceKey = 'a'.repeat(64);
  const currentSourceKey = 'b'.repeat(64);
  const oldEnvironment = createEnvironment(
    oldSourceKey,
    resourceId,
    revision,
    `D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${oldSourceKey}\\${resourceId}\\${revision}`,
  );
  const currentEnvironment = createEnvironment(
    currentSourceKey,
    resourceId,
    revision,
    `D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${currentSourceKey}\\${resourceId}\\${revision}`,
  );
  const scene = createEmptySceneDocument('启动重关联主动重选');
  scene.sceneSettings.environment = oldEnvironment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'startup-relink-reselect-test'), true);
  const sceneSessionId = useEditorStore.getState().sceneSessionId;

  const requestId = useEditorStore.getState().requestEnvironmentApply(currentEnvironment, {
    runtimeEnvironment: currentEnvironment,
    expectedSceneSessionId: sceneSessionId,
  });
  assert.ok(requestId);
  useEditorStore.getState().completeEnvironmentApply(requestId, {
    environment: currentEnvironment,
    snapshot: {
      phase: 'ready',
      requestId,
      sourceUrl: currentEnvironment.activeVariantUrl,
      message: null,
      bounds: null,
      statistics: null,
    },
  });

  assert.deepEqual(useEditorStore.getState().scene.sceneSettings.environment, currentEnvironment);
  assert.equal(useEditorStore.getState().environmentStartupRelinkSessionId, null);
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().scene.sceneSettings.environment, null);
});

test('清除已重关联环境后连续撤销显示和变换仍只恢复当前缓存来源', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = createEnvironment(
    'a'.repeat(64),
    resourceId,
    revision,
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const refreshedEnvironment = createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );
  installRuntimeOverride(oldEnvironment, refreshedEnvironment);

  useEditorStore.getState().updateEnvironmentDisplay({ visible: false }, '隐藏环境模型');
  const beforeTransform = useEditorStore.getState().scene.sceneSettings.environment!.transform;
  const afterTransform = {
    ...beforeTransform,
    position: { ...beforeTransform.position, x: beforeTransform.position.x + 10 },
  };
  useEditorStore.getState().previewEnvironmentTransform(afterTransform);
  useEditorStore.getState().commitEnvironmentTransform(beforeTransform, afterTransform);

  useEditorStore.getState().updateEnvironmentConfig(null);
  assert.equal(useEditorStore.getState().scene.sceneSettings.environment, null);

  for (let undoCount = 0; undoCount < 3; undoCount += 1) {
    useEditorStore.getState().undo();
    const restoredEnvironment = useEditorStore.getState().scene.sceneSettings.environment;
    assert.ok(restoredEnvironment);
    assert.equal(restoredEnvironment.packagePath, refreshedEnvironment.packagePath);
    assert.equal(restoredEnvironment.dataPlatformSourceKey, refreshedEnvironment.dataPlatformSourceKey);
  }
});

test('环境重新加载默认使用当前缓存来源并在成功后持久化', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = createEnvironment(
    'a'.repeat(64),
    resourceId,
    revision,
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const refreshedEnvironment = createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );
  installRuntimeOverride(oldEnvironment, refreshedEnvironment);

  const candidate = {
    ...oldEnvironment,
    lengthUnit: 'meter' as const,
    unitScaleToMeters: 1,
  };
  const requestId = useEditorStore.getState().requestEnvironmentApply(candidate, {
    autoAlign: true,
    commandLabel: '更新环境源单位',
  });
  assert.ok(requestId);

  const requestState = useEditorStore.getState();
  const request = requestState.environmentApplyRequest;
  assert.ok(request?.runtimeEnvironment);
  assert.equal(request.runtimeEnvironment.packagePath, refreshedEnvironment.packagePath);
  assert.equal(request.runtimeEnvironment.activeVariantUrl, refreshedEnvironment.activeVariantUrl);
  assert.equal(request.runtimeEnvironment.dataPlatformSourceKey, refreshedEnvironment.dataPlatformSourceKey);
  assert.equal(request.runtimeEnvironment.lengthUnit, 'meter');
  assert.equal(request.runtimeEnvironment.unitScaleToMeters, 1);
  assert.equal(requestState.environmentRuntimeSnapshot.sourceUrl, refreshedEnvironment.activeVariantUrl);

  useEditorStore.getState().completeEnvironmentApply(requestId, {
    environment: request.runtimeEnvironment,
    snapshot: {
      phase: 'ready',
      requestId,
      sourceUrl: request.runtimeEnvironment.activeVariantUrl,
      message: null,
      bounds: null,
      statistics: null,
    },
  });

  const completedState = useEditorStore.getState();
  assert.deepEqual(completedState.scene.sceneSettings.environment, request.runtimeEnvironment);
  assert.equal(completedState.environmentRuntimeOverride, null);

  completedState.undo();
  const undoneEnvironment = useEditorStore.getState().scene.sceneSettings.environment;
  assert.ok(undoneEnvironment);
  assert.equal(undoneEnvironment.packagePath, refreshedEnvironment.packagePath);
  assert.equal(undoneEnvironment.dataPlatformSourceKey, refreshedEnvironment.dataPlatformSourceKey);
  assert.equal(undoneEnvironment.lengthUnit, oldEnvironment.lengthUnit);
  assert.equal(undoneEnvironment.unitScaleToMeters, oldEnvironment.unitScaleToMeters);
});

test('切换旧场景环境变体时映射到当前缓存中的同名变体', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = withVariants(createEnvironment(
    'a'.repeat(64),
    resourceId,
    revision,
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  ), ['白天', '夜间']);
  const refreshedEnvironment = withVariants(createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  ), ['白天', '夜间']);
  installRuntimeOverride(oldEnvironment, refreshedEnvironment);

  useEditorStore.getState().setEnvironmentActiveVariant(oldEnvironment.variants[1]!.sourceUrl);

  const request = useEditorStore.getState().environmentApplyRequest;
  assert.ok(request?.runtimeEnvironment);
  assert.equal(request.environment.activeVariantUrl, oldEnvironment.variants[1]!.sourceUrl);
  assert.equal(request.runtimeEnvironment.activeVariantUrl, refreshedEnvironment.variants[1]!.sourceUrl);
  assert.equal(request.runtimeEnvironment.dataPlatformSourceKey, refreshedEnvironment.dataPlatformSourceKey);

  useEditorStore.getState().completeEnvironmentApply(request.id, {
    environment: request.runtimeEnvironment,
    snapshot: {
      phase: 'ready',
      requestId: request.id,
      sourceUrl: request.runtimeEnvironment.activeVariantUrl,
      message: null,
      bounds: null,
      statistics: null,
    },
  });
  assert.equal(
    useEditorStore.getState().scene.sceneSettings.environment?.activeVariantUrl,
    refreshedEnvironment.variants[1]!.sourceUrl,
  );
  assert.equal(useEditorStore.getState().environmentRuntimeOverride, null);
});

test('旧版环境转换为场景底座时使用当前缓存来源', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = {
    ...createEnvironment(
      'a'.repeat(64),
      resourceId,
      revision,
      'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
    ),
    placementMode: 'legacy-left' as const,
  };
  const refreshedEnvironment = createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );
  installRuntimeOverride(oldEnvironment, refreshedEnvironment);

  useEditorStore.getState().convertLegacyEnvironmentToSceneBase();

  const request = useEditorStore.getState().environmentApplyRequest;
  assert.ok(request?.runtimeEnvironment);
  assert.equal(request.environment.placementMode, 'scene-base');
  assert.equal(request.runtimeEnvironment.placementMode, 'scene-base');
  assert.equal(request.runtimeEnvironment.packagePath, refreshedEnvironment.packagePath);
  assert.equal(request.runtimeEnvironment.dataPlatformSourceKey, refreshedEnvironment.dataPlatformSourceKey);
});

test('环境变体名称变化时按相同索引映射当前缓存变体', () => {
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const oldEnvironment = withVariants(createEnvironment(
    'a'.repeat(64),
    resourceId,
    revision,
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  ), ['旧白天', '旧夜间'], 1);
  const refreshedEnvironment = withVariants(createEnvironment(
    'b'.repeat(64),
    resourceId,
    revision,
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  ), ['Day', 'Night']);

  const resolved = resolveEnvironmentRuntimeSettings(oldEnvironment, refreshedEnvironment);
  assert.ok(resolved);
  assert.equal(resolved.activeVariantUrl, refreshedEnvironment.variants[1]!.sourceUrl);
});

test('环境缓存 revision 不一致时拒绝运行时覆盖', () => {
  const resourceId = '2088100088037199873';
  const oldEnvironment = createEnvironment(
    'a'.repeat(64),
    resourceId,
    '7645194092844337573',
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const differentRevisionEnvironment = createEnvironment(
    'b'.repeat(64),
    resourceId,
    '7645194092844337574',
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );

  assert.equal(
    resolveEnvironmentRuntimeSettings(oldEnvironment, differentRevisionEnvironment),
    oldEnvironment,
  );
});

test('同一数据中台资源发布新 revision 后持续使用新缓存来源', () => {
  const sourceKey = 'a'.repeat(64);
  const resourceId = '2088100088037199873';
  const oldEnvironment = createEnvironment(
    sourceKey,
    resourceId,
    '7645194092844337573',
    'D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\old\\resource\\revision',
  );
  const refreshedEnvironment = createEnvironment(
    sourceKey,
    resourceId,
    '7645194092844337574',
    'D:\\current-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\current\\resource\\revision',
  );

  const resolved = resolveEnvironmentRuntimeSettings(oldEnvironment, refreshedEnvironment);
  assert.ok(resolved);
  assert.equal(resolved.packagePath, refreshedEnvironment.packagePath);
  assert.equal(resolved.activeVariantUrl, refreshedEnvironment.activeVariantUrl);
  assert.equal(resolved.dataPlatformRevision, refreshedEnvironment.dataPlatformRevision);
});

test('环境启动重关联完成前禁止进入运行预览', () => {
  const sourceKey = 'a'.repeat(64);
  const resourceId = '2088100088037199873';
  const revision = '7645194092844337573';
  const environment = createEnvironment(
    sourceKey,
    resourceId,
    revision,
    `D:\\old-workspace\\SharedResources\\.babylon-editor\\data-platform-cache\\environments\\${sourceKey}\\${resourceId}\\${revision}`,
  );
  const scene = createEmptySceneDocument('环境启动门控预览');
  scene.sceneSettings.environment = environment;
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'startup-relink-preview-test'), true);

  const readiness = useEditorStore.getState().startRuntimePreview();

  assert.equal(readiness.ok, false);
  assert.equal(readiness.ok ? null : readiness.code, 'environment-relink-active');
  assert.equal(useEditorStore.getState().runtimeMode, 'edit');

  useEditorStore.getState().updateEnvironmentConfig(null);
  assert.equal(useEditorStore.getState().scene.sceneSettings.environment, null);
  assert.equal(useEditorStore.getState().environmentStartupRelinkSessionId, null);
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().scene.sceneSettings.environment, null);
});
