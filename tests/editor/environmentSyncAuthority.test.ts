import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createImportedAssetIndexes, findImportedAssetForPackagePath } from '../../src/editor/assets/modelAssetRelink.ts';
import { createModelSyncRevisionTracker } from '../../src/editor/assets/modelSyncRefreshPolicy.ts';
import { environmentForSyncRun, findAuthoritativeEnvironmentAsset } from '../../src/editor/assets/environmentSyncAuthority.ts';
import type { SceneEnvironmentSettings } from '../../src/editor/model/SceneDocument.ts';
import type { ProjectModelAssetEntry } from '../../src/editor/assets/AssetDatabase.ts';

const asset = (source: string, revision = '8') => ({ kind: 'model', name: 'env', path: `${source}/env/model.glb`, libraryKind: 'environment',
  source: 'data-platform', dataPlatformSourceKey: source, dataPlatformResourceId: '9007199254740993',
  dataPlatformRevision: revision, assetRevision: revision, packagePath: `${source}/env`, sourceUrl: `${source}/env/model.glb`,
}) as ProjectModelAssetEntry;

test('当前绑定来源按稳定ID覆盖旧来源和旧revision，不能回退旧资源或同名资产', () => {
  const old = asset('old', '1');
  const current = asset('current');
  assert.equal(findAuthoritativeEnvironmentAsset([old, current], 'current', current.dataPlatformResourceId), current);
  assert.equal(findAuthoritativeEnvironmentAsset([old], 'current', old.dataPlatformResourceId), null);
  assert.equal(findAuthoritativeEnvironmentAsset([current], 'current', undefined), null);
  assert.equal(findAuthoritativeEnvironmentAsset([current, { ...current }], 'current', current.dataPlatformResourceId), null);
});

test('绑定工程内无中台ID的包内环境仍按当前本地包路径选中，不被远程同名环境替换', async () => {
  const source = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const matchedAsset = authoritativeSourceKey');
  const end = source.indexOf('\n    if (!matchedAsset', start);
  const selection = source.slice(start, end);
  const local = { ...asset('local'), source: undefined, dataPlatformSourceKey: undefined, dataPlatformResourceId: undefined };
  const matched = runInNewContext(`(() => { ${selection} return matchedAsset; })()`, {
    authoritativeSourceKey: 'current', resourceId: undefined,
    environment: { packagePath: 'local/env', source: undefined },
    environmentAssets: [asset('current'), local],
    findAuthoritativeEnvironmentAsset, createImportedAssetIndexes, findImportedAssetForPackagePath,
  });
  assert.equal(matched, local);
});

test('实际完成apply提交当前来源身份但只在runtimeOverride保留同步缓存键', async () => {
  const source = await readFile(new URL('../../src/editor/store/editorStore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  completeEnvironmentApply: (requestId, applyResult) =>');
  const end = source.indexOf('  failEnvironmentApply:', start);
  const clean = { dataPlatformSourceKey: 'current', dataPlatformResourceId: '1', dataPlatformRevision: '8',
    activeVariantUrl: 'editor-asset://local/current.glb?assetRevision=8', variants: [], transform: { position: { x: 5, y: 6, z: 7 } } };
  const runtime = { ...clean, activeVariantUrl: `${clean.activeVariantUrl}%3Async2` };
  let state: any = { scene: { sceneSettings: { environment: { ...clean, dataPlatformSourceKey: 'old' } } }, history: [],
    sceneSessionId: 'session', environmentStartupRelinkSessionId: 'session', logs: [],
    environmentApplyRequest: { id: 'request', environment: clean, persistSceneChange: true, preserveSceneResourceUrls: true, commandLabel: '刷新', successMessage: '完成' } };
  const complete = runInNewContext(`({${source.slice(start, end)}}).completeEnvironmentApply`, {
    set: (update: (before: unknown) => unknown) => { state = { ...state, ...update(state) as object }; },
    sanitizeSceneEnvironment: (value: unknown) => value,
    resolveEnvironmentRuntimeSettings: (value: unknown) => value,
    updateSceneEnvironmentCommand: (_label: string, _before: unknown, next: unknown) => next,
    isSceneEnvironmentEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    executeCommand: (scene: any, history: unknown, next: unknown) => ({ scene: { ...scene, sceneSettings: { environment: next } }, history }),
    prependLog: (logs: string[], message: string) => [message, ...logs],
  });
  complete('request', { environment: runtime, snapshot: { phase: 'ready', sourceUrl: runtime.activeVariantUrl } });
  assert.equal(state.scene.sceneSettings.environment.dataPlatformSourceKey, 'current');
  assert.equal(state.scene.sceneSettings.environment.activeVariantUrl, clean.activeVariantUrl);
  assert.equal(state.environmentRuntimeOverride.activeVariantUrl, runtime.activeVariantUrl);
  assert.equal(state.scene.sceneSettings.environment.transform, runtime.transform);
  assert.equal(state.environmentStartupRelinkSessionId, null);
});

test('强制覆盖同路径同revision后改变加载键，不更改远端revision或原资产', () => {
  const current = { dataPlatformRevision: '8', activeVariantUrl: 'editor-asset://local/model.glb?assetRevision=8',
    variants: [{ name: 'default', sourcePath: 'D:/model.glb', sourceUrl: 'editor-asset://local/model.glb?assetRevision=8' }] } as SceneEnvironmentSettings;
  const updated = environmentForSyncRun(current, 'sync-2');
  assert.equal(new URL(updated.activeVariantUrl).searchParams.get('assetRevision'), '8:sync-2');
  assert.equal(updated.dataPlatformRevision, '8');
  assert.equal(current.activeVariantUrl, 'editor-asset://local/model.glb?assetRevision=8');
  assert.equal(environmentForSyncRun(current), current);
});

test('ProjectPanel等待权威同步完成再应用，并传入完成runId刷新环境加载键', async () => {
  const source = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /options.refreshEnvironment && !result.environmentSyncPending/);
  assert.match(source, /environmentSyncRunId: progress.runId/);
  assert.match(source, /persistSceneChange: authorityChanged/);
  assert.match(source, /authorityChanged \? environmentConfig : environment/);
});

test('普通模型同路径同hash强制覆盖完成后改变加载revision，原资产及远端revision不变', async () => {
  const source = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  const original = { path: 'D:/Model-1-X/model.glb', packagePath: 'D:/Model-1-X', assetRevision: 'content-sha', dataPlatformRevision: '8', sourceUrl: 'editor-asset://local/model.glb' };
  const tracker = createModelSyncRevisionTracker();
  const refresh = (runId?: string) => tracker.refresh([original], runId);
  assert.equal(refresh('run2')[0].assetRevision, 'content-sha:run2');
  assert.equal(refresh('run2')[0].dataPlatformRevision, '8');
  assert.equal(original.assetRevision, 'content-sha');
  assert.equal(refresh()[0].assetRevision, 'content-sha:run2');
  assert.equal(tracker.refresh([{ ...original, assetRevision: 'new-sha' }])[0].assetRevision, 'new-sha');
  tracker.clear();
  assert.equal(refresh()[0], original);
  assert.match(source, /modelSyncRunId: progress.runId/);
  assert.match(source, /modelSyncRevisionsRef.current.clear\(\)/);
  assert.match(source, /modelSyncRevisionsRef.current.refresh\(assetsToRefresh, options.modelSyncRunId\)/);
});
