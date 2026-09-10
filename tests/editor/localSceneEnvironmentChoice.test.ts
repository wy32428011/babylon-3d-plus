import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import test from 'node:test';

const source = await readFile(new URL('../../src/editor/loading/ScenePreparationOverlay.tsx', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function ScenePreparationOverlay')).replace('export function', 'function');
const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
function fixture(withChoice = true) {
  const choice = withChoice ? { resourceId: 'env', displayName: '中鼎厂房', previousRevision: 'old-123', availableRevision: 'new-456',
    previousSize: 120010800, availableSize: 120020000, sha256: 'a'.repeat(64) } : null;
  const events: string[] = [];
  const state: any = { sceneResourcePolicy: 'local-refresh', sceneSessionId: 'A', sceneResourceIssues: ['原环境版本缺失'],
    latestSceneResourceTransaction: null, localSceneEnvironmentRecoveryChoice: choice,
    acceptLocalSceneEnvironmentRecoveryChoice: (session: string, expected: unknown) => {
      if (state.sceneSessionId !== session || state.localSceneEnvironmentRecoveryChoice !== expected) return false;
      events.push('accepted'); return true;
    } };
  const useEditorStore = Object.assign((selector: (state: unknown) => unknown) => selector(state), { getState: () => state });
  const element = (type: unknown, props: any, ...children: unknown[]) => ({ type, props: { ...props, children } });
  const Overlay = runInNewContext(`${js};ScenePreparationOverlay`, {
    React: { createElement: element, Fragment: 'fragment' }, SceneLoadingMask: 'mask', RemoteDownloadDetail: 'download',
    styles: {}, useEditorStore, useRef: () => ({ current: null }), useEffect() {}, useState: () => [null, () => {}],
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    environmentPreparationStore: { subscribe() {}, getSnapshot: () => ({ sceneSessionId: 'A', error: '原环境版本缺失', retrying: false }),
      retry: () => { events.push('retry'); return Promise.resolve(); } },
    sceneRemoteDownloadStore: { subscribe() {}, getSnapshot: () => ({ sceneSessionId: 'A' }) },
    subscribeScenePreparation() {}, getScenePreparationSnapshot: () => ({ sceneSessionId: 'A', completed: false, runtime: {}, percent: 61 }),
    isScenePreparationSettled: () => false,
  });
  return { state, events, render: () => Overlay({ onCancel() {} }) };
}
function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value.props ?? {}).flatMap(nodes)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object') return String(value ?? '');
  return Object.values(value.props ?? {}).map(text).join('');
}

test('环境版本确认展示可审阅的旧新版本和大小，不因渲染或普通重试自动接受', () => {
  const f = fixture(); const ui = f.render();
  const content = text(ui);
  for (const value of ['old-123', 'new-456', '120,010,800', '120,020,000', '中鼎厂房']) assert.ok(content.includes(value));
  assert.deepEqual(f.events, []);
  const buttons = nodes(ui).filter(node => node.type === 'button');
  const normalRetry = buttons.find(node => text(node).includes('重新同步场景资源'));
  normalRetry.props.onClick();
  assert.deepEqual(f.events, ['retry']);
  const accept = buttons.find(node => text(node).includes('使用当前中台环境版本恢复'));
  assert.ok(accept); accept.props.onClick();
  assert.deepEqual(f.events, ['retry', 'accepted', 'retry']);
});

test('没有可审阅候选时没有版本接受入口，旧会话的已渲染按钮也不能确认新场景', () => {
  const empty = fixture(false); assert.ok(!text(empty.render()).includes('使用当前中台环境版本恢复'));
  const f = fixture(); const button = nodes(f.render()).find(node => node.type === 'button' && text(node).includes('使用当前中台环境版本恢复'));
  assert.ok(button); f.state.sceneSessionId = 'B'; button.props.onClick(); assert.deepEqual(f.events, []);
});
