import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('入口和额外场景参数warnings只写日志并继续准备，真实资源issues继续阻断', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publish-warning-routing-'));
  const previousWindow = (globalThis as any).window;
  const state: any = { sceneSessionId: 'session', runtimeMode: 'edit', latestSceneResourceTransaction: null,
    sceneResourceIssues: [], scene: { name: 'scene', entities: {}, entityIds: [], sceneSettings: { environment: null } } };
  const logs: string[] = [], commits: string[][] = [];
  const resources: any = { configured: true, sourceKey: 'source', modelReplacements: [], environmentAssets: [],
    warnings: ['旧参数删除', '类型差异'], issues: [] };
  state.pushLog = (message: string) => logs.push(message);
  state.commitLatestSceneResources = (_id: string, _before: unknown, after: unknown, issues: string[]) => {
    state.scene = after; commits.push(issues); return true;
  };
  (globalThis as any).__publishWarningsTest = { state, resources, logs };
  (globalThis as any).window = { editorApi: { prepareLocalSceneResources: async () => resources, cancelSceneModelSync: async () => true },
    document: { createElement: () => ({ remove() {} }) }, setInterval, clearInterval };
  const stubs: Record<string, string> = {
    '../store/editorStore': 'export const useEditorStore={getState:()=>globalThis.__publishWarningsTest.state};',
    '../assets/applySceneModelUpdates': 'export const applyAvailableSceneModelUpdates=scene=>({scene,updatedCount:1,issues:[],warnings:["类型差异"]});',
    '../assets/environmentAssets': 'export const loadEnvironmentFromAsset=async()=>null;',
    '../loading/environmentPreparationProgress': 'export const environmentPreparationStore={clearError(){},getSnapshot:()=>({sceneSessionId:"session",error:null})};',
    '../loading/scenePreparationProgress': 'export const beginSceneModelAssetRefresh=()=>{}; export const reportSceneModelSyncProgress=()=>{}; export const settleSceneModelAssetRefresh=()=>{}; export const countExpectedSceneBatchedEntities=()=>0; export const getScenePreparationSnapshot=()=>({sceneSessionId:"session",completed:true,runtime:{stable:true,forcedSettled:false}});',
    '../model/sceneShadowBake': 'export const getSceneShadowBakeError=()=>null;',
    '../project/SceneSerializer': 'export const deserializeScene=s=>JSON.parse(s).scene; export const serializeScene=scene=>JSON.stringify({version:5,scene});',
    '../../runtime/babylon/sceneRenderReadiness': 'export const waitForSceneRenderReady=async()=>{};',
    '../../runtime/babylon/SceneRuntime': 'export class SceneRuntime { constructor(_scene,_log,_third,onEnvironment){onEnvironment({phase:"ready"});} sync(){} syncEnvironment(){} isModelReady(){return true;} getInitialLoadSnapshot(){return {progress:{loading:false}};} getPerformanceMetrics(){return {modelArrayBatchEntityCount:0};} dispose(){} }',
    '@babylonjs/core': 'export class ArcRotateCamera{} export class Engine { runRenderLoop(callback){callback();} stopRenderLoop(){} dispose(){} } export class Scene { render(){} dispose(){} } export class Vector3 { static Zero(){return {};} }',
  };
  try {
    const input = path.join(root, 'input.ts');
    await writeFile(input, ['preparePublishScene', 'preparePublishSceneSnapshots'].map(name =>
      `export * from ${JSON.stringify(path.resolve('src/editor/deployment', name + '.ts').replace(/\\/g, '/'))};`).join('\n'));
    await build({ configFile: false, logLevel: 'error', plugins: [{ name: 'publish-warning-dependencies', enforce: 'pre',
      resolveId(source) { return Object.hasOwn(stubs, source) ? '\0publish-test:' + source : null; },
      load(id) { return id.startsWith('\0publish-test:') ? stubs[id.slice('\0publish-test:'.length)] : null; },
    }], ssr: { noExternal: true }, build: { ssr: input, outDir: path.join(root, 'out'), minify: false,
      rollupOptions: { output: { entryFileNames: 'entry.mjs' } } } });
    const module = await import(pathToFileURL(path.join(root, 'out/entry.mjs')).href);
    await module.synchronizePublishScene('session', () => {}, state.pushLog);
    assert.equal(logs.length, 2); assert.deepEqual(commits, [[]]); assert.deepEqual(state.sceneResourceIssues, []);
    logs.length = 0;
    await module.preparePublishSceneSnapshot(JSON.stringify({ version: 5, scene: state.scene }), () => {}, state.pushLog);
    assert.equal(logs.length, 2); assert.deepEqual(state.sceneResourceIssues, []);
    resources.issues = [{ resourceKind: 'model', resourceId: '42', message: '真实模型文件下载失败' }];
    await assert.rejects(module.synchronizePublishScene('session', () => {}, state.pushLog), /真实模型文件下载失败/);
    await assert.rejects(module.preparePublishSceneSnapshot(JSON.stringify({ version: 5, scene: state.scene }), () => {}, state.pushLog), /真实模型文件下载失败/);
  } finally {
    (globalThis as any).window = previousWindow;
    delete (globalThis as any).__publishWarningsTest;
    await rm(root, { recursive: true, force: true });
  }
});
