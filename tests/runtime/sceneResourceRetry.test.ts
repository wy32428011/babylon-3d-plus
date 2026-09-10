import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../src/runtime/babylon/SceneRuntime.ts', import.meta.url), 'utf8');
function fixture() {
  const start = source.indexOf('  retryFailedSceneResources(');
  const end = source.indexOf('\n  /**', start + 1);
  assert.ok(start >= 0 && end > start, '显式资源恢复必须支持重试同签名的失败运行时');
  const retry = runInNewContext(stripTypeScriptTypes(`({${source.slice(start, end)}}).retryFailedSceneResources`), {
    resolveModelGeneratorTargetFromSnapshot: (component: any, snapshot: any) => ({ target: component.defaultTarget, role: 'default', snapshot }),
  });
  const events: string[] = [];
  const document: any = { entities: {}, entityIds: [] };
  const runtime: any = { disposed: false, models: new Map(), modelReadinessErrors: new Map(),
    modelArrayParameterVariants: new Map(), generatedOutputOwners: new Map(), syncedEntities: new Map(),
    modelArrayIdentityMode: 'render',
    disposeModel: (id: string) => { runtime.models.delete(id); events.push(`model:${id}`); },
    disposeModelArrayParameterVariant: (variant: any) => { runtime.modelArrayParameterVariants.delete(variant.key); events.push(`variant:${variant.key}`); },
    disposeModelGeneratorOutput: (owner: any) => { owner.output = null; events.push(`generator:${owner.entityId}`); },
    sync: (doc: any, selection: unknown, options: any) => {
      assert.equal(doc, document); assert.equal(options.modelArrayIdentityMode, 'render'); events.push('sync');
    },
    syncModelGeneratorResolvedTarget: (owner: any, resolution: any) => {
      assert.equal(owner.activeTargetSignature, null); assert.equal(owner.readinessError, undefined);
      owner.activeTargetSignature = resolution.target.signature; events.push(`target:${resolution.target.signature}`);
    },
  };
  return { runtime, document, events, retry: () => retry.call(runtime, document, []) };
}

test('只重建失败脚本宿主，健康模型、参数、脚本签名与正常加载均不变', () => {
  const f = fixture();
  for (const id of ['failed', 'healthy', 'loading']) f.document.entities[id] = { components: { modelAsset: { revision: 'same' } } };
  const healthy = { externalScriptRuntime: { getInitializationError: () => null } };
  const loading = { externalScriptStarting: true, readinessError: 'old' };
  f.runtime.models.set('failed', { externalScriptRuntime: { getInitializationError: () => 'read failed' } });
  f.runtime.models.set('healthy', healthy); f.runtime.models.set('loading', loading);
  const before = JSON.stringify(f.document);
  assert.equal(f.retry(), 1);
  assert.deepEqual(f.events, ['model:failed', 'sync']);
  assert.equal(f.runtime.models.get('healthy'), healthy); assert.equal(f.runtime.models.get('loading'), loading);
  assert.equal(JSON.stringify(f.document), before);
});

test('已被释放的 GLB 失败仍触发同版本重试，过期实体失败不启动工作', () => {
  const f = fixture(); f.document.entities.current = { components: { modelAsset: {} } };
  f.runtime.syncedEntities.set('current', f.document.entities.current);
  f.runtime.modelReadinessErrors.set('current', { entityIds: ['current'], error: 'missing' });
  f.runtime.modelReadinessErrors.set('old', { entityIds: ['removed'], error: 'old' });
  assert.equal(f.retry(), 1); assert.deepEqual(f.events, ['sync']);
  assert.equal(f.runtime.syncedEntities.has('current'), false, '已释放参数变体也必须使所属实体重新同步');
});

test('参数变体失败只清对应变体并使源实体重建批次', () => {
  const f = fixture(); f.document.entities.source = { components: { modelAsset: {} } };
  f.runtime.syncedEntities.set('source', {});
  f.runtime.modelArrayParameterVariants.set('bad', { key: 'bad', sourceEntityId: 'source', model: { readinessError: 'script' } });
  f.runtime.modelArrayParameterVariants.set('good', { key: 'good', sourceEntityId: 'source', model: {} });
  assert.equal(f.retry(), 1);
  assert.deepEqual(f.events, ['variant:bad', 'sync']);
  assert.equal(f.runtime.syncedEntities.has('source'), false);
  assert.ok(f.runtime.modelArrayParameterVariants.has('good'));
});

test('生成器清理失败目标并用原规则快照重试，同签名也会再次加载', () => {
  const f = fixture(); f.document.entities.generator = { components: { modelGenerator: {} } };
  const target = { signature: 'unchanged' };
  const owner: any = { entityId: 'cargo', editorEntityId: 'generator', loadToken: 1,
    output: null, activeTargetSignature: 'unchanged', activeSnapshot: { fields: {} },
    readinessError: 'missing GLB', failedTargetSignatures: new Set(['unchanged']),
    reportedLoadFailureKeys: new Set(['default:unchanged']), component: { defaultTarget: target } };
  f.runtime.generatedOutputOwners.set('cargo', owner);
  assert.equal(f.retry(), 1);
  assert.deepEqual(f.events, ['generator:cargo', 'sync', 'target:unchanged']);
  assert.equal(owner.failedTargetSignatures.size, 0); assert.equal(owner.reportedLoadFailureKeys.size, 0);
  assert.equal(owner.loadToken, 2); assert.equal(owner.component.defaultTarget, target);
});

test('没有失败或已销毁时没有同步、资源销毁与脚本重启', () => {
  const f = fixture(); assert.equal(f.retry(), 0); assert.deepEqual(f.events, []);
  f.runtime.disposed = true; f.runtime.modelReadinessErrors.set('one', { entityIds: ['one'], error: 'bad' });
  f.document.entities.one = { components: { modelAsset: {} } };
  assert.equal(f.retry(), 0); assert.deepEqual(f.events, []);
});
