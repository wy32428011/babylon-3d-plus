import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../src/editor/store/editorStore.ts', import.meta.url), 'utf8');
const start = source.indexOf('  loadScene: async (');
const end = source.indexOf('  loadSceneFromContent:', start);
assert.ok(start >= 0 && end > start);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let state: any = { sceneSessionId: 'A', scene: { name: '原场景' }, runtimeMode: 'edit', logs: [], pushLog() {} };
  let resolveRead!: (value: unknown) => void;
  let resolveConfirm!: (value: boolean) => void;
  let current = true;
  const confirmations: unknown[] = [];
  const read = () => new Promise(resolve => { resolveRead = resolve; });
  const actions = runInNewContext(stripTypeScriptTypes(`({${source.slice(start, end)}})`), {
    window: { editorApi: { loadScene: read, loadSceneFile: read,
      confirmSceneOpen: (request: unknown) => { confirmations.push(request); return new Promise(resolve => { resolveConfirm = resolve; }); } } },
    get: () => state, set: (update: any) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; },
    deserializeScene: JSON.parse, createLoadedSceneState: (_before: unknown, scene: unknown) => ({ scene, sceneSessionId: 'loaded' }),
    prependLog: (_before: unknown, message: string) => [message], syncDataPlatformImagesAfterLocalSceneLoad() {},
  });
  return { get: () => state, set: (next: object) => { state = { ...state, ...next }; }, confirmations,
    read: (content = '{"name":"新场景","sceneSettings":{}}', token: number | undefined = 8) =>
      resolveRead({ canceled: false, content, filePath: 'new.scene.json', sceneOpenToken: token }),
    confirm: (accepted: boolean) => resolveConfirm(accepted), cancel: () => { current = false; },
    open: (kind: 'dialog' | 'path') => kind === 'dialog' ? actions.loadScene() : actions.loadSceneFromFile('new.scene.json', () => current),
  };
}

test('文件选择器和最近文件均在反序列化通过后确认发布归属，确认完成前不提交场景', async () => {
  for (const kind of ['dialog', 'path'] as const) {
    const f = fixture(); const pending = f.open(kind); f.read(); await tick();
    assert.equal(f.get().scene.name, '原场景');
    assert.equal(f.confirmations.length, 1);
    assert.equal((f.confirmations[0] as any).sceneOpenToken, 8);
    f.confirm(true); assert.equal(await pending, true); assert.equal(f.get().scene.name, '新场景');
  }
});

test('格式无效或主进程拒绝 token 时保留当前场景，格式校验失败不确认归属', async () => {
  for (const kind of ['dialog', 'path'] as const) {
    const invalid = fixture(); const rejected = invalid.open(kind); invalid.read('{invalid');
    assert.equal(await rejected, false); assert.equal(invalid.confirmations.length, 0);
    assert.equal(invalid.get().scene.name, '原场景');
    const denied = fixture(); const pending = denied.open(kind); denied.read(); await tick();
    assert.equal(denied.confirmations.length, 1); denied.confirm(false);
    assert.equal(await pending, false); assert.equal(denied.get().scene.name, '原场景');
  }
});

test('文件读取或归属确认期间切换场景，旧返回均不能覆盖新会话', async () => {
  for (const kind of ['dialog', 'path'] as const) for (const phase of ['reading', 'confirming']) {
    const f = fixture(); const pending = f.open(kind);
    if (phase === 'confirming') { f.read(); await tick(); assert.equal(f.confirmations.length, 1); }
    f.set({ sceneSessionId: 'B', scene: { name: '后打开的场景' } });
    if (phase === 'reading') f.read(); else f.confirm(true);
    assert.equal(await pending, false); assert.equal(f.get().scene.name, '后打开的场景');
    if (phase === 'reading') assert.equal(f.confirmations.length, 0);
  }
});

test('最近文件在 await confirm 后再次检查外部取消标记', async () => {
  const f = fixture(); const pending = f.open('path'); f.read(); await tick();
  assert.equal(f.confirmations.length, 1); f.cancel(); f.confirm(true);
  assert.equal(await pending, false); assert.equal(f.get().scene.name, '原场景');
});

test('开发与打包 preload 均只发送主进程签发的 sceneOpenToken', async () => {
  for (const file of ['electron/preload.ts', 'electron/preload.cts']) {
    const preload = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const line = preload.split('\n').find(item => item.includes('confirmSceneOpen:'));
    assert.ok(line, `${file} 必须暴露确认接口`);
    const calls: unknown[][] = [];
    const method = runInNewContext(stripTypeScriptTypes(`({${line}}).confirmSceneOpen`), {
      ipcRenderer: { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(true); } },
    });
    const request = { sceneOpenToken: 8 };
    await method(request); assert.equal(calls[0][0], 'scene:confirmOpen'); assert.equal(calls[0][1], request);
  }
});
